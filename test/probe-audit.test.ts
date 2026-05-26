import { describe, it, expect } from "vitest";
import { threeWayMerge, mergeConfig, mergeRoadmap } from "../src/core/merge-driver.js";
import { computeGcPlan } from "../src/core/gc.js";
import { generateKeyBetween, compareByRank, rebalanceRanks } from "../src/core/fractional-index.js";
import { computeReconcilePlan, computeRebalancePlan } from "../src/core/reconcile.js";
import { canClaim, isClaimStale, buildClaim, filterClaimedFromRecommendations } from "../src/core/claims.js";
import { hasConflicts, assertNoConflicts } from "../src/core/conflicts.js";
import { encodeBase32Crockford, generateCanonicalId, CANONICAL_ID_REGEX } from "../src/core/canonical-id.js";
import { resolveRef } from "../src/core/resolver.js";

describe("probe: merge-driver edge cases", () => {
  it("both sides delete same field -- clean merge", () => {
    const base = { id: "t-1", title: "x", description: "d" };
    const ours = { id: "t-1", title: "x" };
    const theirs = { id: "t-1", title: "x" };
    const r = threeWayMerge(base, ours, theirs, "ticket");
    expect(r.clean).toBe(true);
    expect(r.merged.description).toBeUndefined();
  });

  it("ours adds field, theirs unchanged -- field appears in merged", () => {
    const base = { id: "t-1", title: "x" };
    const ours = { id: "t-1", title: "x", rank: "V" };
    const theirs = { id: "t-1", title: "x" };
    const r = threeWayMerge(base, ours, theirs, "ticket");
    expect(r.clean).toBe(true);
    expect(r.merged.rank).toBe("V");
  });

  it("both sides add same value -- convergent, clean", () => {
    const base = { id: "t-1", title: "x" };
    const ours = { id: "t-1", title: "x", rank: "V" };
    const theirs = { id: "t-1", title: "x", rank: "V" };
    const r = threeWayMerge(base, ours, theirs, "ticket");
    expect(r.clean).toBe(true);
    expect(r.merged.rank).toBe("V");
  });

  it("both sides add different value -- hard conflict", () => {
    const base = { id: "t-1", title: "x" };
    const ours = { id: "t-1", title: "x", rank: "A" };
    const theirs = { id: "t-1", title: "x", rank: "Z" };
    const r = threeWayMerge(base, ours, theirs, "ticket");
    expect(r.clean).toBe(false);
    expect(r.conflicts.length).toBeGreaterThan(0);
  });

  it("commutative merge -- union of arrays", () => {
    const base = { id: "t-1", blockedBy: ["T-002"] };
    const ours = { id: "t-1", blockedBy: ["T-002", "T-003"] };
    const theirs = { id: "t-1", blockedBy: ["T-002", "T-004"] };
    const r = threeWayMerge(base, ours, theirs, "ticket");
    expect(r.clean).toBe(true);
    const blocked = r.merged.blockedBy as string[];
    expect(blocked).toContain("T-002");
    expect(blocked).toContain("T-003");
    expect(blocked).toContain("T-004");
  });

  it("coupled group -- both change status differently = conflict", () => {
    const base = { id: "t-1", status: "open", completedDate: null, lifecycle: "active" };
    const ours = { id: "t-1", status: "inprogress", completedDate: null, lifecycle: "active" };
    const theirs = { id: "t-1", status: "complete", completedDate: "2026-01-01", lifecycle: "active" };
    const r = threeWayMerge(base, ours, theirs, "ticket");
    expect(r.clean).toBe(false);
    expect(r.conflicts.some((c) => c.group === "ticket-status")).toBe(true);
  });

  it("delete-edit conflict -- one side deletes, other edits", () => {
    const base = { id: "t-1", title: "x", status: "open", completedDate: null, lifecycle: "active" };
    const ours = { id: "t-1", title: "x", status: "open", completedDate: null, lifecycle: "deleted", deletedAt: "2026-01-01", deletedBy: "alice" };
    const theirs = { id: "t-1", title: "y", status: "open", completedDate: null, lifecycle: "active" };
    const r = threeWayMerge(base, ours, theirs, "ticket");
    expect(r.clean).toBe(false);
    expect(r.conflicts.some((c) => c.kind === "delete-edit")).toBe(true);
  });

  it("latest-wins claim -- later timestamp wins", () => {
    const base = { id: "t-1", claim: { user: "alice", branch: "a", since: "2026-01-01T00:00:00Z" } };
    const ours = { id: "t-1", claim: { user: "bob", branch: "b", since: "2026-01-02T00:00:00Z" } };
    const theirs = { id: "t-1", claim: { user: "carol", branch: "c", since: "2026-01-03T00:00:00Z" } };
    const r = threeWayMerge(base, ours, theirs, "ticket");
    expect(r.clean).toBe(true);
    expect((r.merged.claim as Record<string, unknown>).user).toBe("carol");
  });

  it("monotonic reinforcements -- max wins", () => {
    const base = { id: "l-1", reinforcements: 3 };
    const ours = { id: "l-1", reinforcements: 5 };
    const theirs = { id: "l-1", reinforcements: 7 };
    const r = threeWayMerge(base, ours, theirs, "lesson");
    expect(r.clean).toBe(true);
    expect(r.merged.reinforcements).toBe(7);
  });
});

