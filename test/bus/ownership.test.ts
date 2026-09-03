import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeBusMessage,
  consumeCompactionSuccession,
  leaveEndpoint,
  mintCompactionSuccession,
  pendingMailboxCursor,
  pollBus,
  sendBusMessage,
} from "../../src/bus/index.js";
import { createBusFixture, type BusFixture } from "./helpers.js";

// D2 ownership proof: every endpoint-scoped operation requires endpointId +
// validated current clientTaskId to match the endpoint record under its lock.
// Marker/flag ids are hints, never authority.

const fixtures: BusFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture.root, { recursive: true, force: true })));
});

async function fx(): Promise<BusFixture> {
  const value = await createBusFixture("bus-ownership");
  fixtures.push(value);
  return value;
}

function reviewSend(value: BusFixture) {
  return sendBusMessage(value.root, {
    endpointId: value.reviewer.endpointId,
    clientTaskId: value.reviewerTaskId,
    threadKind: "question",
    messageKind: "question",
    severity: "medium",
    body: "Verify the ownership boundary",
    refs: { ciRun: "ci-own" },
    idempotencyKey: "own-question-1",
  });
}

describe("Storybloq Bus ownership proof (D2)", () => {
  it("rejects a forged (nonexistent) marker endpoint id", async () => {
    const value = await fx();
    await expect(pollBus(value.root, {
      endpointId: randomUUID(),
      clientTaskId: value.reviewerTaskId,
    })).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects a copied task id that does not own the endpoint", async () => {
    const value = await fx();
    await expect(pollBus(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: "claude-task-impersonator",
    })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("rejects a cross-endpoint acknowledgment", async () => {
    const value = await fx();
    const sent = await reviewSend(value); // reviewer -> implementer
    // The sender (reviewer) is not the addressee and cannot acknowledge.
    await expect(acknowledgeBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      messageId: sent.messageId!,
      disposition: "accepted",
    })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("scopes the pending mailbox cursor to the owning task and rejects foreign or retired callers", async () => {
    const value = await fx();
    await reviewSend(value); // reviewer -> implementer, one pending pointer

    // The owning task reads its own cursor.
    const owned = await pendingMailboxCursor(value.root, value.implementer.endpointId, value.implementerTaskId);
    expect(owned.count).toBe(1);

    // A foreign task id (does not own the endpoint) is rejected: the cursor is
    // not a forgery surface (D2).
    await expect(pendingMailboxCursor(value.root, value.implementer.endpointId, "claude-task-impersonator"))
      .rejects.toMatchObject({ code: "unauthorized" });

    // A retired endpoint no longer authorizes even its own former task.
    await leaveEndpoint(value.root, value.implementer.endpointId, value.implementerTaskId);
    await expect(pendingMailboxCursor(value.root, value.implementer.endpointId, value.implementerTaskId))
      .rejects.toMatchObject({ code: "unauthorized" });
  });

  it("rejects a valid task reading a peer endpoint's pending cursor (cross-endpoint mismatch)", async () => {
    const value = await fx();
    await reviewSend(value); // reviewer -> implementer, one pending pointer

    // The reviewer task legitimately owns the reviewer endpoint, but presenting the
    // implementer endpoint id is a cross-endpoint mismatch that must fail closed
    // rather than returning the implementer's cursor.
    await expect(pendingMailboxCursor(value.root, value.implementer.endpointId, value.reviewerTaskId))
      .rejects.toMatchObject({ code: "unauthorized" });
    // The reverse pairing is equally rejected.
    await expect(pendingMailboxCursor(value.root, value.reviewer.endpointId, value.implementerTaskId))
      .rejects.toMatchObject({ code: "unauthorized" });
  });

  it("does not honor a succession record after the endpoint retired", async () => {
    const value = await fx();
    const transcriptPath = "/tmp/ownership-succession.jsonl";
    const minted = await mintCompactionSuccession({
      root: value.root,
      client: "codex",
      clientTaskId: value.implementerTaskId,
      transcriptPath,
    });
    expect(minted?.endpointId).toBe(value.implementer.endpointId);
    // The endpoint retires; the stale succession record must not rebind it.
    await leaveEndpoint(value.root, value.implementer.endpointId, value.implementerTaskId);
    expect(await consumeCompactionSuccession({
      root: value.root,
      client: "codex",
      clientTaskId: "codex-task-successor",
      transcriptPath,
    })).toBeNull();
  });
});
