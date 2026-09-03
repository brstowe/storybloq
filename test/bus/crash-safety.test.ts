import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BusReceiptSchema,
  finalizeReceipt,
  foldBusThread,
  pollBus,
  readReceipt,
  receiptPath,
  removeReceipt,
  sendBusMessage,
  updateBusThread,
  writeReceipt,
  type BusReceipt,
} from "../../src/bus/index.js";
import { endpointMailboxPath, resolveBusPaths, type BusPaths } from "../../src/bus/paths.js";
import { idempotencyKeyHash } from "../../src/bus/security.js";
import { createBusFixture, type BusFixture } from "./helpers.js";

// Round-3 crash-safety coverage for the D3 park + finalize hardening. Each crash
// window is reproduced by reconstructing the exact on-disk state a crash leaves
// (a pending receipt with or without its park entry) and then re-sending with the
// same idempotency key, driving the real recoverPendingReceipt / finalizeReceipt
// paths in the store rather than a mid-call injection (there is no injectable
// durable-IO seam, matching the note in idempotency.test.ts).

const fixtures: BusFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture.root, { recursive: true, force: true })));
});

async function fx(): Promise<BusFixture> {
  const value = await createBusFixture("bus-crash");
  fixtures.push(value);
  return value;
}

function paths(root: string): Promise<BusPaths> {
  return resolveBusPaths(root, false);
}

function keyFor(endpointId: string, key: string): string {
  return idempotencyKeyHash(endpointId, key);
}

// A reviewer-originated question (opens a new thread).
function send(value: BusFixture, overrides: Record<string, unknown> = {}) {
  return sendBusMessage(value.root, {
    endpointId: value.reviewer.endpointId,
    clientTaskId: value.reviewerTaskId,
    threadKind: "question",
    messageKind: "question",
    severity: "medium",
    body: "Verify the crash boundary",
    refs: { ciRun: "ci-crash" },
    idempotencyKey: "crash-open-1",
    ...overrides,
  });
}

// Snapshot a recipient mailbox: the sorted (active + pending) pointer filenames and
// their exact byte contents, so a failed call can be proven to leave the mailbox
// byte-identical (no side-effect mutation).
async function snapshotMailbox(p: BusPaths, endpointId: string): Promise<Record<string, string>> {
  const mailbox = endpointMailboxPath(p, endpointId);
  const snapshot: Record<string, string> = {};
  for (const directory of [mailbox, join(mailbox, "pending")]) {
    let filenames: string[];
    try {
      filenames = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const filename of filenames) {
      const key = directory === mailbox ? filename : `pending/${filename}`;
      snapshot[key] = await readFile(join(directory, filename), "utf-8");
    }
  }
  return snapshot;
}

// Drives a thread to the point where the NEXT identical reply is a duplicate
// actionable fingerprint. Returns the reply payload overrides (minus the
// idempotency key) so the caller can send the parking duplicate under any key.
async function driveToDuplicateBoundary(value: BusFixture): Promise<Record<string, unknown>> {
  const first = await send(value, { idempotencyKey: "park-open" });
  const replyPayload = {
    threadKind: undefined,
    threadId: first.threadId,
    messageKind: "reply",
    body: "A duplicate reply boundary",
    refs: { ciRun: "ci-park-dup" },
    inReplyTo: first.messageId,
  };
  await send(value, { ...replyPayload, idempotencyKey: "park-first-reply" });
  return replyPayload;
}

describe("Storybloq Bus park crash windows (D3/#4)", () => {
  it("finalizes and replays a pending parked receipt when the park entry already landed", async () => {
    const value = await fx();
    const replyPayload = await driveToDuplicateBoundary(value);
    // The duplicate reply parks the thread and writes a final parked receipt.
    const parked = await send(value, { ...replyPayload, idempotencyKey: "park-dup" });
    expect(parked).toMatchObject({ parked: true, replayed: false });
    expect(parked.messageId).toBeNull();

    const p = await paths(value.root);
    const keyHash = keyFor(value.reviewer.endpointId, "park-dup");
    const receipt = await readReceipt(p, value.reviewer.endpointId, keyHash);
    expect(receipt).toMatchObject({ state: "final", outcome: "parked" });
    // The crash-safe park intermediate carries no messageId/mailboxSeq.
    expect(receipt?.messageId ?? null).toBeNull();
    expect(receipt?.mailboxSeq ?? null).toBeNull();

    // Crash window: the park state entry landed (thread parked) but only the
    // PENDING parked receipt exists (the finalize never ran).
    await writeReceipt(p, { ...receipt!, state: "pending" });

    // The retry must replay the parked outcome, not throw thread_parked.
    const replay = await send(value, { ...replyPayload, idempotencyKey: "park-dup" });
    expect(replay).toMatchObject({ parked: true, replayed: true, threadId: parked.threadId });
    expect(replay.messageId).toBeNull();
    // The receipt is finalized again and stays a parked outcome.
    const finalReceipt = await readReceipt(p, value.reviewer.endpointId, keyHash);
    expect(finalReceipt).toMatchObject({ state: "final", outcome: "parked" });
  });

  it("removes a pending parked receipt and re-parks when the park entry never landed", async () => {
    const value = await fx();
    const replyPayload = await driveToDuplicateBoundary(value);
    const threadId = replyPayload.threadId as string;
    // The thread is still open: a duplicate reply would park it, but no park
    // entry has been written yet.
    expect((await foldBusThread(value.root, threadId)).state).toBe("open");

    const p = await paths(value.root);
    const keyHash = keyFor(value.reviewer.endpointId, "park-crash-before-entry");
    // A crash left a PENDING parked receipt (bound to a preallocated park entry
    // that never landed) but no park state entry (thread open). The receipt carries
    // its stateEntryHash binding just as the store writes it before the entry lands.
    await writeReceipt(p, {
      schema: "storybloq-bus-receipt/v1",
      endpointId: value.reviewer.endpointId,
      keyHash,
      payloadHash: "a".repeat(64),
      threadId,
      toEndpoint: value.implementer.endpointId,
      state: "pending",
      outcome: "parked",
      stateEntryHash: "f".repeat(64),
      createdAt: new Date().toISOString(),
    } as BusReceipt);

    // Recovery must not throw: it removes the stale pending receipt, re-attempts
    // the send, and (the duplicate condition still holds) re-parks the thread.
    const result = await send(value, { ...replyPayload, idempotencyKey: "park-crash-before-entry" });
    expect(result).toMatchObject({ parked: true, replayed: false, threadId });
    expect(result.messageId).toBeNull();
    expect((await foldBusThread(value.root, threadId)).state).toBe("parked");
    // A fresh final parked receipt now exists for the reused key.
    expect(await readReceipt(p, value.reviewer.endpointId, keyHash))
      .toMatchObject({ state: "final", outcome: "parked" });
  });
});

