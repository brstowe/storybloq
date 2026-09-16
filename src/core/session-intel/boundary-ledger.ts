/**
 * T-499: the boundary ledger, `.story/telemetry/session-intel/boundaries.json`.
 *
 * Every auto-compaction boundary a lifecycle-bound scan sees is recorded
 * with its provenance: the session, the process era it was attributed to
 * (null = unclassified), the era's capture kind and window. The resolver
 * pools these by exact provenance, never by numeric band.
 *
 * Retention is per session first (`boundarySampleCount` newest), then a
 * global cap of 200 filled round-robin across sessions newest-first, so a
 * busy session cannot evict a quiet one; past 200 sessions the sessions with
 * the oldest newest-boundary are evicted entirely and deterministically.
 *
 * ISS-1211: the ledger is routed per REPO, not per cwd -- writes go to the
 * main worktree's `.story/`, reads take the union of the main checkout and its
 * worktrees -- so a boundary seen while cwd was a linked worktree is still one
 * series (see `ledger-root.ts`).
 */

import { join } from "node:path";
import {
  acquireLock,
  atomicWriteInDir,
  ensureTelemetrySubdir,
  readBoundedNoFollow,
  releaseLock,
  telemetrySubdirIfPresent,
} from "../../presence/io.js";
import type { CaptureKind } from "../../presence/session-intel-fields.js";
import { LEDGER_SUBDIR, boundaryLedgerReadRoots, boundaryLedgerWriteTarget, ledgerWriteTargetStillValid } from "./ledger-root.js";
import type { WorktreeWalkOptions } from "./presence-bridge.js";
import type { CompactionTrigger } from "./types.js";

export { LEDGER_SUBDIR };
export const LEDGER_FILE = "boundaries.json";
export const LEDGER_MAX_INPUT_BYTES = 256 * 1024;
export const LEDGER_GLOBAL_CAP = 200;
const LOCK_BUDGET_MS = 300;

export interface LedgerEntry {
  readonly sessionId: string;
  readonly era: string | null;
  readonly captureKind: CaptureKind | null;
  readonly timestamp: string;
  readonly trigger: CompactionTrigger;
  readonly preTokens: number | null;
  readonly postTokens: number | null;
  readonly autoCompactWindowAtStart: number | null;
}

const CAPTURE_KINDS = new Set(["startup", "late", "absent"]);

function parseEntry(v: unknown): LedgerEntry | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.sessionId !== "string" || r.sessionId.length === 0 || r.sessionId.length > 128) return null;
  if (typeof r.timestamp !== "string" || r.timestamp.length > 40 || !Number.isFinite(Date.parse(r.timestamp))) return null;
  const num = (x: unknown) => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null);
  return {
    sessionId: r.sessionId,
    era: typeof r.era === "string" && r.era.length > 0 && r.era.length <= 64 ? r.era : null,
    captureKind: typeof r.captureKind === "string" && CAPTURE_KINDS.has(r.captureKind) ? (r.captureKind as CaptureKind) : null,
    timestamp: r.timestamp,
    // Only a literal "auto" is measurement-eligible; the resolver filters on it.
    trigger: r.trigger === "auto" ? "auto" : r.trigger === "manual" ? "manual" : "unknown",
    preTokens: num(r.preTokens),
    postTokens: num(r.postTokens),
    autoCompactWindowAtStart: num(r.autoCompactWindowAtStart),
  };
}

export function parseLedger(text: string): LedgerEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).entries) ? (raw as Record<string, unknown>).entries as unknown[] : [];
  const out: LedgerEntry[] = [];
  for (const item of list) {
    const e = parseEntry(item);
    if (e) out.push(e);
  }
  return out;
}

/** One checkout's own file. `[]` when absent, oversize (refused BEFORE parse) or unparsable. */
function readLedgerAt(root: string): LedgerEntry[] {
  const dir = telemetrySubdirIfPresent(root, LEDGER_SUBDIR);
  if (!dir) return [];
  const text = readBoundedNoFollow(join(dir, LEDGER_FILE), LEDGER_MAX_INPUT_BYTES);
  return text === null ? [] : parseLedger(text);
}

/**
 * Read-only, across the repo: the shared series merged with whatever each
 * other checkout of the same repo holds, so the boundaries ISS-1211 stranded
 * in a worktree are still counted from the main checkout and vice versa. A
 * plain checkout reads exactly one file, byte-for-byte as before.
 *
 * The merge is `trimLedger`'s own dedupe rule applied ONCE over the union, so
 * the same boundary recorded in two checkouts collapses to one entry and can
 * gain a classification but never lose one.
 *
 * CAP RULE: every retention cap belongs to the WRITE. Each file on disk is
 * already trimmed to `perSession` and `LEDGER_GLOBAL_CAP`, so both caps here
 * scale with the number of files merged and the merge can never discard an
 * entry a single checkout kept. Folding N files under a flat 200 would have
 * round-robined the union and shrunk a session's 20 boundaries to a handful
 * whenever another checkout held a large ledger. The resolver still applies
 * `boundarySampleCount` to whatever it selects out of this.
 */
