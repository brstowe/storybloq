import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { effectiveReviewDepth, normalizeReviewDepth, reviewDepthInstruction, reviewDepthReminder } from "../../src/autonomous/review-depth.js";
import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import { PlanReviewStage } from "../../src/autonomous/stages/plan-review.js";
import { CodeReviewStage } from "../../src/autonomous/stages/code-review.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";

describe("review depth resolution", () => {
  it("normalizes only valid depths", () => {
    expect(normalizeReviewDepth("light")).toBe("light");
    expect(normalizeReviewDepth("standard")).toBe("standard");
    expect(normalizeReviewDepth("thorough")).toBe("thorough");
    expect(normalizeReviewDepth("LIGHT")).toBeUndefined();
    expect(normalizeReviewDepth(2)).toBeUndefined();
    expect(normalizeReviewDepth(null)).toBeUndefined();
  });

  it("defaults to standard and lets ticket metadata override session config", () => {
    expect(effectiveReviewDepth(null, null)).toBe("standard");
    expect(effectiveReviewDepth({}, { reviewDepth: "light" })).toBe("light");
    expect(effectiveReviewDepth({ reviewDepth: "thorough" }, { reviewDepth: "light" })).toBe("thorough");
    expect(effectiveReviewDepth({ reviewDepth: "bogus" }, { reviewDepth: "light" })).toBe("light");
  });

  it("produces distinct instruction and reminder text per depth", () => {
    expect(reviewDepthInstruction("light", "plan")).toContain("do NOT spawn any reviewer subagents");
    expect(reviewDepthInstruction("standard", "code")).toContain("exactly ONE reviewer subagent");
    expect(reviewDepthInstruction("thorough", "code")).toContain("deep review");
    expect(reviewDepthReminder("light")).toContain("NOT spawn");
  });
});

// ---------------------------------------------------------------------------
// Stage integration: depth text lands in the guide instruction
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-000000000003",
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
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], reviewDepth: "light" },
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

const recipe: ResolvedRecipe = {
  id: "coding",
  pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
  postComplete: [],
  stages: {},
  dirtyFileHandling: "block",
  branchStrategy: "none",
  defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
};

describe("review depth in stage instructions", () => {
  let testRoot: string;
  let sessionDir: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "review-depth-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    const storyDir = join(testRoot, ".story");
    mkdirSync(join(storyDir, "tickets"), { recursive: true });
    writeFileSync(join(storyDir, "config.json"), JSON.stringify({
      version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }));
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("embeds light depth in the plan-review agent instruction", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), recipe);
    const result = await new PlanReviewStage().enter(ctx);
    expect(result.instruction).toContain("Review depth: LIGHT");
    expect(result.reminders.join("\n")).toContain("do NOT spawn subagents");
  });

  it("embeds light depth in the code-review agent instruction", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({ state: "CODE_REVIEW" }), recipe);
    const result = await new CodeReviewStage().enter(ctx);
    expect(result.instruction).toContain("Review depth: LIGHT");
  });

  it("lets ticket metadata escalate depth over session config", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      ticket: { id: "T-001", displayId: "T-001", title: "Test ticket", claimed: true, risk: "low", reviewDepth: "thorough" },
    }), recipe);
    const result = await new PlanReviewStage().enter(ctx);
    expect(result.instruction).toContain("Review depth: THOROUGH");
  });

  it("defaults to standard when no depth is configured", async () => {
    const state = makeState();
    delete (state.config as Record<string, unknown>).reviewDepth;
    const ctx = new StageContext(testRoot, sessionDir, state, recipe);
    const result = await new PlanReviewStage().enter(ctx);
    expect(result.instruction).toContain("Review depth: STANDARD");
    expect(result.instruction).toContain("exactly ONE reviewer subagent");
  });
});
