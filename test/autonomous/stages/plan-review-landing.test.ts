import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { PlanReviewStage } from "../../../src/autonomous/stages/plan-review.js";
import type { Finding, FullSessionState, ReviewRecord } from "../../../src/autonomous/session-types.js";

function review(round: number, verdict = "revise", criticalCount = 0, majorCount = 1): ReviewRecord {
  return {
    round,
    reviewer: "agent",
    verdict,
    findingCount: criticalCount + majorCount,
    criticalCount,
    majorCount,
    suggestionCount: 0,
    timestamp: new Date().toISOString(),
  };
}

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-000000000002",
    recipe: "coding",
    state: "PLAN_REVIEW",
    revision: 1,
    status: "active",
    mode: "auto",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
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
    guideCallCount: 1,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
    ticket: { id: "T-001", displayId: "T-001", title: "Test ticket", claimed: true, risk: "low" },
    currentIssue: null,
    resolvedIssues: [],
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    landingDecision: null,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(maxReviewRounds?: number): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: maxReviewRounds === undefined ? {} : { PLAN_REVIEW: { maxReviewRounds } },
    dirtyFileHandling: "block",
    branchStrategy: "none",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
  };
}

function finding(
  severity: Finding["severity"],
  disposition: Finding["disposition"] = "open",
  extra: Partial<Finding> = {},
): Finding {
  return {
    id: "F-1",
    severity,
    category: "correctness",
    description: "Follow-up needed",
    disposition,
    ...extra,
  };
}

function setupProject(root: string): void {
  const storyDir = join(root, ".story");
  mkdirSync(join(storyDir, "tickets"), { recursive: true });
  mkdirSync(join(storyDir, "issues"), { recursive: true });
  mkdirSync(join(storyDir, "notes"), { recursive: true });
  mkdirSync(join(storyDir, "lessons"), { recursive: true });
  mkdirSync(join(storyDir, "handovers"), { recursive: true });
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 2,
    schemaVersion: 1,
    project: "test",
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test",
    date: "2026-07-09",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
}

function issueCount(root: string): number {
  return readdirSync(join(root, ".story", "issues")).filter((f) => f.endsWith(".json")).length;
}

describe("PlanReviewStage landing cap (fork)", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new PlanReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "plan-review-landing-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot);
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("keeps revise looping when no cap is configured (base behavior)", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: Array.from({ length: 5 }, (_, i) => review(i + 1)), code: [] },
    }), makeRecipe());

    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "revise",
      findings: [finding("major")],
    });

    expect(advance).toMatchObject({ action: "retry" });
  });

  it("keeps revise looping before the cap", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(2));

    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "revise",
      findings: [finding("major")],
    });

    expect(advance).toMatchObject({ action: "retry" });
  });

  it("forces IMPLEMENT at the cap when revise has no unresolved critical findings", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [review(1)], code: [] },
    }), makeRecipe(2));

    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "revise",
      findings: [finding("major"), finding("minor")],
    });

    expect(advance).toMatchObject({ action: "advance" });
    expect(issueCount(testRoot)).toBe(2);
  });

  it("keeps unresolved critical findings blocking even at the cap", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [review(1, "revise", 1, 0)], code: [] },
    }), makeRecipe(2));

    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "revise",
      findings: [finding("critical")],
    });

    expect(advance).toMatchObject({ action: "retry" });
  });

  it("keeps reject routing back to PLAN even at the cap", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [review(1)], code: [] },
    }), makeRecipe(2));

    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "reject",
      findings: [],
    });

    expect(advance).toMatchObject({ action: "back", target: "PLAN" });
  });

  it("ends a plan-mode session at the cap with capped wording", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      mode: "plan",
      reviews: { plan: [review(1)], code: [] },
    }), makeRecipe(2));

    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "revise",
      findings: [finding("major")],
    });

    expect(advance).toMatchObject({ action: "goto", target: "SESSION_END" });
    const result = (advance as { result?: { instruction?: string } }).result;
    expect(result?.instruction).toContain("review cap");
  });

  it("clamps cap below risk minimum to required review rounds", async () => {
    const beforeMinimumCtx = new StageContext(testRoot, sessionDir, makeState({
      ticket: { id: "T-001", displayId: "T-001", title: "High risk", claimed: true, risk: "high" },
      reviews: { plan: [review(1)], code: [] },
    }), makeRecipe(1));

    const beforeMinimum = await stage.report(beforeMinimumCtx, {
      completedAction: "plan_review_round",
      verdict: "revise",
      findings: [finding("major")],
    });
    expect(beforeMinimum).toMatchObject({ action: "retry" });

    const atMinimumCtx = new StageContext(testRoot, sessionDir, makeState({
      ticket: { id: "T-001", displayId: "T-001", title: "High risk", claimed: true, risk: "high" },
      reviews: { plan: [review(1), review(2)], code: [] },
    }), makeRecipe(1));

    const atMinimum = await stage.report(atMinimumCtx, {
      completedAction: "plan_review_round",
      verdict: "revise",
      findings: [finding("major")],
    });
    expect(atMinimum).toMatchObject({ action: "advance" });
  });

  it("treats an explicit zero cap as unlimited", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: Array.from({ length: 8 }, (_, i) => review(i + 1)), code: [] },
    }), makeRecipe(0));

    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "revise",
      findings: [finding("major")],
    });

    expect(advance).toMatchObject({ action: "retry" });
  });
});
