/**
 * T-499: the ONLY sweep entry point for session-intel telemetry. Runs from
 * CLI housekeeping (every non-hook invocation) and never from a hook or a
 * sampler path: the era sweep spawns `ps`, and a hook must stay bounded by
 * construction.
 *
 *   eras     incremental, cursor-scheduled, batched `ps` (era-store.ts).
 *   pending  `session-intel-pending/<base>/` directories whose presence
 *            record is gone (expired by the presence TTL sweep, or the
 *            session ended and its record was cleared): pending FILES older
 *            than the presence TTL are unlinked and the directory is removed
 *            only once it is empty. A live session's pending directory is
 *            never touched: reconciliation owns it.
 *
 * Safety of the pending sweep, in order:
 *   1. Every decision is taken under the session's presence lock (the same
 *      lock reconciliation and the samplers use), with try semantics: a busy
 *      lock skips the directory for this pass.
 *   2. Under the lock the record's absence is re-checked, and the listing is
 *      validated in full BEFORE anything is unlinked: one entry that is not a
 *      regular file, or a listing over the cap, leaves the directory as it
 *      is. Nothing is ever partially cleaned.
 *   3. Only files whose OWN mtime is older than the TTL are unlinked, so an
 *      event published after the listing (publication takes no lock) is
 *      younger than the TTL and survives; the directory is then non-empty
 *      and `rmdir` fails, which is the intended outcome.
 *   4. One work budget for the whole pass: at most `maxOps` filesystem
 *      mutations and an elapsed deadline, shared across directories, so an
 *      accumulated backlog is worked off across invocations rather than in
 *      one.
 *   5. A resumable traversal: the root is STREAMED (opendir/readSync, no
 *      listing materialized, no sort, no stat per entry). A cursor
 *      (`.cursor` in the pending root) names the last directory examined;
 *      the next pass skips the stream up to it (cheap dirent reads, not
 *      budget-checked so a pass always reaches new ground), examines at most
 *      `maxDirs` entries, and wraps to the start when the stream ends or the
 *      cursor's name is gone. Retained directories (live sessions, busy
 *      locks, non-regular content) therefore never starve the ones behind
 *      them, and a pass cut short by the budget still advances. Every dirent
 *      read counts toward ORPHAN_PENDING_MAX_SCAN, the per-pass ceiling on
 *      traversal work (see its note for the limit that implies).
 */

import * as fs from "node:fs";
import { join } from "node:path";
import { acquireLock, atomicWriteInDir, directoryIdentity, presenceDirIfPresent, readBoundedNoFollow, releaseLock, removeRegularFile, telemetrySubdirIfPresent } from "../../presence/io.js";
import { PRESENCE_TTL_MS } from "../../presence/types.js";
import { TRY_LOCK_BUDGET_MS } from "../presence-enrichment.js";
import { sweepEraStore, ERA_SWEEP_BUDGET_MS, type EraSweepOptions, type EraSweepResult } from "./era-store.js";
import { PENDING_SUBDIR } from "./presence-bridge.js";

export const ORPHAN_PENDING_TTL_MS = PRESENCE_TTL_MS;
/** Bound on the directories examined per pass. */
export const ORPHAN_PENDING_MAX_DIRS = 64;
/** Bound on unlinks plus rmdirs per pass, shared across directories. */
export const ORPHAN_PENDING_MAX_OPS = 64;
/** A pending directory listing beyond this is abnormal and is left alone. */
export const ORPHAN_PENDING_MAX_LISTED = 256;
/**
 * Root entries READ per pass, every dirent counted (directories, files,
 * anything), skip phase included. This is the hard per-pass bound on
 * traversal work. Node has no seekable directory read, so reaching entry N
 * of the stream costs N reads on every pass: an entry beyond this cap is
 * reachable only once earlier entries have been removed. The population is
 * self-limiting (orphans are removed by this sweep; retained directories
 * belong to live sessions, which are bounded by real processes), so the cap
 * is sized far above any real root and documents the limit rather than
 * hiding it.
 */
