import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BusReceiptSchema,
  foldBusThread,
  joinEndpoint,
  leaveEndpoint,
  readReceipt,
  sendBusMessage,
  writeReceipt,
  type BusReceipt,
} from "../../src/bus/index.js";
import * as fold from "../../src/bus/fold.js";
import { endpointMailboxPath, resolveBusPaths, type BusPaths } from "../../src/bus/paths.js";
import { idempotencyKeyHash } from "../../src/bus/security.js";
import { createBusFixture, type BusFixture } from "./helpers.js";

// D3 durable idempotency index. This is the highest-value group: the crash-window
// recovery drove five review rounds. There is no injectable durable-IO seam in
// src/bus/io.ts, so each crash window is exercised by reconstructing the exact
// on-disk state a crash would leave (a pending receipt, an un-activated pointer,
// a quarantined thread) and then re-sending with the same key. That drives the
// real recoverPendingReceipt path in the store rather than a mid-call injection.

const fixtures: BusFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture.root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function fx(): Promise<BusFixture> {
  const value = await createBusFixture("bus-idem");
  fixtures.push(value);
  return value;
}

function send(value: BusFixture, overrides: Record<string, unknown> = {}) {
  return sendBusMessage(value.root, {
    endpointId: value.reviewer.endpointId,
    clientTaskId: value.reviewerTaskId,
    threadKind: "question",
    messageKind: "question",
    severity: "medium",
    body: "Verify the recovery boundary",
    refs: { ciRun: "ci-idem" },
    idempotencyKey: "idem-key-1",
    ...overrides,
  });
}

function paths(root: string): Promise<BusPaths> {
  return resolveBusPaths(root, false);
}

function keyFor(endpointId: string, key: string): string {
  return idempotencyKeyHash(endpointId, key);
}

function ghostPointer(endpointId: string, mailboxSeq: number, messageId: string, threadId: string): string {
  return JSON.stringify({
    schema: "storybloq-bus-mailbox/v2",
    endpointId,
    mailboxSeq,
    messageId,
    threadId,
    entrySeq: 1,
    entryHash: "b".repeat(64),
    createdAt: new Date().toISOString(),
  });
}

function pointerName(mailboxSeq: number, messageId: string): string {
  return `${String(mailboxSeq).padStart(12, "0")}-${messageId}.json`;
}

