import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { exportBusThread, pollBus, sendBusMessage } from "../../src/bus/index.js";
import { createBusFixture, createIssue, type BusFixture } from "./helpers.js";

// D1 fluid roles: v2 endpoints carry no role. derivedRole(kind) is display-only
// metadata; any endpoint may send any kind. A single endpoint can act as reviewer
// (issue_notice) and implementer (claim) in one thread with no self-role rejection.

const fixtures: BusFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture.root, { recursive: true, force: true })));
});

async function fx(): Promise<BusFixture> {
  const value = await createBusFixture("bus-fluid");
  fixtures.push(value);
  return value;
}

describe("Storybloq Bus fluid roles (D1)", () => {
  it("derives role from message kind: one endpoint sends issue_notice then claim in one thread", async () => {
    const value = await fx();
    const issueId = await createIssue(value.root, "high");

    // The SAME endpoint sends a reviewer-kind then an implementer-kind message.
    const notice = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      severity: "high",
      body: "Found a defect at the boundary.",
      refs: { issue: issueId },
      idempotencyKey: "fluid-notice",
    });
    const claim = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: notice.threadId,
      messageKind: "claim",
      severity: "info",
      body: "Claiming the fix for this defect.",
      refs: { ciRun: "ci-fluid-claim" },
      inReplyTo: notice.messageId,
      idempotencyKey: "fluid-claim",
    });
    // No self-role rejection: both sends from one endpoint succeed.
    expect(notice.replayed).toBe(false);
    expect(claim.replayed).toBe(false);

    const polled = await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    });
    const byId = new Map(polled.messages.map((envelope) => [envelope.message.messageId, envelope]));
    // Poll envelope sender.role is derivedRole(kind), from the same endpoint.
    expect(byId.get(notice.messageId!)!.sender).toMatchObject({
      role: "reviewer",
      endpointId: value.reviewer.endpointId,
    });
    expect(byId.get(claim.messageId!)!.sender).toMatchObject({
      role: "implementer",
      endpointId: value.reviewer.endpointId,
    });

    // Export labels each entry by its derived role too.
    const md = await exportBusThread(value.root, notice.threadId, "md");
    expect(md).toContain("reviewer (issue_notice)");
    expect(md).toContain("implementer (claim)");
  });

  it("labels unlabeled kinds with a null derived role in the poll envelope", async () => {
    const value = await fx();
    const question = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "Is the boundary safe?",
      refs: { ciRun: "ci-fluid-q" },
      idempotencyKey: "fluid-question",
    });
    const polled = await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    });
    expect(polled.messages[0]!.sender).toMatchObject({
      role: null,
      endpointId: value.reviewer.endpointId,
      client: "claude",
    });
    expect(polled.messages[0]!.message.messageId).toBe(question.messageId);
  });
});
