import { describe, it, expect } from "vitest";
import { mergeRoadmap } from "../../src/core/merge-driver.js";

function roadmap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "test-project",
    date: "2026-01-15",
    phases: [
      { id: "alpha", label: "ALPHA", name: "Alpha Phase", description: "Initial." },
      { id: "beta", label: "BETA", name: "Beta Phase", description: "Second." },
    ],
    blockers: [],
    ...overrides,
  };
}

describe("T-387: mergeRoadmap", () => {
  describe("scalar fields (standard three-way)", () => {
    it("takes changed side for title", () => {
      const base = roadmap({ title: "old" });
      const ours = roadmap({ title: "old" });
      const theirs = roadmap({ title: "new" });
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.merged.title).toBe("new");
      expect(result.clean).toBe(true);
    });

    it("conflicts on divergent date", () => {
      const base = roadmap({ date: "2026-01-01" });
      const ours = roadmap({ date: "2026-02-01" });
      const theirs = roadmap({ date: "2026-03-01" });
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(false);
      expect(result.conflicts.some((c) => c.fieldPath === "/date")).toBe(true);
    });
  });

  describe("phases: keyed array merge", () => {
    it("both add same phase id with same content = clean", () => {
      const base = roadmap();
      const newPhase = { id: "gamma", label: "GAMMA", name: "Gamma", description: "Same." };
      const ours = roadmap({
        phases: [
          { id: "alpha", label: "ALPHA", name: "Alpha Phase", description: "Initial." },
          { id: "beta", label: "BETA", name: "Beta Phase", description: "Second." },
          newPhase,
        ],
      });
      const theirs = roadmap({
        phases: [
          { id: "alpha", label: "ALPHA", name: "Alpha Phase", description: "Initial." },
          { id: "beta", label: "BETA", name: "Beta Phase", description: "Second." },
          newPhase,
        ],
      });
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      const phases = result.merged.phases as Array<Record<string, unknown>>;
      expect(phases.length).toBe(3);
    });

    it("both add same phase id with different content = conflict", () => {
      const base = roadmap();
      const ours = roadmap({
        phases: [
          { id: "alpha", label: "ALPHA", name: "Alpha Phase", description: "Initial." },
          { id: "beta", label: "BETA", name: "Beta Phase", description: "Second." },
          { id: "gamma", label: "GAMMA", name: "Our Gamma", description: "Ours." },
        ],
      });
      const theirs = roadmap({
        phases: [
          { id: "alpha", label: "ALPHA", name: "Alpha Phase", description: "Initial." },
          { id: "beta", label: "BETA", name: "Beta Phase", description: "Second." },
          { id: "gamma", label: "GAMMA", name: "Their Gamma", description: "Theirs." },
        ],
      });
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(false);
    });

    it("both add different phases = auto-merge", () => {
      const base = roadmap();
      const ours = roadmap({
        phases: [
          { id: "alpha", label: "ALPHA", name: "Alpha Phase", description: "Initial." },
          { id: "beta", label: "BETA", name: "Beta Phase", description: "Second." },
          { id: "gamma", label: "GAMMA", name: "Gamma", description: "Ours added." },
        ],
      });
      const theirs = roadmap({
        phases: [
          { id: "alpha", label: "ALPHA", name: "Alpha Phase", description: "Initial." },
          { id: "beta", label: "BETA", name: "Beta Phase", description: "Second." },
          { id: "delta", label: "DELTA", name: "Delta", description: "Theirs added." },
        ],
      });
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      const phases = result.merged.phases as Array<Record<string, unknown>>;
      const ids = phases.map((p) => p.id);
      expect(ids).toContain("alpha");
      expect(ids).toContain("beta");
      expect(ids).toContain("gamma");
      expect(ids).toContain("delta");
    });

    it("same phase id, only one side edits = clean merge", () => {
      const base = roadmap();
      const ours = roadmap();
      const theirs = roadmap({
        phases: [
          { id: "alpha", label: "ALPHA", name: "Alpha Updated", description: "Initial." },
          { id: "beta", label: "BETA", name: "Beta Phase", description: "Second." },
        ],
      });
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      const phases = result.merged.phases as Array<Record<string, unknown>>;
      const alpha = phases.find((p) => p.id === "alpha");
      expect(alpha!.name).toBe("Alpha Updated");
    });

    it("same phase id, both edit different fields = clean field-level merge", () => {
      const base = roadmap();
      const ours = roadmap({
        phases: [
          { id: "alpha", label: "ALPHA-NEW", name: "Alpha Phase", description: "Initial." },
          { id: "beta", label: "BETA", name: "Beta Phase", description: "Second." },
        ],
      });
      const theirs = roadmap({
        phases: [
          { id: "alpha", label: "ALPHA", name: "Alpha Phase", description: "Updated desc." },
          { id: "beta", label: "BETA", name: "Beta Phase", description: "Second." },
        ],
      });
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      const phases = result.merged.phases as Array<Record<string, unknown>>;
      const alpha = phases.find((p) => p.id === "alpha");
      expect(alpha!.label).toBe("ALPHA-NEW");
      expect(alpha!.description).toBe("Updated desc.");
    });

    it("same phase id, both edit same field differently = conflict", () => {
      const base = roadmap();
      const ours = roadmap({
        phases: [
          { id: "alpha", label: "ALPHA", name: "Our Name", description: "Initial." },
          { id: "beta", label: "BETA", name: "Beta Phase", description: "Second." },
        ],
      });
      const theirs = roadmap({
        phases: [
          { id: "alpha", label: "ALPHA", name: "Their Name", description: "Initial." },
          { id: "beta", label: "BETA", name: "Beta Phase", description: "Second." },
        ],
      });
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(false);
      expect(result.conflicts.length).toBeGreaterThan(0);
    });

    it("one side reorders existing phases = take reorder", () => {
      const base = roadmap();
      const ours = roadmap({
        phases: [
          { id: "beta", label: "BETA", name: "Beta Phase", description: "Second." },
          { id: "alpha", label: "ALPHA", name: "Alpha Phase", description: "Initial." },
        ],
      });
      const theirs = roadmap();
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      const phases = result.merged.phases as Array<Record<string, unknown>>;
      expect(phases[0].id).toBe("beta");
      expect(phases[1].id).toBe("alpha");
    });

    it("one side reorders + adds new phase = both preserved", () => {
      const base = roadmap();
      const ours = roadmap({
        phases: [
          { id: "beta", label: "BETA", name: "Beta Phase", description: "Second." },
          { id: "alpha", label: "ALPHA", name: "Alpha Phase", description: "Initial." },
          { id: "gamma", label: "GAMMA", name: "Gamma", description: "New." },
        ],
      });
      const theirs = roadmap();
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      const phases = result.merged.phases as Array<Record<string, unknown>>;
      const ids = phases.map((p) => p.id);
      expect(ids).toContain("gamma");
      expect(ids[0]).toBe("beta");
      expect(ids[1]).toBe("alpha");
    });

    it("one side deletes while the other keeps base order without false reorder conflict", () => {
      const base = roadmap({
        phases: [
          { id: "a", label: "A", name: "A", description: "A" },
          { id: "b", label: "B", name: "B", description: "B" },
          { id: "c", label: "C", name: "C", description: "C" },
        ],
      });
      const ours = roadmap({ phases: base.phases });
      const theirs = roadmap({
        phases: [
          { id: "a", label: "A", name: "A", description: "A" },
          { id: "c", label: "C", name: "C", description: "C" },
        ],
      });
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      expect(result.conflicts.some((c) => c.fieldPath === "/phases")).toBe(false);
      expect((result.merged.phases as Array<Record<string, unknown>>).map((p) => p.id)).toEqual(["a", "c"]);
    });

    it("both sides reorder differently = conflict", () => {
      const base = roadmap({
        phases: [
          { id: "a", label: "A", name: "A", description: "A" },
          { id: "b", label: "B", name: "B", description: "B" },
          { id: "c", label: "C", name: "C", description: "C" },
        ],
      });
      const ours = roadmap({
        phases: [
          { id: "c", label: "C", name: "C", description: "C" },
          { id: "a", label: "A", name: "A", description: "A" },
          { id: "b", label: "B", name: "B", description: "B" },
        ],
      });
      const theirs = roadmap({
        phases: [
          { id: "b", label: "B", name: "B", description: "B" },
          { id: "c", label: "C", name: "C", description: "C" },
          { id: "a", label: "A", name: "A", description: "A" },
        ],
      });
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(false);
    });

    it("remove by one side + unchanged by other = remove", () => {
      const base = roadmap();
      const ours = roadmap({
        phases: [
          { id: "alpha", label: "ALPHA", name: "Alpha Phase", description: "Initial." },
        ],
      });
      const theirs = roadmap();
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      const phases = result.merged.phases as Array<Record<string, unknown>>;
      expect(phases.length).toBe(1);
      expect(phases[0].id).toBe("alpha");
    });

    it("remove + edit = delete-edit conflict", () => {
      const base = roadmap();
      const ours = roadmap({
        phases: [
          { id: "alpha", label: "ALPHA", name: "Alpha Phase", description: "Initial." },
        ],
      });
      const theirs = roadmap({
        phases: [
          { id: "alpha", label: "ALPHA", name: "Alpha Phase", description: "Initial." },
          { id: "beta", label: "BETA-EDIT", name: "Beta Phase", description: "Second." },
        ],
      });
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(false);
      expect(result.conflicts.some((c) => c.kind === "delete-edit")).toBe(true);
    });
  });

  describe("blockers: keyed array merge", () => {
    it("both add different blockers = auto-merge", () => {
      const base = roadmap({ blockers: [] });
      const ours = roadmap({ blockers: [{ name: "npm name", cleared: false }] });
      const theirs = roadmap({ blockers: [{ name: "API key", cleared: false }] });
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      const blockers = result.merged.blockers as Array<Record<string, unknown>>;
      expect(blockers.length).toBe(2);
    });

    it("clearing is monotonic OR", () => {
      const base = roadmap({ blockers: [{ name: "npm name", cleared: false }] });
      const ours = roadmap({ blockers: [{ name: "npm name", cleared: true, clearedDate: "2026-05-01" }] });
      const theirs = roadmap({ blockers: [{ name: "npm name", cleared: false }] });
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      const blockers = result.merged.blockers as Array<Record<string, unknown>>;
      const npm = blockers.find((b) => b.name === "npm name");
      expect(npm!.cleared).toBe(true);
    });

    it("both clear with different dates = take earliest", () => {
      const base = roadmap({ blockers: [{ name: "npm name", cleared: false }] });
      const ours = roadmap({ blockers: [{ name: "npm name", cleared: true, clearedDate: "2026-05-10" }] });
      const theirs = roadmap({ blockers: [{ name: "npm name", cleared: true, clearedDate: "2026-05-01" }] });
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      const blockers = result.merged.blockers as Array<Record<string, unknown>>;
      const npm = blockers.find((b) => b.name === "npm name");
      expect(npm!.clearedDate).toBe("2026-05-01");
    });

    it("clear plus independent note edit = both merge", () => {
      const base = roadmap({ blockers: [{ name: "npm name", cleared: false, note: "original" }] });
      const ours = roadmap({ blockers: [{ name: "npm name", cleared: true, clearedDate: "2026-05-01", note: "original" }] });
      const theirs = roadmap({ blockers: [{ name: "npm name", cleared: false, note: "updated note" }] });
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      const blockers = result.merged.blockers as Array<Record<string, unknown>>;
      const npm = blockers.find((b) => b.name === "npm name");
      expect(npm!.cleared).toBe(true);
      expect(npm!.note).toBe("updated note");
    });
  });

  describe("input validation", () => {
    it("duplicate phase ids cause conflict or failure", () => {
      const base = roadmap();
      const ours = roadmap({
        phases: [
          { id: "alpha", label: "A1", name: "First", description: "d" },
          { id: "alpha", label: "A2", name: "Dupe", description: "d" },
        ],
      });
      const theirs = roadmap();
      expect(() => mergeRoadmap(base, ours, theirs)).toThrow();
    });

    it("missing phase id causes failure", () => {
      const base = roadmap();
      const ours = roadmap({
        phases: [
          { label: "NO-ID", name: "No id", description: "d" },
        ],
      });
      const theirs = roadmap();
      expect(() => mergeRoadmap(base, ours, theirs)).toThrow();
    });
  });

  describe("_conflicts handling", () => {
    it("strips existing _conflicts from inputs", () => {
      const base = roadmap({ _conflicts: [{ fieldPath: "/stale" }] });
      const ours = roadmap();
      const theirs = roadmap();
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      expect(result.merged._conflicts).toBeUndefined();
    });
  });

  describe("ISS-657 placement + ISS-658 reorder/delete-edit", () => {
    const ph = (id: string, name = id.toUpperCase()) => ({
      id,
      label: id.toUpperCase(),
      name,
      description: `${id} desc`,
    });
    const rm = (phases: Array<Record<string, unknown>>) => roadmap({ phases });
    const ids = (r: { merged: Record<string, unknown> }) =>
      (r.merged.phases as Array<Record<string, unknown>>).map((p) => p.id as string);

    it("ISS-658: reordering side deletes an element the other side edits -> delete-edit conflict, not silent loss", () => {
      const base = rm([ph("a"), ph("b"), ph("c")]);
      const ours = rm([ph("c"), ph("b")]); // deletes a, reorders survivors
      const theirs = rm([ph("a", "A-EDIT"), ph("b"), ph("c")]); // edits a
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(false);
      expect(result.conflicts.some((c) => c.kind === "delete-edit")).toBe(true);
      const a = (result.merged.phases as Array<Record<string, unknown>>).find((p) => p.id === "a");
      expect(a).toBeDefined();
      expect(a!.name).toBe("A"); // base retained under conflict; theirs edit surfaced, not dropped
    });

    it("ISS-658 symmetric: theirs reorders+deletes, ours edits", () => {
      const base = rm([ph("a"), ph("b"), ph("c")]);
      const ours = rm([ph("a", "A-EDIT"), ph("b"), ph("c")]);
      const theirs = rm([ph("c"), ph("b")]);
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(false);
      expect(result.conflicts.some((c) => c.kind === "delete-edit")).toBe(true);
      expect((result.merged.phases as Array<Record<string, unknown>>).find((p) => p.id === "a")).toBeDefined();
    });

    it("ISS-658: clean delete under reorder (other side unchanged) -> no false conflict", () => {
      const base = rm([ph("a"), ph("b"), ph("c")]);
      const ours = rm([ph("c"), ph("b")]); // delete a + reorder
      const theirs = rm([ph("a"), ph("b"), ph("c")]); // unchanged
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      expect(ids(result)).not.toContain("a");
      expect(result.conflicts.some((c) => c.fieldPath === "/phases")).toBe(false);
    });

    it("insert after a base id the reordering side deletes unchanged -> addition not dumped at tail", () => {
      const base = rm([ph("a"), ph("b"), ph("c")]);
      const ours = rm([ph("c"), ph("b")]); // delete a + reorder
      const theirs = rm([ph("a"), ph("x"), ph("b"), ph("c")]); // a unchanged, add x after a
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      expect(ids(result)).toEqual(["x", "c", "b"]);
    });

    it("insert after a base id deleted by reorderer AND edited by other -> conflict, base kept, addition present", () => {
      const base = rm([ph("a"), ph("b"), ph("c")]);
      const ours = rm([ph("c"), ph("b")]); // delete a + reorder
      const theirs = rm([ph("a", "A-EDIT"), ph("x"), ph("b"), ph("c")]); // edit a + add x
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(false);
      expect(result.conflicts.some((c) => c.kind === "delete-edit")).toBe(true);
      const merged = ids(result);
      expect(merged).toContain("x");
      expect(merged).toContain("a"); // conflict-kept base
    });

    it("regression lock: non-reorder delete-edit keeps base element in place [a,b,c]", () => {
      const base = rm([ph("a"), ph("b"), ph("c")]);
      const ours = rm([ph("a"), ph("c")]); // delete b, no reorder
      const theirs = rm([ph("a"), ph("b", "B-EDIT"), ph("c")]); // edit b
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(false);
      expect(result.conflicts.some((c) => c.kind === "delete-edit")).toBe(true);
      expect(ids(result)).toEqual(["a", "b", "c"]);
    });

    it("ISS-657: both sides add, placement preserved [X,A,Y,B]", () => {
      const base = rm([ph("A"), ph("B")]);
      const ours = rm([ph("X"), ph("A"), ph("B")]); // add X at start
      const theirs = rm([ph("A"), ph("Y"), ph("B")]); // add Y after A
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      expect(ids(result)).toEqual(["X", "A", "Y", "B"]);
    });

    it("ISS-657: one side reorders, other inserts mid-list", () => {
      const base = rm([ph("A"), ph("B")]);
      const ours = rm([ph("B"), ph("A")]); // reorder
      const theirs = rm([ph("A"), ph("Z"), ph("B")]); // insert Z after A
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      expect(ids(result)).toEqual(["B", "A", "Z"]);
    });

    it("consecutive at-start additions keep source order [X,Y,A,B]", () => {
      const base = rm([ph("A"), ph("B")]);
      const ours = rm([ph("X"), ph("Y"), ph("A"), ph("B")]);
      const theirs = rm([ph("A"), ph("B")]);
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      expect(ids(result)).toEqual(["X", "Y", "A", "B"]);
    });

    it("same-anchor additions on both sides -> ours before theirs [A,X,Y,B]", () => {
      const base = rm([ph("A"), ph("B")]);
      const ours = rm([ph("A"), ph("X"), ph("B")]);
      const theirs = rm([ph("A"), ph("Y"), ph("B")]);
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      expect(ids(result)).toEqual(["A", "X", "Y", "B"]);
    });

    it("chained additions preserve order [A,X,Y,B]", () => {
      const base = rm([ph("A"), ph("B")]);
      const ours = rm([ph("A"), ph("X"), ph("Y"), ph("B")]);
      const theirs = rm([ph("A"), ph("B")]);
      const result = mergeRoadmap(base, ours, theirs);
      expect(result.clean).toBe(true);
      expect(ids(result)).toEqual(["A", "X", "Y", "B"]);
    });
  });
});