describe("Storybloq Bus idempotency conflict before mailbox mutation (#3/#4)", () => {
  it("throws idempotency_conflict for a reused key with a different payload and mutates no mailbox", async () => {
    const value = await fx();
    const first = await send(value, { idempotencyKey: "conflict-key", body: "Payload A" });
    const p = await paths(value.root);
    const keyHash = keyFor(value.reviewer.endpointId, "conflict-key");
    const receipt = await readReceipt(p, value.reviewer.endpointId, keyHash);
    // Crash after the message landed but before the receipt was finalized: the
    // message-present recovery branch will run on the retry.
    await writeReceipt(p, { ...receipt!, state: "pending" });

    const before = await snapshotMailbox(p, value.implementer.endpointId);
    // Reusing the key with a DIFFERENT payload (body B) is a conflict detected in
    // recovery BEFORE any mailbox mutation.
    await expect(send(value, { idempotencyKey: "conflict-key", body: "Payload B" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    const after = await snapshotMailbox(p, value.implementer.endpointId);
    // The recipient mailbox is byte-identical: the conflict had no side effect.
    expect(after).toEqual(before);
    expect(Object.keys(after).length).toBeGreaterThan(0);
    // The in-flight message stays recoverable on a retry with its ORIGINAL payload.
    const replay = await send(value, { idempotencyKey: "conflict-key", body: "Payload A" });
    expect(replay).toMatchObject({ replayed: true, threadId: first.threadId, messageId: first.messageId });
  });

  it("supersedes an uncommitted pending receipt with a different payload and delivers it (no conflict)", async () => {
    const value = await fx();
    const p = await paths(value.root);
    const keyHash = keyFor(value.reviewer.endpointId, "absent-supersede");
    const ghostThread = randomUUID();
    const ghostMessage = randomUUID();
    // A crash left a pending receipt for a message that never landed (no entry).
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

    // The absent-branch supersession never committed, so a retry with a DIFFERENT
    // payload B supersedes and delivers B rather than throwing idempotency_conflict.
    const result = await send(value, {
      idempotencyKey: "absent-supersede",
      body: "A distinct superseding payload B",
      refs: { ciRun: "ci-supersede-b" },
    });
    expect(result.replayed).toBe(false);
    expect(result.threadId).not.toBe(ghostThread);
    expect(result.messageId).not.toBe(ghostMessage);
    const folded = await foldBusThread(value.root, result.threadId);
    expect(folded.messages.at(-1)?.body).toBe("A distinct superseding payload B");
  });

  it("does not delete an unrelated delivery's pointer when an externally corrupted receipt names it (absent-path cleanup guard)", async () => {
    const value = await fx();
    const p = await paths(value.root);
    // A real, delivered message A to the implementer, with its own ACTIVE pointer.
    const delivered = await send(value, { idempotencyKey: "victim-delivery", body: "The victim delivery must survive" });
    expect(delivered.messageId).not.toBeNull();
    const victimHash = keyFor(value.reviewer.endpointId, "victim-delivery");
    const victimReceipt = await readReceipt(p, value.reviewer.endpointId, victimHash);
    const mailbox = endpointMailboxPath(p, value.implementer.endpointId);
    const victimFilename = `${String(victimReceipt!.mailboxSeq).padStart(12, "0")}-${delivered.messageId}.json`;
    const victimPointer = join(mailbox, victimFilename);
    const victimBytes = await readFile(victimPointer, "utf-8");

    // Plant a PENDING delivered receipt for a DIFFERENT key whose toEndpoint/mailboxSeq/
    // messageId name delivery A's ACTIVE pointer, but whose threadId is a thread that never
    // landed (forcing the message-absent cleanup path). A blind unlink of the recorded path
    // would delete delivery A; the envelope guard leaves it intact and fails closed.
    const attackKey = "corrupt-receipt-attack";
    const attackHash = keyFor(value.reviewer.endpointId, attackKey);
    await writeReceipt(p, {
      schema: "storybloq-bus-receipt/v1",
      endpointId: value.reviewer.endpointId,
      keyHash: attackHash,
      payloadHash: "a".repeat(64),
      threadId: randomUUID(), // never landed -> message-absent recovery path
      toEndpoint: value.implementer.endpointId,
      messageId: delivered.messageId!,
      mailboxSeq: victimReceipt!.mailboxSeq!,
      state: "pending",
      createdAt: new Date().toISOString(),
    } as BusReceipt);

    // The retry hits the absent-path cleanup, which refuses to unlink a pointer whose
    // envelope does not belong to this receipt and fails closed on the anomalous active one.
    await expect(send(value, { idempotencyKey: attackKey, body: "attacker payload B" }))
      .rejects.toMatchObject({ code: "corrupt" });

    // Delivery A's active pointer is byte-intact and still deliverable exactly once.
    expect(await readFile(victimPointer, "utf-8")).toBe(victimBytes);
    const polled = await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    });
    expect(polled.messages.map((m) => m.message.messageId)).toContain(delivered.messageId);
  });
});

describe("Storybloq Bus sendBusMessage final-replay identity guard (#5)", () => {
  // The REACHABLE replay guard inside sendBusMessage: when a durable receipt is
  // already `final`, a replay still re-verifies that the receipt indexes a real
  // matching message entry before returning. This is distinct from the direct
  // finalizeReceipt delivered-identity guard exercised in the (#11) block below.
  it("throws corrupt on replay when an already-final receipt no longer indexes its message entry", async () => {
    const value = await fx();
    const first = await send(value, { idempotencyKey: "identity-key" });
    const p = await paths(value.root);
    const keyHash = keyFor(value.reviewer.endpointId, "identity-key");
    const receipt = await readReceipt(p, value.reviewer.endpointId, keyHash);
    expect(receipt).toMatchObject({ state: "final", threadId: first.threadId, messageId: first.messageId });

    // Corrupt the durable final receipt so its stored messageId no longer matches
    // the operation it indexes (payloadHash unchanged so the replay path reaches
    // the identity guard). Honoring it blindly would replay a message that does
    // not exist; identity is verified before the already-final receipt is honored.
    await writeReceipt(p, { ...receipt!, messageId: randomUUID() });

    await expect(send(value, { idempotencyKey: "identity-key" }))
      .rejects.toMatchObject({ code: "corrupt" });
  });
});

describe("Storybloq Bus sendBusMessage replay internal-identity guard (#R5-H)", () => {
  // The PUBLIC sendBusMessage replay path (distinct from the direct finalizeReceipt
  // unit tests in the #11 block below). A durable receipt is loaded by its
  // (endpointId, keyHash) PATH; if the receipt's INTERNAL endpointId/keyHash
  // disagrees with the path, the send must reject `corrupt` at the top of the
  // receipt block, before either the final-replay or the recovery branch, so a
  // misfiled receipt never replays. The file is corrupted in place at its ORIGINAL
  // pathname (the JSON contents are edited; the file is not moved).
  it("throws corrupt when a final DELIVERED receipt's internal endpointId or keyHash is corrupted at its original path", async () => {
    const value = await fx();
    const first = await send(value, { idempotencyKey: "guard-delivered" });
    expect(first.messageId).not.toBeNull();
    const p = await paths(value.root);
    const keyHash = keyFor(value.reviewer.endpointId, "guard-delivered");
    const path = receiptPath(p, value.reviewer.endpointId, keyHash);
    const original = JSON.parse(await readFile(path, "utf-8"));
    expect(original).toMatchObject({ state: "final", messageId: first.messageId });

    // Corrupt the INTERNAL endpointId; the file stays at the correct pathname, so
    // the path-keyed read still finds it and the identity guard must reject it.
    await writeFile(path, JSON.stringify({ ...original, endpointId: randomUUID() }, null, 2) + "\n", "utf-8");
    await expect(send(value, { idempotencyKey: "guard-delivered" }))
      .rejects.toMatchObject({ code: "corrupt" });

    // The same guard rejects a disagreeing INTERNAL keyHash.
    await writeFile(path, JSON.stringify({ ...original, keyHash: "b".repeat(64) }, null, 2) + "\n", "utf-8");
    await expect(send(value, { idempotencyKey: "guard-delivered" }))
      .rejects.toMatchObject({ code: "corrupt" });
  });

  it("throws corrupt when a final PARKED receipt's internal endpointId or keyHash is corrupted at its original path", async () => {
    const value = await fx();
    const replyPayload = await driveToDuplicateBoundary(value);
    // The duplicate reply parks the thread and writes a final parked receipt.
    const parked = await send(value, { ...replyPayload, idempotencyKey: "guard-parked" });
    expect(parked).toMatchObject({ parked: true, replayed: false });
    const p = await paths(value.root);
    const keyHash = keyFor(value.reviewer.endpointId, "guard-parked");
    const path = receiptPath(p, value.reviewer.endpointId, keyHash);
    const original = JSON.parse(await readFile(path, "utf-8"));
    expect(original).toMatchObject({ state: "final", outcome: "parked" });

    // A parked receipt SKIPS entry verification on replay (it has no message
    // entry), so ONLY the top-of-block identity check can catch a misfiled parked
    // receipt. Corrupt the internal endpointId in place and retry.
    await writeFile(path, JSON.stringify({ ...original, endpointId: randomUUID() }, null, 2) + "\n", "utf-8");
    await expect(send(value, { ...replyPayload, idempotencyKey: "guard-parked" }))
      .rejects.toMatchObject({ code: "corrupt" });

    // The same guard rejects a disagreeing internal keyHash on a parked receipt.
    await writeFile(path, JSON.stringify({ ...original, keyHash: "b".repeat(64) }, null, 2) + "\n", "utf-8");
    await expect(send(value, { ...replyPayload, idempotencyKey: "guard-parked" }))
      .rejects.toMatchObject({ code: "corrupt" });
  });
});

describe("Storybloq Bus finalizeReceipt delivered-identity guard (#11)", () => {
  // Direct unit tests of the exported DELIVERED finalization path. Each writes a
  // receipt to disk (via writeReceipt, or a raw write at its receipt path) and
  // then calls finalizeReceipt, exercising identity-guard branches that are
  // otherwise defense-in-depth within a single locked send scope.
  interface Expected {
    payloadHash: string;
    threadId: string;
    toEndpoint: string;
    messageId: string;
    mailboxSeq: number;
  }

  function deliveredReceipt(
    endpointId: string,
    keyHash: string,
    expected: Expected,
    overrides: Record<string, unknown> = {},
  ): BusReceipt {
    return {
      schema: "storybloq-bus-receipt/v1",
      endpointId,
      keyHash,
      payloadHash: expected.payloadHash,
      threadId: expected.threadId,
      toEndpoint: expected.toEndpoint,
      messageId: expected.messageId,
      mailboxSeq: expected.mailboxSeq,
      state: "pending",
      createdAt: new Date().toISOString(),
      ...overrides,
    } as BusReceipt;
  }

  async function setup(): Promise<{ p: BusPaths; endpointId: string; keyHash: string; expected: Expected }> {
    const value = await fx();
    const p = await paths(value.root);
    const endpointId = value.reviewer.endpointId;
    const keyHash = keyFor(endpointId, "finalize-unit");
    const expected: Expected = {
      payloadHash: "a".repeat(64),
      threadId: randomUUID(),
      toEndpoint: value.implementer.endpointId,
      messageId: randomUUID(),
      mailboxSeq: 4,
    };
    return { p, endpointId, keyHash, expected };
  }

  it("finalizes a pending delivered receipt whose stored identity matches expected", async () => {
    const { p, endpointId, keyHash, expected } = await setup();
    await writeReceipt(p, deliveredReceipt(endpointId, keyHash, expected));
    await finalizeReceipt(p, endpointId, keyHash, expected);
    // The on-disk receipt flipped to final and kept its published identity.
    expect(await readReceipt(p, endpointId, keyHash))
      .toMatchObject({ state: "final", messageId: expected.messageId, mailboxSeq: expected.mailboxSeq });
  });

  it("throws corrupt for an already-final receipt whose identity does not match (guard runs before the already-final return)", async () => {
    const { p, endpointId, keyHash, expected } = await setup();
    // The receipt is already `final` but records a DIFFERENT messageId than the
    // operation being finalized. If the identity check were moved below the
    // `if (state === "final") return`, this mismatch would silently pass.
    await writeReceipt(p, deliveredReceipt(endpointId, keyHash, expected, {
      state: "final",
      messageId: randomUUID(),
    }));
    await expect(finalizeReceipt(p, endpointId, keyHash, expected))
      .rejects.toMatchObject({ code: "corrupt" });
  });

  it("rejects writing a parked receipt that carries a messageId or a mailboxSeq (tightened schema)", async () => {
    const { p, endpointId, keyHash, expected } = await setup();
    // The tightened schema forbids either publication field on a parked receipt,
    // so a parked receipt bearing a messageId (or a mailboxSeq) is unrepresentable:
    // both BusReceiptSchema.parse and writeReceipt (which parses before persisting)
    // reject it. The previous "parked with a matching messageId" premise is now
    // impossible to construct, so it is replaced by these two rejections.
    const parkedBase = {
      schema: "storybloq-bus-receipt/v1",
      endpointId,
      keyHash,
      payloadHash: expected.payloadHash,
      threadId: expected.threadId,
      toEndpoint: expected.toEndpoint,
      state: "pending",
      outcome: "parked",
      stateEntryHash: "c".repeat(64),
      createdAt: new Date().toISOString(),
    };
    const withMessageId = { ...parkedBase, messageId: expected.messageId } as BusReceipt;
    expect(BusReceiptSchema.safeParse(withMessageId).success).toBe(false);
    await expect(writeReceipt(p, withMessageId)).rejects.toBeInstanceOf(Error);

    const withMailboxSeq = { ...parkedBase, mailboxSeq: expected.mailboxSeq } as BusReceipt;
    expect(BusReceiptSchema.safeParse(withMailboxSeq).success).toBe(false);
    await expect(writeReceipt(p, withMailboxSeq)).rejects.toBeInstanceOf(Error);
  });

  it("throws corrupt when finalizing a well-formed parked receipt on the delivered path", async () => {
    const { p, endpointId, keyHash, expected } = await setup();
    // A schema-valid parked receipt (no messageId/mailboxSeq, WITH a stateEntryHash)
    // must still be rejected on the DELIVERED finalization path: finalizeReceipt
    // fails closed on any receipt bearing outcome "parked" before honoring it, so a
    // retry never treats a park as a delivered message.
    await writeReceipt(p, {
      schema: "storybloq-bus-receipt/v1",
      endpointId,
      keyHash,
      payloadHash: expected.payloadHash,
      threadId: expected.threadId,
      toEndpoint: expected.toEndpoint,
      state: "pending",
      outcome: "parked",
      stateEntryHash: "c".repeat(64),
      createdAt: new Date().toISOString(),
    } as BusReceipt);
    await expect(finalizeReceipt(p, endpointId, keyHash, expected))
      .rejects.toMatchObject({ code: "corrupt" });
  });

  it("throws corrupt when the receipt's internal endpointId or keyHash disagrees with the path arguments", async () => {
    const { p, endpointId, keyHash, expected } = await setup();
    // Seed the directory, then overwrite the file at the (endpointId, keyHash)
    // path with a schema-valid but misfiled receipt whose internal endpointId
    // disagrees with the path argument.
    await writeReceipt(p, deliveredReceipt(endpointId, keyHash, expected));
    const path = receiptPath(p, endpointId, keyHash);
    await writeFile(path, JSON.stringify(deliveredReceipt(randomUUID(), keyHash, expected), null, 2) + "\n", "utf-8");
    await expect(finalizeReceipt(p, endpointId, keyHash, expected))
      .rejects.toMatchObject({ code: "corrupt" });

    // The same guard rejects a disagreeing internal keyHash.
    await writeFile(path, JSON.stringify(deliveredReceipt(endpointId, "b".repeat(64), expected), null, 2) + "\n", "utf-8");
    await expect(finalizeReceipt(p, endpointId, keyHash, expected))
      .rejects.toMatchObject({ code: "corrupt" });
  });
});

describe("Storybloq Bus pending-pointer recovery replaces an invalid pointer (#7)", () => {
  // durableCreate is exclusive (it links onto the target), so recovery cannot
  // overwrite an existing-but-invalid pending pointer in place: the fix must
  // remove-then-recreate it. Each case reconstructs the crash state (active
  // pointer gone, an invalid pending pointer left behind, receipt back to
  // pending) and re-sends with the same key, driving the real recovery path.
  const corruptions: Array<{ name: string; corrupt: (canonicalBytes: string) => string }> = [
    { name: "truncated", corrupt: (bytes) => bytes.slice(0, Math.max(1, Math.floor(bytes.length / 2))) },
    {
      name: "envelope-mismatched",
      corrupt: (bytes) => {
        // Parses as a pointer but does not canonically equal the reconstruction,
        // so pointerFileDelivered rejects it as an invalid pending pointer.
        const pointer = JSON.parse(bytes) as Record<string, unknown>;
        pointer.entryHash = "b".repeat(64);
        return JSON.stringify(pointer, null, 2) + "\n";
      },
    },
  ];

  for (const { name, corrupt } of corruptions) {
    it(`durably replaces a ${name} pending pointer, finalizes, and leaves exactly one active pointer`, async () => {
      const value = await fx();
      const key = `recover-replace-${name}`;
      const sent = await send(value, { idempotencyKey: key });
      expect(sent.replayed).toBe(false);
      expect(sent.messageId).not.toBeNull();

      const p = await paths(value.root);
      const mailbox = endpointMailboxPath(p, value.implementer.endpointId);
      const keyHash = keyFor(value.reviewer.endpointId, key);
      const receipt = await readReceipt(p, value.reviewer.endpointId, keyHash);
      const filename = `${String(receipt!.mailboxSeq).padStart(12, "0")}-${receipt!.messageId}.json`;
      const active = join(mailbox, filename);
      const pending = join(mailbox, "pending", filename);
      const canonicalBytes = await readFile(active, "utf-8");

      // Crash state: active pointer gone, an INVALID pending pointer in its place,
      // receipt reverted to pending (the finalize never ran).
      await unlink(active);
      await writeFile(pending, corrupt(canonicalBytes), "utf-8");
      await writeReceipt(p, { ...receipt!, state: "pending" });

      // The retry recovers durably: remove the invalid pending pointer, recreate
      // the canonical one, activate it, and finalize the receipt.
      const replay = await send(value, { idempotencyKey: key });
      expect(replay).toMatchObject({ replayed: true, threadId: sent.threadId, messageId: sent.messageId });

      // Exactly one valid active pointer (byte-identical to the canonical one),
      // no leftover pending intent, receipt finalized.
      const activePointers = (await readdir(mailbox)).filter((n) => /^\d{12}-.*\.json$/.test(n));
      expect(activePointers).toEqual([filename]);
      expect(await readFile(active, "utf-8")).toBe(canonicalBytes);
      expect((await readdir(join(mailbox, "pending"))).filter((n) => n.endsWith(".json"))).toEqual([]);
      expect((await readReceipt(p, value.reviewer.endpointId, keyHash))?.state).toBe("final");

      // The recovered pointer delivers the message exactly once.
      const polled = await pollBus(value.root, {
        endpointId: value.implementer.endpointId,
        clientTaskId: value.implementerTaskId,
      });
      expect(polled.messages.map((m) => m.message.messageId)).toEqual([sent.messageId]);
    });
  }
});

describe("Storybloq Bus parked-recovery entry-identity binding (#R6-G)", () => {
  // Recovery of a pending parked receipt proves the park committed by locating the
  // exact park entry (by stateEntryHash) in the folded chain, NOT by the thread's
  // current folded.state. These two tests exercise the two failure modes that
  // binding defends against: a committed park whose thread later transitioned, and
  // a foreign park receipt planted against a thread parked by a different entry.

  it("replays a committed park even after the thread transitioned away from parked", async () => {
    const value = await fx();
    const replyPayload = await driveToDuplicateBoundary(value);
    const threadId = replyPayload.threadId as string;
    // The duplicate reply commits an automatic park and a final parked receipt.
    const parked = await send(value, { ...replyPayload, idempotencyKey: "committed-transitioned" });
    expect(parked).toMatchObject({ parked: true, replayed: false });

    const p = await paths(value.root);
    const keyHash = keyFor(value.reviewer.endpointId, "committed-transitioned");
    const receipt = await readReceipt(p, value.reviewer.endpointId, keyHash);
    expect(receipt).toMatchObject({ state: "final", outcome: "parked" });
    // The park receipt is bound to its committed park entry by stateEntryHash.
    expect(receipt?.stateEntryHash).toMatch(/^[a-f0-9]{64}$/);

    // Crash before finalize: the final parked receipt reverts to pending. It still
    // carries the stateEntryHash binding to the committed park entry.
    await writeReceipt(p, { ...receipt!, state: "pending" });

    // The thread then transitions AWAY from parked through the real update path
    // (reopen with new, unseen evidence), so folded.state is no longer "parked"
    // while the committed park entry remains in the verified chain.
    const reopened = await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId,
      action: "reopen",
      reason: "New CI evidence arrived after the automatic park",
      evidence: { ciRun: "ci-reopen-after-park" },
    });
    expect(reopened.state).toBe("open");
    // The committed park entry is still present in the chain despite the reopen.
    expect(reopened.entries.some((entry) =>
      entry.type === "state" && entry.entryHash === receipt!.stateEntryHash)).toBe(true);

    // Retrying the same idempotency key STILL replays the committed park (identity
    // is by the bound park entry, not folded.state) and re-finalizes the receipt.
    const replay = await send(value, { ...replyPayload, idempotencyKey: "committed-transitioned" });
    expect(replay).toMatchObject({ parked: true, replayed: true, threadId });
    expect(replay.messageId).toBeNull();
    expect(await readReceipt(p, value.reviewer.endpointId, keyHash))
      .toMatchObject({ state: "final", outcome: "parked" });
  });

  it("does not misattribute a committed park to a foreign pending parked receipt", async () => {
    const value = await fx();
    const replyPayload = await driveToDuplicateBoundary(value);
    const threadId = replyPayload.threadId as string;
    // The thread is parked by its OWN automatic park entry.
    const parked = await send(value, { ...replyPayload, idempotencyKey: "own-park" });
    expect(parked).toMatchObject({ parked: true });
    expect((await foldBusThread(value.root, threadId)).state).toBe("parked");

    const p = await paths(value.root);
    const foreignKey = "foreign-park-receipt";
    const keyHash = keyFor(value.reviewer.endpointId, foreignKey);
    const foreignEntryHash = "d".repeat(64); // matches no entry in the parked thread
    // Plant a PENDING parked receipt bound to a park entry that does NOT exist in
    // this thread, even though the thread is currently parked by a DIFFERENT entry.
    await writeReceipt(p, {
      schema: "storybloq-bus-receipt/v1",
      endpointId: value.reviewer.endpointId,
      keyHash,
      payloadHash: "a".repeat(64),
      threadId,
      toEndpoint: value.implementer.endpointId,
      state: "pending",
      outcome: "parked",
      stateEntryHash: foreignEntryHash,
      createdAt: new Date().toISOString(),
    } as BusReceipt);
    // Sanity: the parked thread has no state entry matching the foreign hash.
    expect((await foldBusThread(value.root, threadId)).entries.some((entry) =>
      entry.type === "state" && entry.entryHash === foreignEntryHash)).toBe(false);

    // Retrying with the foreign key must NOT blindly replay the thread's own park:
    // recovery finds no entry matching the receipt's stateEntryHash, removes the
    // receipt, and re-attempts as a fresh send (a brand-new thread here).
    const result = await send(value, {
      idempotencyKey: foreignKey,
      body: "A fresh boundary after the foreign park receipt",
      refs: { ciRun: "ci-foreign-fresh" },
    });
    expect(result.replayed).toBe(false);
    expect(result.parked).toBe(false);
    expect(result.threadId).not.toBe(threadId);
    expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/);
    // The planted parked receipt was removed and superseded by a fresh DELIVERED
    // receipt, never finalized against the foreign park entry.
    const finalReceipt = await readReceipt(p, value.reviewer.endpointId, keyHash);
    expect(finalReceipt?.outcome ?? "delivered").not.toBe("parked");
    expect(finalReceipt?.stateEntryHash ?? null).toBeNull();
    expect(finalReceipt?.messageId).toBe(result.messageId);
  });

  it("rejects a parked receipt whose stateEntryHash names a non-park or non-state entry", async () => {
    // Identity by hash is not enough: the bound entry must have automatic-park
    // semantics. A parked receipt pointing at a REAL entry that is a reopen state
    // entry (wrong action) or a message entry (wrong type) must fail closed, never
    // replay as an automatic park.
    const value = await fx();
    const replyPayload = await driveToDuplicateBoundary(value);
    const threadId = replyPayload.threadId as string;
    // Commit a real automatic park, then reopen so the chain also holds a reopen
    // state entry and message entries: real hashes that are NOT an automatic park.
    await send(value, { ...replyPayload, idempotencyKey: "semantic-guard-park" });
    const reopened = await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId,
      action: "reopen",
      reason: "New CI evidence after the automatic park",
      evidence: { ciRun: "ci-semantic-guard-reopen" },
    });
    const reopenEntry = reopened.entries.find((entry) => entry.type === "state" && entry.payload.action === "reopen");
    const messageEntry = reopened.entries.find((entry) => entry.type === "message");
    expect(reopenEntry).toBeDefined();
    expect(messageEntry).toBeDefined();

    const p = await paths(value.root);
    const plantAndRetry = async (key: string, stateEntryHash: string): Promise<void> => {
      const keyHash = keyFor(value.reviewer.endpointId, key);
      await writeReceipt(p, {
        schema: "storybloq-bus-receipt/v1",
        endpointId: value.reviewer.endpointId,
        keyHash,
        payloadHash: "a".repeat(64),
        threadId,
        toEndpoint: value.implementer.endpointId,
        state: "pending",
        outcome: "parked",
        stateEntryHash,
        createdAt: new Date().toISOString(),
      } as BusReceipt);
      const before = (await foldBusThread(value.root, threadId)).entries.length;
      // The retry hits recoverPendingReceipt; committedAutomaticPark finds the named
      // entry but rejects its non-automatic-park semantics, so the send fails closed.
      await expect(send(value, { ...replyPayload, idempotencyKey: key })).rejects.toMatchObject({ code: "corrupt" });
      // The throw precedes receipt removal, so the receipt and thread are unchanged.
      expect(await readReceipt(p, value.reviewer.endpointId, keyHash)).toMatchObject({ state: "pending", stateEntryHash });
      expect((await foldBusThread(value.root, threadId)).entries).toHaveLength(before);
    };

    await plantAndRetry("semantic-guard-reopen", reopenEntry!.entryHash);
    await plantAndRetry("semantic-guard-message", messageEntry!.entryHash);
  });

  it("rejects a pending parked receipt that names a REAL different-operation automatic park by the same endpoint (#R6-F6)", async () => {
    // Identity-by-hash plus automatic-park semantics are still not enough when the
    // SAME endpoint has more than one automatic park: a receipt whose stateEntryHash
    // names a REAL automatic park committed by a DIFFERENT idempotent send must not
    // replay that other operation's park. The park entry now carries the triggering
    // send's idempotencyKeyHash/payloadHash, and committedAutomaticPark requires both
    // to equal the replaying receipt, so this misattribution fails closed.
    const value = await fx();
    const replyPayload = await driveToDuplicateBoundary(value);
    const threadId = replyPayload.threadId as string;
    // op-1 commits a REAL automatic park bound to its own idempotency key + payload.
    const parked = await send(value, { ...replyPayload, idempotencyKey: "op1-real-park" });
    expect(parked).toMatchObject({ parked: true, replayed: false });

    const p = await paths(value.root);
    const op1KeyHash = keyFor(value.reviewer.endpointId, "op1-real-park");
    const op1Receipt = await readReceipt(p, value.reviewer.endpointId, op1KeyHash);
    expect(op1Receipt).toMatchObject({ state: "final", outcome: "parked" });

    const parkEntry = (await foldBusThread(value.root, threadId)).entries.find((entry) =>
      entry.type === "state" && entry.payload.action === "park" && entry.payload.automatic === true);
    if (!parkEntry || parkEntry.type !== "state") throw new Error("expected a committed automatic park entry");
    // The park entry is bound to op-1's idempotency key hash (covered by entryHash).
    expect(parkEntry.payload.idempotencyKeyHash).toBe(op1KeyHash);

    // Plant a PENDING parked receipt for a DIFFERENT idempotency key whose
    // stateEntryHash names op-1's REAL automatic park. It reuses op-1's payloadHash and
    // op-2 replays the identical payload, so WITHOUT the operation binding recovery would
    // find a matching park, pass the payloadHash check, and MISATTRIBUTE op-1's park as
    // op-2's outcome. The keyHash binding is the only thing that separates them.
    const op2Key = "op2-misattribute";
    const op2KeyHash = keyFor(value.reviewer.endpointId, op2Key);
    await writeReceipt(p, {
      schema: "storybloq-bus-receipt/v1",
      endpointId: value.reviewer.endpointId,
      keyHash: op2KeyHash,
      payloadHash: op1Receipt!.payloadHash,
      threadId,
      toEndpoint: value.implementer.endpointId,
      state: "pending",
      outcome: "parked",
      stateEntryHash: parkEntry.entryHash,
      createdAt: new Date().toISOString(),
    } as BusReceipt);

    const before = (await foldBusThread(value.root, threadId)).entries.length;
    // The retry hits recoverPendingReceipt -> committedAutomaticPark, which finds op-1's
    // real automatic park but rejects the operation-binding mismatch, failing closed.
    await expect(send(value, { ...replyPayload, idempotencyKey: op2Key }))
      .rejects.toMatchObject({ code: "corrupt" });
    // The throw precedes receipt removal, so the planted receipt and the thread are intact:
    // op-1's park was neither replayed as op-2 nor mutated.
    expect(await readReceipt(p, value.reviewer.endpointId, op2KeyHash))
      .toMatchObject({ state: "pending", stateEntryHash: parkEntry.entryHash });
    expect((await foldBusThread(value.root, threadId)).entries).toHaveLength(before);
  });
});

