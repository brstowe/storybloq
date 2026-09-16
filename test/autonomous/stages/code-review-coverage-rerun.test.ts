/**
 * ISS-950 acceptance 2 and 4, CODE_REVIEW side: a coverage-only change request
 * is answered by re-running the named lens, not by sending the implementer a
 * round with nothing in it.
 *
 * The field report is the reason this is a ROUTING question rather than a
 * reporting one. On a docs-only diff the concurrency lens honestly reported
 * `skipped`, the cap turned the verdict to revise, and the seat cleared it by
 * resubmitting the same analysis as `ok` with zero findings. Sending a coverage
 * cap to IMPLEMENT is what makes relabelling the cheapest exit: the round asks
 * for changes and names none, so there is nothing else to do with it.
 *
 * The guard sits BEFORE the ISS-1114 empty change-request repair, and that
 * order is load-bearing: a coverage-only revise carries zero findings, so the
 * generic repair would otherwise claim every one of these and send back an
 * instruction that asks the reviewer for findings it has no reason to have.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { CodeReviewStage } from "../../../src/autonomous/stages/code-review.js";
import type { Finding, FullSessionState } from "../../../src/autonomous/session-types.js";

const SELF_REPORTED_CAP = "core lens 'concurrency' uncovered (skipped, self-reported)";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding",
    state: "CODE_REVIEW",
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
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"] },
    ticket: { id: "T-001", displayId: "T-001", title: "Test ticket", claimed: true, risk: "low" },
    currentIssue: null,
    resolvedIssues: [],
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    landingDecision: null,
    currentReviewStartedAt: now,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(maxReviewRounds: number): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: { CODE_REVIEW: { maxReviewRounds } },
    dirtyFileHandling: "block",
    branchStrategy: "none",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"] },
  };
}

function finding(severity: Finding["severity"], extra: Partial<Finding> = {}): Finding {
  return {
    id: "F-1",
    severity,
    category: "correctness",
    description: "Follow-up needed",
    disposition: "open",
    ...extra,
  };
}

function setupProject(root: string): void {
  const storyDir = join(root, ".story");
  for (const d of ["tickets", "issues", "notes", "lessons", "handovers"]) {
    mkdirSync(join(storyDir, d), { recursive: true });
  }
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
    date: "2026-09-15",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
}

function artifacts(sessionDir: string): Record<string, unknown>[] {
  const dir = join(sessionDir, "telemetry", "reviews");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")));
}

const COVERAGE_REPORT = {
  completedAction: "code_review_round",
  verdict: "revise",
  reviewer: "lenses",
  reviewId: "lens-r1",
  findings: [],
  capReasons: [SELF_REPORTED_CAP],
} as const;

describe("CodeReviewStage coverage-only re-run (ISS-950)", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new CodeReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "code-review-coverage-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot);
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("M-REVISE-NOT-RERUN: a coverage-only revise asks for a lens re-run, not IMPLEMENT", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(3));

    const advance = await stage.report(ctx, COVERAGE_REPORT);

    expect(advance).toMatchObject({ action: "retry" });
    const instruction = (advance as { instruction: string }).instruction;
    // Names EXACTLY the uncovered lens, so the re-run is scoped rather than a
    // second full round.
    expect(instruction).toContain("concurrency");
    expect(instruction).toContain("Re-run exactly those lens");
    // And it must not be the generic ISS-1114 repair, which asks a reviewer
    // with nothing to report to produce findings.
    expect(instruction).not.toContain("requests changes but supplies no actionable changes");
    // The round did not happen: nothing counted, nothing written, nothing
    // emitted. Same three consequences the other pre-round guards have.
    expect(ctx.state.reviews.code).toHaveLength(0);
    expect(artifacts(sessionDir)).toHaveLength(0);
    expect(ctx.state.reviewRepairAttempts).toHaveLength(1);
    expect(ctx.state.reviewRepairAttempts?.[0]).toMatchObject({
      workItemId: "T-001",
      kind: "ticket",
      stage: "code",
      round: 1,
      attempt: 1,
      trigger: "coverage",
    });
  });

  it("names every uncovered core lens and no others", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(3));

    const advance = await stage.report(ctx, {
      ...COVERAGE_REPORT,
      capReasons: [
        SELF_REPORTED_CAP,
        "core lens 'error-handling' uncovered (error, no-submission)",
      ],
    });

    const instruction = (advance as { instruction: string }).instruction;
    expect(instruction).toContain("concurrency");
    expect(instruction).toContain("error-handling");
    expect(instruction).not.toContain("clean-code");
  });

  it("M-REVISE-NOT-RERUN: a revise carrying majors still goes to the implementer", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(3));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "revise",
      reviewer: "lenses",
      reviewId: "lens-r1",
      findings: [finding("major")],
      capReasons: [SELF_REPORTED_CAP],
    });

    expect(advance).toMatchObject({ action: "back", target: "IMPLEMENT" });
    expect(ctx.state.reviews.code).toHaveLength(1);
    expect((ctx.state.reviewRepairAttempts ?? [])).toHaveLength(0);
  });

  it("a cap with no self-reported core skip is not re-run", async () => {
    // `retry pending` is a cap the server owns; re-running a named lens does
    // not answer it, and there is no lens to name.
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(3));

    const advance = await stage.report(ctx, {
      ...COVERAGE_REPORT,
      capReasons: ["retry pending"],
    });

    // Falls through to the ISS-1114 empty change-request repair.
    expect(advance).toMatchObject({ action: "retry" });
    expect((advance as { instruction: string }).instruction)
      .toContain("requests changes but supplies no actionable changes");
    expect(ctx.state.reviewRepairAttempts?.[0]?.trigger).toBeUndefined();
  });

  it("a report with no capReasons at all is unchanged", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(3));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "revise",
      reviewer: "lenses",
      findings: [],
    });

    expect((advance as { instruction: string }).instruction)
      .toContain("requests changes but supplies no actionable changes");
  });

  it("the re-run is bounded: after the cap the round routes normally", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(3));

    await stage.report(ctx, COVERAGE_REPORT);
    await stage.report(ctx, COVERAGE_REPORT);
    const third = await stage.report(ctx, COVERAGE_REPORT);

    expect(ctx.state.reviewRepairAttempts?.filter((a) => a.trigger === "coverage")).toHaveLength(2);
    // The third is no longer a coverage re-run. It falls through to the
    // empty change-request repair, which has its own bound and its own park.
    expect((third as { instruction: string }).instruction)
      .toContain("requests changes but supplies no actionable changes");
  });
});

describe("ISS-950 observability: capReasons reach the record and the artifact", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new CodeReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "code-review-capreasons-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot);
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("a landed round records the caps that fired, in both sinks", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(3));

    await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "revise",
      reviewer: "lenses",
      reviewId: "lens-r1",
      findings: [finding("major")],
      capReasons: [SELF_REPORTED_CAP],
    });

    expect(ctx.state.reviews.code[0]).toMatchObject({
      capReasons: [SELF_REPORTED_CAP],
    });
    const written = artifacts(sessionDir);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ capReasons: [SELF_REPORTED_CAP] });
  });

  it("a round with no caps carries no capReasons field at all", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(3));

    await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "revise",
      reviewer: "lenses",
      findings: [finding("major")],
    });

    // Absent, not empty: no claim was made, which is a different statement
    // from a known-empty one.
    expect(ctx.state.reviews.code[0]).not.toHaveProperty("capReasons");
    expect(artifacts(sessionDir)[0]).not.toHaveProperty("capReasons");
  });
});
