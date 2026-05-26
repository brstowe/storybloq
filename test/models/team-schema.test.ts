import { describe, it, expect } from "vitest";
import { TicketSchema } from "../../src/models/ticket.js";
import { IssueSchema } from "../../src/models/issue.js";
import { NoteSchema } from "../../src/models/note.js";
import { LessonSchema } from "../../src/models/lesson.js";

const baseTicket = {
  id: "T-001",
  title: "Test",
  description: "Desc.",
  type: "task",
  status: "open",
  phase: "p1",
  order: 10,
  createdDate: "2026-01-01",
  completedDate: null,
  blockedBy: [],
};

const baseIssue = {
  id: "ISS-001",
  title: "Test",
  status: "open",
  severity: "medium",
  components: [],
  impact: "Test.",
  resolution: null,
  location: [],
  discoveredDate: "2026-01-01",
  resolvedDate: null,
  relatedTickets: [],
};

const baseNote = {
  id: "N-001",
  title: null,
  content: "Test content.",
  tags: [],
  status: "active",
  createdDate: "2026-01-01",
  updatedDate: "2026-01-01",
};

const baseLesson = {
  id: "L-001",
  title: "Test lesson",
  content: "Lesson content.",
  context: "Context.",
  source: "manual",
  tags: [],
  reinforcements: 0,
  lastValidated: "2026-01-01",
  createdDate: "2026-01-01",
  updatedDate: "2026-01-01",
  supersedes: null,
  status: "active",
};

describe("team-mode schema additions", () => {
  describe("TicketSchema", () => {
    it("parses ticket with displayId", () => {
      const result = TicketSchema.safeParse({ ...baseTicket, displayId: "T-051" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.displayId).toBe("T-051");
      }
    });

    it("parses ticket with claim field", () => {
      const claim = { user: "dev@example.com", branch: "feat/auth", since: "2026-05-25T18:30:00Z" };
      const result = TicketSchema.safeParse({ ...baseTicket, claim });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.claim).toEqual(claim);
      }
    });

    it("parses ticket with lifecycle field", () => {
      const result = TicketSchema.safeParse({ ...baseTicket, lifecycle: "deleted" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.lifecycle).toBe("deleted");
      }
    });

    it("parses ticket with previousDisplayIds", () => {
      const result = TicketSchema.safeParse({ ...baseTicket, previousDisplayIds: ["T-030", "T-045"] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.previousDisplayIds).toEqual(["T-030", "T-045"]);
      }
    });

    it("parses ticket with _conflicts array", () => {
      const conflicts = [{ fieldPath: "/status", kind: "coupled", group: "status-transition", base: "open", ours: "inprogress", theirs: "complete" }];
      const result = TicketSchema.safeParse({ ...baseTicket, _conflicts: conflicts });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data._conflicts).toHaveLength(1);
      }
    });

    it("parses ticket with rank and createdAt", () => {
      const result = TicketSchema.safeParse({ ...baseTicket, rank: "a1V", createdAt: "2026-05-25T14:30:00Z" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.rank).toBe("a1V");
        expect(result.data.createdAt).toBe("2026-05-25T14:30:00Z");
      }
    });

    it("parses ticket with tombstone fields", () => {
      const result = TicketSchema.safeParse({ ...baseTicket, deletedAt: "2026-05-25T20:00:00Z", deletedBy: "dev@example.com" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deletedAt).toBe("2026-05-25T20:00:00Z");
        expect(result.data.deletedBy).toBe("dev@example.com");
      }
    });

    it("still parses ticket without team fields (backward compat)", () => {
      const result = TicketSchema.safeParse(baseTicket);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.displayId).toBeUndefined();
        expect(result.data.claim).toBeUndefined();
        expect(result.data.lifecycle).toBeUndefined();
      }
    });

    it("rejects invalid lifecycle value", () => {
      const result = TicketSchema.safeParse({ ...baseTicket, lifecycle: "bogus" });
      expect(result.success).toBe(false);
    });

    it("rejects _conflicts with invalid kind", () => {
      const conflicts = [{ fieldPath: "/status", kind: "bogus", base: "open", ours: "a", theirs: "b" }];
      const result = TicketSchema.safeParse({ ...baseTicket, _conflicts: conflicts });
      expect(result.success).toBe(false);
    });
  });

  describe("IssueSchema", () => {
    it("parses issue with team fields", () => {
      const result = IssueSchema.safeParse({
        ...baseIssue,
        displayId: "ISS-042",
        lifecycle: "archived",
        rank: "b2X",
        createdAt: "2026-05-25T14:30:00Z",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.displayId).toBe("ISS-042");
        expect(result.data.lifecycle).toBe("archived");
      }
    });

    it("parses issue with tombstone fields", () => {
      const result = IssueSchema.safeParse({ ...baseIssue, deletedAt: "2026-05-25T20:00:00Z", deletedBy: "dev@example.com" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deletedAt).toBe("2026-05-25T20:00:00Z");
        expect(result.data.deletedBy).toBe("dev@example.com");
      }
    });

    it("still parses issue without team fields", () => {
      const result = IssueSchema.safeParse(baseIssue);
      expect(result.success).toBe(true);
    });
  });

  describe("NoteSchema", () => {
    it("parses note with team fields", () => {
      const result = NoteSchema.safeParse({
        ...baseNote,
        displayId: "N-042",
        lifecycle: "active",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.displayId).toBe("N-042");
      }
    });

    it("parses note with tombstone fields", () => {
      const result = NoteSchema.safeParse({ ...baseNote, deletedAt: "2026-05-25T20:00:00Z", deletedBy: "dev@example.com" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deletedAt).toBe("2026-05-25T20:00:00Z");
        expect(result.data.deletedBy).toBe("dev@example.com");
      }
    });
  });

  describe("LessonSchema", () => {
    it("parses lesson with team fields", () => {
      const result = LessonSchema.safeParse({
        ...baseLesson,
        displayId: "L-042",
        rank: "c3Y",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.displayId).toBe("L-042");
      }
    });

    it("parses lesson with tombstone fields", () => {
      const result = LessonSchema.safeParse({ ...baseLesson, deletedAt: "2026-05-25T20:00:00Z", deletedBy: "dev@example.com" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deletedAt).toBe("2026-05-25T20:00:00Z");
        expect(result.data.deletedBy).toBe("dev@example.com");
      }
    });
  });
});
