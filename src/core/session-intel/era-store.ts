/**
 * T-499: the era capture store, `.story/telemetry/session-intel-eras/<pid>-<epoch>.json`.
 *
 * Process captures live OUTSIDE presence records so they survive SessionEnd
 * and `/clear` without depending on hook order: `/clear` gives the same
 * process a new session id, and the new session's presence record copies the
 * capture from here, original `captureKind` and `capturedAt` intact. First
 * writer wins for an era (O_EXCL); the presence record's copy is a cache and
 * this file is authoritative.
 *
 * Expiry never touches a verified live era. The sweep runs ONLY from
 * housekeeping and setup (never a hook or a sampler), is incremental under a
 * cursor so no entry can starve another, and verifies a batch with one `ps`.
 */

import * as fs from "node:fs";
import { join } from "node:path";
import {
  acquireLock,
  atomicWriteInDir,
  directoryIdentity,
  ensureTelemetrySubdir,
  readBoundedNoFollow,
  releaseLock,
  removeRegularFile,
  telemetrySubdirIfPresent,
} from "../../presence/io.js";
import type { CaptureKind } from "../../presence/session-intel-fields.js";
import { checkEra, parseEraId, probeStarts, type ProcessCheck, type PsRunner, defaultPsRunner } from "./process-era.js";

export const ERA_STORE_SUBDIR = "session-intel-eras";
export const MAX_ERA_ENTRY_BYTES = 4096;
export const MAX_ERA_SESSION_IDS = 20;
/** Closed eras expire this long after `endedAt`. */
export const ERA_ENDED_TTL_MS = 24 * 60 * 60 * 1000;
/** Eras whose last three sweeps were unverifiable expire this long after `lastVerifiedAt`. */
export const ERA_UNVERIFIABLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ERA_UNVERIFIABLE_STREAK = 3;
/** `lastVerifiedAt` is rewritten at most this often for a live entry. */
export const ERA_VERIFY_REWRITE_MS = 60 * 60 * 1000;
export const ERA_SWEEP_MAX_ENTRIES = 25;
export const ERA_SWEEP_BUDGET_MS = 1000;
const LOCK_BUDGET_MS = 300;
const CURSOR_FILE = ".cursor";

export interface EraEntry {
  readonly era: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly captureKind: CaptureKind;
  readonly autoCompactWindowAtStart: number | null;
  readonly autoCompactWindowSource: "local" | "project" | "user" | null;
  readonly capturedAt: string;
  readonly endedAt: string | null;
  readonly lastVerifiedAt: string;
  readonly unverifiableStreak: number;
  readonly sessionIds: readonly string[];
}

const CAPTURE_KINDS = new Set(["startup", "late", "absent"]);
const WINDOW_SOURCES = new Set(["local", "project", "user"]);

export function eraFileBase(eraId: string): string | null {
  const parsed = parseEraId(eraId);
  return parsed ? `${parsed.pid}-${parsed.startedSeconds}` : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

export function parseEraEntry(text: string): EraEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.era !== "string" || !parseEraId(r.era)) return null;
  const parsedId = parseEraId(r.era)!;
  const capturedAt = isoOrNull(r.capturedAt);
  const startedAt = isoOrNull(r.startedAt);
  if (!capturedAt || !startedAt) return null;
  const sessionIds: string[] = [];
  if (Array.isArray(r.sessionIds)) {
    for (const id of r.sessionIds) {
      if (typeof id === "string" && id.length > 0 && id.length <= 128 && !sessionIds.includes(id)) sessionIds.push(id);
      if (sessionIds.length >= MAX_ERA_SESSION_IDS) break;
    }
  }
  const window = r.autoCompactWindowAtStart;
  return {
    era: r.era,
    pid: parsedId.pid,
    startedAt,
    captureKind: typeof r.captureKind === "string" && CAPTURE_KINDS.has(r.captureKind) ? (r.captureKind as CaptureKind) : "absent",
    autoCompactWindowAtStart: typeof window === "number" && Number.isSafeInteger(window) && window > 0 ? window : null,
    autoCompactWindowSource:
      typeof r.autoCompactWindowSource === "string" && WINDOW_SOURCES.has(r.autoCompactWindowSource)
        ? (r.autoCompactWindowSource as EraEntry["autoCompactWindowSource"])
        : null,
    capturedAt,
    endedAt: isoOrNull(r.endedAt),
    lastVerifiedAt: isoOrNull(r.lastVerifiedAt) ?? capturedAt,
    unverifiableStreak: typeof r.unverifiableStreak === "number" && Number.isSafeInteger(r.unverifiableStreak) && r.unverifiableStreak >= 0 ? r.unverifiableStreak : 0,
    sessionIds,
  };
}

