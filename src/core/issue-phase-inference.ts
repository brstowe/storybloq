/**
 * The state-only half of issue phase inference (ISS-1203, ISS-1221): a
 * ticket's own phase, else the phase of its resolved umbrella parent, else
 * null. Session discovery lives above this, in the autonomous layer, so
 * core never reaches into the session store.
 */
import type { ProjectState } from "./project-state.js";

export function inferIssuePhaseFromTicket(state: ProjectState, ticketId: string): string | null {
  const ticket = state.activeTickets.find((t) => t.id === ticketId);
  if (!ticket) return null;
  if (ticket.phase != null) return ticket.phase;
  return state.resolvedParent(ticket)?.phase ?? null;
}
