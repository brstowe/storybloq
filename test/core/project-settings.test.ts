import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  __testing,
  claudeDirPath,
  hasBusToolHook,
  installProjectBusToolHook,
  projectSettingsPath,
  readProjectSettingsNoFollow,
  removeProjectBusToolHook,
  writeProjectSettingsNoFollow,
} from "../../src/core/project-settings.js";
import { BusError } from "../../src/bus/errors.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "project-settings-"));
  roots.push(root);
  return root;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout;
}

async function initGitRepo(root: string): Promise<void> {
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "ps-test@example.com"]);
  await git(root, ["config", "user.name", "PS Test"]);
}

const BIN = "/usr/local/bin/storybloq";
const EXPECTED_COMMAND = "/usr/local/bin/storybloq hook-bus-tool";

describe("T-427 project-settings no-follow read/write", () => {
  it("returns {} for a missing settings file and round-trips a written object byte-for-byte", async () => {
    const root = await tempRoot();
    expect(await readProjectSettingsNoFollow(root)).toEqual({});

    await writeProjectSettingsNoFollow(root, { hooks: { PostToolUse: [] }, extra: 1 });
    const raw = await readFile(projectSettingsPath(root), "utf-8");
    expect(raw).toBe(JSON.stringify({ hooks: { PostToolUse: [] }, extra: 1 }, null, 2) + "\n");
    expect(await readProjectSettingsNoFollow(root)).toEqual({ hooks: { PostToolUse: [] }, extra: 1 });
  });

  it("refuses to read or write through a symlinked settings file", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const secret = join(outside, "secret.json");
    await writeFile(secret, JSON.stringify({ stolen: true }), "utf-8");
    await mkdir(join(root, ".claude"), { recursive: true });
    await symlink(secret, projectSettingsPath(root));

    await expect(readProjectSettingsNoFollow(root)).rejects.toMatchObject({ code: "corrupt" });
    await expect(writeProjectSettingsNoFollow(root, { hooks: {} })).rejects.toMatchObject({ code: "corrupt" });
    // The symlink target was never overwritten.
    expect(JSON.parse(await readFile(secret, "utf-8"))).toEqual({ stolen: true });
  });

  it("refuses to READ through a symlinked .claude PARENT (not just the final file)", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    // A real settings file lives in the external dir the symlinked .claude points at. A
    // path-based lstat of the child follows the symlinked parent, so the reader must
    // reject a symlinked .claude BEFORE reading the child's bytes.
    await writeFile(join(outside, "settings.local.json"), JSON.stringify({ stolen: true }), "utf-8");
    await symlink(outside, claudeDirPath(root));
    await expect(readProjectSettingsNoFollow(root)).rejects.toMatchObject({ code: "corrupt" });
  });
});

describe("T-427 git fail-closed when git cannot confirm repo state", () => {
  it("refuses to install when a .git marker exists but git cannot confirm the repo", async () => {
    const root = await tempRoot();
    // A `.git` directory that is NOT a valid repo: `git rev-parse` exits 128 (the same
    // status as unsafe-ownership), but the filesystem marker proves we ARE inside a repo.
    // Skipping the tracked/ignored guards here could leave a committable hook, so install
    // must fail closed instead of treating 128 as "no repo".
    await mkdir(join(root, ".git"), { recursive: true });
    await expect(installProjectBusToolHook(root, BIN)).rejects.toBeInstanceOf(BusError);
    await expect(installProjectBusToolHook(root, BIN)).rejects.toMatchObject({ code: "io_error" });
    // Nothing was written: no settings file materialized behind the failed guard.
    await expect(readFile(projectSettingsPath(root), "utf-8")).rejects.toBeTruthy();
  });
});