/** The store directory, validated at every level, without creating anything. */
export function eraStoreDirIfPresent(root: string): string | null {
  return telemetrySubdirIfPresent(root, ERA_STORE_SUBDIR);
}

export function readEra(root: string, eraId: string): EraEntry | null {
  const dir = eraStoreDirIfPresent(root);
  const base = eraFileBase(eraId);
  if (!dir || !base) return null;
  const text = readBoundedNoFollow(join(dir, `${base}.json`), MAX_ERA_ENTRY_BYTES);
  if (text === null) return null;
  const entry = parseEraEntry(text);
  return entry && entry.era === eraId ? entry : null;
}

export type EraWriteOutcome = "created" | "exists" | "failed";

/**
 * First writer wins, published atomically: the complete entry is written and
 * fsynced to a `.tmp-*` name in the same directory, then `link`ed to the
 * final name (no-replace: EEXIST means another writer won), then the tmp is
 * unlinked. The final name therefore never exposes partial JSON, a writer
 * that dies mid-write leaves no final file (so a retry can still create), and
 * the sweep, which ignores non-`.json` names, cannot delete a capture that
 * is still being written. Two hooks of one process racing at startup cannot
 * overwrite each other, and a later `late` capture cannot displace `startup`.
 */
export function createEraIfAbsent(root: string, entry: EraEntry): EraWriteOutcome {
  const dir = ensureTelemetrySubdir(root, ERA_STORE_SUBDIR);
  const base = eraFileBase(entry.era);
  if (!dir || !base) return "failed";
  const path = join(dir, `${base}.json`);
  const text = JSON.stringify(entry) + "\n";
  if (Buffer.byteLength(text, "utf-8") > MAX_ERA_ENTRY_BYTES) return "failed";
  const before = directoryIdentity(dir);
  if (before === null) return "failed";
  const tmp = join(dir, `.tmp-${base}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  let fd: number | null = null;
  let outcome: EraWriteOutcome = "failed";
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, text, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    const now = directoryIdentity(dir);
    if (now === null || now.dev !== before.dev || now.ino !== before.ino) return "failed";
    try {
      fs.linkSync(tmp, path);
      outcome = "created";
    } catch (err) {
      outcome = (err as NodeJS.ErrnoException)?.code === "EEXIST" ? "exists" : "failed";
    }
    return outcome;
  } catch {
    return "failed";
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    removeRegularFile(dir, tmp, before);
  }
}

/** A `.tmp-*` older than this is a dead writer's leftover and is swept. */
export const ERA_TMP_STALE_MS = 60_000;

/** Locked read-modify-write of one entry. `mutate` returning null leaves the file untouched. */
export function updateEra(
  root: string,
  eraId: string,
  mutate: (entry: EraEntry) => EraEntry | null,
): boolean {
  const dir = eraStoreDirIfPresent(root);
  const base = eraFileBase(eraId);
  if (!dir || !base) return false;
  const recordPath = join(dir, `${base}.json`);
  const lockPath = join(dir, `${base}.lock`);
  if (!acquireLock(lockPath, LOCK_BUDGET_MS)) return false;
  try {
    const text = readBoundedNoFollow(recordPath, MAX_ERA_ENTRY_BYTES);
    if (text === null) return false;
    const current = parseEraEntry(text);
    if (!current || current.era !== eraId) return false;
    const next = mutate(current);
    if (next === null) return true;
    const serialized = JSON.stringify(next) + "\n";
    if (Buffer.byteLength(serialized, "utf-8") > MAX_ERA_ENTRY_BYTES) return false;
    return atomicWriteInDir(dir, recordPath, serialized);
  } finally {
    releaseLock(lockPath);
  }
}

/** Appends a session id to a LIVE era (a closed era gains no sessions). */
export function appendEraSession(root: string, eraId: string, sessionId: string): boolean {
  return updateEra(root, eraId, (entry) => {
    if (entry.endedAt !== null) return null;
    if (entry.sessionIds.includes(sessionId)) return null;
    return { ...entry, sessionIds: [...entry.sessionIds, sessionId].slice(-MAX_ERA_SESSION_IDS) };
  });
}

/** Closes an era. Idempotent. Called by the first reader whose revalidation returns `ended`. */
export function markEraEnded(root: string, eraId: string, nowIso: string): boolean {
  return updateEra(root, eraId, (entry) => (entry.endedAt === null ? { ...entry, endedAt: nowIso } : null));
}

export interface EraSweepOptions {
  readonly now?: number;
  readonly maxEntries?: number;
  readonly budgetMs?: number;
  readonly run?: PsRunner;
  readonly clock?: () => number;
}

export interface EraSweepResult {
  readonly attempted: number;
  readonly removed: number;
  readonly ended: number;
  readonly cursor: string | null;
}

function readCursor(dir: string): string | null {
  const text = readBoundedNoFollow(join(dir, CURSOR_FILE), 256);
  return text === null ? null : text.trim() || null;
}

function writeCursor(dir: string, value: string | null): void {
  if (value === null) {
    removeRegularFile(dir, join(dir, CURSOR_FILE), null);
    return;
  }
  atomicWriteInDir(dir, join(dir, CURSOR_FILE), `${value}\n`);
}

/**
 * Incremental sweep. Entries are taken in sorted-basename order after the
 * cursor (wrapping to the start), at most `maxEntries` per invocation and
 * under an elapsed budget; the cursor advances past EVERY attempted entry --
 * closed ones awaiting expiry and unverifiable ones included -- so a batch
 * that cannot be resolved does not pin the sweep to itself. One batched `ps`
 * verifies the whole batch.
 */
export function sweepEraStore(root: string, options: EraSweepOptions = {}): EraSweepResult {
  const dir = eraStoreDirIfPresent(root);
  if (!dir) return { attempted: 0, removed: 0, ended: 0, cursor: null };
  const identity = directoryIdentity(dir);
  if (identity === null) return { attempted: 0, removed: 0, ended: 0, cursor: null };
  const now = options.now ?? Date.now();
  const clock = options.clock ?? Date.now;
  const maxEntries = options.maxEntries ?? ERA_SWEEP_MAX_ENTRIES;
  const budgetMs = options.budgetMs ?? ERA_SWEEP_BUDGET_MS;
  const run = options.run ?? defaultPsRunner;
  const startedAt = clock();

  let names: string[];
  let removed = 0;
  try {
    const dirents = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
    // Dead writers' leftovers: a `.tmp-*` older than a minute has no live
    // publisher (publication takes milliseconds) and is removed here.
    for (const e of dirents) {
      if (!e.name.startsWith(".tmp-")) continue;
      try {
        const st = fs.lstatSync(join(dir, e.name));
        if (st.isFile() && now - st.mtimeMs > ERA_TMP_STALE_MS && removeRegularFile(dir, join(dir, e.name), identity)) removed++;
      } catch { /* gone already */ }
    }
    names = dirents.filter((e) => e.name.endsWith(".json")).map((e) => e.name).sort();
  } catch {
    return { attempted: 0, removed, ended: 0, cursor: null };
  }
  if (names.length === 0) {
    writeCursor(dir, null);
    return { attempted: 0, removed, ended: 0, cursor: null };
  }
  const cursor = readCursor(dir);
  let start = cursor === null ? 0 : names.findIndex((n) => n > cursor);
  if (start < 0) start = 0;
  const batch: string[] = [];
  for (let i = 0; i < names.length && batch.length < maxEntries; i++) batch.push(names[(start + i) % names.length]!);

  // One ps for the batch.
  const entries = new Map<string, EraEntry>();
  for (const name of batch) {
    const text = readBoundedNoFollow(join(dir, name), MAX_ERA_ENTRY_BYTES);
    const entry = text === null ? null : parseEraEntry(text);
    if (entry && eraFileBase(entry.era) === name.slice(0, -5)) entries.set(name, entry);
  }
  const livePids = [...entries.values()].filter((e) => e.endedAt === null).map((e) => e.pid);
  const starts = probeStarts([...new Set(livePids)], run);

  let attempted = 0;
  let ended = 0;
  let last: string | null = cursor;
  const nowIso = new Date(now).toISOString();
  for (const name of batch) {
    if (clock() - startedAt > budgetMs) break;
    attempted++;
    last = name;
    const entry = entries.get(name);
    const path = join(dir, name);
    if (!entry) {
      // Unparseable or a name that does not match its content: not ours to keep.
      if (removeRegularFile(dir, path, identity)) removed++;
      continue;
    }
    if (entry.endedAt !== null) {
      if (now - Date.parse(entry.endedAt) > ERA_ENDED_TTL_MS && removeRegularFile(dir, path, identity)) removed++;
      continue;
    }
    const started = starts.get(entry.pid);
    const check: ProcessCheck =
      started === undefined || started === null ? "unverifiable"
      : started === "ended" ? "ended"
      : started === parseEraId(entry.era)!.startedSeconds ? "live" : "ended";
    if (check === "ended") {
      if (markEraEnded(root, entry.era, nowIso)) ended++;
      continue;
    }
    if (check === "unverifiable") {
      // Decided under the per-era lock against a fresh read: another process
      // may have verified this era live (streak reset, lastVerifiedAt
      // refreshed) since the snapshot above, and a deletion on the stale
      // snapshot would discard a capture that was just proven current.
      const outcome = expireOrBumpUnverifiable(dir, root, entry.era, path, identity, now);
      if (outcome === "removed") removed++;
      continue;
    }
    // Live: retained regardless of age; the verification stamp is rewritten at most hourly.
    if (entry.unverifiableStreak !== 0 || now - Date.parse(entry.lastVerifiedAt) > ERA_VERIFY_REWRITE_MS) {
      updateEra(root, entry.era, (e) => ({ ...e, unverifiableStreak: 0, lastVerifiedAt: nowIso }));
    }
  }
  // Wrapped past the end: clear the cursor so the next pass starts over.
  const wrapped = last !== null && batch.length > 0 && last === names[names.length - 1];
  writeCursor(dir, wrapped ? null : last);
  return { attempted, removed, ended, cursor: wrapped ? null : last };
}

function unverifiableExpired(entry: EraEntry, streak: number, now: number): boolean {
  return streak >= ERA_UNVERIFIABLE_STREAK && now - Date.parse(entry.lastVerifiedAt) > ERA_UNVERIFIABLE_TTL_MS;
}

/**
 * Under the era's lock: re-read, recompute the streak from the CURRENT entry,
 * then either unlink (expired) or persist the bumped streak. A live era
 * (`endedAt` still null but refreshed since the snapshot) simply gets its
 * streak bumped from its current value, which a fresh verification reset.
 */
function expireOrBumpUnverifiable(
  dir: string,
  root: string,
  eraId: string,
  path: string,
  identity: { dev: number; ino: number },
  now: number,
): "removed" | "bumped" | "skipped" {
  const base = eraFileBase(eraId);
  if (!base) return "skipped";
  const lockPath = join(dir, `${base}.lock`);
  if (!acquireLock(lockPath, LOCK_BUDGET_MS)) return "skipped";
  try {
    const text = readBoundedNoFollow(path, MAX_ERA_ENTRY_BYTES);
    const current = text === null ? null : parseEraEntry(text);
    if (!current || current.era !== eraId || current.endedAt !== null) return "skipped";
    const streak = current.unverifiableStreak + 1;
    if (unverifiableExpired(current, streak, now)) {
      return removeRegularFile(dir, path, identity) ? "removed" : "skipped";
    }
    const serialized = JSON.stringify({ ...current, unverifiableStreak: streak }) + "\n";
    if (Buffer.byteLength(serialized, "utf-8") > MAX_ERA_ENTRY_BYTES) return "skipped";
    return atomicWriteInDir(dir, path, serialized) ? "bumped" : "skipped";
  } finally {
    releaseLock(lockPath);
  }
}

/** Convenience for callers that only need liveness of one era right now. */
export function eraCheck(eraId: string, run: PsRunner = defaultPsRunner): ProcessCheck {
  return checkEra(eraId, run);
}