describe("BusReceiptSchema park/deliver field table (#R6-F)", () => {
  const iso = new Date().toISOString();
  const base = {
    schema: "storybloq-bus-receipt/v1",
    endpointId: randomUUID(),
    keyHash: "a".repeat(64),
    payloadHash: "b".repeat(64),
    threadId: randomUUID(),
    toEndpoint: randomUUID(),
    state: "final",
    createdAt: iso,
  } as const;

  it("rejects a parked receipt that carries a messageId", () => {
    expect(BusReceiptSchema.safeParse({
      ...base, outcome: "parked", stateEntryHash: "c".repeat(64), messageId: randomUUID(),
    }).success).toBe(false);
  });

  it("rejects a parked receipt that carries a mailboxSeq", () => {
    expect(BusReceiptSchema.safeParse({
      ...base, outcome: "parked", stateEntryHash: "c".repeat(64), mailboxSeq: 3,
    }).success).toBe(false);
  });

  it("accepts a parked receipt with both publication fields absent and a stateEntryHash present", () => {
    expect(BusReceiptSchema.safeParse({
      ...base, outcome: "parked", stateEntryHash: "c".repeat(64),
    }).success).toBe(true);
  });

  it("rejects a parked receipt missing its stateEntryHash (#5: every parked writer preallocates it)", () => {
    expect(BusReceiptSchema.safeParse({ ...base, outcome: "parked" }).success).toBe(false);
  });

  it("rejects a delivered receipt that carries a stateEntryHash (#5: park binding is parked-only)", () => {
    expect(BusReceiptSchema.safeParse({
      ...base, outcome: "delivered", messageId: randomUUID(), mailboxSeq: 1, stateEntryHash: "c".repeat(64),
    }).success).toBe(false);
  });

  it("rejects a delivered receipt (outcome absent) that carries a stateEntryHash (#5)", () => {
    expect(BusReceiptSchema.safeParse({
      ...base, messageId: randomUUID(), mailboxSeq: 1, stateEntryHash: "c".repeat(64),
    }).success).toBe(false);
  });

  it("rejects a delivered receipt (outcome absent) missing a messageId", () => {
    expect(BusReceiptSchema.safeParse({ ...base, mailboxSeq: 1 }).success).toBe(false);
  });

  it("rejects a delivered receipt (outcome delivered) missing a mailboxSeq", () => {
    expect(BusReceiptSchema.safeParse({ ...base, outcome: "delivered", messageId: randomUUID() }).success).toBe(false);
  });

  it("accepts a delivered receipt (outcome absent) with both publication fields present", () => {
    expect(BusReceiptSchema.safeParse({ ...base, messageId: randomUUID(), mailboxSeq: 1 }).success).toBe(true);
  });

  it("accepts a delivered receipt (outcome delivered) with both publication fields present", () => {
    expect(BusReceiptSchema.safeParse({
      ...base, outcome: "delivered", messageId: randomUUID(), mailboxSeq: 1,
    }).success).toBe(true);
  });
});

