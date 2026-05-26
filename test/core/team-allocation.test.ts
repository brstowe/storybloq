import { describe, it, expect, vi } from "vitest";
import {
  allocateTeamTicketId,
  allocateTeamIssueId,
  allocateTeamNoteId,
  allocateTeamLessonId,
  maxSequentialNumber,
} from "../../src/core/id-allocation.js";
import { CANONICAL_ID_REGEX } from "../../src/core/canonical-id.js";
import type { Ticket } from "../../src/models/ticket.js";
import type { Issue } from "../../src/models/issue.js";
import type { Note } from "../../src/models/note.js";
import type { Lesson } from "../../src/models/lesson.js";

function stubTicket(overrides: Partial<Ticket> & { id: string }): Ticket {
  return {
    id: overrides.id,
    title: "test",
    type: "task",
    status: "open",
    phase: "p0",
    order: 10,
    description: "",
    createdDate: "2026-01-01",
    completedDate: null,
    blockedBy: [],
    parentTicket: null,
    ...overrides,
  } as Ticket;
}

function stubIssue(overrides: Partial<Issue> & { id: string }): Issue {
  return {
    id: overrides.id,
    title: "test",
    status: "open",
    severity: "medium",
    components: [],
    impact: "test",
    resolution: null,
    location: [],
    discoveredDate: "2026-01-01",
    resolvedDate: null,
    relatedTickets: [],
    order: 10,
    ...overrides,
  } as Issue;
}

function stubNote(overrides: Partial<Note> & { id: string }): Note {
  return {
    id: overrides.id,
    content: "test",
    status: "active",
    tags: [],
    createdDate: "2026-01-01",
    updatedDate: "2026-01-01",
    ...overrides,
  } as Note;
}

function stubLesson(overrides: Partial<Lesson> & { id: string }): Lesson {
  return {
    id: overrides.id,
    title: "test",
    content: "test",
    context: "test",
    source: "manual",
    status: "active",
    tags: [],
    reinforcements: 0,
    createdDate: "2026-01-01",
    updatedDate: "2026-01-01",
    lastValidated: "2026-01-01",
    ...overrides,
  } as Lesson;
}

describe("allocateTeamTicketId", () => {
  it("returns canonical ID format + sequential displayId", () => {
    const result = allocateTeamTicketId([]);
    expect(result.id).toMatch(CANONICAL_ID_REGEX);
    expect(result.id).toMatch(/^t-/);
    expect(result.displayId).toBe("T-001");
  });

  it("scans max from legacy id field", () => {
    const items = [
      stubTicket({ id: "T-003" }),
      stubTicket({ id: "T-005" }),
    ];
    const result = allocateTeamTicketId(items);
    expect(result.displayId).toBe("T-006");
  });

  it("scans max from team-mode displayId field", () => {
    const items = [
      stubTicket({ id: "t-abc1234567890abc", displayId: "T-010" }),
    ];
    const result = allocateTeamTicketId(items);
    expect(result.displayId).toBe("T-011");
  });

  it("scans max from previousDisplayIds", () => {
    const items = [
      stubTicket({ id: "t-abc1234567890abc", displayId: "T-005", previousDisplayIds: ["T-020"] }),
    ];
    const result = allocateTeamTicketId(items);
    expect(result.displayId).toBe("T-021");
  });

  it("finds max across all three sources", () => {
    const items = [
      stubTicket({ id: "T-003" }),
      stubTicket({ id: "t-abc1234567890abc", displayId: "T-007" }),
      stubTicket({ id: "t-def1234567890def", displayId: "T-002", previousDisplayIds: ["T-015"] }),
    ];
    const result = allocateTeamTicketId(items);
    expect(result.displayId).toBe("T-016");
  });

  it("skips malformed IDs in scan", () => {
    const items = [
      stubTicket({ id: "not-valid" }),
      stubTicket({ id: "T-003" }),
    ];
    const result = allocateTeamTicketId(items);
    expect(result.displayId).toBe("T-004");
  });

  it("retries on canonical ID collision", () => {
    const existing = [stubTicket({ id: "t-collide000000000" })];
    let callCount = 0;
    const mockGen = () => {
      callCount++;
      return callCount === 1 ? "t-collide000000000" : "t-unique0000000000";
    };
    const result = allocateTeamTicketId(existing, mockGen);
    expect(result.id).toBe("t-unique0000000000");
    expect(callCount).toBe(2);
  });

  it("throws on collision retry exhaustion", () => {
    const existing = [stubTicket({ id: "t-alwayscollide000" })];
    const mockGen = () => "t-alwayscollide000";
    expect(() => allocateTeamTicketId(existing, mockGen)).toThrow(/allocation_failed/);
  });
});

