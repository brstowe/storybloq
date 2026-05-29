import { describe, it, expect } from "vitest";
import { computeGcPlan } from "../../src/core/gc.js";
import { makeTicket, makeIssue, makeNote, makeLesson, makeState, makePhase, makeRoadmap } from "./test-factories.js";

const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

describe("computeGcPlan", () => {
  it("finds tombstoned items past retention", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", lifecycle: "deleted", deletedAt: thirtyOneDaysAgo, deletedBy: "alice" }),
      ],
      issues: [
        makeIssue({ id: "ISS-001", lifecycle: "deleted", deletedAt: thirtyOneDaysAgo, deletedBy: "bob" }),
      ],
    });
    const plan = computeGcPlan(state, { retentionDays: 30 });
    expect(plan.eligible.length).toBe(2);
    expect(plan.eligible.map((c) => c.id).sort()).toEqual(["ISS-001", "T-001"]);
  });

  it("skips items within retention period", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", lifecycle: "deleted", deletedAt: tenDaysAgo, deletedBy: "alice" }),
      ],
    });
    const plan = computeGcPlan(state, { retentionDays: 30 });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.eligible).toHaveLength(0);
  });

  it("blocks candidates with active references", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", lifecycle: "deleted", deletedAt: thirtyOneDaysAgo, deletedBy: "alice" }),
        makeTicket({ id: "T-002", blockedBy: ["T-001"] }),
      ],
    });
    const plan = computeGcPlan(state, { retentionDays: 30 });
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.id).toBe("T-001");
    expect(plan.blocked[0]!.activeReferences.length).toBeGreaterThan(0);
    expect(plan.eligible).toHaveLength(0);
  });

  it("blocks a candidate referenced by its displayId or previousDisplayIds (ISS-711)", () => {
    // The tombstone has a canonical id plus a displayId and a previous displayId;
    // active tickets reference it by those rather than the canonical id. The
    // candidateByRef map (built during collection) must resolve all three.
    const state = makeState({
      tickets: [
        makeTicket({
          id: "t-k7m2p9x3w4a5b6e8",
          displayId: "T-051",
          previousDisplayIds: ["T-030"],
          lifecycle: "deleted",
          deletedAt: thirtyOneDaysAgo,
          deletedBy: "alice",
        } as any),
        makeTicket({ id: "T-100", blockedBy: ["T-051"] }),
        makeTicket({ id: "T-101", parentTicket: "T-030" }),
      ],
    });
    const plan = computeGcPlan(state, { retentionDays: 30 });
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.id).toBe("t-k7m2p9x3w4a5b6e8");
    expect(plan.blocked[0]!.activeReferences.sort()).toEqual(["T-100", "T-101"]);
    expect(plan.eligible).toHaveLength(0);
  });

  it("handles empty state", () => {
    const state = makeState({});
    const plan = computeGcPlan(state, { retentionDays: 30 });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.eligible).toHaveLength(0);
    expect(plan.blocked).toHaveLength(0);
    expect(plan.warnings).toHaveLength(0);
  });

  it("respects custom retention days", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", lifecycle: "deleted", deletedAt: tenDaysAgo, deletedBy: "alice" }),
      ],
    });
    const plan = computeGcPlan(state, { retentionDays: 5 });
    expect(plan.eligible).toHaveLength(1);
    expect(plan.eligible[0]!.id).toBe("T-001");
  });

  it("warns on missing/invalid/future deletedAt", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", lifecycle: "deleted", deletedBy: "alice" }),
        makeTicket({ id: "T-002", lifecycle: "deleted", deletedAt: "not-a-date", deletedBy: "bob" }),
        makeTicket({ id: "T-003", lifecycle: "deleted", deletedAt: tomorrow, deletedBy: "carol" }),
      ],
    });
    const plan = computeGcPlan(state, { retentionDays: 30 });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.eligible).toHaveLength(0);
    expect(plan.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("ignores references from other deleted items", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", lifecycle: "deleted", deletedAt: thirtyOneDaysAgo, deletedBy: "alice" }),
        makeTicket({ id: "T-002", lifecycle: "deleted", deletedAt: thirtyOneDaysAgo, deletedBy: "bob", blockedBy: ["T-001"] }),
      ],
    });
    const plan = computeGcPlan(state, { retentionDays: 30 });
    expect(plan.eligible.map((c) => c.id).sort()).toEqual(["T-001", "T-002"]);
    expect(plan.blocked).toHaveLength(0);
  });

  it("finds tombstoned notes past retention", () => {
    const state = makeState({
      notes: [
        makeNote({ id: "N-001", lifecycle: "deleted", deletedAt: thirtyOneDaysAgo, deletedBy: "alice" }),
      ],
    });
    const plan = computeGcPlan(state, { retentionDays: 30 });
    expect(plan.eligible).toHaveLength(1);
    expect(plan.eligible[0]!.id).toBe("N-001");
    expect(plan.eligible[0]!.type).toBe("note");
  });

  it("finds tombstoned lessons past retention", () => {
    const state = makeState({
      lessons: [
        makeLesson({ id: "L-001", lifecycle: "deleted", deletedAt: thirtyOneDaysAgo, deletedBy: "bob" }),
      ],
    });
    const plan = computeGcPlan(state, { retentionDays: 30 });
    expect(plan.eligible).toHaveLength(1);
    expect(plan.eligible[0]!.id).toBe("L-001");
    expect(plan.eligible[0]!.type).toBe("lesson");
  });

  it("blocks GC when issue.relatedTickets references deleted ticket", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", lifecycle: "deleted", deletedAt: thirtyOneDaysAgo, deletedBy: "alice" }),
      ],
      issues: [
        makeIssue({ id: "ISS-001", relatedTickets: ["T-001"] }),
      ],
    });
    const plan = computeGcPlan(state, { retentionDays: 30 });
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.id).toBe("T-001");
    expect(plan.blocked[0]!.activeReferences).toContain("ISS-001");
    expect(plan.eligible).toHaveLength(0);
  });

  it("ignores relatedTickets references from tombstoned issues", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", lifecycle: "deleted", deletedAt: thirtyOneDaysAgo, deletedBy: "alice" }),
      ],
      issues: [
        makeIssue({ id: "ISS-001", lifecycle: "deleted", deletedAt: thirtyOneDaysAgo, deletedBy: "bob", relatedTickets: ["T-001"] }),
      ],
    });
    const plan = computeGcPlan(state, { retentionDays: 30 });
    expect(plan.blocked).toHaveLength(0);
    expect(plan.eligible.map((c) => c.id).sort()).toEqual(["ISS-001", "T-001"]);
  });

  it("blocks GC when an active lesson's supersedes references a deleted lesson (ISS-685)", () => {
    const state = makeState({
      lessons: [
        makeLesson({ id: "L-001", lifecycle: "deleted", deletedAt: thirtyOneDaysAgo, deletedBy: "alice" }),
        makeLesson({ id: "L-002", supersedes: "L-001" }),
      ],
    });
    const plan = computeGcPlan(state, { retentionDays: 30 });
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.id).toBe("L-001");
    expect(plan.blocked[0]!.activeReferences).toContain("L-002");
    expect(plan.eligible).toHaveLength(0);
  });

  it("ignores supersedes references from tombstoned lessons (ISS-685)", () => {
    const state = makeState({
      lessons: [
        makeLesson({ id: "L-001", lifecycle: "deleted", deletedAt: thirtyOneDaysAgo, deletedBy: "alice" }),
        makeLesson({ id: "L-002", lifecycle: "deleted", deletedAt: thirtyOneDaysAgo, deletedBy: "bob", supersedes: "L-001" }),
      ],
    });
    const plan = computeGcPlan(state, { retentionDays: 30 });
    expect(plan.blocked).toHaveLength(0);
    expect(plan.eligible.map((c) => c.id).sort()).toEqual(["L-001", "L-002"]);
  });
});
