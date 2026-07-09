import { describe, it, expect } from "vitest";
import { PhaseSchema, RoadmapSchema, ProjectSchema } from "../../src/models/roadmap.js";
import { TicketSchema } from "../../src/models/ticket.js";
import { IssueSchema } from "../../src/models/issue.js";
import { nextTicket, nextTickets } from "../../src/core/queries.js";
import { recommend } from "../../src/core/recommend.js";
import { validateProject } from "../../src/core/validation.js";
import { mergeRoadmap } from "../../src/core/merge-driver.js";
import {
  makeState,
  makeRoadmap,
  makePhase,
  makeTicket,
  makeIssue,
} from "./test-factories.js";

// --- Schemas ---

describe("phase state schema", () => {
  it("accepts pending/paused/skipped and null", () => {
    for (const state of ["pending", "paused", "skipped", null]) {
      const phase = PhaseSchema.parse({
        id: "p1", label: "P1", name: "One", description: "d", state,
      });
      expect(phase.state).toBe(state);
    }
  });

  it("accepts an absent state", () => {
    const phase = PhaseSchema.parse({ id: "p1", label: "P1", name: "One", description: "d" });
    expect(phase.state).toBeUndefined();
  });

  it("rejects unknown state values", () => {
    expect(() =>
      PhaseSchema.parse({ id: "p1", label: "P1", name: "One", description: "d", state: "done" }),
    ).toThrow();
  });
});

describe("roadmap projects schema", () => {
  it("round-trips projects on the roadmap", () => {
    const roadmap = RoadmapSchema.parse({
      title: "t",
      date: "2026-07-09",
      phases: [{ id: "ops", label: "OPS", name: "Operations", description: "d" }],
      blockers: [],
      projects: [{ id: "docusign", name: "Docusign", phase: "ops", color: "#4f7cff" }],
    });
    expect(roadmap.projects).toHaveLength(1);
    expect(roadmap.projects![0]!.color).toBe("#4f7cff");
  });

  it("color is optional", () => {
    const p = ProjectSchema.parse({ id: "x", name: "X", phase: "p1" });
    expect(p.color).toBeUndefined();
  });

  it("ticket and issue accept a project ref", () => {
    const t = TicketSchema.parse({
      ...makeTicket({ id: "T-001" }),
      project: "docusign",
    });
    expect(t.project).toBe("docusign");
    const i = IssueSchema.parse({
      ...makeIssue({ id: "ISS-001" }),
      project: "docusign",
    });
    expect(i.project).toBe("docusign");
  });
});

// --- Work selection gating ---

describe("parked phase gating", () => {
  const roadmap = makeRoadmap([
    makePhase({ id: "p1", state: "pending" }),
    makePhase({ id: "p2" }),
  ]);
  const tickets = [
    makeTicket({ id: "T-001", phase: "p1", order: 10 }),
    makeTicket({ id: "T-002", phase: "p2", order: 10 }),
  ];

  it("nextTicket skips parked phases", () => {
    const state = makeState({ roadmap, tickets });
    const outcome = nextTicket(state);
    expect(outcome.kind).toBe("found");
    if (outcome.kind === "found") expect(outcome.ticket.id).toBe("T-002");
  });

  it("nextTicket includes parked phases with includeParked", () => {
    const state = makeState({ roadmap, tickets });
    const outcome = nextTicket(state, { includeParked: true });
    expect(outcome.kind).toBe("found");
    if (outcome.kind === "found") expect(outcome.ticket.id).toBe("T-001");
  });

  it("nextTickets skips parked phases", () => {
    const state = makeState({ roadmap, tickets });
    const outcome = nextTickets(state, 5);
    expect(outcome.kind).toBe("found");
    if (outcome.kind === "found") {
      expect(outcome.candidates.map((c) => c.ticket.id)).toEqual(["T-002"]);
    }
  });

  it("returns all_parked when only parked work remains", () => {
    const parkedOnly = makeState({
      roadmap: makeRoadmap([makePhase({ id: "p1", state: "paused" })]),
      tickets: [makeTicket({ id: "T-001", phase: "p1" })],
    });
    const one = nextTicket(parkedOnly);
    expect(one.kind).toBe("all_parked");
    if (one.kind === "all_parked") expect(one.parkedPhaseIds).toEqual(["p1"]);
    const many = nextTickets(parkedOnly, 3);
    expect(many.kind).toBe("all_parked");
  });

  it("returns all_complete when parked phases hold only complete work", () => {
    const state = makeState({
      roadmap: makeRoadmap([makePhase({ id: "p1", state: "skipped" })]),
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "complete" })],
    });
    expect(nextTicket(state).kind).toBe("all_complete");
  });

  it("recommend never surfaces items in parked phases", () => {
    const issues = [makeIssue({ id: "ISS-001", phase: "p1", severity: "critical" })];
    const activeRoadmap = makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]);

    // Same data, phase active: the critical issue is recommended
    const activeIds = recommend(makeState({ roadmap: activeRoadmap, tickets, issues }), 10)
      .recommendations.map((r) => r.id);
    expect(activeIds).toContain("ISS-001");

    // Phase parked: the same items disappear
    const parkedIds = recommend(makeState({ roadmap, tickets, issues }), 10)
      .recommendations.map((r) => r.id);
    expect(parkedIds).not.toContain("T-001");
    expect(parkedIds).not.toContain("ISS-001");
  });
});

