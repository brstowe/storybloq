import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import {
  initializeBus,
  joinEndpoint,
  leaveEndpoint,
  readReceipt,
  sendBusMessage,
  writeReceipt,
  type BusEndpoint,
  type BusReceipt,
} from "../../src/bus/index.js";
import { resolveBusPaths } from "../../src/bus/paths.js";
import { idempotencyKeyHash } from "../../src/bus/security.js";
import { createBusFixture, createIssue, type BusFixture } from "./helpers.js";

// D2 endpoint-addressed routing: a send targets the sole active peer. No declared
// roles, no toRole. Self-send is structurally impossible.

const fixtures: BusFixture[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...fixtures.splice(0).map((fixture) => rm(fixture.root, { recursive: true, force: true })),
    ...roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ]);
});

async function fx(): Promise<BusFixture> {
  const value = await createBusFixture("bus-routing");
  fixtures.push(value);
  return value;
}

// Clones an existing endpoint into a fresh active endpoint plus its mailbox,
// bypassing the two-endpoint join guard, to build an invariant-violating runtime.
async function forgeExtraEndpoint(root: string, templateEndpointId: string): Promise<string> {
  const busRoot = join(root, ".story", "bus");
  const template = JSON.parse(await readFile(join(busRoot, "endpoints", `${templateEndpointId}.json`), "utf-8"));
  const endpointId = randomUUID();
  const record = { ...template, endpointId, clientTaskId: `forged-${endpointId}`, resumeHandle: `forged-${endpointId}` };
  await writeFile(join(busRoot, "endpoints", `${endpointId}.json`), JSON.stringify(record, null, 2) + "\n", "utf-8");
  await mkdir(join(busRoot, "mailboxes", endpointId, "pending"), { recursive: true, mode: 0o700 });
  return endpointId;
}

// Writes an unparseable endpoint record under a valid `<uuid>.json` filename (with
// a matching mailbox so the layout assertion passes), so the corruption is caught
// by the listEndpoints content parse rather than the filename/layout check.
async function forgeCorruptEndpoint(root: string): Promise<void> {
  const busRoot = join(root, ".story", "bus");
  const endpointId = randomUUID();
  await mkdir(join(busRoot, "mailboxes", endpointId, "pending"), { recursive: true, mode: 0o700 });
  await writeFile(join(busRoot, "endpoints", `${endpointId}.json`), "{ not valid endpoint json", "utf-8");
}

async function soloEndpoint(): Promise<{ root: string; endpoint: BusEndpoint; taskId: string }> {
  const root = await mkdtemp(join(tmpdir(), "bus-solo-"));
  roots.push(root);
  await initProject(root, { name: "bus-solo" });
  await initializeBus(root);
  const taskId = "claude-solo-task";
  const endpoint = (await joinEndpoint(root, {
    client: "claude",
    clientTaskId: taskId,
    surface: "claude_cli",
  })).endpoint;
  return { root, endpoint, taskId };
}