describe("allocateTeamIssueId", () => {
  it("returns canonical ID + sequential displayId", () => {
    const result = allocateTeamIssueId([]);
    expect(result.id).toMatch(/^i-/);
    expect(result.displayId).toBe("ISS-001");
  });

  it("scans max across id and displayId", () => {
    const items = [
      stubIssue({ id: "ISS-005" }),
      stubIssue({ id: "i-abc1234567890abc", displayId: "ISS-010" }),
    ];
    const result = allocateTeamIssueId(items);
    expect(result.displayId).toBe("ISS-011");
  });
});

describe("allocateTeamNoteId", () => {
  it("returns canonical ID + sequential displayId", () => {
    const result = allocateTeamNoteId([]);
    expect(result.id).toMatch(/^n-/);
    expect(result.displayId).toBe("N-001");
  });

  it("scans max from previousDisplayIds", () => {
    const items = [
      stubNote({ id: "n-abc1234567890abc", displayId: "N-003", previousDisplayIds: ["N-008"] }),
    ];
    const result = allocateTeamNoteId(items);
    expect(result.displayId).toBe("N-009");
  });
});

describe("allocateTeamLessonId", () => {
  it("returns canonical ID + sequential displayId", () => {
    const result = allocateTeamLessonId([]);
    expect(result.id).toMatch(/^l-/);
    expect(result.displayId).toBe("L-001");
  });

  it("scans max across all sources", () => {
    const items = [
      stubLesson({ id: "L-002" }),
      stubLesson({ id: "l-abc1234567890abc", displayId: "L-005", previousDisplayIds: ["L-001"] }),
    ];
    const result = allocateTeamLessonId(items);
    expect(result.displayId).toBe("L-006");
  });
});

describe("maxSequentialNumber", () => {
  it("returns 0 for empty array", () => {
    expect(maxSequentialNumber([], /^T-(\d+)[a-z]?$/)).toBe(0);
  });

  it("finds max from id field", () => {
    const items = [
      stubTicket({ id: "T-003" }),
      stubTicket({ id: "T-007" }),
    ];
    expect(maxSequentialNumber(items, /^T-(\d+)[a-z]?$/)).toBe(7);
  });

  it("finds max from displayId field", () => {
    const items = [
      stubTicket({ id: "t-abc1234567890abc", displayId: "T-012" }),
    ];
    expect(maxSequentialNumber(items, /^T-(\d+)[a-z]?$/)).toBe(12);
  });

  it("finds max from previousDisplayIds", () => {
    const items = [
      stubTicket({ id: "T-001", previousDisplayIds: ["T-050"] }),
    ];
    expect(maxSequentialNumber(items, /^T-(\d+)[a-z]?$/)).toBe(50);
  });

  it("same number in all three sources across different items", () => {
    const items = [
      stubTicket({ id: "T-010" }),
      stubTicket({ id: "t-aaa1234567890aaa", displayId: "T-010" }),
      stubTicket({ id: "t-bbb1234567890bbb", previousDisplayIds: ["T-010"] }),
    ];
    expect(maxSequentialNumber(items, /^T-(\d+)[a-z]?$/)).toBe(10);
  });
});
