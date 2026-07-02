import { describe, it, expect } from "vitest";
import {
  buildClaim,
  canClaim,
  isClaimStale,
  clearClaimOnComplete,
  applyClaimAnnotations,
} from "../../src/core/claims.js";
import type { Claim } from "../../src/models/types.js";
import type { Ticket } from "../../src/models/ticket.js";
import { makeTicket, makeState, makeRoadmap, makePhase } from "./test-factories.js";

const now = "2026-05-26T12:00:00.000Z";

describe("buildClaim", () => {
  it("creates claim with user, branch, and timestamp", () => {
    const claim = buildClaim("alice@example.com", "feature/foo", now);
    expect(claim.user).toBe("alice@example.com");
    expect(claim.branch).toBe("feature/foo");
    expect(claim.since).toBe(now);
  });
});

describe("canClaim", () => {
  it("allows claim on unclaimed ticket", () => {
    const ticket = makeTicket({ id: "T-001" }) as Ticket;
    const result = canClaim(ticket, "alice@example.com", "feature/foo");
    expect(result.allowed).toBe(true);
  });

  it("allows re-claim by same user on same branch", () => {
    const ticket = makeTicket({
      id: "T-001",
      claim: { user: "alice@example.com", branch: "feature/foo", since: now },
    }) as Ticket;
    const result = canClaim(ticket, "alice@example.com", "feature/foo");
    expect(result.allowed).toBe(true);
  });

  it("rejects claim when claimed by another user without force", () => {
    const ticket = makeTicket({
      id: "T-001",
      claim: { user: "bob@example.com", branch: "feature/bar", since: now },
    }) as Ticket;
    const result = canClaim(ticket, "alice@example.com", "feature/foo");
    expect(result.allowed).toBe(false);
    expect(result.claimedBy).toBe("bob@example.com");
  });

  it("allows claim when forced even if claimed by another", () => {
    const ticket = makeTicket({
      id: "T-001",
      claim: { user: "bob@example.com", branch: "feature/bar", since: now },
    }) as Ticket;
    const result = canClaim(ticket, "alice@example.com", "feature/foo", true);
    expect(result.allowed).toBe(true);
  });
});

describe("isClaimStale", () => {
  it("returns false for fresh claim within threshold", () => {
    const claim: Claim = { user: "alice@example.com", branch: "feature/foo", since: now };
    const checkTime = new Date(now).getTime() + 1 * 60 * 60 * 1000; // 1 hour later
    expect(isClaimStale(claim, 48, checkTime)).toBe(false);
  });

  it("returns true for claim older than threshold", () => {
    const claim: Claim = { user: "alice@example.com", branch: "feature/foo", since: now };
    const checkTime = new Date(now).getTime() + 49 * 60 * 60 * 1000; // 49 hours later
    expect(isClaimStale(claim, 48, checkTime)).toBe(true);
  });
});

describe("clearClaimOnComplete", () => {
  it("clears claim when ticket status becomes complete", () => {
    const ticket = makeTicket({
      id: "T-001",
      status: "complete",
      claim: { user: "alice@example.com", branch: "feature/foo", since: now },
      claimedBySession: "session-1",
    }) as Ticket;
    const result = clearClaimOnComplete(ticket);
    expect(result.claim).toBeUndefined();
    expect(result.claimedBySession).toBeUndefined();
  });

  it("preserves claim when ticket is not complete", () => {
    const ticket = makeTicket({
      id: "T-001",
      status: "inprogress",
      claim: { user: "alice@example.com", branch: "feature/foo", since: now },
    }) as Ticket;
    const result = clearClaimOnComplete(ticket);
    expect(result.claim).toBeDefined();
  });

  // ISS-759(a): the gate must be key PRESENCE, not truthiness. A completed
  // ticket carrying claimedBySession: null (the pre-ISS-652 release shape)
  // must still have the KEY stripped, not survive as an explicit null.
  it("strips a present-but-null claimedBySession key on complete (ISS-759)", () => {
    const ticket = makeTicket({
      id: "T-001",
      status: "complete",
      claimedBySession: null,
    }) as Ticket;
    const result = clearClaimOnComplete(ticket);
    expect("claimedBySession" in result).toBe(false);
    expect("claim" in result).toBe(false);
  });
});

describe("applyClaimAnnotations", () => {
  const baseRec = (id: string, score: number) =>
    ({ id, kind: "ticket" as const, title: id, category: "open_ticket" as const, reason: "ready", score });

  it("downranks and annotates tickets claimed by others, keeping them visible", () => {
    const recs = [baseRec("T-001", 100), baseRec("T-002", 90)];
    const claims = new Map<string, Claim>([
      ["T-002", { user: "bob@example.com", branch: "feature/bar", since: now }],
    ]);
    const result = applyClaimAnnotations(recs, claims, "alice@example.com");
    expect(result).toHaveLength(2); // never removed (ISS-681)
    const t002 = result.find((r) => r.id === "T-002")!;
    expect(t002.claim?.user).toBe("bob@example.com");
    expect(t002.reason).toContain("claimed by bob@example.com");
    expect(t002.score).toBeLessThan(90); // downranked
  });

  it("annotates the current user's own claimed ticket without a penalty", () => {
    const recs = [baseRec("T-001", 100)];
    const claims = new Map<string, Claim>([
      ["T-001", { user: "alice@example.com", branch: "feature/foo", since: now }],
    ]);
    const result = applyClaimAnnotations(recs, claims, "alice@example.com");
    expect(result).toHaveLength(1);
    expect(result[0]!.claim?.user).toBe("alice@example.com");
    expect(result[0]!.score).toBe(100); // no penalty for owner
    expect(result[0]!.reason).not.toContain("claimed by");
  });

  it("returns recommendations unchanged when no claims exist", () => {
    const recs = [baseRec("T-001", 100)];
    const result = applyClaimAnnotations(recs, new Map(), "alice@example.com");
    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBe(100);
    expect(result[0]!.claim).toBeUndefined();
  });

  it("downranks (never drops) claimed tickets when currentUser is null (identity unavailable)", () => {
    const recs = [baseRec("T-001", 100)];
    const claims = new Map<string, Claim>([
      ["T-001", { user: "bob@example.com", branch: "feature/bar", since: now }],
    ]);
    const result = applyClaimAnnotations(recs, claims, null);
    expect(result).toHaveLength(1); // ISS-681: never hidden, even with unknown identity
    expect(result[0]!.score).toBeLessThan(100);
    expect(result[0]!.claim?.user).toBe("bob@example.com");
  });
});