describe("BusReceiptSchema inverted park semantics (#3)", () => {
  const iso = new Date().toISOString();
  function delivered(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
      createdAt: iso,
      ...overrides,
    };
  }
  function parked(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const base: Record<string, unknown> = {
      schema: "storybloq-bus-receipt/v1",
      endpointId: randomUUID(),
      keyHash: "a".repeat(64),
      payloadHash: "b".repeat(64),
      threadId: randomUUID(),
      toEndpoint: randomUUID(),
      state: "final",
      outcome: "parked",
      // A valid parked receipt carries the hash of the automatic-park entry it commits.
      stateEntryHash: "c".repeat(64),
      createdAt: iso,
    };
    return { ...base, ...overrides };
  }

  it("rejects a pending delivered receipt with a null messageId", () => {
    expect(BusReceiptSchema.safeParse(delivered({ state: "pending", messageId: null })).success).toBe(false);
  });

  it("rejects a pending delivered receipt with a null mailboxSeq", () => {
    expect(BusReceiptSchema.safeParse(delivered({ state: "pending", mailboxSeq: null })).success).toBe(false);
  });

  it("rejects a final delivered receipt with absent messageId and mailboxSeq", () => {
    const receipt = delivered();
    delete receipt.messageId;
    delete receipt.mailboxSeq;
    expect(BusReceiptSchema.safeParse(receipt).success).toBe(false);
  });

  it("accepts a pending parked receipt with absent messageId and mailboxSeq (stateEntryHash present)", () => {
    expect(BusReceiptSchema.safeParse(parked({ state: "pending" })).success).toBe(true);
  });

  it("accepts a final parked receipt with absent messageId and mailboxSeq (stateEntryHash present)", () => {
    expect(BusReceiptSchema.safeParse(parked()).success).toBe(true);
  });

  it("rejects a parked receipt with an explicit null messageId or mailboxSeq", () => {
    // The publication fields are non-nullable optional, so an explicit null is a
    // present-but-invalid value, not "absent"; a parked receipt must omit them.
    expect(BusReceiptSchema.safeParse(parked({ messageId: null })).success).toBe(false);
    expect(BusReceiptSchema.safeParse(parked({ mailboxSeq: null })).success).toBe(false);
  });
});

