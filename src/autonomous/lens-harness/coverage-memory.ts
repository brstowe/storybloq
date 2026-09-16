/**
 * ISS-950: the cross-call coverage memory, per reviewId.
 *
 * The lens server decides a skip's basis within ONE review session. This
 * harness calls `runMergerPipeline` once per synthesize, and two synthesize
 * calls for the same review are two separate calls the server never sees
 * together. Two facts therefore have no owner but this side:
 *
 *  - THE DOWNGRADE-ONLY RULE. A basis is trusted downward only. Once a lens
 *    has skipped on a change the server judged applicable, a later call cannot
 *    raise that skip to `not-applicable` by presenting a narrower diff. The
 *    server cannot enforce it because it has no record of the earlier call.
 *  - THE RELABEL (acceptance 5). The field harm is a lens that skips, pays the
 *    cap, and is resubmitted as `ok` with zero findings in the NEXT synthesize:
 *    the same analysis under a different label. The server's own relabel rule
 *    is scoped to one dispatch, so it is blind to this shape by construction.
 *
 * Both need memory that survives the process, because a synthesize call is a
 * single MCP tool invocation and the next one may run in a different process
 * entirely. It lives in the session TELEMETRY directory beside the other
 * per-session review records, and every read and write is best-effort: losing
 * it degrades to the pre-ISS-950 behaviour (a basis computed fresh, no relabel
 * flag), which is a weaker check, never a wrong one.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import type { LensCoverageBasis, LensCoverageEntry } from "@storybloq/lenses";
import { telemetryDirPath } from "../liveness.js";

const MEMORY_FILE = "lens-coverage-memory.json";

/**
 * Matches `withTelemLock` in telemetry-writer.ts, which locks this same
 * directory, so the two writers interlock rather than each guarding half of it.
 *
 * It is not a call to that helper for one reason: the retry below. A lost write
 * here is not a lost telemetry line, it is a RESTRICTION that silently stops
 * applying, so a call that finds the lock held should wait rather than give up
 * on the first attempt.
 */
const LOCK_OPTIONS = { stale: 10_000 };

/**
 * proper-lockfile REFUSES `retries` on the sync API (`toSyncOptions` throws
 * `ESYNC`, since backing off requires an async flow), so the retry is a bounded
 * loop here rather than an option passed down.
 *
 * Four retries at 10ms is at most 40ms of blocking, and only under real
 * contention: two synthesize calls for one session finishing within the same
 * few milliseconds. The write it protects is a single small JSON file.
 */
const LOCK_RETRIES = 4;
const LOCK_RETRY_MS = 10;

/**
 * The PER-REVIEW lock's budget, which is deliberately far larger than the
 * shared file's.
 *
 * This one is held across a whole synthesize (the read, the pipeline, the
 * persist), so a contending call is waiting for real work rather than for a
 * small JSON write, and giving up early would degrade rounds that only needed
 * to queue. 1.2s covers an ordinary synthesize; past it the caller degrades,
 * which is safe by construction (see `acquireReviewCoverageLock`).
 */
const REVIEW_LOCK_RETRIES = 30;
const REVIEW_LOCK_RETRY_MS = 40;

/**
 * Test seam. A contender has to wait out the whole budget to reach the refusal
 * branch, and 1.2s per test case buys nothing a few milliseconds does not.
 *
 * Read per call rather than at module load so a test can set it after import,
 * and clamped so a stray value in a real environment cannot turn the wait into
 * either zero (every contender refused on the first collision) or minutes.
 */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function reviewLockRetries(): number {
  return envInt("STORYBLOQ_REVIEW_LOCK_RETRIES", REVIEW_LOCK_RETRIES, 1, 1000);
}

function reviewLockRetryMs(): number {
  return envInt("STORYBLOQ_REVIEW_LOCK_RETRY_MS", REVIEW_LOCK_RETRY_MS, 1, 1000);
}

