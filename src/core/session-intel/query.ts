/**
 * T-499: `sampleSession` -- the I/O half of the sampler and the engine
 * behind `storybloq session intel` / `storybloq_session_intel`.
 *
 *   1 resolve the target (caller binding, or an explicit read-only target)
 *   2 authorize + locate the transcript
 *   3 reconcile (bound only) under the record lock
 *   4 scan (tail, or full on request), resolve the ceiling for the TARGET's
 *     provenance, compute the sample against the record as it is
 *   5 persist (bound, authoritative, reconciliation complete) and ingest
 *     boundaries into the ledger with era stamping
 *
 * Read-only targets (explicit --session-id / --transcript, no project,
 * presence disabled, unbound caller) never write anything anywhere.
 */

import { currentStorybloqClient } from "../../autonomous/client-profile.js";
import { isPresenceEnabled } from "../../presence/handler.js";
import { readAutoCompactWindow } from "../claude-settings.js";
import { readSessionIntelConfig, resolveSessionIntelConfig, type SessionIntelConfig } from "./config.js";
import { LEDGER_GLOBAL_CAP, ingestBoundaries, readLedger, type IngestOutcome, type LedgerEntry } from "./boundary-ledger.js";
import { resolveCeiling } from "./ceiling-resolver.js";
import { readEra } from "./era-store.js";
import { computeSample } from "./sampler.js";
import { boundaryInsideEra, peekPending, persistSample, readPresenceRecord, reconcileIntel, reconcileUnderLock, resolveCallerBinding, resolveTargetProvenance, type CallerBinding, type WorktreeWalkOptions } from "./presence-bridge.js";
import { processEra } from "./process-era.js";
import { authorizeTranscriptPath, explainTranscriptRefusal, locateTranscript, REFUSAL_NO_SESSION_ID } from "./transcript-locate.js";
import { scanFull, scanTail, type ScanRequest } from "./transcript-scan.js";
import type { ScanResult, ScannedSessionFacts, SampledBy, TargetProvenance, TokenPressureSample, UsageAdvisoryInput } from "./types.js";
import { TRY_LOCK_BUDGET_MS } from "../presence-enrichment.js";

export type BindingMode = "bound" | "read-only";
export type PresenceOutcome = "persisted" | "presence-disabled" | "no-project" | "skipped" | "rejected";

export interface SampleSessionOptions {
  /** Project root, or null when running without `.story/`. */
  readonly root: string | null;
  readonly cwd: string;
  readonly sampledBy: SampledBy;
  readonly sessionId?: string | null;
  readonly transcriptPath?: string | null;
  /**
   * A transcript path from a HOOK PAYLOAD for the caller's own session: the
   * first lookup candidate, still subject to the access contract, and unlike
   * `transcriptPath` it does not make the scan read-only (the session id
   * came from the same payload, so the scan stays lifecycle-bound).
   */
  readonly transcriptHint?: string | null;
  readonly callerModel?: string | null;
  readonly full?: boolean;
  /** Test seam: the --full read budget in bytes. */
  readonly fullBudgetBytes?: number;
  readonly explicitTaskId?: string | null;
  /** Read-only scans may glob; the sync prompt hook must not. */
  readonly allowGlob?: boolean;
  readonly now?: number;
  readonly projectsDir?: string;
  readonly userSettingsPath?: string;
  /**
   * Soft budget for non-query paths. Checked between stages (after locate,
   * after the scan, before the lock); past it the remaining work is
   * abandoned and nothing computed so far is persisted. No hard deadline:
   * synchronous I/O cannot be cancelled by a timer.
   */
  readonly budget?: { readonly startedAt: number; readonly softMs: number; /** Test seam: the clock the checkpoints read. */ readonly clock?: () => number };
}

export interface SessionIntelResult {
  readonly client: "claude" | "codex";
  readonly sessionId: string | null;
  readonly transcriptPath: string | null;
  readonly binding: BindingMode;
  readonly bindingReason: string;
  readonly coverage: "tail" | "full" | "partial" | "none";
  readonly scannedBytes: number;
  readonly truncationReason: string | null;
  readonly pressure: TokenPressureSample | null;
  readonly usable: boolean;
  readonly unusableReason: string | null;
  readonly session: ScannedSessionFacts | null;
  readonly callerModelMismatch: { readonly caller: string; readonly transcript: string | null } | null;
  readonly presence: PresenceOutcome;
  readonly presenceReason: string | null;
  /**
   * ISS-1211 gate: the boundary ledger write's own outcome, null when this
   * call never attempted one. `presence` describes the presence record, which
   * can be persisted while the ledger write is lock-busy or fails, so a
   * dropped boundary used to be entirely silent.
   */
  readonly ledgerIngest: IngestOutcome | null;
  readonly provenance: TargetProvenance;
  readonly config: { readonly notes: readonly string[] };
}