describe("probe: mergeConfig edge cases", () => {
  it("config delete-vs-edit preserves base value", () => {
    const base = { schemaVersion: 2, team: { claimStalenessHours: 48 } };
    const ours = { schemaVersion: 2 };
    const theirs = { schemaVersion: 2, team: { claimStalenessHours: 72 } };
    const r = mergeConfig(base, ours, theirs);
    expect(r.clean).toBe(false);
    expect(r.merged.team).toEqual({ claimStalenessHours: 48 });
  });

  it("config known-object key as scalar throws even on one-sided add", () => {
    const base = { schemaVersion: 2 };
    const ours = { schemaVersion: 2, team: "invalid" };
    const theirs = { schemaVersion: 2 };
    expect(() => mergeConfig(base, ours, theirs)).toThrow(/must be an object/);
  });

  it("deep merge nested objects", () => {
    const base = { features: { boardView: true } };
    const ours = { features: { boardView: true, timeline: true } };
    const theirs = { features: { boardView: true, calendar: true } };
    const r = mergeConfig(base, ours, theirs);
    expect(r.clean).toBe(true);
    const features = r.merged.features as Record<string, unknown>;
    expect(features.boardView).toBe(true);
    expect(features.timeline).toBe(true);
    expect(features.calendar).toBe(true);
  });
});

describe("probe: mergeRoadmap keyed array edge cases", () => {
  it("both sides add same phase with different content -- conflict", () => {
    const base = { phases: [{ id: "p1", title: "Phase 1" }] };
    const ours = { phases: [{ id: "p1", title: "Phase 1" }, { id: "p2", title: "New A" }] };
    const theirs = { phases: [{ id: "p1", title: "Phase 1" }, { id: "p2", title: "New B" }] };
    const r = mergeRoadmap(base, ours, theirs);
    expect(r.conflicts.length).toBeGreaterThan(0);
  });

  it("one side removes, other edits -- delete-edit conflict", () => {
    const base = { phases: [{ id: "p1", title: "A" }, { id: "p2", title: "B" }] };
    const ours = { phases: [{ id: "p1", title: "A" }] };
    const theirs = { phases: [{ id: "p1", title: "A" }, { id: "p2", title: "B edited" }] };
    const r = mergeRoadmap(base, ours, theirs);
    expect(r.conflicts.some((c) => c.kind === "delete-edit")).toBe(true);
  });

  it("blocker monotonic cleared -- once cleared stays cleared", () => {
    const base = { blockers: [{ name: "b1", cleared: false }] };
    const ours = { blockers: [{ name: "b1", cleared: true, clearedDate: "2026-01-02" }] };
    const theirs = { blockers: [{ name: "b1", cleared: false }] };
    const r = mergeRoadmap(base, ours, theirs);
    expect(r.clean).toBe(true);
    const b = (r.merged.blockers as Record<string, unknown>[])[0]!;
    expect(b.cleared).toBe(true);
  });
});