describe("Storybloq Bus routing (D2)", () => {
  it("fails no_peer when a lone endpoint sends with no active peer", async () => {
    const { root, endpoint, taskId } = await soloEndpoint();
    await expect(sendBusMessage(root, {
      endpointId: endpoint.endpointId,
      clientTaskId: taskId,
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "Anyone there?",
      refs: { ciRun: "ci-no-peer" },
      idempotencyKey: "no-peer-1",
    })).rejects.toMatchObject({
      code: "no_peer",
      message: expect.stringContaining("waiting_for_peer"),
    });
  });

  it("fails closed when a third endpoint tries to join two active endpoints", async () => {
    const value = await fx();
    await expect(joinEndpoint(value.root, {
      client: "codex",
      clientTaskId: "codex-task-third",
      surface: "codex_desktop",
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("fails a send closed (conflict) rather than routing to an arbitrary peer with three active endpoints (R5)", async () => {
    const value = await fx();
    // A third forged endpoint means the peer set is ambiguous; the send must not
    // silently pick peers[0]. It fails closed on the two-endpoint invariant.
    await forgeExtraEndpoint(value.root, value.implementer.endpointId);
    await expect(sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "Which peer?",
      refs: { ciRun: "ci-three-peers" },
      idempotencyKey: "three-peers-1",
    })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("Two-endpoint invariant violated"),
    });
  });

  it("fails a send closed (corrupt) when the endpoint registry has a malformed record (R5)", async () => {
    const value = await fx();
    // A corrupt endpoint file makes listEndpoints report a finding; the send must
    // honor that finding and fail closed instead of ignoring it.
    await forgeCorruptEndpoint(value.root);
    await expect(sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "Send over a corrupt registry",
      refs: { ciRun: "ci-corrupt-registry" },
      idempotencyKey: "corrupt-registry-1",
    })).rejects.toMatchObject({
      code: "corrupt",
      message: expect.stringContaining("Endpoint registry is corrupt"),
    });
  });

  it("fails a reply closed (corrupt) when the registry is corrupt, before any mutation (R5 reply branch)", async () => {
    const value = await fx();
    // Establish a valid thread between the two endpoints.
    const first = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "Open a thread to reply into",
      refs: { ciRun: "ci-reply-corrupt" },
      idempotencyKey: "reply-corrupt-open",
    });
    // Corrupt the registry AFTER the thread exists. The reply peer-resolution
    // branch must honor the listEndpoints finding and fail closed, matching the
    // new-thread path, rather than routing over a corrupt registry.
    await forgeCorruptEndpoint(value.root);
    const mailbox = join(value.root, ".story", "bus", "mailboxes", value.implementer.endpointId);
    const pointersBefore = (await readdir(mailbox)).filter((name) => /^\d{12}-.*\.json$/.test(name));
    const entriesDir = join(value.root, ".story", "bus", "threads", first.threadId, "entries");
    const entriesBefore = await readdir(entriesDir);

    await expect(sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      messageKind: "reply",
      severity: "medium",
      body: "Reply over a corrupt registry",
      refs: { ciRun: "ci-reply-corrupt-2" },
      inReplyTo: first.messageId,
      idempotencyKey: "reply-corrupt-1",
    })).rejects.toMatchObject({
      code: "corrupt",
      message: expect.stringContaining("Endpoint registry is corrupt"),
    });

    // No receipt/pointer/entry mutation occurred: the fail-closed check ran first. Assert
    // the RECEIPT too (not just pointers/entries): a regression that wrote a pending
    // idempotency receipt before detecting the corrupt registry would still leave the
    // mailbox and thread untouched, so only the receipt-null check would catch it.
    const p = await resolveBusPaths(value.root, false);
    const replyKeyHash = idempotencyKeyHash(value.reviewer.endpointId, "reply-corrupt-1");
    expect(await readReceipt(p, value.reviewer.endpointId, replyKeyHash)).toBeNull();
    expect((await readdir(mailbox)).filter((name) => /^\d{12}-.*\.json$/.test(name))).toEqual(pointersBefore);
    expect(await readdir(entriesDir)).toEqual(entriesBefore);
  });

  it("refuses --replace of an incumbent without positive offline proof", async () => {
    const value = await fx();
    await expect(joinEndpoint(value.root, {
      client: "codex",
      clientTaskId: "codex-task-third",
      surface: "codex_desktop",
      replace: value.implementer.endpointId,
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("fails participant_retired when replying into a thread whose peer retired", async () => {
    const value = await fx();
    const first = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "Still connected?",
      refs: { ciRun: "ci-retire" },
      idempotencyKey: "retire-thread-1",
    });
    // The peer participant (the addressee) retires.
    await leaveEndpoint(value.root, value.implementer.endpointId, value.implementerTaskId);
    await expect(sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      messageKind: "reply",
      severity: "medium",
      body: "Are you still there?",
      refs: { ciRun: "ci-retire-2" },
      inReplyTo: first.messageId,
      idempotencyKey: "retire-reply-1",
    })).rejects.toMatchObject({ code: "participant_retired" });
  });

  it("replays a committed reply after the peer retires and refuses a fresh reply into it", async () => {
    const value = await fx();
    const issueId = await createIssue(value.root, "critical");
    // Open a thread between the two endpoints.
    const first = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "Open a thread to reply into",
      refs: { ciRun: "ci-replay-open" },
      idempotencyKey: "replay-open-1",
    });
    // Commit a CRITICAL reply carrying an idempotency key while the peer is active.
    const replyInput = {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      messageKind: "reply" as const,
      severity: "critical" as const,
      body: "Critical follow-up before retirement",
      refs: { issue: issueId },
      inReplyTo: first.messageId,
      idempotencyKey: "replay-critical-reply",
    };
    const reply = await sendBusMessage(value.root, replyInput);

    const mailbox = join(value.root, ".story", "bus", "mailboxes", value.implementer.endpointId);
    const entriesDir = join(value.root, ".story", "bus", "threads", first.threadId, "entries");
    const isPointer = (name: string) => /^\d{12}-.*\.json$/.test(name);

    // The peer (the addressee) retires.
    await leaveEndpoint(value.root, value.implementer.endpointId, value.implementerTaskId);
    const pointersBefore = (await readdir(mailbox)).filter(isPointer);
    const entriesBefore = await readdir(entriesDir);

    // Retrying the SAME send replays the committed reply (Fix B defers the
    // participant_retired throw to AFTER the receipt-replay path): same messageId,
    // no second message published (entry + mailbox pointer counts unchanged).
    const replay = await sendBusMessage(value.root, replyInput);
    expect(replay.messageId).toBe(reply.messageId);
    expect((await readdir(mailbox)).filter(isPointer)).toEqual(pointersBefore);
    expect(await readdir(entriesDir)).toEqual(entriesBefore);

    // A FRESH reply (new key) into the retired-peer thread fails closed.
    await expect(sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      messageKind: "reply",
      severity: "medium",
      body: "A brand new reply",
      refs: { ciRun: "ci-fresh-reply" },
      inReplyTo: first.messageId,
      idempotencyKey: "fresh-reply-after-retire",
    })).rejects.toMatchObject({ code: "participant_retired" });
  });

  it("replays a committed NEW-thread send after the peer retires (idempotent replay must not depend on peer liveness)", async () => {
    const value = await fx();
    const newThreadInput = {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question" as const,
      messageKind: "question" as const,
      severity: "medium" as const,
      body: "New thread committed before the peer retires",
      refs: { ciRun: "ci-new-retire" },
      idempotencyKey: "new-thread-retire-1",
    };
    // Commit the new-thread send while the sole peer (implementer) is active.
    const first = await sendBusMessage(value.root, newThreadInput);

    const mailbox = join(value.root, ".story", "bus", "mailboxes", value.implementer.endpointId);
    const entriesDir = join(value.root, ".story", "bus", "threads", first.threadId, "entries");
    const isPointer = (name: string) => /^\d{12}-.*\.json$/.test(name);

    // The sole active peer retires. The sender never learned the threadId out of band,
    // so it retries the identical new-thread input (no threadId, same idempotencyKey).
    // resolveActivePeer now returns null, but the committed receipt must still replay.
    await leaveEndpoint(value.root, value.implementer.endpointId, value.implementerTaskId);
    const pointersBefore = (await readdir(mailbox)).filter(isPointer);
    const entriesBefore = await readdir(entriesDir);

    const replay = await sendBusMessage(value.root, newThreadInput);
    expect(replay.messageId).toBe(first.messageId);
    expect(replay.threadId).toBe(first.threadId);
    // No second publication: entry + mailbox pointer counts unchanged.
    expect((await readdir(mailbox)).filter(isPointer)).toEqual(pointersBefore);
    expect(await readdir(entriesDir)).toEqual(entriesBefore);
  });

  it("still fails no_peer for a FRESH new-thread send when no active peer remains", async () => {
    const value = await fx();
    // Retire the peer with no prior committed send under this key: nothing to replay,
    // so the deferred no_peer refusal must still fire (the fix must not weaken it).
    await leaveEndpoint(value.root, value.implementer.endpointId, value.implementerTaskId);
    await expect(sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "No peer to receive this",
      refs: { ciRun: "ci-fresh-no-peer" },
      idempotencyKey: "fresh-no-peer-1",
    })).rejects.toMatchObject({ code: "no_peer" });
  });

  it("fails no_peer (mutating nothing durable) for a new-thread send with only a pending, never-committed receipt after the peer retires", async () => {
    // The deferral of the new-thread no_peer refusal (F6) must NOT let a pending-but-never-
    // committed receipt open a thread to a retired peer. A committed new-thread send replays
    // (covered above); this pins the middle case: a prior PENDING receipt whose message never
    // landed. resolveActivePeer returns null, the pending receipt is read, recovery proves the
    // message absent and returns null, so the deferred no_peer fires -- nothing durable is
    // published to the retired peer.
    const value = await fx();
    const key = "pending-new-thread-no-peer";
    const p = await resolveBusPaths(value.root, false);
    const keyHash = idempotencyKeyHash(value.reviewer.endpointId, key);
    // Plant a valid PENDING delivered receipt for a new-thread send that crashed before
    // committing: it references a threadId/messageId that never landed on disk.
    await writeReceipt(p, {
      schema: "storybloq-bus-receipt/v1",
      endpointId: value.reviewer.endpointId,
      keyHash,
      payloadHash: "a".repeat(64),
      threadId: randomUUID(),
      toEndpoint: value.implementer.endpointId,
      messageId: randomUUID(),
      mailboxSeq: 1,
      state: "pending",
      createdAt: new Date().toISOString(),
    } as BusReceipt);

    // The sole peer retires, so resolveActivePeer returns null.
    await leaveEndpoint(value.root, value.implementer.endpointId, value.implementerTaskId);

    const threadsDir = join(value.root, ".story", "bus", "threads");
    const mailbox = join(value.root, ".story", "bus", "mailboxes", value.implementer.endpointId);
    const isPointer = (name: string) => /^\d{12}-.*\.json$/.test(name);
    const threadsBefore = await readdir(threadsDir);
    const pointersBefore = (await readdir(mailbox)).filter(isPointer);

    await expect(sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "A pending-but-uncommitted new thread after retirement",
      refs: { ciRun: "ci-pending-no-peer" },
      idempotencyKey: key,
    })).rejects.toMatchObject({ code: "no_peer" });

    // No thread was opened to the retired peer and no mailbox pointer was published.
    expect(await readdir(threadsDir)).toEqual(threadsBefore);
    expect((await readdir(mailbox)).filter(isPointer)).toEqual(pointersBefore);
    // The stale pending receipt was superseded (removed) by recovery, so a later retry is a
    // clean fresh no_peer, not a lingering pending-receipt replay.
    expect(await readReceipt(p, value.reviewer.endpointId, keyHash)).toBeNull();
  });
});
