/**
 * T-518: `storybloq update`. Every subprocess is injected; nothing here
 * touches npm or the real binary. The prefix is a temp directory standing in
 * for `dirname(process.execPath)`.
 *
 * Mutants this file kills: M-NPM-FROM-PATH (npm taken from PATH instead of
 * beside the running Node), M-REEXEC-FROM-PATH (setup re-exec'd through the
 * PATH walk although the prefix has a launcher), M-SETUP-IN-PROCESS (setup
 * not re-exec'd at all), M-SETUP-AFTER-FAILED-INSTALL, M-WIN32-RUNS-NPM.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { handleUpdate, manualUpdateLines, UPDATE_PACKAGE_SPEC } from "../../../src/cli/commands/update.js";

interface Call {
  cmd: string;
  args: readonly string[];
  opts: { stdio: string; encoding: string };
}

let prefix: string;

beforeEach(async () => {
  prefix = join(tmpdir(), `storybloq-update-${randomUUID()}`);
  await mkdir(prefix, { recursive: true });
});

afterEach(async () => {
  process.exitCode = undefined;
  await rm(prefix, { recursive: true, force: true });
});

/** A prefix with `npm` and, unless told otherwise, `storybloq` beside the Node binary. */
async function prefixWith(names: readonly string[]): Promise<void> {
  for (const name of names) await writeFile(join(prefix, name), "#!/bin/sh\n", "utf-8");
}

function fakeDeps(over: {
  platform?: NodeJS.Platform;
  fallbackBin?: string | null;
  failInstall?: boolean;
  failSetup?: boolean;
  versionOut?: string;
} = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    platform: over.platform ?? ("darwin" as NodeJS.Platform),
    execDir: prefix,
    currentVersion: "1.15.0",
    fallbackBin: () => (over.fallbackBin === undefined ? "/somewhere/on/path/storybloq" : over.fallbackBin),
    log: (line: string) => {
      out.push(line);
    },
    warn: (line: string) => {
      err.push(line);
    },
    run: (cmd: string, args: readonly string[], opts: { stdio: string; encoding: string }): string => {
      calls.push({ cmd, args, opts });
      if (args[0] === "install" && over.failInstall) throw new Error("npm ERR! EACCES");
      if (args[0] === "--version") return over.versionOut ?? "1.15.1\n";
      if (args[0] === "setup" && over.failSetup) throw new Error("setup exploded");
      return "";
    },
  };
  return { deps, calls, out, err };
}

describe("storybloq update (T-518)", () => {
  it("installs with the npm beside the running Node, re-execs THAT prefix's storybloq for setup, then says restart (M-NPM-FROM-PATH, M-REEXEC-FROM-PATH, M-SETUP-IN-PROCESS)", async () => {
    await prefixWith(["npm", "storybloq"]);
    const { deps, calls, out, err } = fakeDeps();
    await handleUpdate({}, deps);

    expect(calls[0]).toEqual({ cmd: join(prefix, "npm"), args: ["install", "-g", UPDATE_PACKAGE_SPEC], opts: { stdio: "inherit", encoding: "utf-8" } });
    expect(calls[1]).toEqual({ cmd: join(prefix, "storybloq"), args: ["--version"], opts: { stdio: "pipe", encoding: "utf-8" } });
    expect(calls[2]).toEqual({ cmd: join(prefix, "storybloq"), args: ["setup", "--client", "all"], opts: { stdio: "inherit", encoding: "utf-8" } });
    expect(calls).toHaveLength(3);
    expect(out.at(-1)).toBe("Updated storybloq 1.15.0 -> 1.15.1. Restart Claude Code and Codex now.");
    expect(err).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("falls back to the PATH walk for the binary only when the prefix has no launcher, and to bare `npm` when the prefix has none", async () => {
    await prefixWith([]);
    const { deps, calls } = fakeDeps();
    await handleUpdate({}, deps);
    expect(calls[0]!.cmd).toBe("npm");
    expect(calls[2]!.cmd).toBe("/somewhere/on/path/storybloq");
  });

  it("falls back to the bare name when neither the prefix nor the PATH walk has a binary", async () => {
    await prefixWith(["npm"]);
    const { deps, calls } = fakeDeps({ fallbackBin: null });
    await handleUpdate({}, deps);
    expect(calls[2]!.cmd).toBe("storybloq");
  });

  it("passes --client through to the setup re-exec and names only that client in the restart line", async () => {
    await prefixWith(["npm", "storybloq"]);
    const { deps, calls, out } = fakeDeps();
    await handleUpdate({ client: "codex" }, deps);
    expect(calls[2]!.args).toEqual(["setup", "--client", "codex"]);
    expect(out.at(-1)).toContain("Restart Codex now.");
  });

  it("a failed npm install runs no setup, changes nothing else, and exits non-zero (M-SETUP-AFTER-FAILED-INSTALL)", async () => {
    await prefixWith(["npm", "storybloq"]);
    const { deps, calls, err } = fakeDeps({ failInstall: true });
    await handleUpdate({}, deps);
    expect(calls).toHaveLength(1);
    expect(err.join("\n")).toContain("npm install failed");
    expect(err.join("\n")).toContain("setup was not run");
    expect(process.exitCode).toBe(1);
  });

  it("a failed setup after a good install says how to finish and exits non-zero", async () => {
    await prefixWith(["npm", "storybloq"]);
    const { deps, err } = fakeDeps({ failSetup: true });
    await handleUpdate({ client: "claude" }, deps);
    expect(err.join("\n")).toContain("storybloq setup --client claude");
    expect(process.exitCode).toBe(1);
  });

  it("a --version that answers nothing still runs setup and reports the update without a number", async () => {
    await prefixWith(["npm", "storybloq"]);
    const { deps, calls, out } = fakeDeps({ versionOut: "" });
    await handleUpdate({}, deps);
    expect(calls.some((c) => c.args[0] === "setup")).toBe(true);
    expect(out.at(-1)).toContain("1.15.0 -> the installed version");
  });

  it("on Windows runs nothing and prints the two manual commands (M-WIN32-RUNS-NPM)", async () => {
    await prefixWith(["npm", "storybloq"]);
    const { deps, calls, out } = fakeDeps({ platform: "win32" });
    await handleUpdate({ client: "all" }, deps);
    expect(calls).toEqual([]);
    expect(out).toEqual([...manualUpdateLines("all")]);
    expect(out.join("\n")).toContain(`npm install -g ${UPDATE_PACKAGE_SPEC}`);
    expect(out.join("\n")).toContain("storybloq setup --client all");
    expect(process.exitCode).toBeUndefined();
  });
});
