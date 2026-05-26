import { describe, it, expect } from "vitest";
import { hasConflicts } from "../../src/core/conflicts.js";
import { makeTicket, makeIssue, makeState } from "../core/test-factories.js";
import { checkAutonomousConflicts } from "../../src/autonomous/conflicts-guard.js";

describe("T-384: autonomous _conflicts enforcement", () => {
  describe("checkAutonomousConflicts", () => {
    it("returns error message when project has conflicted ticket", () => {
      const ticket = makeTicket({ id: "T-001" });
      (ticket as Record<string, unknown>)._conflicts = [
        { fieldPath: "status", kind: "field", base: "open", ours: "inprogress", theirs: "complete" },
      ];
      const state = makeState({ tickets: [ticket] });
      const result = checkAutonomousConflicts(state);
      expect(result).not.toBeNull();
      expect(result).toContain("conflicts");
      expect(result).toContain("T-001");
    });

    it("returns error message when project has conflicted issue", () => {
      const issue = makeIssue({ id: "ISS-001" });
      (issue as Record<string, unknown>)._conflicts = [
        { fieldPath: "severity", kind: "field", base: "low", ours: "high", theirs: "medium" },
      ];
      const state = makeState({ issues: [issue] });
      const result = checkAutonomousConflicts(state);
      expect(result).not.toBeNull();
      expect(result).toContain("conflicts");
      expect(result).toContain("ISS-001");
    });

    it("returns null when no conflicts present", () => {
      const state = makeState({
        tickets: [makeTicket({ id: "T-001" })],
        issues: [makeIssue({ id: "ISS-001" })],
      });
      const result = checkAutonomousConflicts(state);
      expect(result).toBeNull();
    });

    it("includes resolve instruction in error message", () => {
      const ticket = makeTicket({ id: "T-001" });
      (ticket as Record<string, unknown>)._conflicts = [
        { fieldPath: "status", kind: "field", base: "a", ours: "b", theirs: "c" },
      ];
      const state = makeState({ tickets: [ticket] });
      const result = checkAutonomousConflicts(state);
      expect(result).toContain("storybloq resolve");
    });

    it("reports all conflicted items in the error", () => {
      const t1 = makeTicket({ id: "T-001" });
      (t1 as Record<string, unknown>)._conflicts = [
        { fieldPath: "status", kind: "field", base: "a", ours: "b", theirs: "c" },
      ];
      const i1 = makeIssue({ id: "ISS-005" });
      (i1 as Record<string, unknown>)._conflicts = [
        { fieldPath: "title", kind: "field", base: "a", ours: "b", theirs: "c" },
      ];
      const state = makeState({ tickets: [t1], issues: [i1] });
      const result = checkAutonomousConflicts(state);
      expect(result).toContain("T-001");
      expect(result).toContain("ISS-005");
    });
  });
});
