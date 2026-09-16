/**
 * ISS-950 gate round: the coverage memory is a SHARED file, and two synthesize
 * calls in one session can reach it at once.
 *
 * The record it holds is a restriction: once a lens has skipped on a change the
 * server judged applicable, no later call may raise that skip. A read-modify-
 * write that merges from a copy read before the lock, or that writes the target
 * in place, can drop that restriction -- and dropping it is not a lost
 * telemetry line, it is an approve the ledger should not have reached.
 *
 * Both tests drive `updateCoverageMemory` directly, because what they pin is
 * the ORDER of its own steps, which is invisible from `handleSynthesize`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** Fired at lock acquisition, standing in for a peer process's write. */
let onLockAcquired: (() => void) | null = null;
/** Armed to make the next writeFileSync write PART of its payload, then throw. */
let failNextWriteAfterPartial = false;

vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import("proper-lockfile") }>();
  const real = (actual as unknown as Record<string, unknown>).default ?? actual;
  const mod = real as typeof import("proper-lockfile");
  return {
    default: {
      ...mod,
      lockSync: ((path: string, opts?: unknown) => {
        // BEFORE the real acquisition, so a peer's write lands in the window an
        // implementation that reads before locking would have already passed.
        const cb = onLockAcquired;
        onLockAcquired = null;
        cb?.();
        return (mod.lockSync as (p: string, o?: unknown) => () => void)(path, opts);
      }) as typeof mod.lockSync,
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeFileSync = ((path: never, data: never, options?: never) => {
    if (failNextWriteAfterPartial) {
      failNextWriteAfterPartial = false;
      // A half-written payload, then a failure: the shape a full disk or a
      // killed process leaves behind.
      const text = typeof data === "string" ? data : String(data);
      actual.writeFileSync(path, text.slice(0, Math.max(1, Math.floor(text.length / 2))));
      throw Object.assign(new Error("ENOSPC: simulated"), { code: "ENOSPC" });
    }
    return actual.writeFileSync(path, data, options);
  }) as typeof actual.writeFileSync;
  return { ...actual, default: { ...actual, writeFileSync }, writeFileSync };
});

const { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync } =
  await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { coverageMemoryPath, readCoverageMemory, updateCoverageMemory } =
  await import("../../../src/autonomous/lens-harness/coverage-memory.js");

const REVIEW = "lens-cov-race";
const LENS = "error-handling";

/** The restriction a peer call established: this lens skipped when it mattered. */
const PEER_FILE = {
  [REVIEW]: { [LENS]: { everSkipped: true, basis: "self-reported" } },
};

/** What OUR call computed, having read the memory before the peer wrote it. */
const OUR_ROUND = [
  { lensId: LENS, status: "skipped" as const, attempts: 1, contributedFindings: 0, basis: "not-applicable" as const },
];

let root: string;
let sessionDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lens-cov-race-"));
  sessionDir = join(root, ".story", "sessions", "sess-1");
  mkdirSync(join(sessionDir, "telemetry"), { recursive: true });
  onLockAcquired = null;
  failNextWriteAfterPartial = false;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  onLockAcquired = null;
  failNextWriteAfterPartial = false;
});

describe("updateCoverageMemory merges under the lock (ISS-950)", () => {
  it("M-NO-REREAD: a peer write landing before the lock is merged, not overwritten", () => {
    // Nothing on disk when our call started, which is why our round proposed
    // `not-applicable`. The peer's write lands while we are acquiring the lock.
    onLockAcquired = () => {
      writeFileSync(coverageMemoryPath(sessionDir), JSON.stringify(PEER_FILE));
    };

    updateCoverageMemory(sessionDir, REVIEW, OUR_ROUND);

    // The restriction survives. Merging from a prior read before the lock would
    // have replaced it with our own stale `not-applicable`.
    expect(readCoverageMemory(sessionDir, REVIEW)[LENS]).toEqual({
      everSkipped: true,
      basis: "self-reported",
    });
  });

  it("other reviews in the same file are preserved across the merge", () => {
    onLockAcquired = () => {
      writeFileSync(
        coverageMemoryPath(sessionDir),
        JSON.stringify({ ...PEER_FILE, "other-review": { security: { everSkipped: true } } }),
      );
    };

    updateCoverageMemory(sessionDir, REVIEW, OUR_ROUND);

    expect(readCoverageMemory(sessionDir, "other-review").security).toEqual({
      everSkipped: true,
    });
  });
});

describe("updateCoverageMemory writes atomically (ISS-950)", () => {
  it("M-NO-RENAME: a write that fails part way leaves the previous file intact", () => {
    writeFileSync(coverageMemoryPath(sessionDir), JSON.stringify(PEER_FILE));
    failNextWriteAfterPartial = true;

    // Best effort: the failure is swallowed, never thrown at the review.
    expect(() => updateCoverageMemory(sessionDir, REVIEW, OUR_ROUND)).not.toThrow();

    // The established restriction is still readable. Written in place, the
    // target would hold half a JSON document and read back as nothing known,
    // which silently releases the restriction.
    expect(readCoverageMemory(sessionDir, REVIEW)[LENS]).toEqual({
      everSkipped: true,
      basis: "self-reported",
    });
  });

  it("leaves no temp file behind on a successful write", () => {
    updateCoverageMemory(sessionDir, REVIEW, OUR_ROUND);

    const left = readdirSync(join(sessionDir, "telemetry"))
      .filter((f) => f !== "lens-coverage-memory.json" && !f.endsWith(".lock"));
    expect(left).toEqual([]);
    expect(existsSync(coverageMemoryPath(sessionDir))).toBe(true);
  });

  it("a sessionless call writes nothing and does not throw", () => {
    expect(() => updateCoverageMemory(undefined, REVIEW, OUR_ROUND)).not.toThrow();
  });
});