describe("probe: GC reference chain safety", () => {
  it("retained tombstone referencing candidate blocks GC", () => {
    const state = {
      tickets: [
        { id: "t-old-parent", lifecycle: "deleted", deletedAt: "2025-01-01", deletedBy: "x", blockedBy: [], status: "open" },
        { id: "t-young-child", lifecycle: "deleted", deletedAt: new Date(Date.now() - 5 * 86400000).toISOString(), deletedBy: "x", blockedBy: [], parentTicket: "t-old-parent", status: "open" },
      ],
      issues: [],
      notes: [],
      lessons: [],
      activeTickets: [],
      activeIssues: [],
    } as any;
    const plan = computeGcPlan(state, { retentionDays: 30 });
    const parentCandidate = plan.candidates.find((c) => c.id === "t-old-parent");
    expect(parentCandidate).toBeDefined();
    expect(parentCandidate!.activeReferences.length).toBeGreaterThan(0);
    expect(plan.eligible.find((c) => c.id === "t-old-parent")).toBeUndefined();
  });
});

describe("probe: fractional-index comprehensive", () => {
  it("generateKeyBetween(null, '0') throws", () => {
    expect(() => generateKeyBetween(null, "0")).toThrow(/minimum rank/);
  });

  it("generateKeyBetween(null, '00') returns '0' (truncation)", () => {
    const r = generateKeyBetween(null, "00");
    expect(r).toBe("0");
    expect(r < "00").toBe(true);
  });

  it("generateKeyBetween(null, '000') returns '00'", () => {
    const r = generateKeyBetween(null, "000");
    expect(r).toBe("00");
    expect(r < "000").toBe(true);
  });

  it("generateKeyBetween(null, '0V') preserves ordering", () => {
    const r = generateKeyBetween(null, "0V");
    expect(r < "0V").toBe(true);
  });

  it("generateKeyBetween(null, '00V') preserves ordering", () => {
    const r = generateKeyBetween(null, "00V");
    expect(r < "00V").toBe(true);
  });

  it("rebalanceRanks produces strictly increasing keys", () => {
    const ranks = rebalanceRanks(20);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]! > ranks[i - 1]!).toBe(true);
    }
  });

  it("100 sequential inserts maintain ordering", () => {
    const keys: string[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 100; i++) {
      const key = generateKeyBetween(prev, null);
      if (prev !== null) expect(key > prev).toBe(true);
      keys.push(key);
      prev = key;
    }
  });

  it("interleaved inserts maintain ordering", () => {
    const a = generateKeyBetween(null, null);
    const b = generateKeyBetween(a, null);
    const mid = generateKeyBetween(a, b);
    expect(mid > a).toBe(true);
    expect(mid < b).toBe(true);
  });

  it("compareByRank: ranked before unranked", () => {
    const ranked = { id: "t-2", rank: "V" };
    const unranked = { id: "t-1", order: 1 };
    expect(compareByRank(ranked, unranked)).toBeLessThan(0);
  });

  it("compareByRank: numeric displayId tiebreaker for unranked", () => {
    const a = { id: "c-1", displayId: "T-002", order: 1 };
    const b = { id: "c-2", displayId: "T-010", order: 1 };
    expect(compareByRank(a, b)).toBeLessThan(0);
  });
});

