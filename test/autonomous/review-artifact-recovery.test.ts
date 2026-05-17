/**
 * Tests for review verdict artifact recovery bug fix and escape mechanisms.
 * Covers: content mismatch fix, HANDOVER transitions, skip_ticket, stuck-detection.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeReviewVerdict,
  readReviewVerdict,
  computeContentHash,
  type ReviewVerdictArtifact,
} from "../../src/autonomous/review-verdict.js";
import { isValidTransition } from "../../src/autonomous/state-machine.js";
import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { telemetryDirPath } from "../../src/autonomous/liveness.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeArtifact(overrides?: Partial<ReviewVerdictArtifact>): ReviewVerdictArtifact {
  return {
    target: "T-072",
    stage: "plan",
    round: 1,
    reviewer: "codex",
    verdict: "approve",
    findingsCount: 3,
    severityCounts: { critical: 0, major: 3, minor: 0, suggestion: 0 },
    startedAt: "2026-05-17T01:00:00.000Z",
    durationMs: 5000,
    summary: "All findings addressed.",
    findings: [
      { id: "F1", severity: "major", category: "arch", description: "Gate all paths", disposition: "addressed" },
      { id: "F2", severity: "major", category: "deps", description: "Codable compat", disposition: "addressed" },
      { id: "F3", severity: "major", category: "edge", description: "Keyframe times", disposition: "addressed" },
    ],
    timestamp: "2026-05-17T01:00:05.000Z",
    ...overrides,
  };
}

function makeSessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-test-"));
  mkdirSync(join(dir, "telemetry", "reviews"), { recursive: true });
  return dir;
}

function makeSessionState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "PLAN_REVIEW", revision: 1, status: "active",
    mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 0,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], currentIssue: null, targetWork: [],
    ticket: { id: "T-072", title: "Variable speed ramp", claimed: true },
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block", branchStrategy: "none",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
  };
}

// ---------------------------------------------------------------------------
// Bug 1: Content mismatch fix
// ---------------------------------------------------------------------------

describe("review verdict artifact recovery (Bug 1)", () => {
  let sessionDir: string;

  beforeEach(() => { sessionDir = makeSessionDir(); });
  afterEach(() => { rmSync(sessionDir, { recursive: true, force: true }); });

  it("writeReviewVerdict returns existing file hash when file already exists", () => {
    const artifact1 = makeArtifact({ summary: "First write" });
    const result1 = writeReviewVerdict(sessionDir, artifact1);
    expect(result1.status).toBe("written");
    const hash1 = result1.contentHash;

    const artifact2 = makeArtifact({ summary: "Second write with different content" });
    const result2 = writeReviewVerdict(sessionDir, artifact2);
    expect(result2.status).toBe("exists");
    expect(result2.contentHash).toBe(hash1);
  });

  it("readReviewVerdict succeeds after writeReviewVerdict returns existing hash", () => {
    const artifact1 = makeArtifact();
    const result1 = writeReviewVerdict(sessionDir, artifact1);
    expect(result1.status).toBe("written");

    const artifact2 = makeArtifact({ summary: "Different content" });
    const result2 = writeReviewVerdict(sessionDir, artifact2);
    expect(result2.status).toBe("exists");

    const recovered = readReviewVerdict(sessionDir, result2.contentHash);
    expect(recovered).not.toBeNull();
    expect(recovered!.target).toBe("T-072");
    expect(recovered!.summary).toBe("All findings addressed.");
  });

  it("recovery works even with drastically different retry content", () => {
    const artifact1 = makeArtifact({
      findings: [{ id: "F1", severity: "major", category: "arch", description: "Original finding text", disposition: "addressed" }],
      summary: "Original summary",
    });
    writeReviewVerdict(sessionDir, artifact1);

    const artifact2 = makeArtifact({
      findings: [{ id: "F1", severity: "major", category: "arch", description: "Completely rewritten text", disposition: "addressed" }],
      summary: "Totally new summary",
      reviewer: "agent",
    });
    const result2 = writeReviewVerdict(sessionDir, artifact2);

    const recovered = readReviewVerdict(sessionDir, result2.contentHash);
    expect(recovered).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bug 2: HANDOVER transitions
// ---------------------------------------------------------------------------

describe("HANDOVER transitions (Bug 2)", () => {
  it("PLAN_REVIEW can transition to HANDOVER", () => {
    expect(isValidTransition("PLAN_REVIEW", "HANDOVER")).toBe(true);
  });

  it("CODE_REVIEW can transition to HANDOVER", () => {
    expect(isValidTransition("CODE_REVIEW", "HANDOVER")).toBe(true);
  });

  it("PLAN can transition to HANDOVER", () => {
    expect(isValidTransition("PLAN", "HANDOVER")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bug 3: Skip ticket
// ---------------------------------------------------------------------------

describe("skip_ticket mechanism (Bug 3)", () => {
  let testRoot: string;
  let sessionDir: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "test-skip-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });
  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("PLAN_REVIEW routes to HANDOVER on skip_ticket with skip-specific instruction", async () => {
    const { PlanReviewStage } = await import("../../src/autonomous/stages/plan-review.js");
    const state = makeSessionState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PlanReviewStage();

    const result = await stage.report(ctx, {
      completedAction: "skip_ticket",
      notes: "Requires FFmpeg rebuild with libvpx",
    } as any);

    expect(result).toHaveProperty("action", "goto");
    expect(result).toHaveProperty("target", "HANDOVER");
    expect((result as any).result.instruction).toContain("Ticket Skipped");
    expect((result as any).result.instruction).toContain("FFmpeg");
    expect((result as any).result.transitionedFrom).toBe("PLAN_REVIEW");
    expect(ctx.state.ticket).toBeUndefined();
  });

  it("PLAN routes to HANDOVER on skip_ticket with skip-specific instruction", async () => {
    const { PlanStage } = await import("../../src/autonomous/stages/plan.js");
    const state = makeSessionState({ state: "PLAN" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PlanStage();

    const result = await stage.report(ctx, {
      completedAction: "skip_ticket",
      notes: "Infrastructure work impossible in auto session",
    } as any);

    expect(result).toHaveProperty("action", "goto");
    expect(result).toHaveProperty("target", "HANDOVER");
    expect((result as any).result.instruction).toContain("Ticket Skipped");
    expect((result as any).result.instruction).toContain("Infrastructure");
    expect((result as any).result.transitionedFrom).toBe("PLAN");
    expect(ctx.state.ticket).toBeUndefined();
  });

  it("CODE_REVIEW routes to HANDOVER on skip_ticket with skip-specific instruction", async () => {
    const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
    const state = makeSessionState({ state: "CODE_REVIEW" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new CodeReviewStage();

    const result = await stage.report(ctx, {
      completedAction: "skip_ticket",
      notes: "Code review stuck on content mismatch",
    } as any);

    expect(result).toHaveProperty("action", "goto");
    expect(result).toHaveProperty("target", "HANDOVER");
    expect((result as any).result.instruction).toContain("Ticket Skipped");
    expect((result as any).result.instruction).toContain("content mismatch");
    expect((result as any).result.transitionedFrom).toBe("CODE_REVIEW");
    expect(ctx.state.ticket).toBeUndefined();
    expect(ctx.state.currentIssue).toBeNull();
  });

  it("CODE_REVIEW skip_ticket from issue-fix path clears currentIssue", async () => {
    const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
    const state = makeSessionState({
      state: "CODE_REVIEW",
      ticket: undefined,
      currentIssue: { id: "ISS-050", title: "Some issue", severity: "high" },
    } as any);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new CodeReviewStage();

    const result = await stage.report(ctx, {
      completedAction: "skip_ticket",
      notes: "Cannot resolve in this session",
    } as any);

    expect(result).toHaveProperty("action", "goto");
    expect(result).toHaveProperty("target", "HANDOVER");
    expect((result as any).result.instruction).toContain("ISS-050");
    expect(ctx.state.currentIssue).toBeNull();
  });
});
