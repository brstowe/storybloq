/**
 * T-499: process-start capture and the PreCompact pending mark, the two
 * lifecycle writes that give a presence record its era.
 *
 * Setting provenance is the process era, never the presence generation. The
 * era store is authoritative and survives SessionEnd and `/clear`; the
 * presence record carries a copy for fast reads. Hook execution order is
 * irrelevant: whichever of the presence hook and `intel-start` runs first,
 * the record converges on the same capture, because the capture is keyed on
 * the era store and `applyPresenceEnrichment` mints a fresh record when the
 * hook has not written one yet.
 */

import { isPresenceEnabled } from "../../presence/handler.js";
import { emptySessionIntel, type SessionIntelPresence } from "../../presence/session-intel-fields.js";
import { applyPresenceEnrichment, LIFECYCLE_LOCK_BUDGET_MS } from "../presence-enrichment.js";
import { readAutoCompactWindow } from "../claude-settings.js";
import { readSessionIntelConfig } from "./config.js";
import { appendEraSession, createEraIfAbsent, readEra, type EraEntry } from "./era-store.js";
import { processEra, type ProcessEraResolver } from "./process-era.js";
import { markCompactPending } from "./presence-bridge.js";

/** Which lifecycle moment asked for the capture. Only a NEW process (`startup`, `resume`) may label its capture `startup`. */
export type CaptureSource = "startup" | "resume" | "clear" | "compact" | "stop";

export interface CaptureInput {
  readonly root: string;
  readonly sessionId: string;
  readonly source: CaptureSource;
  readonly now: number;
  /** Test seams. */
  readonly userSettingsPath?: string;
  readonly resolver?: ProcessEraResolver;
}

export type CaptureOutcome =
  /** A new era entry was written and copied onto the record. */
  | { readonly status: "captured"; readonly era: string; readonly captureKind: string }
  /** An existing era entry was copied onto the record (a `/clear`, a hook order where the presence hook ran first, a re-capture after an era change). */
  | { readonly status: "transferred"; readonly era: string; readonly captureKind: string }
  /** The record already carries this era's capture. */
  | { readonly status: "unchanged"; readonly era: string }
  /** No process era: a late, unattributed capture on the record only. Never labelled startup. */
  | { readonly status: "late-unbound"; readonly captureKind: string }
  | { readonly status: "skipped"; readonly reason: string };

/**
 * Ensures the record for `sessionId` carries the capture of the CURRENT
 * process era. Idempotent. Never re-reads settings for an era that already
 * has an entry (a `compact` never moves the ceiling); never upgrades a late
 * entry to startup; never attributes a session to a closed era; performs no
 * identity-sensitive side effect when the era cannot be verified live.
 */