describe("T-427 install/remove on-tool hook", () => {
  it("installs an idempotent PostToolUse hook and ignores the file via .claude/.gitignore", async () => {
    const root = await tempRoot();
    await initGitRepo(root);

    const first = await installProjectBusToolHook(root, BIN);
    expect(first).toEqual({ changed: true, command: EXPECTED_COMMAND });
    expect(hasBusToolHook(await readProjectSettingsNoFollow(root), EXPECTED_COMMAND)).toBe(true);

    // git now ignores the local settings file.
    await expect(git(root, ["check-ignore", ".claude/settings.local.json"])).resolves.toContain("settings.local.json");

    // Second install is a no-op (idempotent), no duplicate entry.
    const second = await installProjectBusToolHook(root, BIN);
    expect(second.changed).toBe(false);
    const settings = await readProjectSettingsNoFollow(root);
    const groups = (settings.hooks as { PostToolUse: { hooks: unknown[] }[] }).PostToolUse;
    const total = groups.reduce((n, g) => n + g.hooks.length, 0);
    expect(total).toBe(1);
  });

  it("removes the hook and prunes the emptied matcher group", async () => {
    const root = await tempRoot();
    await initGitRepo(root);
    await installProjectBusToolHook(root, BIN);

    const removed = await removeProjectBusToolHook(root);
    expect(removed.changed).toBe(true);
    expect(hasBusToolHook(await readProjectSettingsNoFollow(root), EXPECTED_COMMAND)).toBe(false);
    const settings = await readProjectSettingsNoFollow(root);
    const groups = (settings.hooks as { PostToolUse: unknown[] }).PostToolUse;
    expect(groups).toEqual([]);

    // Removing again is a no-op.
    expect((await removeProjectBusToolHook(root)).changed).toBe(false);
  });

  it("preserves the user's own PostToolUse hooks when removing ours", async () => {
    const root = await tempRoot();
    await initGitRepo(root);
    await writeProjectSettingsNoFollow(root, {
      hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "user-tool" }] }] },
    });
    await installProjectBusToolHook(root, BIN);
    await removeProjectBusToolHook(root);
    const settings = await readProjectSettingsNoFollow(root);
    expect(settings).toEqual({
      hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "user-tool" }] }] },
    });
  });

  it("refuses to install when settings.local.json is git-tracked", async () => {
    const root = await tempRoot();
    await initGitRepo(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(projectSettingsPath(root), JSON.stringify({ hooks: {} }, null, 2) + "\n", "utf-8");
    await git(root, ["add", "-f", ".claude/settings.local.json"]);
    await git(root, ["commit", "-m", "track settings"]);

    await expect(installProjectBusToolHook(root, BIN)).rejects.toBeInstanceOf(BusError);
    await expect(installProjectBusToolHook(root, BIN)).rejects.toMatchObject({ code: "conflict" });
  });

  it("works without git (no tracking risk): installs the hook, no gitignore required", async () => {
    const root = await tempRoot();
    const result = await installProjectBusToolHook(root, BIN);
    expect(result.changed).toBe(true);
    expect(hasBusToolHook(await readProjectSettingsNoFollow(root), EXPECTED_COMMAND)).toBe(true);
  });

  it("normalizes a stale-bin on-tool hook to exactly the canonical command", async () => {
    const root = await tempRoot();
    await installProjectBusToolHook(root, "/old/path/storybloq");
    // A later Node switch changes the resolved bin: install must strip the stale
    // entry and leave exactly the new canonical command (no duplicate).
    const result = await installProjectBusToolHook(root, BIN);
    expect(result.changed).toBe(true);
    const commands = collectAllPostToolUseCommands(await readProjectSettingsNoFollow(root));
    expect(commands).toEqual([EXPECTED_COMMAND]);
  });

  it("removes an on-tool hook installed with a DIFFERENT bin (disable after a Node switch)", async () => {
    const root = await tempRoot();
    await installProjectBusToolHook(root, "/old/path/storybloq");
    // Disable resolves a different bin now, but removal matches by subcommand.
    const removed = await removeProjectBusToolHook(root);
    expect(removed.changed).toBe(true);
    expect(collectAllPostToolUseCommands(await readProjectSettingsNoFollow(root))).toEqual([]);
  });
});

