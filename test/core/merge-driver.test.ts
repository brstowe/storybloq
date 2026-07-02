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
    // ISS-761: the original test used three identical inputs and asserted
    // nothing (any implementation passes). The sides MUST differ for the
    // identity rule to be exercised.
    it("preserves id from base even if sides differ", () => {
      const base = ticket({ id: "T-001" });
      const ours = ticket({ id: "T-002" });
      const theirs = ticket({ id: "T-003" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.merged.id).toBe("T-001");
    });
  });

  // ISS-761: the issue and note rule tables were previously dead-untested;
  // every threeWayMerge test went through "ticket" or "lesson".
  describe("issue and note entity types", () => {
    function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        id: "ISS-001", title: "Issue", severity: "medium", status: "open",
        components: [], impact: "x", resolution: null, location: [],
        discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [], order: 10,
        ...overrides,
      };
    }
    function note(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        id: "N-001", title: "Note", content: "body", tags: [], status: "active",
        createdDate: "2026-01-01", updatedDate: "2026-01-01",
        ...overrides,
      };
    }

    it("issue: one-sided severity change merges clean; divergent titles conflict", () => {
      const base = issue();
      const ours = issue({ severity: "high" });
      const theirs = issue({ title: "Renamed by theirs" });
      const result = threeWayMerge(base, ours, theirs, "issue");
      expect(result.clean).toBe(true);
      expect(result.merged.severity).toBe("high");
      expect(result.merged.title).toBe("Renamed by theirs");

      const divergent = threeWayMerge(issue(), issue({ title: "A" }), issue({ title: "B" }), "issue");
      expect(divergent.clean).toBe(false);
      const conflictFields = (divergent.merged._conflicts as Array<{ fieldPath: string }>).map(c => c.fieldPath);
      expect(conflictFields).toContain("/title");
    });

    it("note: one-sided content change merges clean; divergent content conflicts", () => {
      const base = note();
      const ours = note({ content: "edited by ours" });
      const theirs = note();
      const result = threeWayMerge(base, ours, theirs, "note");
      expect(result.clean).toBe(true);
      expect(result.merged.content).toBe("edited by ours");

      const divergent = threeWayMerge(note(), note({ content: "A" }), note({ content: "B" }), "note");
      expect(divergent.clean).toBe(false);
      expect((divergent.merged._conflicts as Array<{ fieldPath: string }>).map(c => c.fieldPath)).toContain("/content");
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
      const titleConflict = result.conflicts.find((c) => c.fieldPath === "/title");
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
      const statusConflict = result.conflicts.find((c) => c.fieldPath === "/status");
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
      // ISS-746: the entry carries full entity snapshots, not placeholder strings,
      // and the merged body is the EDITED side (loadable, visible, resolvable).
      const entry = deleteEdit as Record<string, unknown>;
      expect((entry.ours as Record<string, unknown>).lifecycle).toBe("deleted");
      expect((entry.ours as Record<string, unknown>).deletedAt).toBe("2026-05-26T00:00:00Z");
      expect((entry.theirs as Record<string, unknown>).title).toBe("Changed");
      expect(entry.ours).not.toBe("deleted");
      expect(entry.theirs).not.toBe("edited");
      expect(entry.base).not.toBe("active");
      expect(result.merged.title).toBe("Changed");
      expect(result.merged.lifecycle).not.toBe("deleted");
    });

    it("mirrored branch: theirs deletes, ours edits -> body is ours' edit, snapshots per side (ISS-746)", () => {
      const base = ticket({ title: "Original", lifecycle: "active" });
      const ours = ticket({ title: "Changed by us", lifecycle: "active" });
      const theirs = ticket({ title: "Original", lifecycle: "deleted", deletedAt: "2026-05-27T00:00:00Z", deletedBy: "bob@test.com" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(false);
      const entry = result.conflicts.find((c) => c.kind === "delete-edit") as Record<string, unknown>;
      expect(entry).toBeDefined();
      expect((entry.theirs as Record<string, unknown>).lifecycle).toBe("deleted");
      expect((entry.theirs as Record<string, unknown>).deletedAt).toBe("2026-05-27T00:00:00Z");
      expect((entry.theirs as Record<string, unknown>).deletedBy).toBe("bob@test.com");
      expect((entry.ours as Record<string, unknown>).title).toBe("Changed by us");
      expect(result.merged.title).toBe("Changed by us");
      expect(result.merged.lifecycle).not.toBe("deleted");
    });

    it("add/add tombstone variant: base {} produces a full active-entity body (ISS-747 repro 2)", () => {
      const tombstone = ticket({ lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "alice@test.com" });
      const active = ticket({ title: "Fresh add" });
      const result = threeWayMerge({}, tombstone, active, "ticket");
      expect(result.clean).toBe(false);
      expect(result.merged.id).toBeDefined();
      expect(result.merged.title).toBe("Fresh add");
      const entry = result.conflicts.find((c) => c.kind === "delete-edit") as Record<string, unknown>;
      expect(entry).toBeDefined();
      expect(entry.base).toBeNull();
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

    it("drops an entry present in base+theirs but resolved by ours (ISS-750 resurrection repro 1)", () => {
      const entry = { fieldPath: "/title", field: "title", kind: "field", base: "Old", ours: "A", theirs: "B" };
      const base = ticket({ _conflicts: [entry] });
      const ours = ticket(); // ours resolved it: entry removed
      const theirs = ticket({ _conflicts: [entry] });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(true);
      expect(result.merged._conflicts).toBeUndefined();
    });

    it("drops a base-only entry (both sides resolved it, ISS-750 resurrection repro 2)", () => {
      const entry = { fieldPath: "/title", field: "title", kind: "field", base: "Old", ours: "A", theirs: "B" };
      const base = ticket({ _conflicts: [entry] });
      const ours = ticket();
      const theirs = ticket();
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(true);
      expect(result.merged._conflicts).toBeUndefined();
    });

    it("fresh entry supersedes a stale carried entry on the same slot", () => {
      const stale = { fieldPath: "/title", field: "title", kind: "field", base: "Ancient", ours: "X", theirs: "Y" };
      const base = ticket({ title: "Original" });
      const ours = ticket({ title: "Ours new", _conflicts: [stale] });
      const theirs = ticket({ title: "Theirs new" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(false);
      const entries = (result.merged._conflicts as Array<Record<string, unknown>>).filter((c) => c.fieldPath === "/title");
      expect(entries).toHaveLength(1);
      expect(entries[0]!.ours).toBe("Ours new");
      expect(entries[0]!.theirs).toBe("Theirs new");
    });
  });

  describe("add/add divergence with base {} (ISS-747)", () => {
    it("hard-conflict field keeps ours' value in the body instead of dropping it", () => {
      const ours = ticket({ title: "From A" });
      const theirs = ticket({ title: "From B" });
      const result = threeWayMerge({}, ours, theirs, "ticket");
      expect(result.clean).toBe(false);
      expect(result.merged.title).toBe("From A");
      const entry = result.conflicts.find((c) => c.fieldPath === "/title");
      expect(entry).toBeDefined();
      expect(entry!.base).toBeUndefined();
    });

    it("divergent displayId keeps ours' value in the body", () => {
      const ours = ticket({ displayId: "T-042" });
      const theirs = ticket({ displayId: "T-043" });
      const result = threeWayMerge({}, ours, theirs, "ticket");
      expect(result.merged.displayId).toBe("T-042");
      expect(result.conflicts.some((c) => c.fieldPath === "/displayId")).toBe(true);
    });

    it("divergent coupled group keeps ours' members in the body", () => {
      const ours = ticket({ status: "open", completedDate: null, lifecycle: "active" });
      const theirs = ticket({ status: "inprogress", completedDate: null, lifecycle: "active" });
      const result = threeWayMerge({}, ours, theirs, "ticket");
      expect(result.merged.status).toBe("open");
      expect(result.merged.lifecycle).toBe("active");
    });
  });

  describe("unknown fields", () => {
    it("applies three-way logic to unknown fields", () => {
      const base = ticket({ customField: "base" });
      const ours = ticket({ customField: "ours" });
      const theirs = ticket({ customField: "theirs" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(false);
      expect(result.conflicts.some((c) => c.fieldPath === "/customField")).toBe(true);
    });
  });

  describe("claim coupled group with null (G-5)", () => {
    it("unclaim wins when updatedDate is more recent than stale claim", () => {
      const base = ticket({
        claim: { user: "alice@test.com", branch: "feat/x", since: "2026-05-20T10:00:00Z" },
        claimedBySession: "sess-1",
        updatedDate: "2026-05-20",
      });
      const ours = ticket({
        claim: null,
        claimedBySession: null,
        updatedDate: "2026-05-25",
        updatedAt: "2026-05-25T14:00:00Z",
      });
      const theirs = ticket({
        claim: { user: "alice@test.com", branch: "feat/x", since: "2026-05-20T10:00:00Z" },
        claimedBySession: "sess-1",
        updatedDate: "2026-05-20",
      });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.merged.claim).toBeNull();
      expect(result.merged.claimedBySession).toBeNull();
    });

    it("newer claim wins over older unclaim", () => {
      const base = ticket({
        claim: { user: "alice@test.com", branch: "feat/x", since: "2026-05-20T10:00:00Z" },
        claimedBySession: "sess-1",
        updatedDate: "2026-05-20",
      });
      const ours = ticket({
        claim: null,
        claimedBySession: null,
        updatedDate: "2026-05-21",
        updatedAt: "2026-05-21T08:00:00Z",
      });
      const theirs = ticket({
        claim: { user: "bob@test.com", branch: "feat/y", since: "2026-05-25T12:00:00Z" },
        claimedBySession: "sess-2",
        updatedDate: "2026-05-25",
      });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.merged.claim).toEqual({ user: "bob@test.com", branch: "feat/y", since: "2026-05-25T12:00:00Z" });
    });

    it("both add claims: latest since wins", () => {
      const base = ticket({ claim: null, claimedBySession: null, updatedDate: "2026-05-20" });
      const ours = ticket({
        claim: { user: "alice@test.com", branch: "feat/x", since: "2026-05-22T10:00:00Z" },
        claimedBySession: "sess-1",
        updatedDate: "2026-05-22",
      });
      const theirs = ticket({
        claim: { user: "bob@test.com", branch: "feat/y", since: "2026-05-25T14:00:00Z" },
        claimedBySession: "sess-2",
        updatedDate: "2026-05-25",
      });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.merged.claim).toEqual({ user: "bob@test.com", branch: "feat/y", since: "2026-05-25T14:00:00Z" });
    });

    it("same-day mixed precision is non-blocking: cleared side wins, no conflict", () => {
      // ours clears the claim with only a date-only updatedDate; theirs has a same-day ISO claim.
      // The time-of-day is unknown, so recency is ambiguous -> advisory claims must NOT block.
      const base = ticket({
        claim: { user: "alice@test.com", branch: "feat/x", since: "2026-05-24T10:00:00Z" },
        claimedBySession: "sess-1",
        updatedDate: "2026-05-24",
      });
      const ours = ticket({ claim: null, claimedBySession: null, updatedDate: "2026-05-25" });
      const theirs = ticket({
        claim: { user: "bob@test.com", branch: "feat/y", since: "2026-05-25T10:00:00Z" },
        claimedBySession: "sess-2",
        updatedDate: "2026-05-25",
      });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(true);
      expect(result.merged.claim).toBeNull(); // cleared side preferred
      expect(result.merged.claimedBySession).toBeNull();
    });

    it("cross-day date-only unclaim beats an earlier ISO claim via fallback", () => {
      const base = ticket({
        claim: { user: "alice@test.com", branch: "feat/x", since: "2026-05-20T10:00:00Z" },
        claimedBySession: "sess-1",
        updatedDate: "2026-05-20",
      });
      // ours clears the claim; its only recency signal is a date-only updatedDate on a LATER day.
      const ours = ticket({ claim: null, claimedBySession: null, updatedDate: "2026-05-26" });
      // theirs re-claims (a real divergence) but on an earlier day with a full ISO since.
      const theirs = ticket({
        claim: { user: "bob@test.com", branch: "feat/y", since: "2026-05-22T10:00:00Z" },
        claimedBySession: "sess-2",
        updatedDate: "2026-05-22",
      });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.merged.claim).toBeNull(); // later-day unclaim wins over earlier ISO claim
      expect(result.merged.claimedBySession).toBeNull();
    });
  });

  describe("attribution coupled group (B-4)", () => {
    it("picks the later updatedAt without conflict", () => {
      const base = ticket({ updatedAt: "2026-05-20T10:00:00Z" });
      const ours = ticket({ updatedAt: "2026-05-22T10:00:00Z" });
      const theirs = ticket({ updatedAt: "2026-05-25T10:00:00Z" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(true);
      expect(result.merged.updatedAt).toBe("2026-05-25T10:00:00Z");
    });
  });

  describe("attribution coupled group (B-5)", () => {
    it("lastModifiedBy follows the later-updatedAt side (consistent attribution)", () => {
      const base = ticket({ lastModifiedBy: "alice@test.com", updatedAt: "2026-05-20T10:00:00Z" });
      const ours = ticket({ lastModifiedBy: "bob@test.com", updatedAt: "2026-05-22T10:00:00Z" });
      const theirs = ticket({ lastModifiedBy: "carol@test.com", updatedAt: "2026-05-25T10:00:00Z" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(true);
      // The later updatedAt is theirs, so BOTH attribution fields come from theirs.
      expect(result.merged.updatedAt).toBe("2026-05-25T10:00:00Z");
      expect(result.merged.lastModifiedBy).toBe("carol@test.com");
    });

    it("keeps lastModifiedBy and updatedAt from the SAME side", () => {
      const base = ticket({ lastModifiedBy: "alice@test.com", updatedAt: "2026-05-20T10:00:00Z" });
      // ours has the later updatedAt; theirs has a lexicographically larger email.
      const ours = ticket({ lastModifiedBy: "aaa@test.com", updatedAt: "2026-05-28T10:00:00Z" });
      const theirs = ticket({ lastModifiedBy: "zzz@test.com", updatedAt: "2026-05-25T10:00:00Z" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(true);
      expect(result.merged.updatedAt).toBe("2026-05-28T10:00:00Z");
      expect(result.merged.lastModifiedBy).toBe("aaa@test.com"); // NOT the larger email
    });

    it("emits a conflict when attribution is genuinely ambiguous (no timestamp signal)", () => {
      const base = ticket({ lastModifiedBy: "alice@test.com" });
      const ours = ticket({ lastModifiedBy: "bob@test.com" });
      const theirs = ticket({ lastModifiedBy: "carol@test.com" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      expect(result.clean).toBe(false);
      expect(result.merged.lastModifiedBy).toBe("alice@test.com"); // base preserved, not silently picked
      expect(result.conflicts.some((c) => c.field === "lastModifiedBy" && c.group === "attribution")).toBe(true);
    });

    it("treats an unparseable updatedAt as ambiguous (no throw)", () => {
      const base = ticket({ lastModifiedBy: "alice@test.com", updatedAt: "2026-05-20T10:00:00Z" });
      const ours = ticket({ lastModifiedBy: "bob@test.com", updatedAt: "not-a-timestamp" });
      const theirs = ticket({ lastModifiedBy: "carol@test.com", updatedAt: "also-garbage" });
      const result = threeWayMerge(base, ours, theirs, "ticket");
      // Both recency values unparseable -> ambiguous -> conflict, not a crash.
      expect(result.clean).toBe(false);
      expect(result.conflicts.some((c) => c.group === "attribution")).toBe(true);
    });
  });
});