/**
 * Thrown when a synthesize call cannot take its review's lock.
 *
 * ITS OWN TYPE, because the caller has to be able to tell this apart from a
 * malformed payload: this one is retryable as-is and nothing about the request
 * was wrong. The message is the whole remedy, so it names the review and says
 * the retry is the SAME call rather than a corrected one.
 */
export class ReviewCoverageLockUnavailableError extends Error {
  readonly reviewId: string;

  constructor(reviewId: string) {
    super(
      `another synthesize call for reviewId ${reviewId} holds the review lock, so this round was ` +
        `not run: no verdict was computed and nothing was recorded. Retry this same call once the ` +
        `other call finishes.`,
    );
    this.name = "ReviewCoverageLockUnavailableError";
    this.reviewId = reviewId;
  }
}

/** A synchronous wait. `updateCoverageMemory` is called from a sync tool path. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // No SharedArrayBuffer in this environment: retry immediately instead. The
    // retry is an optimization, never a correctness requirement.
  }
}

/**
 * Run `fn` holding the telemetry directory lock, or not at all.
 *
 * Returns without calling `fn` when the lock cannot be taken, which keeps the
 * whole mechanism best-effort: an unwritten record costs the NEXT call its
 * cross-call checks, and a weaker check is always preferable to a wrong one.
 */
function withCoverageLock(sessionDir: string, fn: () => void): void {
  const tDir = telemetryDirPath(sessionDir);
  let release: (() => void) | undefined;
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt += 1) {
    try {
      // INSIDE the guarded region, as withTelemLock does it: an unmakeable
      // directory is the same fact as an untakeable lock.
      mkdirSync(tDir, { recursive: true });
      release = lockfile.lockSync(tDir, LOCK_OPTIONS);
      break;
    } catch {
      if (attempt === LOCK_RETRIES) return;
      sleepSync(LOCK_RETRY_MS);
    }
  }
  if (!release) return;
  try {
    fn();
  } finally {
    try {
      release();
    } catch {
      /* ignore unlock errors */
    }
  }
}

/**
 * Replace the memory file in one step.
 *
 * A partial write to the target itself is worse than no write: the file reads
 * back as unparseable, `readMemoryFile` answers `{}`, and every restriction the
 * file held is released at once. Writing a sibling temp file and renaming over
 * the target makes a failed write leave the previous content exactly as it was.
 * The temp file is in the SAME directory so the rename stays within one
 * filesystem and is therefore atomic.
 */
