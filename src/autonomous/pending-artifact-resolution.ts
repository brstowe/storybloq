/**
 * The mint point for `ResolvedTicketIdentities`.
 *
 * It lives here rather than in `pending-artifacts.ts` for two reasons. The
 * classifier is pure over an already-loaded observation and must stay that way,
 * and more importantly the brand is only worth anything if the value can be
 * produced in exactly ONE place that does the real work. A function that took a
 * list and handed it back branded would authenticate nothing: the caller could
 * pass the very list it was being asked to verify, which is a guard whose two
 * sides come from one source (L-038).
 *
 * So this takes a project state and resolves against it. The classifier then
 * consumes the branded result and never resolves anything itself.
 */
import type { ProjectState } from "../core/project-state.js";
import { resolveAndNormalizeTicketRefs, RefResolutionError } from "../core/ref-normalization.js";
import { ownStringArray } from "./pending-artifacts.js";
import { markResolvedTicketIdentities } from "./resolved-identities.js";
import type { PendingIssueCreatePayload, ResolvedTicketIdentities } from "./session-types.js";
import { asCanonicalTicketIdentities, type UnverifiedIssueCreatePayload } from "./pending-artifacts.js";
import { inferIssuePhase } from "./issue-create-preparation.js";
import {
  validateIssueCreateSeverity,
  validateIssueCreateDedupeKey,
  validateIssueCreatePhase,
} from "../core/issue-create-input.js";

/**
 * Resolve a stored payload's ticket references against the ledger as it is now.
 *
 * Returns null when they cannot be resolved, which is a real answer rather than
 * an error: a record naming a ticket that no longer exists, or one that is
 * ambiguous, is a record recovery must refuse to replay. The classifier turns
 * that null into a quarantine.
 *
 * Non-resolution failures are rethrown. Swallowing them would report "these
 * refs do not resolve" for a bug that had nothing to do with the refs.
 */
export function resolvePayloadTicketIdentities(
  state: ProjectState,
  refs: readonly string[],
): ResolvedTicketIdentities | null {
  // The SAME own-data reader the classifier uses, not a second spelling of it.
  // It refuses holes, extra own properties, symbol keys and accessor elements,
  // and it returns a fresh copy read through descriptors -- so no getter is
  // invoked, nothing is read twice, and what gets resolved is exactly what was
  // checked. `Object.keys` plus `every` could do none of that: `every` skips
  // holes and invokes accessors, a spread invokes them a second time, and an
  // unrelated enumerable property can balance a missing index in the count.
  const checked = ownStringArray(refs);
  if (checked === null) return null;
  if (checked.some((r) => r.length === 0)) return null;
  try {
    return markResolvedTicketIdentities(resolveAndNormalizeTicketRefs(state, [...checked]));
  } catch (error) {
    if (error instanceof RefResolutionError) return null;
    throw error;
  }
}

export type IssueCreatePreparation =
  | { readonly ok: true; readonly payload: PendingIssueCreatePayload }
  | { readonly ok: "deduplicated"; readonly issueId: string }
  | {
      readonly ok: false;
      readonly reason: "severity" | "dedupeKey" | "phase" | "unresolvable-links";
      readonly message: string;
    };

/**
 * ISS-1221: prepare an `issue_create` payload so that what gets fingerprinted
 * is what `handleIssueCreate` will write, field for field, and nothing the
 * writer would refuse is ever recorded as replayable. The checks run in the
 * writer's own order: severity, dedupe key, the dedupe early return (a live
 * key is a completed no-op, so no record is written for it), an explicit
 * phase, then the links, then an inferred phase. The refusal carries the
 * writer's field name and message so a record can say why it is not
 * replayable. The classifier still resolves nothing itself.
 */
export async function resolveIssueCreatePayload(
  state: ProjectState,
  payload: UnverifiedIssueCreatePayload,
  root: string,
): Promise<IssueCreatePreparation> {
  const severity = validateIssueCreateSeverity(payload);
  if (severity) return { ok: false, reason: "severity", message: severity.message };
  const dedupeKey = validateIssueCreateDedupeKey(payload);
  if (dedupeKey) return { ok: false, reason: "dedupeKey", message: dedupeKey.message };
  if (payload.dedupeKey) {
    // Truthy like the writer: a payload with no key never matches an issue with no key.
    const existing = state.activeIssues.find((issue) => issue.dedupeKey === payload.dedupeKey);
    if (existing) return { ok: "deduplicated", issueId: existing.id };
  }
  if (payload.phase !== undefined) {
    const explicit = validateIssueCreatePhase(state, payload.phase);
    if (explicit) return { ok: false, reason: "phase", message: explicit.message };
  }
  const resolved = resolvePayloadTicketIdentities(state, payload.relatedTickets);
  if (resolved === null) return { ok: false, reason: "unresolvable-links", message: "related tickets do not resolve against the ledger" };
  const links = asCanonicalTicketIdentities([...resolved], resolved);
  if (links === null) return { ok: false, reason: "unresolvable-links", message: "related tickets do not resolve against the ledger" };
  const phase = payload.phase !== undefined ? payload.phase : await inferIssuePhase(state, resolved, root);
  if (payload.phase === undefined) {
    const inferred = validateIssueCreatePhase(state, phase);
    if (inferred) return { ok: false, reason: "phase", message: inferred.message };
  }
  return {
    ok: true,
    payload: {
      title: payload.title,
      severity: payload.severity,
      impact: payload.impact,
      components: [...payload.components],
      relatedTickets: links,
      location: [...payload.location],
      dedupeKey: payload.dedupeKey,
      phase,
    },
  };
}
