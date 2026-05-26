import { describe, it, expect } from "vitest";
import { makeTicket, makeIssue, makeNote, makeLesson, makeState, makePhase, makeRoadmap } from "./test-factories.js";
import { validateProject } from "../../src/core/validation.js";

describe("ProjectState lifecycle filtering", () => {
  it("activeTickets excludes deleted and archived tickets", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", status: "open" }),
        makeTicket({ id: "T-002", status: "open", lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "alice" }),
        makeTicket({ id: "T-003", status: "complete", lifecycle: "active" }),
        makeTicket({ id: "T-004", status: "open", lifecycle: "archived" }),
      ],
    });
    const active = state.activeTickets;
    expect(active.map((t) => t.id)).toEqual(["T-001", "T-003"]);
  });

  it("activeTickets includes items with undefined lifecycle", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001" }),
        makeTicket({ id: "T-002" }),
      ],
    });
    expect(state.activeTickets).toHaveLength(2);
  });

  it("activeIssues excludes deleted issues", () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001" }),
        makeIssue({ id: "ISS-002", lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "bob" }),
      ],
    });
    const active = state.activeIssues;
    expect(active.map((i) => i.id)).toEqual(["ISS-001"]);
  });

  it("activeNotes excludes deleted notes", () => {
    const state = makeState({
      notes: [
        makeNote({ id: "N-001" }),
        makeNote({ id: "N-002", lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "carol" }),
      ],
    });
    expect(state.activeNotes.map((n) => n.id)).toEqual(["N-001"]);
  });

  it("activeLessons excludes deleted lessons", () => {
    const state = makeState({
      lessons: [
        makeLesson({ id: "L-001" }),
        makeLesson({ id: "L-002", lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "dave" }),
      ],
    });
    expect(state.activeLessons.map((l) => l.id)).toEqual(["L-001"]);
  });
});

describe("leafTickets with lifecycle", () => {
  it("leafTickets excludes deleted tickets", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", status: "open" }),
        makeTicket({ id: "T-002", status: "open", lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "alice" }),
      ],
    });
    expect(state.leafTickets.map((t) => t.id)).toEqual(["T-001"]);
  });

  it("deleted parent umbrella lets children become leaf tickets", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "alice" }),
        makeTicket({ id: "T-002", parentTicket: "T-001", status: "open" }),
        makeTicket({ id: "T-003", parentTicket: "T-001", status: "open" }),
      ],
    });
    const leafIds = state.leafTickets.map((t) => t.id).sort();
    expect(leafIds).toEqual(["T-002", "T-003"]);
  });
});

describe("isBlocked with deleted blockers", () => {
  it("returns false when blocker is deleted", () => {
    const blocker = makeTicket({ id: "T-001", status: "open", lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "alice" });
    const blocked = makeTicket({ id: "T-002", blockedBy: ["T-001"] });
    const state = makeState({ tickets: [blocker, blocked] });
    expect(state.isBlocked(blocked)).toBe(false);
  });

  it("still blocked when blocker is active and not complete", () => {
    const blocker = makeTicket({ id: "T-001", status: "inprogress" });
    const blocked = makeTicket({ id: "T-002", blockedBy: ["T-001"] });
    const state = makeState({ tickets: [blocker, blocked] });
    expect(state.isBlocked(blocked)).toBe(true);
  });
});

describe("phase status derivation with deleted tickets", () => {
  it("ignores deleted tickets in phase progress", () => {
    const roadmap = makeRoadmap([makePhase({ id: "p1" })]);
    const state = makeState({
      roadmap,
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "complete" }),
        makeTicket({ id: "T-002", phase: "p1", status: "open", lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "alice" }),
      ],
    });
    expect(state.phaseStatus("p1")).toBe("complete");
  });
});

describe("counts exclude deleted items", () => {
  it("openTicketCount excludes deleted", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", status: "open" }),
        makeTicket({ id: "T-002", status: "open", lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "alice" }),
      ],
    });
    expect(state.openTicketCount).toBe(1);
    expect(state.totalTicketCount).toBe(1);
  });

  it("activeIssueCount excludes deleted", () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001", status: "open" }),
        makeIssue({ id: "ISS-002", status: "open", lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "bob" }),
      ],
    });
    expect(state.activeIssueCount).toBe(1);
  });
});

describe("validation with deleted references", () => {
  it("references to deleted items produce warnings not errors", () => {
    const roadmap = makeRoadmap([makePhase({ id: "p1" })]);
    const state = makeState({
      roadmap,
      tickets: [
        makeTicket({ id: "T-001", lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "alice" }),
        makeTicket({ id: "T-002", blockedBy: ["T-001"] }),
      ],
    });
    const result = validateProject(state);
    const allFindings = result.findings;
    const deletedRefFindings = allFindings.filter(
      (f) => f.message.includes("deleted") && f.level === "warning",
    );
    const errorFindings = allFindings.filter((f) => f.level === "error");
    expect(errorFindings).toHaveLength(0);
    expect(deletedRefFindings.length).toBeGreaterThan(0);
  });
});

describe("raw collections preserve deleted items", () => {
  it("ticketByID still finds deleted tickets", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "alice" }),
      ],
    });
    expect(state.ticketByID("T-001")).toBeDefined();
    expect(state.tickets).toHaveLength(1);
  });
});