// --- Validation ---

describe("project validation", () => {
  const roadmapWithProjects = {
    ...makeRoadmap([makePhase({ id: "ops" }), makePhase({ id: "next" })]),
    projects: [{ id: "docusign", name: "Docusign", phase: "ops" }],
  };

  it("flags unknown project refs as errors", () => {
    const state = makeState({
      roadmap: roadmapWithProjects,
      tickets: [makeTicket({ id: "T-001", phase: "ops", project: "nope" })],
    });
    const result = validateProject(state);
    expect(result.findings.some((f) => f.code === "invalid_project_ref" && f.entity === "T-001")).toBe(true);
  });

  it("flags phase-mismatched assignments as warnings", () => {
    const state = makeState({
      roadmap: roadmapWithProjects,
      tickets: [makeTicket({ id: "T-001", phase: "next", project: "docusign" })],
    });
    const result = validateProject(state);
    const finding = result.findings.find((f) => f.code === "stale_project_assignment");
    expect(finding?.level).toBe("warning");
    expect(finding?.entity).toBe("T-001");
  });

  it("flags duplicate project ids and unknown project phases", () => {
    const state = makeState({
      roadmap: {
        ...makeRoadmap([makePhase({ id: "ops" })]),
        projects: [
          { id: "a", name: "A", phase: "ops" },
          { id: "a", name: "A2", phase: "ops" },
          { id: "b", name: "B", phase: "ghost" },
        ],
      },
    });
    const codes = validateProject(state).findings.map((f) => f.code);
    expect(codes).toContain("duplicate_project_id");
    expect(codes).toContain("invalid_project_phase_ref");
  });

  it("accepts a valid assignment silently", () => {
    const state = makeState({
      roadmap: roadmapWithProjects,
      tickets: [makeTicket({ id: "T-001", phase: "ops", project: "docusign" })],
    });
    const codes = validateProject(state).findings.map((f) => f.code);
    expect(codes).not.toContain("invalid_project_ref");
    expect(codes).not.toContain("stale_project_assignment");
  });
});

// --- Merge driver ---

describe("roadmap merge with state and projects", () => {
  const base = {
    title: "t",
    date: "2026-07-09",
    phases: [{ id: "p1", label: "P1", name: "One", description: "d" }],
    blockers: [],
  };

  it("one side parking a phase merges cleanly", () => {
    const ours = structuredClone(base);
    (ours.phases[0] as Record<string, unknown>).state = "pending";
    const result = mergeRoadmap(base, ours, structuredClone(base));
    expect(result.clean).toBe(true);
    expect((result.merged.phases as Record<string, unknown>[])[0]!.state).toBe("pending");
  });

  it("divergent phase state records a conflict", () => {
    const ours = structuredClone(base);
    (ours.phases[0] as Record<string, unknown>).state = "pending";
    const theirs = structuredClone(base);
    (theirs.phases[0] as Record<string, unknown>).state = "paused";
    const result = mergeRoadmap(base, ours, theirs);
    expect(result.clean).toBe(false);
    expect(result.conflicts.some((c) => c.fieldPath.includes("state"))).toBe(true);
  });

  it("projects added on both sides merge keyed by id", () => {
    const ours = { ...structuredClone(base), projects: [{ id: "a", name: "A", phase: "p1" }] };
    const theirs = { ...structuredClone(base), projects: [{ id: "b", name: "B", phase: "p1" }] };
    const result = mergeRoadmap(base, ours, theirs);
    expect(result.clean).toBe(true);
    const ids = (result.merged.projects as { id: string }[]).map((p) => p.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("a roadmap without projects does not gain an empty projects key", () => {
    const result = mergeRoadmap(base, structuredClone(base), structuredClone(base));
    expect(result.merged).not.toHaveProperty("projects");
  });
});