export const ORPHAN_PENDING_MAX_SCAN = 65536;
export const ORPHAN_PENDING_BUDGET_MS = ERA_SWEEP_BUDGET_MS;
const CURSOR_FILE = ".cursor";

export interface OrphanSweepOptions {
  readonly now?: number;
  readonly ttlMs?: number;
  readonly maxDirs?: number;
  readonly maxOps?: number;
  readonly budgetMs?: number;
  /** Test seams: the clock the deadline reads; the per-pass dirent read cap. */
  readonly clock?: () => number;
  readonly maxScan?: number;
}

export interface OrphanSweepResult {
  readonly examined: number;
  readonly filesRemoved: number;
  readonly dirsRemoved: number;
  /** True when the op or time budget stopped the pass early. */
  readonly exhausted: boolean;
  /** The last directory examined, null once the traversal wrapped. */
  readonly cursor: string | null;
}

function readCursor(dir: string): string | null {
  const text = readBoundedNoFollow(join(dir, CURSOR_FILE), 256);
  return text === null ? null : text.trim() || null;
}

function writeCursor(dir: string, identity: { dev: number; ino: number }, value: string | null): void {
  if (value === null) {
    removeRegularFile(dir, join(dir, CURSOR_FILE), identity);
    return;
  }
  atomicWriteInDir(dir, join(dir, CURSOR_FILE), `${value}\n`);
}

export interface TelemetrySweepResult {
  readonly eras: EraSweepResult;
  readonly pending: OrphanSweepResult;
}

/** Enumerates incrementally; null when the listing is abnormal (over the cap, unreadable, or holding a non-regular entry). */
function listRegularEntries(dir: string, cap: number): string[] | null {
  let handle: fs.Dir;
  try {
    handle = fs.opendirSync(dir);
  } catch {
    return null;
  }
  const names: string[] = [];
  try {
    for (;;) {
      const e = handle.readSync();
      if (e === null) break;
      if (!e.isFile()) return null;
      names.push(e.name);
      if (names.length > cap) return null;
    }
  } catch {
    return null;
  } finally {
    try { handle.closeSync(); } catch { /* closed */ }
  }
  return names;
}

interface Budget { ops: number; readonly deadline: number; readonly clock: () => number }

const overBudget = (b: Budget): boolean => b.ops <= 0 || b.clock() > b.deadline;

/**
 * One directory, under the session lock. Returns the mutations performed;
 * `exhausted` when the budget ran out mid-directory (the rest waits for the
 * next pass).
 */