function emptyFacts(): ScannedSessionFacts {
  return { startedAt: null, version: null, entrypoint: null, cwd: null, gitBranch: null, permissionMode: null, aiTitle: null, slug: null, bridgeSessionId: null, effort: null, models: [], turns: null, compactions: { autoObserved: 0, manualObserved: 0, unknownObserved: 0, last: null } };
}

function unknownResult(base: Partial<SessionIntelResult>, reason: string): SessionIntelResult {
  return {
    client: "claude",
    sessionId: null,
    transcriptPath: null,
    binding: "read-only",
    bindingReason: reason,
    coverage: "none",
    scannedBytes: 0,
    truncationReason: null,
    pressure: null,
    usable: false,
    unusableReason: reason,
    session: null,
    callerModelMismatch: null,
    presence: "skipped",
    presenceReason: reason,
    ledgerIngest: null,
    provenance: { era: null, capture: null },
    config: { notes: [] },
    ...base,
  };
}

/** Stamp boundaries seen by a BOUND scan with the caller's live era where they fall inside its proven interval. */
export function stampBoundaries(root: string, sessionId: string, era: string, scan: ScanResult, now: number): LedgerEntry[] {
  const entry = readEra(root, era);
  return scan.boundaries.map((b) => {
    const inside = boundaryInsideEra(entry, b.timestamp, now);
    return {
      sessionId,
      era: inside ? era : null,
      captureKind: inside && entry ? entry.captureKind : null,
      timestamp: b.timestamp,
      trigger: b.trigger,
      preTokens: b.preTokens,
      postTokens: b.postTokens,
      autoCompactWindowAtStart: inside && entry ? entry.autoCompactWindowAtStart : null,
    };
  });
}

