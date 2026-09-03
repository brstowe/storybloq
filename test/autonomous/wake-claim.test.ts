import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  writeWakeClaim,
  clearWakeClaim,
  readWakeClaim,
  wakeClaimPath,
} from "../../src/autonomous/wake-claim.js";
import { telemetryDirPath } from "../../src/autonomous/liveness.js";

// getuid is POSIX-only; the 0700 permission assertion only holds where mode
// bits are meaningful.
const POSIX = typeof process.getuid === "function";

describe("wake-claim write/clear", () => {
  let base: string;
  let globalDir: string;
  let sessDir: string;
  let savedGlobal: string | undefined;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "sb-wake-claim-"));
    globalDir = join(base, "global");
    sessDir = join(base, "workspace", ".story", "sessions", "sess-uuid-1");
    mkdirSync(sessDir, { recursive: true });
    savedGlobal = process.env.STORYBLOQ_GLOBAL_DIR;
    process.env.STORYBLOQ_GLOBAL_DIR = globalDir;
  });

  afterEach(() => {
    if (savedGlobal === undefined) delete process.env.STORYBLOQ_GLOBAL_DIR;
    else process.env.STORYBLOQ_GLOBAL_DIR = savedGlobal;
    rmSync(base, { recursive: true, force: true });
  });

  it("round-trips a claim through the trusted global dir", () => {
    const claim = { attemptId: "at-1", token: "tok-1", generation: 1, childPid: 4_242, createdAt: Date.now() };
    expect(writeWakeClaim(sessDir, claim)).toBe(true);
    // The claim lives under the global dir keyed by session UUID, NOT in the
    // user's workspace.
    expect(wakeClaimPath(sessDir).startsWith(globalDir)).toBe(true);
    expect(existsSync(wakeClaimPath(sessDir))).toBe(true);
    expect(readWakeClaim(sessDir)).toEqual(claim);

    clearWakeClaim(sessDir);
    expect(existsSync(wakeClaimPath(sessDir))).toBe(false);
    expect(readWakeClaim(sessDir)).toBeNull();
  });

  it("writes NOTHING into the workspace session tree (immune to a symlinked telemetry dir)", () => {
    // Even if an attacker swaps the workspace telemetry leaf for a symlink out
    // of the tree, the claim never touches it: claims live in the global dir.
    const outside = join(base, "outside");
    mkdirSync(outside, { recursive: true });
    if (POSIX) symlinkSync(outside, telemetryDirPath(sessDir));

    expect(writeWakeClaim(sessDir, { attemptId: "x", token: "y", generation: 1, childPid: null, createdAt: Date.now() })).toBe(true);
    // The workspace symlink target is untouched...
    expect(readdirSync(outside)).toHaveLength(0);
    // ...and the claim landed in the global dir.
    expect(wakeClaimPath(sessDir).startsWith(globalDir)).toBe(true);
    expect(existsSync(wakeClaimPath(sessDir))).toBe(true);
  });

  it("distinct sessions get distinct claim files (keyed by session UUID)", () => {
    const otherSess = join(base, "workspace", ".story", "sessions", "sess-uuid-2");
    mkdirSync(otherSess, { recursive: true });
    writeWakeClaim(sessDir, { attemptId: "a1", token: "t1", generation: 1, childPid: 1, createdAt: Date.now() });
    writeWakeClaim(otherSess, { attemptId: "a2", token: "t2", generation: 1, childPid: 2, createdAt: Date.now() });
    expect(wakeClaimPath(sessDir)).not.toBe(wakeClaimPath(otherSess));
    expect(readWakeClaim(sessDir)?.attemptId).toBe("a1");
    expect(readWakeClaim(otherSess)?.attemptId).toBe("a2");
  });

  it("creates the claim dir with 0700 permissions on write", () => {
    if (!POSIX) return;
    writeWakeClaim(sessDir, { attemptId: "a", token: "b", generation: 1, childPid: null, createdAt: Date.now() });
    const mode = statSync(dirname(wakeClaimPath(sessDir))).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});
