import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FinalizeStage } from "../../../src/autonomous/stages/finalize.js";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import { acknowledgeBusMessage, sendBusMessage } from "../../../src/bus/index.js";
import { createBusFixture, createIssue, type BusFixture } from "../../bus/helpers.js";

const fixtures: BusFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture.root, { recursive: true, force: true })));
});

function recipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: {},
    dirtyFileHandling: "block",
    branchStrategy: "none",
    defaults: {
      maxTicketsPerSession: 1,
      compactThreshold: "high",
      reviewBackends: ["codex", "agent"],
    },
  };
}

function state(): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-000000000420",
    recipe: "coding",
    state: "FINALIZE",
    revision: 1,
    status: "active",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: null, expectedHead: null },
    lease: { workspaceId: "bus-finalize", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 1, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
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
    config: { maxTicketsPerSession: 1, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
  } as FullSessionState;
}

describe("FINALIZE Storybloq Bus gate", () => {
  it("blocks an unacknowledged critical notice before staging", async () => {
    const fixture = await createBusFixture("finalize-bus");
    fixtures.push(fixture);
    const issueId = await createIssue(fixture.root, "critical");
    const sent = await sendBusMessage(fixture.root, {
      endpointId: fixture.reviewer.endpointId,
      clientTaskId: fixture.reviewerTaskId,
      threadKind: "issue_notice",
      toRole: "implementer",
      messageKind: "issue_notice",
      severity: "critical",
      body: "Critical review finding requires acknowledgment.",
      refs: { issue: issueId },
      idempotencyKey: "finalize-critical-notice",
    });
    const sessionDir = join(fixture.root, ".story", "sessions", state().sessionId);
    await mkdir(sessionDir, { recursive: true });
    const stage = new FinalizeStage();
    const blocked = await stage.enter(new StageContext(fixture.root, sessionDir, state(), recipe()));
    expect(blocked).toHaveProperty("instruction");
    expect((blocked as { instruction: string }).instruction).toContain("Finalize blocked by Storybloq Bus");

    await acknowledgeBusMessage(fixture.root, {
      endpointId: fixture.implementer.endpointId,
      clientTaskId: fixture.implementerTaskId,
      messageId: sent.messageId!,
      disposition: "accepted",
    });
    const clear = await stage.enter(new StageContext(fixture.root, sessionDir, state(), recipe()));
    expect((clear as { instruction: string }).instruction).toContain("# Finalize");
    expect((clear as { instruction: string }).instruction).not.toContain("blocked by Storybloq Bus");
  });
});
