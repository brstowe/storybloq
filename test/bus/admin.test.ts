import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeBus } from "../../src/bus/index.js";
import { assertBusRuntimeIgnored } from "../../src/bus/paths.js";
import { initProject } from "../../src/core/init.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  roots.push(root);
  await initProject(root, { name });
  return root;
}

describe("Storybloq Bus initialization", () => {
  it("is idempotent and keeps one ignore entry", async () => {
    const root = await project("bus-init-idempotent");

    const first = await initializeBus(root);
    const second = await initializeBus(root);

    expect(first).toMatchObject({ enabled: true, existing: false });
    expect(second).toMatchObject({ enabled: true, existing: true, instanceId: first.instanceId });
    const entries = (await readFile(join(root, ".story", ".gitignore"), "utf-8"))
      .split(/\r?\n/)
      .filter((entry) => entry.trim() === "bus/");
    expect(entries).toHaveLength(1);
  });

  it("rejects a symlinked ignore file without touching its target", async () => {
    const root = await project("bus-init-ignore-symlink");
    const ignorePath = join(root, ".story", ".gitignore");
    const target = join(root, "ignore-target");
    await writeFile(target, "sentinel\n", "utf-8");
    await rm(ignorePath);
    await symlink(target, ignorePath);

    await expect(initializeBus(root)).rejects.toMatchObject({ code: "invalid_input" });
    expect(await readFile(target, "utf-8")).toBe("sentinel\n");
    await expect(access(join(root, ".story", "bus"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a later negation before enabling or creating the runtime", async () => {
    const root = await project("bus-init-ignore-negation");
    const ignorePath = join(root, ".story", ".gitignore");
    await writeFile(ignorePath, `${await readFile(ignorePath, "utf-8")}bus/\n!bus/\n`, "utf-8");

    await expect(initializeBus(root)).rejects.toMatchObject({ code: "conflict" });
    const config = JSON.parse(await readFile(join(root, ".story", "config.json"), "utf-8"));
    expect(config.features.bus).not.toBe(true);
    await expect(access(join(root, ".story", "bus"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts an anchored Bus rule with unrelated surrounding entries", async () => {
    const root = await project("bus-init-ignore-anchored");
    await writeFile(
      join(root, ".story", ".gitignore"),
      "# local runtime\ncache/\n/bus/\nstatus.json\n",
      "utf-8",
    );

    await expect(assertBusRuntimeIgnored(join(root, ".story"))).resolves.toBeUndefined();
  });

  it("rejects glob negations that could re-include Bus runtime", async () => {
    const root = await project("bus-init-ignore-glob-negation");
    const ignorePath = join(root, ".story", ".gitignore");
    await writeFile(ignorePath, `${await readFile(ignorePath, "utf-8")}bus/\n!*\n`, "utf-8");

    await expect(initializeBus(root)).rejects.toMatchObject({ code: "conflict" });
    const config = JSON.parse(await readFile(join(root, ".story", "config.json"), "utf-8"));
    expect(config.features.bus).not.toBe(true);
    await expect(access(join(root, ".story", "bus"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