describe("probe: claims edge cases", () => {
  it("isClaimStale with invalid date returns true", () => {
    expect(isClaimStale({ user: "x", branch: "b", since: "not-a-date" }, 48)).toBe(true);
  });

  it("isClaimStale with future date returns false", () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    expect(isClaimStale({ user: "x", branch: "b", since: future }, 48)).toBe(false);
  });

  it("canClaim -- same user same branch = allowed", () => {
    const ticket = { claim: { user: "alice", branch: "feat", since: "2026-01-01" } } as any;
    expect(canClaim(ticket, "alice", "feat").allowed).toBe(true);
  });

  it("canClaim -- different user without force = denied", () => {
    const ticket = { claim: { user: "alice", branch: "feat", since: "2026-01-01" } } as any;
    const r = canClaim(ticket, "bob", "other");
    expect(r.allowed).toBe(false);
    expect(r.claimedBy).toBe("alice");
  });

  it("filterClaimedFromRecommendations -- null user returns all", () => {
    const recs = [{ id: "t-1" }, { id: "t-2" }] as any;
    const claims = new Map([["t-1", { user: "alice", branch: "a", since: "" }]]);
    expect(filterClaimedFromRecommendations(recs, claims, null)).toHaveLength(2);
  });
});

describe("probe: conflicts module", () => {
  it("hasConflicts detects _conflicts array", () => {
    const state = { tickets: [{ id: "t-1", _conflicts: [{ fieldPath: "/title" }] }], issues: [], notes: [], lessons: [] } as any;
    const r = hasConflicts(state);
    expect(r.hasConflicts).toBe(true);
    expect(r.items[0]!.conflictCount).toBe(1);
  });

  it("assertNoConflicts throws with summary", () => {
    const state = { tickets: [{ id: "t-1", _conflicts: [{}] }], issues: [], notes: [], lessons: [] } as any;
    expect(() => assertNoConflicts(state)).toThrow(/t-1/);
  });
});

describe("probe: canonical-id", () => {
  it("generates 16-char base32 IDs", () => {
    for (let i = 0; i < 50; i++) {
      const id = generateCanonicalId("t");
      expect(CANONICAL_ID_REGEX.test(id)).toBe(true);
      expect(id.startsWith("t-")).toBe(true);
      expect(id.length).toBe(18);
    }
  });

  it("IDs are unique", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(generateCanonicalId("t"));
    expect(ids.size).toBe(100);
  });

  it("encodeBase32Crockford handles zero bytes", () => {
    const zeros = new Uint8Array(10);
    const encoded = encodeBase32Crockford(zeros);
    expect(encoded.length).toBe(16);
    expect(encoded).toMatch(/^0+$/);
  });
});

describe("probe: resolveRef", () => {
  function buildIndexes<T extends { id: string; displayId?: string | null }>(items: T[]) {
    const primary = new Map(items.map((i) => [i.id, i]));
    const secondary = new Map<string, T[]>();
    for (const item of items) {
      const did = item.displayId ?? item.id;
      let arr = secondary.get(did);
      if (!arr) { arr = []; secondary.set(did, arr); }
      arr.push(item);
    }
    return { primary, secondary };
  }

  it("found by displayId", () => {
    const items = [{ id: "c-abc", displayId: "T-001" }];
    const { primary, secondary } = buildIndexes(items);
    const r = resolveRef("T-001", primary, secondary, items);
    expect(r.kind).toBe("found");
  });

  it("found by canonical id", () => {
    const items = [{ id: "t-abc123def456gh", displayId: "T-001" }];
    const { primary, secondary } = buildIndexes(items);
    const r = resolveRef("t-abc123def456gh", primary, secondary, items);
    expect(r.kind).toBe("found");
  });

  it("ambiguous returns all matches", () => {
    const items = [
      { id: "c-1", displayId: "T-001" },
      { id: "c-2", displayId: "T-001" },
    ];
    const { primary, secondary } = buildIndexes(items);
    const r = resolveRef("T-001", primary, secondary, items);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.matches.length).toBe(2);
  });

  it("missing ref returns missing", () => {
    const items = [{ id: "c-1", displayId: "T-001" }];
    const { primary, secondary } = buildIndexes(items);
    const r = resolveRef("T-999", primary, secondary, items);
    expect(r.kind).toBe("missing");
  });

  it("found by previousDisplayIds", () => {
    const items = [{ id: "c-1", displayId: "T-002", previousDisplayIds: ["T-001"] }];
    const { primary, secondary } = buildIndexes(items);
    const r = resolveRef("T-001", primary, secondary, items);
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.matchedBy).toBe("previousDisplayId");
  });
});
