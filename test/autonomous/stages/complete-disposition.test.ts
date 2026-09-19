/**
 * ISS-1113: COMPLETE's "is there more work" issue check, the same Layer-2
 * advisory listing site T-475 fixed for earmarks, for the same reason.
 *
 * Once ISSUE_SWEEP skips non-actionable issues, a session whose only open
 * issues carry a non-actionable disposition would route to PICK_TICKET and
 * find nothing pickable there either. The predicate is the shared one, so the
 * three values this slice adds and ISS-1154's original three are treated
 * alike.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, isStageAdvance } from "../../../src/autonomous/stages/types.js";
import { CompleteStage } from "../../../src/autonomous/stages/complete.js";
import { NON_ACTIONABLE_DISPOSITIONS } from "../../../src/core/issue-disposition.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import type { ResolvedRecipe } from "../../../src/autonomous/stages/types.js";

/** Spelled out, not only iterated -- see the note in issue-sweep-disposition.test.ts. */
const EVERY_NON_ACTIONABLE = [
  "escalate_only", "owner_gated", "duplicate",
  "pre_existing", "accepted_out_of_scope", "forced_landing",
] as const;

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-0000000000f1",
    recipe: "coding", state: "COMPLETE", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [{ id: "T-001" }],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 1, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 5 },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  };
}

describe("CompleteStage: non-actionable issues are not more work (ISS-1113)", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new CompleteStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "complete-disposition-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
    for (const sub of ["tickets", "issues", "notes", "handovers", "lessons"]) {
      mkdirSync(join(testRoot, ".story", sub), { recursive: true });
    }
    writeFileSync(join(testRoot, ".story", "config.json"), JSON.stringify({
      version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }));
    writeFileSync(join(testRoot, ".story", "roadmap.json"), JSON.stringify({ title: "test", date: "2026-01-01", phases: [], blockers: [] }));
    // No tickets at all, so `nextTickets` returns "empty_project" and the
    // fallback open-issue check is what decides the target.
  });

  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  function writeIssue(id: string, disposition?: string): void {
    writeFileSync(join(testRoot, ".story", "issues", `${id}.json`), JSON.stringify({
      id, title: `Issue ${id}`, status: "open", severity: "medium", components: [],
      impact: "test", resolution: null, location: [], discoveredDate: "2026-01-01",
      resolvedDate: null, relatedTickets: [], earmark: null,
      ...(disposition ? { disposition } : {}),
    }));
  }

  async function target(): Promise<string | undefined> {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    const result = await stage.enter(ctx);
    expect(isStageAdvance(result)).toBe(true);
    return isStageAdvance(result) && "target" in result ? result.target : undefined;
  }

  it("covers every value the shared list carries", () => {
    expect([...NON_ACTIONABLE_DISPOSITIONS].sort()).toEqual([...EVERY_NON_ACTIONABLE].sort());
  });

  it("routes to PICK_TICKET when an open issue carries no disposition", async () => {
    writeIssue("ISS-001");
    expect(await target()).toBe("PICK_TICKET");
  });

  it.each(EVERY_NON_ACTIONABLE)(
    "routes to HANDOVER when the only open issue is %s",
    async (disposition) => {
      writeIssue("ISS-001", disposition);
      expect(await target()).toBe("HANDOVER");
    },
  );

  it("still routes to PICK_TICKET when one actionable issue sits among non-actionable ones", async () => {
    EVERY_NON_ACTIONABLE.forEach((d, i) => writeIssue(`ISS-${String(100 + i)}`, d));
    writeIssue("ISS-200");
    expect(await target()).toBe("PICK_TICKET");
  });
});
