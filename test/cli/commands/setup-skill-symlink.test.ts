import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile, readdir, lstat, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Issue Storybloq/storybloq#12: every setup/hook writer that lands on a
// user-managed dotfile must follow a symlink (stow/chezmoi/yadm) instead of
// replacing it. These regression tests assert, per site, that the symlinked
// target survives and the real file receives the write. All are skipped on
// Windows (symlink creation needs elevation there).

const SKILL = "../../../src/cli/commands/setup-skill.js";

async function noTmpArtifacts(dir: string): Promise<boolean> {
  const names = await readdir(dir);
  return !names.some((n) => n.endsWith(".tmp"));
}

describe("setup-skill symlink preservation (issue #12)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `storybloq-setup-symlink-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // --- ~/.claude/settings.json sites ---------------------------------------

  it("registerPreCompactHook preserves a symlinked settings.json", async () => {
    if (process.platform === "win32") return;
    const real = join(dir, "real-settings.json");
    const link = join(dir, "settings.json");
    await writeFile(real, "{}\n", "utf-8");
    await symlink(real, link);

    const { registerPreCompactHook } = await import(SKILL);
    const result = await registerPreCompactHook(link, "/usr/local/bin/storybloq");

    expect(result).toBe("registered");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    const written = JSON.parse(await readFile(real, "utf-8")) as Record<string, unknown>;
    expect(written.hooks).toBeDefined();
    expect(await noTmpArtifacts(dir)).toBe(true);
  });

  it("removeHook preserves a symlinked settings.json", async () => {
    if (process.platform === "win32") return;
    const real = join(dir, "real-settings.json");
    const link = join(dir, "settings.json");
    const command = "/usr/local/bin/storybloq hook-status";
    await writeFile(
      real,
      JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command }] }] } }, null, 2) + "\n",
      "utf-8",
    );
    await symlink(real, link);

    const { removeHook } = await import(SKILL);
    const result = await removeHook("Stop", command, link);

    expect(result).toBe("removed");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    const written = JSON.parse(await readFile(real, "utf-8")) as { hooks: { Stop: { hooks: unknown[] }[] } };
    expect(written.hooks.Stop[0]!.hooks).toHaveLength(0);
    expect(await noTmpArtifacts(dir)).toBe(true);
  });

  it("migrateLegacyHookVariants preserves a symlinked settings.json", async () => {
    if (process.platform === "win32") return;
    const { migrateLegacyHookVariants, PRECOMPACT_SUBCOMMAND } = await import(SKILL);
    const real = join(dir, "real-settings.json");
    const link = join(dir, "settings.json");
    const legacy = `claudestory ${PRECOMPACT_SUBCOMMAND}`;
    await writeFile(
      real,
      JSON.stringify({ hooks: { PreCompact: [{ matcher: "", hooks: [{ type: "command", command: legacy }] }] } }, null, 2) + "\n",
      "utf-8",
    );
    await symlink(real, link);

    const removed = await migrateLegacyHookVariants(
      "PreCompact",
      PRECOMPACT_SUBCOMMAND,
      `/usr/local/bin/storybloq ${PRECOMPACT_SUBCOMMAND}`,
      link,
    );

    expect(removed).toBe(1);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    const written = JSON.parse(await readFile(real, "utf-8")) as { hooks: { PreCompact: { hooks: unknown[] }[] } };
    expect(written.hooks.PreCompact[0]!.hooks).toHaveLength(0);
    expect(await noTmpArtifacts(dir)).toBe(true);
  });

  // --- ~/.codex/config.toml sites ------------------------------------------

  it("ensureCodexToolApprovals preserves a symlinked config.toml", async () => {
    if (process.platform === "win32") return;
    const real = join(dir, "real-config.toml");
    const link = join(dir, "config.toml");
    await writeFile(real, "", "utf-8");
    await symlink(real, link);

    const { ensureCodexToolApprovals } = await import(SKILL);
    const result = await ensureCodexToolApprovals(link);

    expect(result).toBe("updated");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf-8")).toContain("approval_mode");
    expect(await noTmpArtifacts(dir)).toBe(true);
  });

  it("ensureCodexClientEnv preserves a symlinked config.toml", async () => {
    if (process.platform === "win32") return;
    const real = join(dir, "real-config.toml");
    const link = join(dir, "config.toml");
    await writeFile(real, "", "utf-8");
    await symlink(real, link);

    const { ensureCodexClientEnv } = await import(SKILL);
    const result = await ensureCodexClientEnv(link);

    expect(result).toBe("updated");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf-8")).toContain('STORYBLOQ_CLIENT = "codex"');
    expect(await noTmpArtifacts(dir)).toBe(true);
  });

  // --- ~/.codex/hooks.json sites -------------------------------------------

  it("registerCodexHook preserves a symlinked hooks.json", async () => {
    if (process.platform === "win32") return;
    const real = join(dir, "real-hooks.json");
    const link = join(dir, "hooks.json");
    await writeFile(real, "{}\n", "utf-8");
    await symlink(real, link);

    const { registerCodexHook } = await import(SKILL);
    const result = await registerCodexHook("Stop", { type: "command", command: "/usr/local/bin/storybloq hook-status" }, link);

    expect(result).toBe("registered");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    const written = JSON.parse(await readFile(real, "utf-8")) as Record<string, unknown>;
    expect(written.hooks).toBeDefined();
    expect(await noTmpArtifacts(dir)).toBe(true);
  });

  it("migrateCodexHookVariants preserves a symlinked hooks.json", async () => {
    if (process.platform === "win32") return;
    const { migrateCodexHookVariants, SESSIONSTART_SUBCOMMAND } = await import(SKILL);
    const acceptedRest = `${SESSIONSTART_SUBCOMMAND} --codex-hook-json`;
    const real = join(dir, "real-hooks.json");
    const link = join(dir, "hooks.json");
    await writeFile(
      real,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `claudestory ${acceptedRest}` }] }] } }, null, 2) + "\n",
      "utf-8",
    );
    await symlink(real, link);

    const removed = await migrateCodexHookVariants(
      "SessionStart",
      [acceptedRest],
      `/usr/local/bin/storybloq ${acceptedRest}`,
      link,
    );

    expect(removed).toBe(1);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await noTmpArtifacts(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// copyDirRecursive: symlinked destination directory (issue #12)
// ---------------------------------------------------------------------------

describe("copyDirRecursive symlinked destination (issue #12)", () => {
  let dir: string;
  let src: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `storybloq-copydir-symlink-${randomUUID()}`);
    src = join(dir, "src");
    await mkdir(join(src, "sub"), { recursive: true });
    await writeFile(join(src, "a.txt"), "A", "utf-8");
    await writeFile(join(src, "sub", "b.txt"), "B", "utf-8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("preserves a symlinked destDir, copies into the real target, and removes stale files", async () => {
    if (process.platform === "win32") return;
    const realDest = join(dir, "realdest");
    await mkdir(realDest, { recursive: true });
    await writeFile(join(realDest, "stale.txt"), "STALE", "utf-8"); // absent from src
    const linkDest = join(dir, "linkdest");
    await symlink(realDest, linkDest);

    const { copyDirRecursive } = await import(SKILL);
    const written: string[] = await copyDirRecursive(src, linkDest);

    expect((await lstat(linkDest)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(realDest, "a.txt"), "utf-8")).toBe("A");
    expect(await readFile(join(realDest, "sub", "b.txt"), "utf-8")).toBe("B");
    // Whole-directory swap drops files that are no longer in src.
    expect(existsSync(join(realDest, "stale.txt"))).toBe(false);
    // Readable through the preserved link too.
    expect(await readFile(join(linkDest, "a.txt"), "utf-8")).toBe("A");
    expect(written).toContain("a.txt");
  });

  it("rolls back to the original real target if the swap rename fails, preserving the link", async () => {
    if (process.platform === "win32") return;
    const realDest = join(dir, "realdest");
    await mkdir(realDest, { recursive: true });
    await writeFile(join(realDest, "orig.txt"), "ORIG", "utf-8");
    const linkDest = join(dir, "linkdest");
    await symlink(realDest, linkDest);

    const { __copyDirRecursiveForTest } = await import(SKILL);
    await expect(
      __copyDirRecursiveForTest(src, linkDest, {
        beforeSwapRename: () => {
          throw new Error("injected swap failure");
        },
      }),
    ).rejects.toThrow("injected swap failure");

    // Link preserved; real target restored from backup with original contents.
    expect((await lstat(linkDest)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(realDest, "orig.txt"), "utf-8")).toBe("ORIG");
    // No tmp/bak scaffolding left behind beside the real target.
    expect(existsSync(realDest + ".tmp")).toBe(false);
    expect(existsSync(realDest + ".bak")).toBe(false);
  });

  it("refuses to convert a symlink that points at an existing non-directory", async () => {
    if (process.platform === "win32") return;
    const realFile = join(dir, "realfile");
    await writeFile(realFile, "F", "utf-8");
    const linkDest = join(dir, "linkdest");
    await symlink(realFile, linkDest);

    const { copyDirRecursive } = await import(SKILL);
    await expect(copyDirRecursive(src, linkDest)).rejects.toThrow(/non-directory/);

    expect((await lstat(linkDest)).isSymbolicLink()).toBe(true);
    expect(await readFile(realFile, "utf-8")).toBe("F");
  });
});