function sweepOneDir(base: string, name: string, presenceDir: string, now: number, ttlMs: number, budget: Budget): { files: number; dir: number; exhausted: boolean } {
  const none = { files: 0, dir: 0, exhausted: false };
  const dir = join(base, name);
  const lockPath = join(presenceDir, `${name}.lock`);
  if (!acquireLock(lockPath, TRY_LOCK_BUDGET_MS)) return none;
  try {
    // Re-checked under the lock: a record that appeared since the pre-check
    // means the session is back and reconciliation owns the directory again.
    if (fs.existsSync(join(presenceDir, `${name}.json`))) return none;
    const identity = directoryIdentity(dir);
    if (identity === null) return none;
    const names = listRegularEntries(dir, ORPHAN_PENDING_MAX_LISTED);
    if (names === null) return none;
    let files = 0;
    for (const n of names) {
      if (overBudget(budget)) return { files, dir: 0, exhausted: true };
      const path = join(dir, n);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(path);
      } catch {
        continue;
      }
      if (!st.isFile() || now - st.mtimeMs <= ttlMs) continue;
      budget.ops -= 1;
      if (removeRegularFile(dir, path, identity)) files += 1;
    }
    if (overBudget(budget)) return { files, dir: 0, exhausted: true };
    budget.ops -= 1;
    try {
      fs.rmdirSync(dir); // fails when a newer file was published meanwhile: intended
      return { files, dir: 1, exhausted: false };
    } catch {
      return { files, dir: 0, exhausted: false };
    }
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Removes pending directories that no longer belong to any presence record.
 * The presence directory must exist for a lock to be taken; without one
 * there was never a session here and nothing is touched.
 */
export function sweepOrphanPendingDirs(root: string, options: OrphanSweepOptions = {}): OrphanSweepResult {
  const zero: OrphanSweepResult = { examined: 0, filesRemoved: 0, dirsRemoved: 0, exhausted: false, cursor: null };
  const base = telemetrySubdirIfPresent(root, PENDING_SUBDIR);
  const presenceDir = presenceDirIfPresent(root);
  if (!base || !presenceDir) return zero;
  const baseIdentity = directoryIdentity(base);
  if (baseIdentity === null) return zero;
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? ORPHAN_PENDING_TTL_MS;
  const maxDirs = options.maxDirs ?? ORPHAN_PENDING_MAX_DIRS;
  const clock = options.clock ?? Date.now;
  const budget: Budget = { ops: options.maxOps ?? ORPHAN_PENDING_MAX_OPS, deadline: clock() + (options.budgetMs ?? ORPHAN_PENDING_BUDGET_MS), clock };
  const maxScan = options.maxScan ?? ORPHAN_PENDING_MAX_SCAN;
  const cursor = readCursor(base);

  let examined = 0;
  let filesRemoved = 0;
  let dirsRemoved = 0;
  let exhausted = false;
  let scanned = 0;
  let last: string | null = null;
  let reachedEnd = false;

  /**
   * One streamed walk. `skipTo` non-null: read past that name first (it was
   * the last examined); reaching the end without meeting it means the name
   * is gone, and the walk reports `cursorLost` so the caller restarts once.
   */
  const walk = (skipTo: string | null): "done" | "cursorLost" => {
    let handle: fs.Dir;
    try {
      handle = fs.opendirSync(base);
    } catch {
      return "done";
    }
    let skipping = skipTo !== null;
    try {
      for (;;) {
        if (examined >= maxDirs) return "done";
        if (!skipping && overBudget(budget)) { exhausted = true; return "done"; }
        if (scanned >= maxScan) { exhausted = true; return "done"; }
        const e = handle.readSync();
        if (e === null) {
          if (skipping) return "cursorLost";
          reachedEnd = true;
          return "done";
        }
        scanned += 1; // every dirent counts, whatever its type
        if (!e.isDirectory()) continue;
        if (skipping) {
          if (e.name === skipTo) skipping = false;
          continue;
        }
        examined += 1;
        const prev = last;
        last = e.name;
        // Pre-check outside the lock (cheap, avoids a lock per live session);
        // the decision itself is re-taken under the lock in sweepOneDir.
        if (fs.existsSync(join(presenceDir, `${e.name}.json`))) continue;
        const r = sweepOneDir(base, e.name, presenceDir, now, ttlMs, budget);
        filesRemoved += r.files;
        dirsRemoved += r.dir;
        if (r.exhausted) {
          // Cut short inside this directory: the cursor stays BEFORE it so
          // the next pass retries it rather than skipping its remainder.
          last = prev;
          exhausted = true;
          return "done";
        }
      }
    } catch {
      return "done";
    } finally {
      try { handle.closeSync(); } catch { /* closed */ }
    }
  };

  if (walk(cursor) === "cursorLost") walk(null);
  // Reached the natural end while examining: clear the cursor so the next
  // pass starts over. Otherwise it resumes after the last examined name.
  const next = reachedEnd || last === null ? null : last;
  writeCursor(base, baseIdentity, next);
  return { examined, filesRemoved, dirsRemoved, exhausted, cursor: next };
}

export function sweepSessionIntelTelemetry(root: string, options: EraSweepOptions & OrphanSweepOptions = {}): TelemetrySweepResult {
  const eras = sweepEraStore(root, options);
  const pending = sweepOrphanPendingDirs(root, options);
  return { eras, pending };
}
