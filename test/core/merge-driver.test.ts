import { describe, it, expect } from "vitest";
import { threeWayMerge } from "../../src/core/merge-driver.js";

function ticket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "T-001", title: "Test", description: "", type: "task",
    status: "open", phase: "p1", order: 10, createdDate: "2026-01-01",
    blockedBy: [], parentTicket: null, completedDate: null,
    ...overrides,
  };
}

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ISS-001", title: "Bug", status: "open", severity: "high",
    components: [], impact: "Breaks things", resolution: null,
    location: [], discoveredDate: "2026-01-01", resolvedDate: null,
    relatedTickets: [],
    ...overrides,
  };
}

describe("T-385: threeWayMerge", () => {
  describe("identity fields", () => {
    it("preserves id from base even if sides differ", () => {
      const base = ticket({ id: "T-001" });
      const ours = ticket({ id: "T-001" });
      const theirs = ticket({ id: "T-001" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.merged.id).toBe("T-001");
    });
  });

  describe("clean merge (no divergence)", () => {
    it("takes theirs when only they changed a field", () => {
      const base = ticket({ title: "Original" });
      const ours = ticket({ title: "Original" });
      const theirs = ticket({ title: "Updated" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.merged.title).toBe("Updated");
      expect(result.clean).toBe(true);
    });

    it("takes ours when only we changed a field", () => {
      const base = ticket({ title: "Original" });
      const ours = ticket({ title: "Updated" });
      const theirs = ticket({ title: "Original" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.merged.title).toBe("Updated");
      expect(result.clean).toBe(true);
    });

    it("takes either when both agree", () => {
      const base = ticket({ title: "Original" });
      const ours = ticket({ title: "Same" });
      const theirs = ticket({ title: "Same" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.merged.title).toBe("Same");
      expect(result.clean).toBe(true);
    });
  });

  describe("hard conflict", () => {
    it("emits ConflictEntry for divergent hard-conflict field", () => {
      const base = ticket({ title: "Original" });
      const ours = ticket({ title: "Our version" });
      const theirs = ticket({ title: "Their version" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(false);
      expect(result.conflicts.length).toBeGreaterThan(0);
      const titleConflict = result.conflicts.find((c) => c.fieldPath === "title");
      expect(titleConflict).toBeDefined();
      expect(titleConflict!.base).toBe("Original");
      expect(titleConflict!.ours).toBe("Our version");
      expect(titleConflict!.theirs).toBe("Their version");
      expect(titleConflict!.kind).toBe("field");
    });

    it("includes _conflicts in merged output", () => {
      const base = ticket({ title: "Original" });
      const ours = ticket({ title: "A" });
      const theirs = ticket({ title: "B" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      const merged = result.merged;
      expect(Array.isArray(merged._conflicts)).toBe(true);
      expect((merged._conflicts as unknown[]).length).toBeGreaterThan(0);
    });
  });

  describe("commutative array merge", () => {
    it("unions additions from both sides", () => {
      const base = ticket({ blockedBy: ["T-010"] });
      const ours = ticket({ blockedBy: ["T-010", "T-020"] });
      const theirs = ticket({ blockedBy: ["T-010", "T-030"] });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(true);
      const merged = (result.merged.blockedBy as string[]).sort();
      expect(merged).toEqual(["T-010", "T-020", "T-030"]);
    });

    it("respects deletion by one side", () => {
      const base = ticket({ blockedBy: ["T-010", "T-020"] });
      const ours = ticket({ blockedBy: ["T-010"] });
      const theirs = ticket({ blockedBy: ["T-010", "T-020"] });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(true);
      expect(result.merged.blockedBy).toEqual(["T-010"]);
    });

    it("handles addition + deletion correctly", () => {
      const base = ticket({ blockedBy: ["T-010", "T-020"] });
      const ours = ticket({ blockedBy: ["T-010", "T-030"] });
      const theirs = ticket({ blockedBy: ["T-010"] });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(true);
      const merged = (result.merged.blockedBy as string[]).sort();
      expect(merged).toEqual(["T-010", "T-030"]);
    });
  });

  describe("monotonic fields", () => {
    it("takes max for reinforcements", () => {
      const base = { id: "L-001", title: "Lesson", content: "c", context: "x", source: "manual", tags: [], reinforcements: 3, lastValidated: "2026-01-01", createdDate: "2026-01-01", updatedDate: "2026-01-01", supersedes: null, status: "active" };
      const ours = { ...base, reinforcements: 5 };
      const theirs = { ...base, reinforcements: 7 };
      const result = threeWayMerge(base, ours, theirs, "lesson");
      expect(result.merged.reinforcements).toBe(7);
      expect(result.clean).toBe(true);
    });
  });

  describe("coupled groups", () => {
    it("takes theirs when only they changed the coupled group", () => {
      const base = ticket({ status: "open", completedDate: null, lifecycle: "active" });
      const ours = ticket({ status: "open", completedDate: null, lifecycle: "active" });
      const theirs = ticket({ status: "complete", completedDate: "2026-05-26", lifecycle: "active" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.merged.status).toBe("complete");
      expect(result.merged.completedDate).toBe("2026-05-26");
      expect(result.clean).toBe(true);
    });

    it("emits coupled conflicts for all group members when both sides diverge", () => {
      const base = ticket({ status: "open", completedDate: null, lifecycle: "active" });
      const ours = ticket({ status: "inprogress", completedDate: null, lifecycle: "active" });
      const theirs = ticket({ status: "complete", completedDate: "2026-05-26", lifecycle: "active" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(false);
      const statusConflict = result.conflicts.find((c) => c.fieldPath === "status");
      expect(statusConflict).toBeDefined();
      expect(statusConflict!.kind).toBe("coupled");
      expect(statusConflict!.group).toBe("ticket-status");
    });
  });

  describe("delete-edit detection", () => {
    it("detects one side delete + other side edit", () => {
      const base = ticket({ title: "Original", lifecycle: "active" });
      const ours = ticket({ title: "Original", lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z" });
      const theirs = ticket({ title: "Changed", lifecycle: "active" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(false);
      const deleteEdit = result.conflicts.find((c) => c.kind === "delete-edit");
      expect(deleteEdit).toBeDefined();
    });

    it("clean merge when both sides delete", () => {
      const base = ticket({ lifecycle: "active" });
      const ours = ticket({ lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z" });
      const theirs = ticket({ lifecycle: "deleted", deletedAt: "2026-05-26T01:00:00Z" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(true);
      expect(result.merged.lifecycle).toBe("deleted");
    });
  });

  describe("pre-existing _conflicts", () => {
    it("preserves existing conflicts from ours", () => {
      const existing = [{ fieldPath: "phase", kind: "field", base: "p1", ours: "p2", theirs: "p3" }];
      const base = ticket();
      const ours = ticket({ _conflicts: existing });
      const theirs = ticket();
      const result = threeWayMerge(base, ours, theirs, "ticket");
      const conflicts = result.merged._conflicts as unknown[];
      expect(conflicts).toBeDefined();
      expect(conflicts.some((c: any) => c.fieldPath === "phase")).toBe(true);
    });
  });

  describe("unknown fields", () => {
    it("applies three-way logic to unknown fields", () => {
      const base = ticket({ customField: "base" });
      const ours = ticket({ customField: "ours" });
      const theirs = ticket({ customField: "theirs" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(false);
      expect(result.conflicts.some((c) => c.fieldPath === "customField")).toBe(true);
    });
  });
});
