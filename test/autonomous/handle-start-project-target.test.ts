/**
 * Project-target expansion in handleStart: a targetWork entry matching a
 * roadmap.projects id expands in place to the project's remaining leaf
 * tickets (order sequence) followed by open issues, phase-matching only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { readSession } from "../../src/autonomous/session.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function setupProject(root: string): void {
  const story = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2,
    schemaVersion: 1,
    project: "project-target-fixture",
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    recipeOverrides: {
      stages: {
        WRITE_TESTS: { enabled: false },
        TEST: { enabled: false },
        BUILD: { enabled: false },
        VERIFY: { enabled: false },
      },
    },
  }));
  writeFileSync(join(story, "roadmap.json"), JSON.stringify({
    title: "project-target",
    date: "2026-07-09",
    phases: [
      { id: "p1", label: "P1", name: "Phase 1", description: "Test phase" },
      { id: "p2", label: "P2", name: "Phase 2", description: "Later phase" },
    ],
    blockers: [],
    projects: [
      { id: "tigris", name: "Tigris", phase: "p1", color: "#e0699f" },
      { id: "empty-proj", name: "Empty", phase: "p2" },
    ],
  }));
}

function writeTicket(
  root: string,
  id: string,
  opts: { status?: "open" | "complete"; order?: number; project?: string | null; phase?: string } = {},
): void {
  const status = opts.status ?? "open";
  writeFileSync(join(root, ".story", "tickets", `${id}.json`), JSON.stringify({
    id,
    title: `Ticket ${id}`,
    type: "task",
    status,
    phase: opts.phase ?? "p1",
    order: opts.order ?? 10,
    description: "",
    createdDate: "2026-07-09",
    completedDate: status === "complete" ? "2026-07-09" : null,
    blockedBy: [],
    parentTicket: null,
    ...(opts.project !== undefined && { project: opts.project }),
  }));
}

function writeIssue(
  root: string,
  id: string,
  opts: { status?: "open" | "resolved"; project?: string; phase?: string } = {},
): void {
  const status = opts.status ?? "open";
  writeFileSync(join(root, ".story", "issues", `${id}.json`), JSON.stringify({
    id,
    title: `Issue ${id}`,
    status,
    severity: "medium",
    components: [],
    impact: "test",
    resolution: status === "resolved" ? "fixed" : null,
    location: [],
    discoveredDate: "2026-07-09",
    resolvedDate: status === "resolved" ? "2026-07-09" : null,
    relatedTickets: [],
    phase: opts.phase ?? "p1",
    ...(opts.project !== undefined && { project: opts.project }),
  }));
}

function buildProject(): string {
  const root = mkdtempSync(join(tmpdir(), "project-target-"));
  setupProject(root);
  // Tigris members, deliberately written out of order sequence:
  writeTicket(root, "T-010", { order: 20, project: "tigris" });
  writeTicket(root, "T-011", { order: 10, project: "tigris" });
  writeTicket(root, "T-020", { order: 30, project: "tigris", status: "complete" });
  // Stale assignment: tigris ref but wrong phase — must be excluded:
  writeTicket(root, "T-021", { order: 5, project: "tigris", phase: "p2" });
  // Non-member:
  writeTicket(root, "T-030", { order: 40 });
  writeIssue(root, "ISS-050", { project: "tigris" });
  writeIssue(root, "ISS-051", { project: "tigris", status: "resolved" });
  run("git init -q -b main", root);
  run("git config user.email test@test.com", root);
  run("git config user.name Test", root);
  run("git add .", root);
  run("git commit -q -m fixture", root);
  return root;
}

function startedSession(root: string): FullSessionState {
  const sessionsDir = join(root, ".story", "sessions");
  const sessions = readdirSync(sessionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readSession(join(sessionsDir, d.name)))
    .filter((s): s is FullSessionState => s !== null);
  expect(sessions.length).toBe(1);
  return sessions[0]!;
}

const createdRoots: string[] = [];
function track(root: string): string {
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length) {
    const dir = createdRoots.pop()!;
    killSidecarsInRoot(dir);
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("handleStart project-target expansion", () => {
  it("expands a project id to remaining members: tickets in order, then issues", async () => {
    const root = track(buildProject());
    const result = await handleAutonomousGuide(root, {
      action: "start", sessionId: null, mode: "auto",
      targetWork: ["tigris"],
    });
    expect(result.isError).toBeFalsy();
    const session = startedSession(root);
    // T-011 (order 10) before T-010 (order 20); complete T-020, resolved
    // ISS-051, and phase-mismatched T-021 all excluded.
    expect(session.targetWork).toEqual(["T-011", "T-010", "ISS-050"]);
  });

  it("mixed lists keep expansion in place alongside explicit ids", async () => {
    const root = track(buildProject());
    const result = await handleAutonomousGuide(root, {
      action: "start", sessionId: null, mode: "auto",
      targetWork: ["tigris", "T-030"],
    });
    expect(result.isError).toBeFalsy();
    const session = startedSession(root);
    expect(session.targetWork).toEqual(["T-011", "T-010", "ISS-050", "T-030"]);
  });

  it("errors on a project with no assigned items", async () => {
    const root = track(buildProject());
    const result = await handleAutonomousGuide(root, {
      action: "start", sessionId: null, mode: "auto",
      targetWork: ["empty-proj"],
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("no assigned tickets or issues");
  });

  it("still hard-errors on an id that is neither item nor project", async () => {
    const root = track(buildProject());
    const result = await handleAutonomousGuide(root, {
      action: "start", sessionId: null, mode: "auto",
      targetWork: ["euphrates"],
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Invalid target IDs");
  });
});
