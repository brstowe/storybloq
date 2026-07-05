/**
 * ISS-720: the recorded `reviewer` tag on a review verdict was self-reported
 * from the configured backend and never cross-checked against the lens path
 * actually taken, so analytics over-counted "lens-reviewed" rounds even when
 * the verification gate was skipped or degraded.
 *
 * These tests cover:
 *  - classifyLensReviewPath: deriving the path from per-review telemetry.
 *  - computeContentHash: reviewId/reviewerPath are observability metadata and
 *    must not perturb the dedupe hash (additive, hash-stable).
 *  - The code-review / plan-review stages recording reviewId + reviewerPath on
 *    the verdict artifact for lens-backed reviews only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyLensReviewPath,
  computeContentHash,
  type ReviewVerdictArtifact,
} from "../../src/autonomous/review-verdict.js";
import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sessionDir: string;

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "iss720-"));
});

afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

function writeTelemetry(dir: string, entries: Array<Record<string, unknown>>): void {
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(dir, "verification-telemetry.jsonl"), body, "utf-8");
}

function entry(reviewId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reviewId,
    proposed: 3,
    verified: 2,
    rejected: 1,
    snapshotIntegrityFailure: false,
    verificationSkipped: false,
    verificationRuntimeErrors: 0,
    logWriteFailures: 0,
    timestamp: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}

function baseArtifact(overrides: Partial<ReviewVerdictArtifact> = {}): ReviewVerdictArtifact {
  return {
    target: "T-001",
    stage: "code",
    round: 1,
    reviewer: "lenses",
    verdict: "approve",
    findingsCount: 0,
    severityCounts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    startedAt: "2026-05-29T00:00:00.000Z",
    durationMs: 1234,
    summary: "ok",
    findings: [],
    timestamp: "2026-05-29T00:00:01.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyLensReviewPath
// ---------------------------------------------------------------------------

describe("classifyLensReviewPath (ISS-720)", () => {
  it("returns undefined when no reviewId is supplied", () => {
    writeTelemetry(sessionDir, [entry("code-review-r1")]);
    expect(classifyLensReviewPath(sessionDir, undefined)).toBeUndefined();
  });

  it("returns undefined when the telemetry file is absent", () => {
    expect(classifyLensReviewPath(sessionDir, "code-review-r1")).toBeUndefined();
  });

  it("returns undefined when no entry matches the reviewId", () => {
    writeTelemetry(sessionDir, [entry("code-review-r1"), entry("code-review-r2")]);
    expect(classifyLensReviewPath(sessionDir, "code-review-r9")).toBeUndefined();
  });

  it("returns lenses-verified for a matching entry with both flags false", () => {
    writeTelemetry(sessionDir, [entry("code-review-r1")]);
    expect(classifyLensReviewPath(sessionDir, "code-review-r1")).toBe("lenses-verified");
  });

  it("returns lenses-unverified when verificationSkipped is true", () => {
    writeTelemetry(sessionDir, [entry("lens-abc", { verificationSkipped: true, verified: 0 })]);
    expect(classifyLensReviewPath(sessionDir, "lens-abc")).toBe("lenses-unverified");
  });

  it("returns lenses-unverified when snapshotIntegrityFailure is true (defensive: legacy entries)", () => {
    writeTelemetry(sessionDir, [entry("code-review-r1", { snapshotIntegrityFailure: true, verified: 0 })]);
    expect(classifyLensReviewPath(sessionDir, "code-review-r1")).toBe("lenses-unverified");
  });

  it("returns lenses-unverified when findings bypassed verification with runtime errors", () => {
    // The gate ran but let some findings through unverified (verificationRuntimeErrors > 0),
    // so the round was not fully verified.
    writeTelemetry(sessionDir, [entry("code-review-r1", { verificationRuntimeErrors: 2 })]);
    expect(classifyLensReviewPath(sessionDir, "code-review-r1")).toBe("lenses-unverified");
  });

  it("treats verificationRuntimeErrors: 0 as verified (no false downgrade)", () => {
    writeTelemetry(sessionDir, [entry("code-review-r1", { verificationRuntimeErrors: 0 })]);
    expect(classifyLensReviewPath(sessionDir, "code-review-r1")).toBe("lenses-verified");
  });

  it("uses the LAST matching entry (a re-run that degraded overrides an earlier verified run)", () => {
    writeTelemetry(sessionDir, [
      entry("code-review-r1"),
      entry("code-review-r1", { verificationSkipped: true, verified: 0 }),
    ]);
    expect(classifyLensReviewPath(sessionDir, "code-review-r1")).toBe("lenses-unverified");
  });

  it("ignores entries for other reviewIds when selecting the match", () => {
    writeTelemetry(sessionDir, [
      entry("code-review-r1", { verificationSkipped: true }),
      entry("code-review-r2"),
      entry("code-review-r1"),
    ]);
    expect(classifyLensReviewPath(sessionDir, "code-review-r2")).toBe("lenses-verified");
  });

  it("tolerates malformed and blank trailing lines", () => {
    const body =
      JSON.stringify(entry("code-review-r1")) + "\n" +
      "{ not json\n" +
      "\n";
    writeFileSync(join(sessionDir, "verification-telemetry.jsonl"), body, "utf-8");
    expect(classifyLensReviewPath(sessionDir, "code-review-r1")).toBe("lenses-verified");
  });
});

// ---------------------------------------------------------------------------
// computeContentHash stability
// ---------------------------------------------------------------------------

describe("computeContentHash ignores reviewId/reviewerPath (ISS-720)", () => {
  it("hashes identically with and without the observability fields", () => {
    const without = computeContentHash(baseArtifact());
    const withMeta = computeContentHash(baseArtifact({ reviewId: "code-review-r1", reviewerPath: "lenses-verified" }));
    expect(withMeta).toBe(without);
  });

  it("two artifacts differing ONLY in reviewerPath hash the same", () => {
    const verified = computeContentHash(baseArtifact({ reviewId: "code-review-r1", reviewerPath: "lenses-verified" }));
    const unverified = computeContentHash(baseArtifact({ reviewId: "code-review-r1", reviewerPath: "lenses-unverified" }));
    expect(verified).toBe(unverified);
  });

  it("still reflects a change to a real content field (sanity)", () => {
    const approve = computeContentHash(baseArtifact({ verdict: "approve" }));
    const reject = computeContentHash(baseArtifact({ verdict: "reject" }));
    expect(approve).not.toBe(reject);
  });
});

// ---------------------------------------------------------------------------
// Stage integration: code-review + plan-review record the path
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "CODE_REVIEW", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"] },
    ticket: { id: "T-001", title: "Test ticket", claimed: true, risk: "low" },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], currentIssue: null,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"] },
  };
}

function setupProject(root: string): void {
  const storyDir = join(root, ".story");
  mkdirSync(join(storyDir, "tickets"), { recursive: true });
  mkdirSync(join(storyDir, "issues"), { recursive: true });
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-03-31", phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
}

function readVerdictArtifact(sDir: string): Record<string, unknown> {
  const reviewsDir = join(sDir, "telemetry", "reviews");
  const files = readdirSync(reviewsDir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBe(1);
  return JSON.parse(readFileSync(join(reviewsDir, files[0]!), "utf-8"));
}

describe("review stages record reviewerPath/reviewId for lens reviews (ISS-720)", () => {
  let testRoot: string;
  let sDir: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "iss720-stage-"));
    sDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sDir, { recursive: true });
    setupProject(testRoot);
  });

  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("code-review records lenses-verified when telemetry shows the gate ran", async () => {
    writeTelemetry(sDir, [entry("code-review-r1")]);
    const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
    const stage = new CodeReviewStage();
    const ctx = new StageContext(testRoot, sDir, makeState(), makeRecipe());

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "approve",
      reviewer: "lenses",
      reviewId: "code-review-r1",
      findings: [],
    });
    expect(advance.action).not.toBe("retry");

    const artifact = readVerdictArtifact(sDir);
    expect(artifact.reviewer).toBe("lenses");
    expect(artifact.reviewId).toBe("code-review-r1");
    expect(artifact.reviewerPath).toBe("lenses-verified");
  });

  it("code-review records lenses-unverified when the gate was skipped", async () => {
    writeTelemetry(sDir, [entry("lens-xyz", { verificationSkipped: true, verified: 0 })]);
    const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
    const stage = new CodeReviewStage();
    const ctx = new StageContext(testRoot, sDir, makeState(), makeRecipe());

    await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "approve",
      reviewer: "lenses",
      reviewId: "lens-xyz",
      findings: [],
    });

    const artifact = readVerdictArtifact(sDir);
    expect(artifact.reviewId).toBe("lens-xyz");
    expect(artifact.reviewerPath).toBe("lenses-unverified");
  });

  it("code-review omits reviewerPath/reviewId when no reviewId is reported", async () => {
    writeTelemetry(sDir, [entry("code-review-r1")]);
    const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
    const stage = new CodeReviewStage();
    const ctx = new StageContext(testRoot, sDir, makeState(), makeRecipe());

    await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "approve",
      reviewer: "lenses",
      findings: [],
    });

    const artifact = readVerdictArtifact(sDir);
    expect(artifact.reviewerPath).toBeUndefined();
    expect(artifact.reviewId).toBeUndefined();
  });

  it("non-lens (agent) reviews never record reviewerPath/reviewId even if a reviewId is passed", async () => {
    writeTelemetry(sDir, [entry("code-review-r1")]);
    const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
    const stage = new CodeReviewStage();
    const ctx = new StageContext(testRoot, sDir, makeState(), makeRecipe());

    await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "approve",
      reviewer: "agent",
      reviewId: "code-review-r1",
      findings: [],
    });

    const artifact = readVerdictArtifact(sDir);
    expect(artifact.reviewer).toBe("agent");
    expect(artifact.reviewerPath).toBeUndefined();
    expect(artifact.reviewId).toBeUndefined();
  });

  it("plan-review records lenses-unverified (plan reviews never anchor, so the gate always skips)", async () => {
    // Production reality: the lens-harness synthesize only runs @storybloq/lenses
    // T-026 anchoring for CODE_REVIEW, so a plan review never verifies evidence
    // and its telemetry is written with verificationSkipped:true. A lens-backed
    // plan review is therefore ALWAYS classified lenses-unverified -- this pins
    // that reachable state rather than the lenses-verified state plan reviews
    // cannot produce. The lenses-verified recording path is covered by the
    // code-review cases above.
    writeTelemetry(sDir, [entry("lens-pr1", { verificationSkipped: true, verified: 0 })]);
    const { PlanReviewStage } = await import("../../src/autonomous/stages/plan-review.js");
    const stage = new PlanReviewStage();
    const ctx = new StageContext(testRoot, sDir, makeState({ state: "PLAN_REVIEW" }), makeRecipe());

    await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "approve",
      reviewer: "lenses",
      reviewId: "lens-pr1",
      findings: [],
    });

    const artifact = readVerdictArtifact(sDir);
    expect(artifact.stage).toBe("plan");
    expect(artifact.reviewId).toBe("lens-pr1");
    expect(artifact.reviewerPath).toBe("lenses-unverified");
  });
});
