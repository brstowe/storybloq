/**
 * ISS-1220 half 2: the config tripwire. Exercised against synthetic config
 * paths -- never the real repository's, which these tests only read.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  compareConfig,
  resolveGitCommonDir,
  snapshotConfigAt,
  snapshotProductionConfig,
} from "./git-config-tripwire.js";

const PKG_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

describe("ISS-1220 resolveGitCommonDir", () => {
  it("returns an ABSOLUTE path even though bare rev-parse returns a relative one", () => {
    // The bug this guards: `git rev-parse --git-common-dir` prints ".git" from
    // a main worktree, which a reader would then resolve against its own cwd.
    const raw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: PKG_ROOT,
      encoding: "utf-8",
    }).trim();
    expect(isAbsolute(raw)).toBe(false); // documents the trap

    const resolved = resolveGitCommonDir(PKG_ROOT);
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(".git")).toBe(true);
  });

  it("resolves the same common dir from a nested directory", () => {
    expect(resolveGitCommonDir(join(PKG_ROOT, "test"))).toBe(resolveGitCommonDir(PKG_ROOT));
  });
});

describe("ISS-1220 compareConfig", () => {
  function syntheticConfig(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "iss1220-tripwire-"));
    const path = join(dir, "config");
    writeFileSync(path, body, "utf-8");
    return path;
  }

  it("passes when the bytes are identical", () => {
    const path = syntheticConfig("[core]\n\tbare = false\n");
    const before = snapshotConfigAt(path);
    expect(compareConfig(before, "unit")).toBeNull();
  });

  it("fails with a diff naming exactly what changed", () => {
    const path = syntheticConfig("[core]\n\tbare = false\n");
    const before = snapshotConfigAt(path);

    // The incident's own shape.
    writeFileSync(path, "[core]\n\tbare = true\n[user]\n\temail = t@t.t\n\tname = t\n", "utf-8");

    const failure = compareConfig(before, "unit");
    expect(failure).not.toBeNull();
    expect(failure).toContain("bare = true");
    expect(failure).toContain("t@t.t");
    expect(failure).toContain(before.sha256);
    // The concurrent-write possibility must be named so a reader rules it out
    // before concluding the suite has an isolation gap.
    expect(failure).toContain("worktree add");
  });

  it("treats a deleted config as a change rather than as 'nothing to compare'", () => {
    const path = syntheticConfig("[core]\n\tbare = false\n");
    const before = snapshotConfigAt(path);
    writeFileSync(path, "", "utf-8");
    expect(compareConfig(before, "unit")).not.toBeNull();
  });
});

describe("ISS-1220 self-heal baseline", () => {
  it("snapshotProductionConfig works with no persisted snapshot present", () => {
    // test/setup.ts falls back to this when globalSetup's file is absent, so a
    // run can never silently lose its tripwire.
    const snapshot = snapshotProductionConfig(PKG_ROOT);
    expect(isAbsolute(snapshot.path)).toBe(true);
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.path.endsWith(join(".git", "config"))).toBe(true);
  });

  it("degrades rather than throwing outside a git repository", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "iss1220-norepo-"));
    mkdirSync(join(notARepo, "sub"), { recursive: true });
    // Outside any repository git exits non-zero; the caller in setup.ts wraps
    // this in try/catch and yields a null baseline.
    expect(() => resolveGitCommonDir(join(notARepo, "sub"))).toThrow();
  });
});