export function ensureCapture(input: CaptureInput): CaptureOutcome {
  const { root, sessionId } = input;
  if (!isPresenceEnabled(root)) return { status: "skipped", reason: "presence disabled" };
  const cfg = readSessionIntelConfig(root);
  if (!cfg.enabled) return { status: "skipped", reason: "sessionIntel disabled" };
  const resolver = input.resolver ?? processEra;
  const nowIso = new Date(input.now).toISOString();
  const era = resolver.current();

  if (era === null) {
    // No CLAUDE_PID (older client, unusual launcher) or ps failed at startup.
    // The record gets a late, era-less capture so `session intel` can still
    // answer at reduced confidence; nothing is attributed anywhere.
    let kind = "absent";
    const outcome = applyPresenceEnrichment(root, sessionId, LIFECYCLE_LOCK_BUDGET_MS, "session-intel", (base) => {
      const intel = base.sessionIntel;
      if (intel && intel.capturedAt !== null) { kind = intel.captureKind; return base; }
      const reading = readAutoCompactWindow(root, input.userSettingsPath);
      kind = reading ? "late" : "absent";
      return {
        ...base,
        sessionIntel: {
          ...(intel ?? emptySessionIntel()),
          era: null,
          captureKind: reading ? "late" : "absent",
          autoCompactWindowAtStart: reading?.value ?? null,
          autoCompactWindowSource: reading?.source ?? null,
          capturedAt: nowIso,
        },
      };
    }, () => new Date(input.now));
    return outcome.status === "written" ? { status: "late-unbound", captureKind: kind } : { status: "skipped", reason: `presence write ${outcome.status}` };
  }

  const check = resolver.revalidate();
  if (check !== "live") return { status: "skipped", reason: `process era ${check}` };

  let entry: EraEntry | null = readEra(root, era.id);
  let created = false;
  if (entry === null) {
    const reading = readAutoCompactWindow(root, input.userSettingsPath);
    const kind = input.source === "startup" || input.source === "resume" ? "startup" : "late";
    const candidate: EraEntry = {
      era: era.id,
      pid: era.pid,
      startedAt: era.startedAt,
      captureKind: reading ? kind : "absent",
      autoCompactWindowAtStart: reading?.value ?? null,
      autoCompactWindowSource: reading?.source ?? null,
      capturedAt: nowIso,
      endedAt: null,
      lastVerifiedAt: nowIso,
      unverifiableStreak: 0,
      sessionIds: [sessionId],
    };
    const wrote = createEraIfAbsent(root, candidate);
    if (wrote === "failed") return { status: "skipped", reason: "era store write failed" };
    created = wrote === "created";
    entry = readEra(root, era.id);
    if (entry === null) return { status: "skipped", reason: "era store unreadable after write" };
  }
  if (entry.endedAt !== null) return { status: "skipped", reason: "era closed" };
  if (!entry.sessionIds.includes(sessionId)) appendEraSession(root, era.id, sessionId);

  const capture = entry;
  let changed = false;
  const outcome = applyPresenceEnrichment(root, sessionId, LIFECYCLE_LOCK_BUDGET_MS, "session-intel", (base) => {
    const intel = base.sessionIntel;
    if (intel && intel.era === era.id) return base;
    changed = true;
    // An era change (or a first binding) makes every sample, anchor and
    // handover from before it unproven: the subtree restarts at the capture,
    // one revision up so an in-flight sample computed against the old
    // record is rejected as stale. The transcript hint survives, it is only
    // a lookup hint.
    const next: SessionIntelPresence = {
      ...emptySessionIntel(),
      era: era.id,
      revision: (intel?.revision ?? 0) + (intel ? 1 : 0),
      captureKind: capture.captureKind,
      autoCompactWindowAtStart: capture.autoCompactWindowAtStart,
      autoCompactWindowSource: capture.autoCompactWindowSource,
      capturedAt: capture.capturedAt,
      transcriptPath: intel?.transcriptPath ?? null,
    };
    return { ...base, sessionIntel: next };
  }, () => new Date(input.now));
  if (outcome.status !== "written") return { status: "skipped", reason: `presence write ${outcome.status}` };
  if (!changed) return { status: "unchanged", era: era.id };
  return created
    ? { status: "captured", era: era.id, captureKind: capture.captureKind }
    : { status: "transferred", era: era.id, captureKind: capture.captureKind };
}

/**
 * The PreCompact mark: publishes an immutable pending event for the caller's
 * session, stamped with the live process era so reconciliation can tell it
 * from a stale file of an earlier process. Best-effort; gated on presence and
 * on the feature, since nothing would consume the file otherwise.
 */
export function publishCompactPending(root: string, sessionId: string, now: number, resolver: ProcessEraResolver = processEra): boolean {
  if (!isPresenceEnabled(root)) return false;
  if (!readSessionIntelConfig(root).enabled) return false;
  const era = resolver.current();
  const at = new Date(now).toISOString();
  return markCompactPending(root, sessionId, { eventId: `${process.pid}-${now}-${Math.floor(Math.random() * 1e6)}`, era: era?.id ?? null, at });
}