describe("Storybloq Bus durable idempotency (D3)", () => {
  it("replays an exact send across a simulated process restart (state is fully on disk)", async () => {
    const value = await fx();
    const first = await send(value);
    const p = await paths(value.root);
    const keyHash = keyFor(value.reviewer.endpointId, "idem-key-1");
    const receipt = await readReceipt(p, value.reviewer.endpointId, keyHash);
    // The receipt is durable and final: a restart is just another disk read.
    expect(receipt).toMatchObject({
      state: "final",
      threadId: first.threadId,
      messageId: first.messageId,
      toEndpoint: value.implementer.endpointId,
    });
    const replay = await send(value);
    expect(replay).toMatchObject({
      replayed: true,
      threadId: first.threadId,
      messageId: first.messageId,
      toEndpoint: value.implementer.endpointId,
    });
  });

  it("fails idempotency_conflict when the resolved recipient changed (payloadHash binds the recipient)", async () => {
    const value = await fx();
    await send(value);
    // Retire the original recipient and bring in a fresh peer.
    await leaveEndpoint(value.root, value.implementer.endpointId, value.implementerTaskId);
    const replacement = (await joinEndpoint(value.root, {
      client: "codex",
      clientTaskId: "codex-task-replacement",
      surface: "codex_desktop",
    })).endpoint;
    expect(replacement.endpointId).not.toBe(value.implementer.endpointId);
    // Reusing the key now resolves a different recipient, so the recomputed
    // payloadHash no longer matches the stored (retired-recipient) hash.
    await expect(send(value)).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("throws idempotency_conflict when the same key reuses a different threadKind", async () => {
    const value = await fx();
    // Open a thread with threadKind "question" under a fixed key.
    await send(value);
    // Reuse the SAME key and the same opening message but a DIFFERENT valid
    // threadKind. threadKind is bound into payloadHash (normalizeSend), so the
    // recomputed hash differs and the receipt check rejects the reuse. This guards
    // against a regression that would drop threadKind from the hash (Codex #16).
    await expect(send(value, { threadKind: "coordination" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("supersedes a pending receipt whose message never landed and removes the recorded pointer intent", async () => {
    const value = await fx();
    const p = await paths(value.root);
    const keyHash = keyFor(value.reviewer.endpointId, "crash-a");
    const ghostThread = randomUUID();
    const ghostMessage = randomUUID();
    // The crash left a pending receipt plus a pending pointer intent, but no entry.
    await writeReceipt(p, {
      schema: "storybloq-bus-receipt/v1",
      endpointId: value.reviewer.endpointId,
      keyHash,
      payloadHash: "a".repeat(64),
      threadId: ghostThread,
      toEndpoint: value.implementer.endpointId,
      messageId: ghostMessage,
      mailboxSeq: 1,
      state: "pending",
      createdAt: new Date().toISOString(),
    } as BusReceipt);
    const pendingDir = join(endpointMailboxPath(p, value.implementer.endpointId), "pending");
    await writeFile(join(pendingDir, pointerName(1, ghostMessage)), ghostPointer(value.implementer.endpointId, 1, ghostMessage, ghostThread), "utf-8");

    const result = await send(value, { idempotencyKey: "crash-a" });
    // Provable absence via a successful fold -> supersede and publish fresh.
    expect(result.replayed).toBe(false);
    expect(result.messageId).not.toBe(ghostMessage);
    expect(result.threadId).not.toBe(ghostThread);
    expect(await readdir(pendingDir)).not.toContain(pointerName(1, ghostMessage));
    const finalReceipt = await readReceipt(p, value.reviewer.endpointId, keyHash);
    expect(finalReceipt).toMatchObject({ state: "final", threadId: result.threadId });
  });

  it("finalizes and replays a pending receipt whose message landed but was never finalized", async () => {
    const value = await fx();
    const first = await send(value);
    const p = await paths(value.root);
    const keyHash = keyFor(value.reviewer.endpointId, "idem-key-1");
    const receipt = await readReceipt(p, value.reviewer.endpointId, keyHash);
    // Simulate a crash after publication but before the receipt was finalized.
    await writeReceipt(p, { ...receipt!, state: "pending" });
    const result = await send(value);
    expect(result).toMatchObject({ replayed: true, threadId: first.threadId, messageId: first.messageId });
    expect((await readReceipt(p, value.reviewer.endpointId, keyHash))?.state).toBe("final");
  });

  it("activates the recorded pointer before finalizing when a crash landed between entry and activation", async () => {
    const value = await fx();
    const first = await send(value);
    const p = await paths(value.root);
    const mailbox = endpointMailboxPath(p, value.implementer.endpointId);
    const active = (await readdir(mailbox)).find((name) => /^\d{12}-.*\.json$/.test(name))!;
    // Crash window: entry published, pointer intent still pending, receipt pending.
    await rename(join(mailbox, active), join(mailbox, "pending", active));
    const keyHash = keyFor(value.reviewer.endpointId, "idem-key-1");
    const receipt = await readReceipt(p, value.reviewer.endpointId, keyHash);
    await writeReceipt(p, { ...receipt!, state: "pending" });

    const result = await send(value);
    expect(result).toMatchObject({ replayed: true, threadId: first.threadId, messageId: first.messageId });
    // The exact recorded pointer (seq + messageId) was activated, not scanned.
    expect(await readdir(join(mailbox, "pending"))).not.toContain(active);
    expect(await readdir(mailbox)).toContain(active);
  });

  it("supersedes a pending receipt and re-sends to the new recipient after the peer changed", async () => {
    const value = await fx();
    const p = await paths(value.root);
    const keyHash = keyFor(value.reviewer.endpointId, "crash-recipient");
    const ghostThread = randomUUID();
    const ghostMessage = randomUUID();
    await writeReceipt(p, {
      schema: "storybloq-bus-receipt/v1",
      endpointId: value.reviewer.endpointId,
      keyHash,
      payloadHash: "a".repeat(64),
      threadId: ghostThread,
      toEndpoint: value.implementer.endpointId,
      messageId: ghostMessage,
      mailboxSeq: 1,
      state: "pending",
      createdAt: new Date().toISOString(),
    } as BusReceipt);
    const pendingDir = join(endpointMailboxPath(p, value.implementer.endpointId), "pending");
    await writeFile(join(pendingDir, pointerName(1, ghostMessage)), ghostPointer(value.implementer.endpointId, 1, ghostMessage, ghostThread), "utf-8");
    // The recipient changes between the crash and the retry.
    await leaveEndpoint(value.root, value.implementer.endpointId, value.implementerTaskId);
    const replacement = (await joinEndpoint(value.root, {
      client: "codex",
      clientTaskId: "codex-task-new-peer",
      surface: "codex_desktop",
    })).endpoint;

    const result = await send(value, { idempotencyKey: "crash-recipient" });
    expect(result.replayed).toBe(false);
    expect(result.toEndpoint).toBe(replacement.endpointId);
    expect(result.messageId).not.toBe(ghostMessage);
    // The stale intent addressed to the retired peer was proven-removed.
    expect(await readdir(pendingDir)).not.toContain(pointerName(1, ghostMessage));
  });

  it("preserves the receipt and pointer intent and fails closed when the recorded thread is quarantined", async () => {
    const value = await fx();
    const first = await send(value);
    const p = await paths(value.root);
    const entriesDir = join(value.root, ".story", "bus", "threads", first.threadId, "entries");
    const filename = (await readdir(entriesDir))[0]!;
    const entryPath = join(entriesDir, filename);
    const entry = JSON.parse(await readFile(entryPath, "utf-8"));
    entry.payload.body = "tampered";
    await writeFile(entryPath, JSON.stringify(entry, null, 2) + "\n", "utf-8");
    const keyHash = keyFor(value.reviewer.endpointId, "idem-key-1");
    const receipt = await readReceipt(p, value.reviewer.endpointId, keyHash);
    await writeReceipt(p, { ...receipt!, state: "pending" });
    const mailbox = endpointMailboxPath(p, value.implementer.endpointId);
    const pointersBefore = (await readdir(mailbox)).filter((name) => /^\d{12}-.*\.json$/.test(name));

    // Absence can only be proven by a verified fold; a quarantined recorded
    // thread fails closed and preserves the receipt + intent for recovery.
    await expect(send(value)).rejects.toMatchObject({ code: "corrupt" });
    expect((await readReceipt(p, value.reviewer.endpointId, keyHash))?.state).toBe("pending");
    expect((await readdir(mailbox)).filter((name) => /^\d{12}-.*\.json$/.test(name))).toEqual(pointersBefore);
  });

  it("does not let a quarantined unrelated thread block a fresh send (ISS-855 acceptance)", async () => {
    const value = await fx();
    const first = await send(value);
    const entriesDir = join(value.root, ".story", "bus", "threads", first.threadId, "entries");
    const filename = (await readdir(entriesDir))[0]!;
    const entry = JSON.parse(await readFile(join(entriesDir, filename), "utf-8"));
    entry.payload.body = "tampered";
    await writeFile(join(entriesDir, filename), JSON.stringify(entry, null, 2) + "\n", "utf-8");
    expect((await foldBusThread(value.root, first.threadId)).integrity).toBe("quarantined");

    // A fresh send on a new key + new thread is unaffected by the corrupt thread.
    const fresh = await send(value, {
      idempotencyKey: "fresh-after-quarantine",
      body: "A fresh boundary is verified",
      refs: { ciRun: "ci-fresh" },
    });
    expect(fresh.replayed).toBe(false);
    expect(fresh.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fresh.threadId).not.toBe(first.threadId);
  });

  it("replays a terminal parked outcome instead of throwing thread_parked on retry", async () => {
    const value = await fx();
    // Open a thread, then reply once so a second identical reply is a duplicate
    // actionable fingerprint that the thread parks automatically.
    const first = await send(value);
    const replyPayload = {
      threadKind: undefined, // a reply targets an existing thread; no thread kind
      threadId: first.threadId,
      messageKind: "reply",
      body: "A duplicate reply boundary",
      refs: { ciRun: "ci-park-dup" },
      inReplyTo: first.messageId,
    };
    await send(value, { ...replyPayload, idempotencyKey: "park-first-reply" });

    // The second identical reply parks the thread (automatic PARK) and persists a
    // terminal parked receipt rather than publishing a message.
    const parked = await send(value, { ...replyPayload, idempotencyKey: "park-dup-reply" });
    expect(parked).toMatchObject({ parked: true, replayed: false });
    expect(parked.messageId).toBeNull();

    // Retrying the exact same parking send (same endpoint + same key + same
    // payload) replays the parked outcome; it must not throw thread_parked.
    const replay = await send(value, { ...replyPayload, idempotencyKey: "park-dup-reply" });
    expect(replay).toMatchObject({ parked: true, replayed: true, threadId: first.threadId });
    expect(replay.messageId).toBeNull();
  });

  it("replays a delivered message with parked:false even after the thread is later parked", async () => {
    const value = await fx();
    // A delivered opening message A on thread T.
    const a = await send(value, { idempotencyKey: "deliver-a", body: "Delivered A", refs: { ciRun: "ci-a" } });
    expect(a).toMatchObject({ replayed: false, parked: false });
    expect(a.messageId).toMatch(/^[0-9a-f-]{36}$/);

    // Park T through a LATER operation: a duplicate actionable reply fingerprint.
    const replyPayload = {
      threadKind: undefined,
      threadId: a.threadId,
      messageKind: "reply",
      body: "A duplicate reply boundary",
      refs: { ciRun: "ci-a-park" },
      inReplyTo: a.messageId,
    };
    await send(value, { ...replyPayload, idempotencyKey: "a-reply-1" });
    const parked = await send(value, { ...replyPayload, idempotencyKey: "a-reply-2-park" });
    expect(parked).toMatchObject({ parked: true });
    expect((await foldBusThread(value.root, a.threadId as string)).state).toBe("parked");

    // Replaying A's key now: `parked` derives from the receipt outcome (delivered),
    // NOT the thread's current state, so it stays false while `state` reports parked
    // and the original messageId is returned.
    const replay = await send(value, { idempotencyKey: "deliver-a", body: "Delivered A", refs: { ciRun: "ci-a" } });
    expect(replay).toMatchObject({ replayed: true, parked: false, state: "parked", threadId: a.threadId });
    expect(replay.messageId).toBe(a.messageId);
  });

  it("replays by folding only the recorded thread, never unrelated threads", async () => {
    const value = await fx();
    const t1 = await send(value, { idempotencyKey: "k1", body: "One boundary", refs: { ciRun: "ci-1" } });
    const t2 = await send(value, { idempotencyKey: "k2", body: "Two boundary", refs: { ciRun: "ci-2" } });
    const t3 = await send(value, { idempotencyKey: "k3", body: "Three boundary", refs: { ciRun: "ci-3" } });

    const spy = vi.spyOn(fold, "foldBusThread");
    const replay = await send(value, { idempotencyKey: "k1", body: "One boundary", refs: { ciRun: "ci-1" } });
    expect(replay).toMatchObject({ replayed: true, threadId: t1.threadId });

    const foldedIds = spy.mock.calls.map((call) => call[1]);
    // The spy being called with t1 proves interception (guards a no-op spy).
    expect(foldedIds).toContain(t1.threadId);
    expect(foldedIds).not.toContain(t2.threadId);
    expect(foldedIds).not.toContain(t3.threadId);
    spy.mockRestore();
  });
});

// R19: D3 allocates messageId + mailboxSeq before the pending write and no writer
// emits null, so the schema must reject a null in either field. A null admitted an
// externally-corrupt receipt that recovery then mistook for message-absent.
describe("BusReceiptSchema required identity (R19)", () => {
  function baseReceipt(): Record<string, unknown> {
    return {
      schema: "storybloq-bus-receipt/v1",
      endpointId: randomUUID(),
      keyHash: "a".repeat(64),
      payloadHash: "b".repeat(64),
      threadId: randomUUID(),
      toEndpoint: randomUUID(),
      messageId: randomUUID(),
      mailboxSeq: 1,
      state: "final",
      createdAt: new Date().toISOString(),
    };
  }

  it("accepts a fully populated receipt", () => {
    expect(BusReceiptSchema.safeParse(baseReceipt()).success).toBe(true);
  });

  it("rejects a receipt with a null messageId", () => {
    expect(BusReceiptSchema.safeParse({ ...baseReceipt(), messageId: null }).success).toBe(false);
  });

  it("rejects a receipt with a null mailboxSeq", () => {
    expect(BusReceiptSchema.safeParse({ ...baseReceipt(), mailboxSeq: null }).success).toBe(false);
  });
});
