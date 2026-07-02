/**
 * ISS-759: PLAN-stage claim handling.
 *
 * (a) Release paths must DELETE the claim keys (claimedBySession/claim), not
 *     write explicit nulls (the ISS-652 handover.ts pattern). Representative
 *     path: PlanStage skip_ticket release.
 * (b) PLAN's claim recheck must allow a SAME-user claim on any branch
 *     (per-ticket-branch sessions legitimately re-claim across branches), and
 *     a FOREIGN-user claim must send the session back to PICK_TICKET with the
 *     draft lock cleared -- not spin on retry.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { PlanStage } from "../../../src/autonomous/stages/plan.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

const SESSION_ID = "00000000-0000-0000-0000-000000000001";
const NOW = new Date().toISOString();

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    recipe: "coding",
    state: "PLAN",
    revision: 1,
    status: "active",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "story/T-001-test", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: {
      level: "low",
      guideCallCount: 0,
      ticketsCompleted: 0,
      compactionCount: 0,
      eventsLogBytes: 0,
    },
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: null,
    compactPending: false,
    compactPreparedAt: null,
    resumeBlocked: false,
    terminationReason: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 0,
    config: {
      maxTicketsPerSession: 0,
      compactThreshold: "high",
      reviewBackends: ["codex", "agent"],
    },
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    resolvedBranchStrategy: "per-ticket",
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: {},
    dirtyFileHandling: "block",
    branchStrategy: "per-ticket",
    defaults: {
      maxTicketsPerSession: 3,
      compactThreshold: "high",
      reviewBackends: ["codex", "agent"],
    },
  };
}

function writeStoryProject(testRoot: string, ticket: Record<string, unknown>): void {
  for (const dir of ["tickets", "issues", "notes", "handovers"]) {
    mkdirSync(join(testRoot, ".story", dir), { recursive: true });
  }
  writeFileSync(
    join(testRoot, ".story", "config.json"),
    JSON.stringify({
      version: 1,
      schemaVersion: 1,
      project: "test",
      type: "npm",
      language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }),
    "utf-8",
  );
  writeFileSync(
    join(testRoot, ".story", "roadmap.json"),
    JSON.stringify({
      title: "test",
      date: "2026-01-01",
      phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Desc." }],
      blockers: [],
    }),
    "utf-8",
  );
  writeFileSync(
    join(testRoot, ".story", "tickets", "T-001.json"),
    JSON.stringify(ticket, null, 2),
    "utf-8",
  );
}

const baseTicket = {
  id: "T-001",
  title: "Test ticket",
  description: "A test.",
  type: "task",
  status: "open",
  phase: "p1",
  order: 10,
  createdDate: "2026-01-01",
  completedDate: null,
  blockedBy: [],
};

describe("PLAN stage claim handling (ISS-759)", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new PlanStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "plan-claim-"));
    sessionDir = join(testRoot, ".story", "sessions", SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("skip_ticket release deletes the claimedBySession key instead of writing null (ISS-759 part A)", async () => {
    writeStoryProject(testRoot, {
      ...baseTicket,
      status: "inprogress",
      claimedBySession: SESSION_ID,
      claim: { user: "me@example.com", branch: "story/T-001-test", since: NOW },
    });
    const state = makeState({
      ticket: { id: "T-001", title: "Test ticket", claimed: true },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "skip_ticket", notes: "cannot do" });
    expect(advance.action).toBe("goto");

    const written = JSON.parse(readFileSync(join(testRoot, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(written.status).toBe("open");
    expect("claimedBySession" in written).toBe(false);
    expect("claim" in written).toBe(false);
  });

  it("same-user claim on a DIFFERENT branch passes the PLAN claim recheck (ISS-759 part B)", async () => {
    writeStoryProject(testRoot, {
      ...baseTicket,
      // Claim held by the SAME user but on a previous per-ticket branch.
      claim: { user: "me@example.com", branch: "story/T-001-old-attempt", since: NOW },
    });
    writeFileSync(join(sessionDir, "plan.md"), "# Plan\n\n1. Do the thing.\n", "utf-8");

    const state = makeState({
      ticket: { id: "T-001", title: "Test ticket", claimed: true },
      pendingTicketClaim: { user: "me@example.com", branch: "story/T-001-test", since: NOW },
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "plan_written" });
    expect(advance.action).toBe("advance");

    // The claim block actually ran and re-claimed the ticket on the new branch.
    const written = JSON.parse(readFileSync(join(testRoot, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(written.status).toBe("inprogress");
    expect(written.claimedBySession).toBe(SESSION_ID);
    expect(written.claim.user).toBe("me@example.com");
    expect(written.claim.branch).toBe("story/T-001-test");
  });

  it("FOREIGN-user claim at PLAN returns goto PICK_TICKET and clears the draft lock (ISS-759 part B)", async () => {
    writeStoryProject(testRoot, {
      ...baseTicket,
      claim: { user: "rival@example.com", branch: "feature/rival", since: NOW },
    });
    writeFileSync(join(sessionDir, "plan.md"), "# Plan\n\n1. Do the thing.\n", "utf-8");

    const state = makeState({
      ticket: { id: "T-001", title: "Test ticket", claimed: true },
      pendingTicketClaim: { user: "me@example.com", branch: "story/T-001-test", since: NOW },
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "plan_written" });
    expect(advance.action).toBe("goto");
    if (advance.action === "goto") {
      expect(advance.target).toBe("PICK_TICKET");
      expect("result" in advance && advance.result?.instruction).toBeTruthy();
    }

    // The draft lock is cleared so the re-pick starts clean.
    expect(ctx.state.ticket).toBeUndefined();
    expect((ctx.state as Record<string, unknown>).pendingTicketClaim).toBeUndefined();

    // The foreign claim on disk is untouched.
    const written = JSON.parse(readFileSync(join(testRoot, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(written.status).toBe("open");
    expect(written.claim.user).toBe("rival@example.com");
  });
});