describe("Storybloq Bus receipt directory symlink guard (#R9-A)", () => {
  it("fails closed on read, write, and remove when the per-endpoint receipt directory is a symlink", async () => {
    const value = await fx();
    const p = await paths(value.root);
    const endpointId = value.reviewer.endpointId;
    const keyHash = keyFor(endpointId, "receipt-symlink-guard");

    // An external directory OUTSIDE .story/bus holding a decoy receipt-named file.
    // idempotency/<endpointId> is a lazily-created child that assertBusLayout does
    // not cover, so a tampered runtime could symlink it away from .story/bus.
    const external = join(value.root, "external-receipt-target");
    await mkdir(external, { recursive: true });
    const decoy = join(external, `${keyHash}.json`);
    await writeFile(decoy, "decoy-bytes", "utf-8");
    const dir = join(p.idempotency, endpointId);
    await rm(dir, { recursive: true, force: true });
    await symlink(external, dir);

    // read, write, and remove must all fail closed rather than traverse the symlink.
    await expect(readReceipt(p, endpointId, keyHash)).rejects.toMatchObject({ code: "corrupt" });
    await expect(removeReceipt(p, endpointId, keyHash)).rejects.toMatchObject({ code: "corrupt" });
    await expect(writeReceipt(p, {
      schema: "storybloq-bus-receipt/v1",
      endpointId,
      keyHash,
      payloadHash: "b".repeat(64),
      threadId: randomUUID(),
      toEndpoint: value.implementer.endpointId,
      messageId: randomUUID(),
      mailboxSeq: 1,
      state: "final",
      createdAt: new Date().toISOString(),
    } as BusReceipt)).rejects.toMatchObject({ code: "corrupt" });

    // The external decoy was neither read as a receipt, deleted, nor overwritten.
    expect(await readFile(decoy, "utf-8")).toBe("decoy-bytes");
    expect(await readdir(external)).toEqual([`${keyHash}.json`]);
  });

  it("rejects a multi-component endpointId as invalid_input before any filesystem access", async () => {
    const value = await fx();
    const p = await paths(value.root);
    // A multi-component id such as `link/<uuid>` stays lexically contained, but
    // `idempotency/link` (a symlink) would redirect every subsequent lstat/mkdir/
    // read/write/unlink outside the runtime since the per-endpoint symlink guard only
    // lstats the FINAL path component. Validating the id as a bare UUID up front fails
    // closed BEFORE any path is touched.
    const badEndpointId = `link/${randomUUID()}`;
    const keyHash = keyFor(value.reviewer.endpointId, "receipt-multicomponent-guard");

    const external = join(value.root, "external-intermediate-target");
    await mkdir(external, { recursive: true });
    const decoy = join(external, `${keyHash}.json`);
    await writeFile(decoy, "decoy-bytes", "utf-8");
    // Plant idempotency/link as a symlink to the external directory.
    await symlink(external, join(p.idempotency, "link"));

    // read, write, and remove all reject as invalid_input (the id validation), never
    // traversing the intermediate symlink.
    await expect(readReceipt(p, badEndpointId, keyHash)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(removeReceipt(p, badEndpointId, keyHash)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(writeReceipt(p, {
      schema: "storybloq-bus-receipt/v1",
      endpointId: badEndpointId,
      keyHash,
      payloadHash: "b".repeat(64),
      threadId: randomUUID(),
      toEndpoint: value.implementer.endpointId,
      messageId: randomUUID(),
      mailboxSeq: 1,
      state: "final",
      createdAt: new Date().toISOString(),
    } as BusReceipt)).rejects.toMatchObject({ code: "invalid_input" });

    // Nothing was created, read, or removed in the external target.
    expect(await readFile(decoy, "utf-8")).toBe("decoy-bytes");
    expect(await readdir(external)).toEqual([`${keyHash}.json`]);
  });
});