function replaceMemoryFile(sessionDir: string, file: MemoryFile): void {
  const target = coverageMemoryPath(sessionDir);
  const temp = `${target}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(file, null, 2));
    renameSync(temp, target);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
}

/** What an earlier synthesize established about one lens in one review. */
export interface LensCoverageRecord {
  /** This lens has submitted `skipped` at least once in this review. */
  readonly everSkipped: boolean;
  /** The basis the VERDICT carried, after the server confirmed or demoted it. */
  readonly basis?: LensCoverageBasis;
}

/** lensId -> what is known about it. */
export type LensCoverageMemory = Readonly<Record<string, LensCoverageRecord>>;

/** reviewId -> that review's lens records. The on-disk shape. */
type MemoryFile = Record<string, Record<string, LensCoverageRecord>>;

export function coverageMemoryPath(sessionDir: string): string {
  return join(telemetryDirPath(sessionDir), MEMORY_FILE);
}

/**
 * The lock path for ONE review.
 *
 * A `reviewId` is caller-supplied text and must never reach the filesystem as a
 * path: `../../x` would put a lock outside the session, and on a
 * case-insensitive filesystem two ids could collide silently. Everything
 * outside a conservative character set is replaced, the result is truncated,
 * and a digest of the ORIGINAL id is appended, so sanitizing can never merge
 * two distinct reviews onto one lock while the readable part still says which
 * review it belongs to.
 */
function reviewLockPath(sessionDir: string, reviewId: string): string {
  const safe = reviewId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48);
  const digest = createHash("sha256").update(reviewId).digest("hex").slice(0, 12);
  return join(telemetryDirPath(sessionDir), `lens-coverage-${safe}-${digest}.lock`);
}

/**
 * The outcome of asking for a review's lock.
 *
 * Three values, not a nullable one, because "there was nothing to lock" and
 * "someone else has it" call for opposite behaviour and a single `null` cannot
 * tell them apart. A sessionless synthesize has no memory to race over and
 * proceeds exactly as before; a contended one must NOT.
 */
export type ReviewCoverageLock =
  | { readonly kind: "held"; readonly release: () => void }
  | { readonly kind: "not-needed" }
  | { readonly kind: "unavailable" };

/**
 * Hold one review's coverage decisions against every other call for that review.
 *
 * WHY THE PERSIST LOCK IS NOT ENOUGH. `updateCoverageMemory` merges under the
 * shared file's lock, so the PERSISTED memory always carries the strictest
 * basis any call established. That is the wrong guarantee on its own, because a
 * verdict is returned before it is persisted. Two calls for one review can both
 * read unrestricted memory; A persists `self-reported`; B, still holding the
 * snapshot it read before A wrote, RETURNS `not-applicable`. B's own merge then
 * keeps A's restriction on disk and the ledger looks consistent, while the
 * round B answered has already cleared a cap it owed. The same window loses a
 * relabel: B cannot see the skip A recorded, so a flip to `ok` with zero
 * findings passes unflagged. Downgrade-only has to hold for what a call
 * RETURNS, which means the read, the pipeline and the persist are one critical
 * section.
 *
 * KEYED ON THE REVIEW, not on the session or the file. Two unrelated reviews in
 * one session share no decision and must not queue behind each other; the
 * shared-file lock inside `updateCoverageMemory` still serializes the write
 * itself, which is the only thing they do share.
 *
 * UNAVAILABLE MEANS RUN NOTHING AND PERSIST NOTHING. An earlier revision ran
 * the round anyway with every skip forced to `self-reported`, on the reasoning
 * that a stricter verdict can never be an escaped one. That reasoning was about
 * the CONTENDER's verdict and the guarantee is about the HOLDER's: a contender
 * that completes still writes through the persist lock, and that write changes
 * what the holder reads on its next round, while the holder -- which read before
 * the write -- can still return the `not-applicable` this whole mechanism
 * exists to refuse. The persist lock protects the file, not a verdict.
 *
 * So the caller refuses: `handleSynthesize` throws
 * `ReviewCoverageLockUnavailableError` and the agent retries the identical call
 * once the holder finishes.
 */
export function acquireReviewCoverageLock(
  sessionDir: string | undefined,
  reviewId: string,
): ReviewCoverageLock {
  if (!sessionDir) return { kind: "not-needed" };
  const tDir = telemetryDirPath(sessionDir);
  const target = reviewLockPath(sessionDir, reviewId);
  const retries = reviewLockRetries();
  const retryMs = reviewLockRetryMs();
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      mkdirSync(tDir, { recursive: true });
      const release = lockfile.lockSync(target, {
        ...LOCK_OPTIONS,
        // The target is a name, not a file we keep: `realpath` would demand it
        // exist, and creating a sentinel only to resolve it buys nothing.
        realpath: false,
      });
      return {
        kind: "held",
        release: () => {
          try {
            release();
          } catch {
            /* ignore unlock errors */
          }
        },
      };
    } catch {
      if (attempt === retries) return { kind: "unavailable" };
      sleepSync(retryMs);
    }
  }
  return { kind: "unavailable" };
}

function readMemoryFile(sessionDir: string): MemoryFile {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(coverageMemoryPath(sessionDir), "utf-8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as MemoryFile;
  } catch {
    return {};
  }
}

/**
 * What earlier calls recorded for this review. Empty for a first call, for a
 * sessionless synthesize, and for an unreadable file -- all three are the same
 * statement: nothing is known, so nothing is held against this round.
 *
 * TAKES NO LOCK OF ITS OWN, and does not need one: the CALLER holds this
 * review's lock across the read, the pipeline and the persist. That is what
 * closes the window an earlier revision left open, where two calls both read
 * unrestricted memory and the second RETURNED a `not-applicable` the first had
 * already ruled out (see `acquireReviewCoverageLock` for the full sequence).
 *
 * The critical section has to span all three steps, because a verdict is
 * returned before it is persisted: a lock around this read alone would be
 * released before the answer it informs is computed, and would guarantee
 * nothing about that answer. `handleSynthesize` is the one caller and takes the
 * lock before calling this; a caller that could not take it must not read the
 * memory and act on it at all.
 */
export function readCoverageMemory(
  sessionDir: string | undefined,
  reviewId: string,
): LensCoverageMemory {
  if (!sessionDir) return {};
  const forReview = readMemoryFile(sessionDir)[reviewId];
  if (!forReview || typeof forReview !== "object") return {};
  return forReview;
}

/**
 * Fold this round's coverage into the memory for this review.
 *
 * `everSkipped` only ever accumulates: a lens that skipped once has skipped,
 * whatever it submits afterwards, and that is precisely what makes a later
 * zero-finding `ok` readable as a relabel.
 *
 * SELF-REPORTED IS STICKY, and it has to be rather than merely being the basis
 * of the latest round. The recorded basis is a RESTRICTION, not a status, and
 * the latest round is not always the strictest one. The sequence that showed it:
 * a lens skips on an applicable change (`self-reported`), then a round goes by
 * where it submits nothing at all (`no-submission`), then it skips again on a
 * narrower diff. Written last-wins, round two replaces the restriction with
 * `no-submission`, round three no longer sees a self-reported skip to be held
 * to, and the raise round one was supposed to make impossible happens anyway.
 *
 * Every other basis still takes the latest value, and `not-applicable` is the
 * one the stickiness exists to refuse: nothing a later round observes can
 * un-skip a lens that already skipped when it mattered.
 *
 * The recorded basis is the one the VERDICT carried, not the one this harness
 * proposed, so a basis the server demoted is what a later call is held to.
 *
 * READ-MODIFY-WRITE UNDER THE LOCK. The file is shared by every synthesize call
 * in the session, so the current content is re-read INSIDE the lock rather than
 * carried in from a read taken earlier: a peer that established a restriction
 * while this call was computing its round must not be overwritten by it. The
 * write itself goes to a temp file and is renamed over the target, so a failure
 * part way through leaves the previous content intact instead of releasing
 * every restriction the file held.
 *
 * Other reviews' records in the same file are preserved: one session runs many
 * reviews and a write must not be a truncation.
 */
export function updateCoverageMemory(
  sessionDir: string | undefined,
  reviewId: string,
  coverage: readonly LensCoverageEntry[],
): void {
  if (!sessionDir) return;
  withCoverageLock(sessionDir, () => {
    try {
      const file = readMemoryFile(sessionDir);
      const prior = file[reviewId] ?? {};
      const next: Record<string, LensCoverageRecord> = { ...prior };
      for (const entry of coverage) {
        const before = prior[entry.lensId];
        const everSkipped = before?.everSkipped === true || entry.status === "skipped";
        const basis = before?.basis === "self-reported"
          ? "self-reported"
          : entry.basis ?? before?.basis;
        next[entry.lensId] = {
          everSkipped,
          ...(basis === undefined ? {} : { basis }),
        };
      }
      file[reviewId] = next;
      replaceMemoryFile(sessionDir, file);
    } catch {
      // Best effort. A lost write costs the next call its cross-call checks; it
      // can never produce a WRONG verdict, only a less suspicious one.
    }
  });
}