describe("T-427 git ignore is authoritative (negation cannot leave a committable hook)", () => {
  it("re-ignores settings.local.json when a wildcard negation had re-included it, then installs", async () => {
    const root = await tempRoot();
    await initGitRepo(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    // `!*.json` after the rule re-includes the file via last-match-wins.
    await writeFile(join(root, ".claude", ".gitignore"), "settings.local.json\n!*.json\n", "utf-8");
    // Precondition: git currently does NOT ignore it.
    await expect(git(root, ["check-ignore", "-q", ".claude/settings.local.json"])).rejects.toBeTruthy();

    const result = await installProjectBusToolHook(root, BIN);
    expect(result.changed).toBe(true);
    // After install, git DOES ignore it again (the guard appended a last-match rule and
    // re-verified via git check-ignore, the sole authority in a worktree).
    await expect(git(root, ["check-ignore", ".claude/settings.local.json"])).resolves.toContain("settings.local.json");
    expect(hasBusToolHook(await readProjectSettingsNoFollow(root), EXPECTED_COMMAND)).toBe(true);
  });
});

describe("T-427 normalization re-homes a wrong-matcher canonical hook", () => {
  it("moves a canonical command sitting under a tool-specific matcher to the all-tools matcher", async () => {
    const root = await tempRoot();
    await initGitRepo(root);
    // The canonical command is present, but under "Bash" -> it would NOT fire after every
    // tool. Install must NOT treat this as an idempotent no-op.
    await writeProjectSettingsNoFollow(root, {
      hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: EXPECTED_COMMAND }] }] },
    });
    const result = await installProjectBusToolHook(root, BIN);
    expect(result.changed).toBe(true);

    const settings = await readProjectSettingsNoFollow(root);
    const groups = (settings.hooks as { PostToolUse: { matcher?: string; hooks: { command?: string }[] }[] }).PostToolUse;
    const matchers = groups
      .filter((g) => g.hooks.some((h) => h.command === EXPECTED_COMMAND))
      .map((g) => g.matcher ?? "");
    // Exactly one lineage entry, now under the all-tools ("") matcher.
    expect(matchers).toEqual([""]);
    expect(collectAllPostToolUseCommands(settings)).toEqual([EXPECTED_COMMAND]);
  });
});

describe("T-427 parent-directory swap defense", () => {
  it("refuses to write when .claude is a symlink to an external directory", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await symlink(outside, claudeDirPath(root));
    await expect(writeProjectSettingsNoFollow(root, { hooks: {} })).rejects.toMatchObject({ code: "corrupt" });
    // Nothing landed in the external directory.
    await expect(readFile(join(outside, "settings.local.json"), "utf-8")).rejects.toBeTruthy();
  });

  it("unlinks the temp file when the write/sync fails, leaving no `.tmp-*` leak", async () => {
    const root = await tempRoot();
    await mkdir(claudeDirPath(root), { recursive: true });
    // Simulate a write/sync failure AFTER the exclusive temp file is opened but BEFORE its
    // content is written, with `.claude` left intact (so the failure alone, not a parent
    // swap, is what must trigger temp cleanup).
    __testing.setAfterTempOpenHook(async () => { throw new Error("simulated fsync failure"); });
    try {
      await expect(writeProjectSettingsNoFollow(root, { hooks: {} })).rejects.toThrow("simulated fsync failure");
    } finally {
      __testing.setAfterTempOpenHook(null);
    }
    // No temp file was leaked, and nothing was committed as the settings file.
    const entries = await readdir(claudeDirPath(root));
    expect(entries.filter((e) => e.startsWith(".tmp-"))).toEqual([]);
    expect(entries).not.toContain("settings.local.json");
  });

  it("aborts if .claude is swapped to a symlink AFTER the temp write, before commit", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await mkdir(claudeDirPath(root), { recursive: true });
    let swapped = false;
    __testing.setAfterTempWriteHook(async () => {
      if (swapped) return;
      swapped = true;
      await rm(claudeDirPath(root), { recursive: true, force: true });
      await symlink(outside, claudeDirPath(root));
    });
    try {
      await expect(writeProjectSettingsNoFollow(root, { hooks: {} })).rejects.toMatchObject({ code: "corrupt" });
    } finally {
      __testing.setAfterTempWriteHook(null);
    }
    // The commit never happened through the swapped-in symlink.
    await expect(readFile(join(outside, "settings.local.json"), "utf-8")).rejects.toBeTruthy();
  });
});

function collectAllPostToolUseCommands(settings: Record<string, unknown>): string[] {
  const groups = (settings.hooks as { PostToolUse?: { hooks?: { command?: string }[] }[] } | undefined)?.PostToolUse ?? [];
  return groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command).filter((c): c is string => typeof c === "string"));
}
