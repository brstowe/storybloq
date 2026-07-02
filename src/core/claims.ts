import type { Claim } from "../models/types.js";
import type { Ticket } from "../models/ticket.js";
import type { Recommendation } from "./recommend.js";

export interface CanClaimResult {
  allowed: boolean;
  claimedBy?: string;
}

export function buildClaim(user: string, branch: string, since: string): Claim {
  return { user, branch, since };
}

export function canClaim(
  ticket: Ticket,
  user: string,
  branch: string,
  force?: boolean,
): CanClaimResult {
  if (!ticket.claim) {
    return { allowed: true };
  }
  if (ticket.claim.user === user && ticket.claim.branch === branch) {
    return { allowed: true };
  }
  if (force) {
    return { allowed: true };
  }
  return { allowed: false, claimedBy: ticket.claim.user };
}

export function isClaimStale(
  claim: Claim,
  thresholdHours: number,
  nowMs?: number,
): boolean {
  const since = Date.parse(claim.since);
  if (isNaN(since)) return true;
  const now = nowMs ?? Date.now();
  const ageHours = (now - since) / (1000 * 60 * 60);
  return ageHours > thresholdHours;
}

export function clearClaimOnComplete(ticket: Ticket): Ticket {
  // ISS-759: gate on key PRESENCE, not truthiness. A completed ticket carrying
  // claimedBySession: null (the pre-ISS-652 release shape) must still have the
  // key deleted rather than surviving as an explicit null on disk.
  if (ticket.status === "complete" && (("claim" in ticket) || ("claimedBySession" in ticket))) {
    const { claim: _, claimedBySession: _claimedBySession, ...rest } = ticket;
    return rest as Ticket;
  }
  return ticket;
}

// Claimed-by-others items are downranked far below unclaimed work but never
// hidden (N-059 decision #22: claims are advisory, surfaced and downranked, not
// removed). The max generator score is ~1000, so this penalty guarantees a
// claimed-by-others candidate sinks beneath every unclaimed one while keeping
// the relative order among claimed items.
const CLAIM_DOWNRANK_PENALTY = 10000;

/// Annotates recommendations with their claim and downranks those claimed by
/// another user (or by anyone, when the current identity is unknown). It never
/// removes a recommendation -- claims are advisory. ISS-681.
export function applyClaimAnnotations(
  recommendations: readonly Recommendation[],
  claims: ReadonlyMap<string, Claim>,
  currentUser: string | null,
): Recommendation[] {
  if (claims.size === 0) {
    return [...recommendations];
  }
  return recommendations.map((rec) => {
    const claim = claims.get(rec.id);
    if (!claim) return rec;
    // Own claim: surface it, no penalty.
    if (currentUser !== null && claim.user === currentUser) {
      return { ...rec, claim };
    }
    // Claimed by another user, or identity unknown (currentUser === null):
    // annotate and downrank, never hide.
    return {
      ...rec,
      claim,
      score: rec.score - CLAIM_DOWNRANK_PENALTY,
      reason: `${rec.reason} (claimed by ${claim.user})`,
    };
  });
}
