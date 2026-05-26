import { describe, it, expect } from "vitest";
import { computeRebalancePlan } from "../../src/core/reconcile.js";
import { REBALANCE_THRESHOLD, compareByRank } from "../../src/core/fractional-index.js";

function fakeState(tickets: Array<{ id: string; rank?: string; order: number; phase: string; displayId?: string }>): any {
  const phases = [...new Set(tickets.map((t) => t.phase))];
  return {
    config: { version: 2 },
    tickets,
    issues: [],
    notes: [],
    lessons: [],
    phaseTickets(phaseId: string) {
      return tickets.filter((t) => t.phase === phaseId).sort(compareByRank);
    },
    roadmap: { phases: phases.map((id) => ({ id, label: id, name: id, description: "" })) },
  };
}

describe("T-390: reconcile rebalance", () => {
  it("no changes when all ranks are short", () => {
    const state = fakeState([
      { id: "t-1", rank: "V", order: 10, phase: "p1" },
      { id: "t-2", rank: "X", order: 20, phase: "p1" },
    ]);
    const result = computeRebalancePlan(state);
    expect(result.changes).toHaveLength(0);
  });

  it("changes when any rank exceeds threshold", () => {
    const longRank = "V".repeat(REBALANCE_THRESHOLD + 5);
    const state = fakeState([
      { id: "t-1", rank: "A", order: 10, phase: "p1" },
      { id: "t-2", rank: longRank, order: 20, phase: "p1" },
    ]);
    const result = computeRebalancePlan(state);
    expect(result.changes.length).toBeGreaterThan(0);
  });

  it("rebalanced ranks preserve sort order", () => {
    const longRank = "V".repeat(REBALANCE_THRESHOLD + 5);
    const state = fakeState([
      { id: "t-1", rank: "A", order: 10, phase: "p1" },
      { id: "t-2", rank: "M", order: 20, phase: "p1" },
      { id: "t-3", rank: longRank, order: 30, phase: "p1" },
    ]);
    const result = computeRebalancePlan(state);
    const oldOrder = ["t-1", "t-2", "t-3"];
    const newRanks = new Map<string, string>();
    for (const c of result.changes) newRanks.set(c.id, c.newRank);
    const items = [
      { id: "t-1", rank: newRanks.get("t-1") ?? "A" },
      { id: "t-2", rank: newRanks.get("t-2") ?? "M" },
      { id: "t-3", rank: newRanks.get("t-3") ?? longRank },
    ];
    items.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
    expect(items.map((i) => i.id)).toEqual(oldOrder);
  });

  it("rebalanced ranks are shorter than originals", () => {
    const longRank = "V".repeat(REBALANCE_THRESHOLD + 5);
    const state = fakeState([
      { id: "t-1", rank: longRank, order: 10, phase: "p1" },
    ]);
    const result = computeRebalancePlan(state);
    for (const c of result.changes) {
      expect(c.newRank.length).toBeLessThan(c.oldRank.length);
    }
  });

  it("idempotent: second run produces no changes", () => {
    const longRank = "V".repeat(REBALANCE_THRESHOLD + 5);
    const tickets = [
      { id: "t-1", rank: "A", order: 10, phase: "p1" },
      { id: "t-2", rank: longRank, order: 20, phase: "p1" },
    ];
    const state1 = fakeState(tickets);
    const result1 = computeRebalancePlan(state1);
    for (const c of result1.changes) {
      const t = tickets.find((t) => t.id === c.id)!;
      t.rank = c.newRank;
    }
    const state2 = fakeState(tickets);
    const result2 = computeRebalancePlan(state2);
    expect(result2.changes).toHaveLength(0);
  });

  it("skips items with _conflicts", () => {
    const longRank = "V".repeat(REBALANCE_THRESHOLD + 5);
    const state = fakeState([
      { id: "t-1", rank: longRank, order: 10, phase: "p1" },
    ]);
    (state.tickets[0] as any)._conflicts = [{ fieldPath: "/rank" }];
    const result = computeRebalancePlan(state);
    expect(result.changes).toHaveLength(0);
  });
});
