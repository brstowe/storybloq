/**
 * Shared preparation for the two writers of an issue create: the CLI/MCP
 * command and the autonomous recovery-record preparer (ISS-1221).
 */
import type { ProjectState } from "../core/project-state.js";
import type { IssueCreateInput } from "../core/issue-create-input.js";
import { inferIssuePhaseFromTicket } from "../core/issue-phase-inference.js";
import { findActiveSessionFull } from "./session.js";
import type { UnverifiedIssueCreatePayload } from "./pending-artifacts.js";

/**
 * ISS-1203: an issue filed with no phase is invisible on the Mac app's
 * phase-grouped board. When the caller omits `phase`, default it from the
 * first related ticket's phase, or the active session's current ticket when
 * there is no related ticket. This is only ever a DEFAULT VALUE: nothing
 * about the inference is recorded on the issue, so it is indistinguishable
 * from a phase the caller typed in directly.
 *
 * ISS-1221: that is exactly why there are TWO writers of this value and both
 * must go through this function. `handleIssueCreate` writes it, and the
 * preparer of an `issue_create` recovery record (`resolveIssueCreatePayload`)
 * fingerprints it: phase is part of `issueCreateFingerprint`, so a record
 * whose stored phase differs from what the create writes can never recognize
 * its own result. A caller that has already resolved the phase passes it
 * explicitly, null included, and the create does not infer again.
 *
 * Pitfall: a child ticket's own `phase` can be null while its umbrella
 * carries the real one (leaf tickets are the ones roadmap phase listings
 * group by, but a child's own field is not guaranteed to be populated).
 * The core calculation resolves through the parent in that case rather than
 * leaving the issue phase-less. An umbrella-related ticket has no parent to
 * resolve through, so this is a no-op for it.
 */
export async function inferIssuePhase(
  state: ProjectState,
  resolvedRelatedTicketIds: readonly string[],
  root: string,
): Promise<string | null> {
  let ticketId = resolvedRelatedTicketIds[0];
  if (!ticketId) {
    try {
      ticketId = findActiveSessionFull(root)?.state.ticket?.id;
    } catch {
      // An unreadable session store is not proof a session is running --
      // leave the issue phase-less rather than guess.
    }
  }
  if (!ticketId) return null;
  return inferIssuePhaseFromTicket(state, ticketId);
}

export function issueCreateArgsFromPayload(payload: UnverifiedIssueCreatePayload): IssueCreateInput {
  return {
    title: payload.title,
    severity: payload.severity,
    impact: payload.impact,
    components: [...payload.components],
    relatedTickets: [...payload.relatedTickets],
    location: [...payload.location],
    dedupeKey: payload.dedupeKey,
    phase: payload.phase,
  };
}