export function sampleSession(opts: SampleSessionOptions): SessionIntelResult {
  const now = opts.now ?? Date.now();
  if (currentStorybloqClient() !== "claude") return unknownResult({ client: "codex" }, "client is Codex: no transcript access");
  const cfg: SessionIntelConfig = opts.root ? readSessionIntelConfig(opts.root) : resolveSessionIntelConfig(null);

  // 1. Target.
  const explicit = Boolean(opts.sessionId || opts.transcriptPath);
  const overBudget = () => opts.budget !== undefined && (opts.budget.clock ?? Date.now)() - opts.budget.startedAt > opts.budget.softMs;
  let binding: CallerBinding | null = null;
  let sessionId = opts.sessionId ?? null;
  if (!explicit) {
    binding = resolveCallerBinding(opts.root, opts.explicitTaskId);
    sessionId = binding.sessionId;
  } else if (!sessionId && opts.transcriptPath) {
    const m = /([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\.jsonl$/.exec(opts.transcriptPath);
    sessionId = m ? m[1]! : null;
  }
  // ISS-1224: an explicit transcript with no session id (given or derivable
  // from its basename) names that rule instead of a generic target failure.
  if (!sessionId) return unknownResult({}, binding?.reason ?? (opts.transcriptPath ? REFUSAL_NO_SESSION_ID : "no target session id"));
  const presenceOn = opts.root ? isPresenceEnabled(opts.root) : false;
  const bound = !explicit && binding !== null && binding.bound && presenceOn && cfg.enabled;
  const bindingReason = explicit ? "explicit target" : !presenceOn ? "presence disabled" : !cfg.enabled ? "sessionIntel disabled" : binding!.reason;

  // 2. Transcript.
  const record = opts.root ? readPresenceRecord(opts.root, sessionId) : null;
  let transcriptPath: string | null = null;
  if (opts.transcriptPath) {
    transcriptPath = authorizeTranscriptPath(opts.transcriptPath, sessionId, opts.projectsDir);
  } else {
    transcriptPath = opts.transcriptHint ? authorizeTranscriptPath(opts.transcriptHint, sessionId, opts.projectsDir) : null;
    if (!transcriptPath) {
      const located = locateTranscript({ sessionId, cwd: opts.cwd, hint: record?.sessionIntel?.transcriptPath ?? null, allowGlob: opts.allowGlob ?? true, projectsDir: opts.projectsDir });
      transcriptPath = located?.path ?? null;
    }
  }
  const provenance = resolveTargetProvenance(opts.root, sessionId);
  if (!transcriptPath) {
    // ISS-1224: an explicit --transcript names the access-contract rule it
    // failed (never echoing the path); a located lookup keeps the generic
    // reason, since no candidate was the caller's own claim.
    const reason = opts.transcriptPath
      ? explainTranscriptRefusal(opts.transcriptPath, sessionId, opts.projectsDir) ?? "transcript not found or not authorized"
      : "transcript not found or not authorized";
    return unknownResult({ sessionId, binding: bound ? "bound" : "read-only", bindingReason, provenance, config: { notes: cfg.notes } }, reason);
  }
  if (overBudget()) {
    return unknownResult({ sessionId, transcriptPath, binding: bound ? "bound" : "read-only", bindingReason, provenance, config: { notes: cfg.notes } }, "soft budget exceeded after locate");
  }

  // 3. Scan (revision read BEFORE the scan).
  const intelBefore = record?.sessionIntel ?? null;
  const req: ScanRequest = {
    path: transcriptPath,
    sessionId,
    era: bound ? binding!.era : null,
    revisionSeen: intelBefore?.revision ?? null,
    epochSince: intelBefore?.epoch.kind === "unobserved" || !intelBefore ? null : intelBefore.epoch.at,
  };
  const doScan = (r: ScanRequest) => (opts.full ? scanFull(r, opts.fullBudgetBytes) : scanTail(r));
  let scan = doScan(req);
  if (!scan) {
    return unknownResult({ sessionId, transcriptPath, binding: bound ? "bound" : "read-only", bindingReason, provenance, config: { notes: cfg.notes } }, "transcript could not be read");
  }
  if (overBudget()) {
    return unknownResult({ sessionId, transcriptPath, binding: bound ? "bound" : "read-only", bindingReason, provenance, config: { notes: cfg.notes } }, "soft budget exceeded after scan");
  }

  // 4. Reconcile, then resolve and compute. Bound: under the record lock.
  //    Read-only: the same pure reconciliation applied to an IN-MEMORY copy
  //    of the target's record (a boundary the scan saw resets suppression;
  //    a pending compaction makes pressure unusable) with nothing written.
  let usable = true;
  let unusableReason: string | null = null;
  let recordNow = intelBefore;
  if (bound && opts.root) {
    const rec = reconcileUnderLock({ root: opts.root, sessionId, cfg, tailBoundaries: scan.boundaries, transcriptPath, source: "other", now }, TRY_LOCK_BUDGET_MS);
    if (rec.status === "incomplete") {
      usable = false;
      unusableReason = rec.reason ?? "reconciliation incomplete";
    }
    recordNow = readPresenceRecord(opts.root, sessionId)?.sessionIntel ?? null;
    // Reconciliation bumped the revision (a boundary or an expiry was applied):
    // the scan above saw the old one and would be rejected as stale, so read
    // the transcript again against the reconciled record. Bounded: one more
    // tail read, and the record cannot bump twice for the same evidence. A
    // failed rescan leaves only pre-reconciliation evidence: unusable.
    if (recordNow && recordNow.revision !== (intelBefore?.revision ?? null)) {
      const again = doScan({ ...req, revisionSeen: recordNow.revision, epochSince: recordNow.epoch.kind === "unobserved" ? null : recordNow.epoch.at });
      if (again) scan = again;
      else {
        usable = false;
        unusableReason = "transcript could not be re-read after reconciliation";
      }
    }
  } else if (opts.root && intelBefore) {
    const newest = scan.boundaries.length ? scan.boundaries[scan.boundaries.length - 1]! : null;
    const r = reconcileIntel(intelBefore, newest, peekPending(opts.root, sessionId, now), cfg, now);
    recordNow = r.intel;
    if (r.status === "incomplete") {
      usable = false;
      unusableReason = "pending compaction events remain";
    }
  }
  // ISS-1211 gate: the routing's `git worktree list` runs under the CALLER's
  // budget, not its own. A spent deadline makes discovery return nothing,
  // which is the local routing and is never memoized, so the next call with
  // budget left resolves properly.
  const walk: WorktreeWalkOptions = opts.budget
    ? { deadline: opts.budget.startedAt + opts.budget.softMs, clock: opts.budget.clock ?? Date.now }
    : {};
  const ledger = opts.root ? readLedger(opts.root, walk) : [];
  // The live setting is read ONLY when there is no capture object at all. A
  // capture that recorded no window (`captureKind: "absent"`) is a captured
  // null: re-reading the file here would report a window this process is not
  // actually running under.
  const liveReading = provenance.capture === null ? readAutoCompactWindow(opts.root ?? opts.cwd, opts.userSettingsPath) : null;
  const liveSetting = liveReading ? { value: liveReading.value, basis: opts.root ? "live read, unbound" : "live read, no capture" } : null;
  // T-501: the advisory's inputs, from the same resolution, passed explicitly
  // into the pure sampler.
  const usage: UsageAdvisoryInput = provenance.capture !== null
    ? { window: provenance.capture.autoCompactWindowAtStart, source: provenance.capture.autoCompactWindowSource, provenance: "capture" }
    : liveReading
      ? { window: liveReading.value, source: liveReading.source, provenance: "live" }
      : { window: null, source: null, provenance: "none" };
  const ceiling = resolveCeiling({
    sessionId,
    target: provenance,
    ledger,
    liveSetting,
    lastAssistantModel: scan.lastAssistantModel,
    oneMillionFlag: scan.oneMillionFlag,
    modelEvidence: scan.modelEvidence,
    highWaterMark: scan.highWaterMark,
    cfg,
  });
  const sampledAt = new Date(now).toISOString();
  const compute = (rec: typeof recordNow) => computeSample({ scan, ceiling, cfg, sampledBy: opts.sampledBy, sampledAt, record: rec, usage });
  let pressure = compute(recordNow);

  // 5. Persist + ingest.
  let presence: PresenceOutcome = opts.root ? (presenceOn ? "skipped" : "presence-disabled") : "no-project";
  let presenceReason: string | null = bound ? null : bindingReason;
  let ledgerIngest: IngestOutcome | null = null;
  if (bound && opts.root && usable && scan.observation.authoritative && overBudget()) {
    // Computed past the budget: reported, never persisted or ingested.
    usable = false;
    unusableReason = "soft budget exceeded before persist";
    presenceReason = unusableReason;
  } else if (bound && opts.root && usable && scan.observation.authoritative) {
    const outcome = persistSample({ root: opts.root, sessionId, sample: pressure, transcriptPath, cfg, now, recompute: (rec) => compute(rec) });
    if (outcome.status === "accepted") {
      presence = "persisted";
      pressure = outcome.sample;
    } else if (outcome.status === "rejected") {
      // Validation rejected the observation (era, revision, replacement,
      // anchor, pending compaction): the evidence does not describe the
      // file the record describes. Neither reported as usable nor ingested.
      presence = "rejected";
      presenceReason = outcome.reason;
      usable = false;
      unusableReason = `sample rejected: ${outcome.reason}`;
    } else if (outcome.validated) {
      // The locked checks passed and only the write failed: the evidence stands.
      presence = "skipped";
      presenceReason = outcome.reason;
    } else {
      // The lock was never acquired (a lifecycle write holds it): none of the
      // locked checks ran, so the sample is unproven. Not usable for
      // automatic consumption, not ingested.
      presence = "skipped";
      presenceReason = outcome.reason;
      usable = false;
      unusableReason = `sample unvalidated: ${outcome.reason}`;
    }
    if (usable && scan.boundaries.length > 0 && binding!.era) {
      ledgerIngest = ingestBoundaries(opts.root, stampBoundaries(opts.root, sessionId, binding!.era, scan, now), cfg.boundarySampleCount, LEDGER_GLOBAL_CAP, walk);
    }
  } else if (bound && !usable) {
    presenceReason = unusableReason;
  } else if (bound && !scan.observation.authoritative) {
    presenceReason = "partial scan never persists";
  }

  const callerModelMismatch = opts.callerModel && opts.callerModel !== scan.lastAssistantModel
    ? { caller: opts.callerModel, transcript: scan.lastAssistantModel }
    : null;

  return {
    client: "claude",
    sessionId,
    transcriptPath,
    binding: bound ? "bound" : "read-only",
    bindingReason,
    coverage: scan.coverage,
    scannedBytes: scan.scannedBytes,
    truncationReason: scan.truncationReason,
    pressure,
    usable: usable && pressure.state !== "unknown",
    unusableReason: !usable ? unusableReason : pressure.state === "unknown" ? pressure.reason : null,
    session: scan.session,
    callerModelMismatch,
    presence,
    presenceReason,
    ledgerIngest,
    provenance,
    config: { notes: cfg.notes },
  };
}

export { processEra, emptyFacts };
