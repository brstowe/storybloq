import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSelftest } from "../../../src/cli/commands/selftest.js";
import { initProject } from "../../../src/core/init.js";

describe("handleSelftest", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("all 24 checks pass on a clean project (md)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "selftest-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleSelftest(dir, "md");
    expect(result.output).toContain("24/24 passed");
    expect(result.output).toContain("## Lesson");
    expect(result.output).not.toContain("[ ]");
  });

  it("all 24 checks pass on a clean project (json)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "selftest-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleSelftest(dir, "json");
    const parsed = JSON.parse(result.output);
    expect(parsed.data.passed).toBe(24);
    expect(parsed.data.failed).toBe(0);
    expect(parsed.data.total).toBe(24);
    expect(parsed.data.results).toHaveLength(24);
    expect(parsed.data.cleanupErrors).toHaveLength(0);
    expect(parsed.data.warnings).toEqual([]);
    expect(parsed.data.results.some((r: { entity: string }) => r.entity === "lesson")).toBe(true);
  });

  it("adds a non-failing Codex hook warning without changing the CRUD count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "selftest-"));
    const codexHome = await mkdtemp(join(tmpdir(), "selftest-codex-home-"));
    tmpDirs.push(dir, codexHome);
    await initProject(dir, { name: "test" });
    const oldClient = process.env.STORYBLOQ_CLIENT;
    const oldHome = process.env.CODEX_HOME;
    process.env.STORYBLOQ_CLIENT = "codex";
    process.env.CODEX_HOME = codexHome;
    try {
      const result = await handleSelftest(dir, "json");
      const parsed = JSON.parse(result.output);
      expect(parsed.data.total).toBe(24);
      expect(parsed.data.passed).toBe(24);
      expect(parsed.data.warnings).toEqual([
        expect.stringContaining("hooks are not installed"),
      ]);
    } finally {
      if (oldClient === undefined) delete process.env.STORYBLOQ_CLIENT;
      else process.env.STORYBLOQ_CLIENT = oldClient;
      if (oldHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldHome;
    }
  });

  it("cleans up entities even when failAfter triggers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "selftest-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    // Should throw due to failAfter, but cleanup should remove created entities
    await expect(handleSelftest(dir, "md", 3)).rejects.toThrow("failAfter");

    // Verify no leftover entities
    const ticketFiles = await readdir(join(dir, ".story", "tickets")).catch(() => []);
    const issueFiles = await readdir(join(dir, ".story", "issues")).catch(() => []);
    const noteFiles = await readdir(join(dir, ".story", "notes")).catch(() => []);
    const lessonFiles = await readdir(join(dir, ".story", "lessons")).catch(() => []);
    expect(ticketFiles).toHaveLength(0);
    expect(issueFiles).toHaveLength(0);
    expect(noteFiles).toHaveLength(0);
    expect(lessonFiles).toHaveLength(0);
  });

  it("no leftover entities after successful run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "selftest-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleSelftest(dir, "md");

    const ticketFiles = await readdir(join(dir, ".story", "tickets")).catch(() => []);
    const issueFiles = await readdir(join(dir, ".story", "issues")).catch(() => []);
    const noteFiles = await readdir(join(dir, ".story", "notes")).catch(() => []);
    const lessonFiles = await readdir(join(dir, ".story", "lessons")).catch(() => []);
    expect(ticketFiles).toHaveLength(0);
    expect(issueFiles).toHaveLength(0);
    expect(noteFiles).toHaveLength(0);
    expect(lessonFiles).toHaveLength(0);
  });

  it("uses canonical IDs in team-mode projects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "selftest-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    const configPath = join(dir, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.team = {
      enabled: true,
      idAllocator: "local",
      minCliVersion: "1.4.4",
      mergeDriverVersion: 1,
      requiredFeatures: ["merge-driver"],
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const result = await handleSelftest(dir, "json");
    const parsed = JSON.parse(result.output);
    const created = parsed.data.results
      .filter((r: { step: string }) => r.step === "create")
      .map((r: { detail: string }) => r.detail);

    expect(created).toEqual([
      expect.stringMatching(/^Created t-/),
      expect.stringMatching(/^Created i-/),
      expect.stringMatching(/^Created n-/),
      expect.stringMatching(/^Created l-/),
    ]);
  });

  it("does not require or mutate a remote in git-refs team mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "selftest-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    const configPath = join(dir, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.team = {
      enabled: true,
      idAllocator: "git-refs",
      minCliVersion: "1.4.4",
      mergeDriverVersion: 1,
      requiredFeatures: ["merge-driver"],
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const result = await handleSelftest(dir, "json");
    const parsed = JSON.parse(result.output);
    expect(parsed.data.passed).toBe(24);
    expect(parsed.data.failed).toBe(0);
    expect(parsed.data.cleanupErrors).toEqual([]);
  });
});