export function readLedger(root: string, opts: WorktreeWalkOptions = {}): LedgerEntry[] {
  const roots = boundaryLedgerReadRoots(root, opts);
  const shared = readLedgerAt(roots[0]!);
  if (roots.length === 1) return shared;
  const rest: LedgerEntry[] = [];
  for (let i = 1; i < roots.length; i++) rest.push(...readLedgerAt(roots[i]!));
  if (rest.length === 0) return shared;
  const cap = LEDGER_GLOBAL_CAP * roots.length;
  return trimLedger(shared, rest, cap, cap).entries;
}

const ts = (e: LedgerEntry) => Date.parse(e.timestamp);

export interface TrimResult {
  readonly entries: LedgerEntry[];
  /** Entries retained per session after both caps. */
  readonly windows: ReadonlyMap<string, number>;
  readonly evictedSessions: readonly string[];
}

/**
 * Pure retention. Dedupes by `(sessionId, timestamp)` (the incoming entry
 * wins only when the existing one is unclassified and the new one carries
 * an era: a classification can be gained, never lost or changed), keeps the
 * newest `perSession` per session, then fills `globalCap` round-robin.
 */
export function trimLedger(existing: readonly LedgerEntry[], incoming: readonly LedgerEntry[], perSession: number, globalCap = LEDGER_GLOBAL_CAP): TrimResult {
  const byKey = new Map<string, LedgerEntry>();
  for (const e of existing) byKey.set(`${e.sessionId}\0${e.timestamp}`, e);
  for (const e of incoming) {
    const key = `${e.sessionId}\0${e.timestamp}`;
    const cur = byKey.get(key);
    if (!cur) byKey.set(key, e);
    else if (cur.era === null && e.era !== null) byKey.set(key, e);
  }
  const bySession = new Map<string, LedgerEntry[]>();
  for (const e of byKey.values()) {
    const list = bySession.get(e.sessionId) ?? [];
    list.push(e);
    bySession.set(e.sessionId, list);
  }
  for (const [sid, list] of bySession) {
    list.sort((a, b) => ts(b) - ts(a));
    bySession.set(sid, list.slice(0, Math.max(1, perSession)));
  }
  // Sessions ordered by their newest boundary (desc), ties by sessionId.
  const order = [...bySession.keys()].sort((a, b) => {
    const d = ts(bySession.get(b)![0]!) - ts(bySession.get(a)![0]!);
    return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
  });
  const kept = new Map<string, LedgerEntry[]>();
  let total = 0;
  for (let round = 0; total < globalCap; round++) {
    let progressed = false;
    for (const sid of order) {
      if (total >= globalCap) break;
      const list = bySession.get(sid)!;
      if (round >= list.length) continue;
      const k = kept.get(sid) ?? [];
      k.push(list[round]!);
      kept.set(sid, k);
      total++;
      progressed = true;
    }
    if (!progressed) break;
  }
  const entries: LedgerEntry[] = [];
  for (const list of kept.values()) entries.push(...list);
  entries.sort((a, b) => ts(a) - ts(b) || (a.sessionId < b.sessionId ? -1 : 1));
  const windows = new Map<string, number>();
  for (const [sid, list] of kept) windows.set(sid, list.length);
  return { entries, windows, evictedSessions: order.filter((sid) => !kept.has(sid)) };
}

export type IngestOutcome = "written" | "unchanged" | "lock-busy" | "failed";

/**
 * Locked read-merge-trim-write. Only lifecycle-bound scans may call this.
 *
 * ISS-1211: the write lands in the REPO's ledger (the main worktree's), not
 * whatever checkout the hook's cwd resolved to, so one compaction is one entry
 * in one series no matter which worktree the session was standing in.
 *
 * Two fallbacks keep a boundary from being dropped outright, since the merged
 * read finds it wherever it lands: a routed root whose identity no longer
 * matches the one discovery validated, and a routed root whose telemetry
 * directory cannot be created, both write to the caller's own checkout.
 */
export function ingestBoundaries(root: string, incoming: readonly LedgerEntry[], perSession: number, globalCap = LEDGER_GLOBAL_CAP, opts: WorktreeWalkOptions = {}): IngestOutcome {
  if (incoming.length === 0) return "unchanged";
  const target = boundaryLedgerWriteTarget(root, opts);
  const routed = ledgerWriteTargetStillValid(root, target) ? target.root : root;
  let dir = ensureTelemetrySubdir(routed, LEDGER_SUBDIR);
  if (dir === null && routed !== root) dir = ensureTelemetrySubdir(root, LEDGER_SUBDIR);
  if (!dir) return "failed";
  const path = join(dir, LEDGER_FILE);
  const lockPath = join(dir, "boundaries.lock");
  if (!acquireLock(lockPath, LOCK_BUDGET_MS)) return "lock-busy";
  try {
    const text = readBoundedNoFollow(path, LEDGER_MAX_INPUT_BYTES);
    const existing = text === null ? [] : parseLedger(text);
    const trimmed = trimLedger(existing, incoming, perSession, globalCap);
    const serialized = JSON.stringify({ version: 1, entries: trimmed.entries }) + "\n";
    if (text !== null && serialized === text) return "unchanged";
    return atomicWriteInDir(dir, path, serialized) ? "written" : "failed";
  } finally {
    releaseLock(lockPath);
  }
}
