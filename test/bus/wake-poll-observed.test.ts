/**
 * ISS-1153: `poll_observed` written from the delivery layer, and wake statistics.
 *
 * T-489 reserved the `poll_observed` action and documented that the delivery layer
 * would write it when a woken peer's poll passed the cursor recorded at wake time.
 * Nothing wrote it, so the wake-to-poll rate read as a permanent zero.
 *
 * WHAT AN OBSERVATION MEANS HERE, because the tests below are only meaningful
 * against the exact claim. A `poll_observed` entry says: a poll by endpoint E
 * folded thread T, T carried a `requested` wake for E with wake-time cursor C, and
 * E's polled mailbox cursor stood at or past C. It does NOT say the wake caused
 * the poll, and its absence does NOT prove the mail went unread. The recorded rate
 * is a LOWER BOUND, and the three ways it loses a recording are pinned by the
 * `documented limitation` tests near the end of this file rather than left for a
 * later reader to discover as a surprise.
 *
 * WHY THE APPENDER IS TESTED DIRECTLY AND NOT ONLY THROUGH `pollBus`. The sweep
 * pre-filters candidates against the fold it already has, so a guard inside the
 * appender is never reached by an end-to-end test that the pre-filter refuses
 * first. A guard covered only end-to-end is not covered at all: the mutant that
 * deletes it dies to the pre-filter, not to the guard. Codex plan review rounds 2
 * and 3 both found this, so the appender block below drives it with no poll.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeBusMessage,
  appendPollObservedEntries,
  appendWakeEntry,
  busSummary,
  foldBusThread,
  initializeBus,
  joinEndpoint,
  pollBus,
  sendBusMessage,
  updateEndpoint,
  __storeTesting,
  type BusEndpoint,
  type BusWakePayload,
} from "../../src/bus/index.js";
import { initProject } from "../../src/core/init.js";
import { runBusCli } from "./cli-harness.js";

/**
 * Every test here builds a real project, a real Bus runtime and two real endpoints
 * on disk, and several then write a dozen or more hash-chained entries through
 * their locks. That costs a few hundred milliseconds per test at rest and several
 * times that under `--maxWorkers=4`, so the 5s default passes in isolation and
 * times out in the full suite. A test that only passes when run alone is not a
 * gate, and raising the bound is the honest fix rather than trimming the fixtures
 * until the number fits: the work is real work. Kept well above the observed
 * worst case rather than just over it, since the margin is what stops this from
 * becoming a flake under a heavier machine.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const roots: string[] = [];

afterEach(async () => {
  // `maxRetries` because macOS temp cleanup can lose a race with a directory that
  // was still being written when the test ended, which surfaces as ENOTEMPTY from
  // rmdir and fails the test for a reason that has nothing to do with its subject.
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })));
});

interface Fixture {
  readonly root: string;
  /** The sender. */
  readonly a: BusEndpoint;
  /** The recipient, and therefore the endpoint every wake in this file is for. */
  readonly b: BusEndpoint;
  readonly aTask: string;
  readonly bTask: string;
}

async function fixture(name = "iss1153"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  roots.push(root);
  await initProject(root, { name });
  await initializeBus(root);
  const aTask = "task-sender";
  const bTask = "task-recipient";
  const a = (await joinEndpoint(root, {
    client: "claude", clientTaskId: aTask, surface: "claude_cli",
  })).endpoint;
  const b = (await joinEndpoint(root, {
    client: "codex", clientTaskId: bTask, surface: "codex_cli",
  })).endpoint;
  return { root, a, b, aTask, bTask };
}

let bodySeq = 0;

/** One message from the sender to the recipient. A fresh body every time, so the
 *  duplicate-fingerprint park never fires and no test depends on it not firing. */
async function send(fx: Fixture, threadId?: string): Promise<{ threadId: string; messageId: string }> {
  bodySeq += 1;
  const sent = await sendBusMessage(fx.root, {
    endpointId: fx.a.endpointId,
    clientTaskId: fx.aTask,
    ...(threadId ? { threadId } : { threadKind: "question" as const }),
    messageKind: threadId ? ("reply" as const) : ("question" as const),
    severity: "info",
    body: `fixture message ${bodySeq}`,
    refs: { ciRun: "ci-iss1153" },
    idempotencyKey: randomUUID(),
  });
  if (!sent.messageId) throw new Error("fixture send produced no messageId");
  return { threadId: sent.threadId, messageId: sent.messageId };
}

/** Write a canonical wake entry. This is what `wake-runner` writes today; every
 *  test in this file builds its precondition from the real entry rather than from
 *  a mock, so a schema change breaks the tests instead of passing them. */
async function wake(
  fx: Fixture,
  threadId: string,
  payload: {
    action: "requested" | "failed" | "poll_observed";
    batchCursor: number;
    endpointId?: string;
    wakeId?: string;
    attempt?: 1 | 2 | 3;
    reason?: string;
  },
): Promise<string> {
  const wakeId = payload.wakeId ?? randomUUID();
  const entry: BusWakePayload = {
    wakeId,
    endpointId: payload.endpointId ?? fx.b.endpointId,
    attempt: payload.attempt ?? 1,
    batchCursor: payload.batchCursor,
    action: payload.action,
    ...(payload.reason ? { reason: payload.reason } : {}),
  };
  await appendWakeEntry(fx.root, threadId, entry);
  return wakeId;
}

async function wakeEntries(root: string, threadId: string): Promise<BusWakePayload[]> {
  const folded = await foldBusThread(root, threadId);
  return folded.entries.flatMap((entry) => (entry.type === "wake" ? [entry.payload] : []));
}

async function observed(root: string, threadId: string): Promise<BusWakePayload[]> {
  return (await wakeEntries(root, threadId)).filter((payload) => payload.action === "poll_observed");
}

async function poll(fx: Fixture, limit?: number) {
  return pollBus(fx.root, {
    endpointId: fx.b.endpointId,
    clientTaskId: fx.bTask,
    ...(limit === undefined ? {} : { limit }),
  });
}

/** Every entry file of a thread, name and content, for a byte-level comparison. */
async function entryFiles(root: string, threadId: string): Promise<[string, string][]> {
  const dir = join(root, ".story", "bus", "threads", threadId, "entries");
  const names = (await readdir(dir)).sort();
  return Promise.all(names.map(async (name) =>
    [name, await readFile(join(dir, name), "utf-8")] as [string, string]));
}

/** Break one entry's hash so the thread folds `quarantined`. The payload is
 *  edited WITHOUT recomputing `entryHash`, which is exactly what the fold's
 *  integrity check exists to catch. */
async function quarantine(root: string, threadId: string): Promise<void> {
  const dir = join(root, ".story", "bus", "threads", threadId, "entries");
  const names = (await readdir(dir)).sort();
  const target = join(dir, names[names.length - 1]!);
  const raw = JSON.parse(await readFile(target, "utf-8")) as Record<string, unknown>;
  raw["createdAt"] = new Date(Date.parse(String(raw["createdAt"])) + 1000).toISOString();
  await writeFile(target, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  const folded = await foldBusThread(root, threadId);
  if (folded.integrity !== "quarantined") {
    throw new Error(`fixture failed to quarantine ${threadId}: ${folded.integrity}`);
  }
}

describe("ISS-1153 the observation appender, driven directly", () => {
  it("appends exactly one entry when the poll cursor is exactly at the canonical wake cursor", async () => {
    // The boundary is inclusive: `cursor >= batchCursor`. An exclusive comparison
    // would silently never record the most common case, where the wake cursor IS
    // the sequence of the message that triggered it.
    const fx = await fixture();
    const { threadId } = await send(fx);
    const wakeId = await wake(fx, threadId, { action: "requested", batchCursor: 1 });

    const result = await appendPollObservedEntries({
      root: fx.root, threadId, endpointId: fx.b.endpointId, pollCursor: 1, wakeIds: [wakeId],
    });

    expect(result.get(wakeId)).toBe("appended");
    const entries = await observed(fx.root, threadId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.wakeId).toBe(wakeId);
  });

  it("returns not-eligible and appends nothing when the poll cursor is one below the canonical wake cursor", async () => {
    const fx = await fixture();
    const { threadId } = await send(fx);
    const wakeId = await wake(fx, threadId, { action: "requested", batchCursor: 4 });

    const result = await appendPollObservedEntries({
      root: fx.root, threadId, endpointId: fx.b.endpointId, pollCursor: 3, wakeIds: [wakeId],
    });

    expect(result.get(wakeId)).toBe("not-eligible");
    expect(await observed(fx.root, threadId)).toHaveLength(0);
  });

  it("returns not-eligible and appends nothing when the canonical request names a different endpoint", async () => {
    // The canonical entry decides, never the caller. A hint naming the wrong
    // endpoint must not be able to record one endpoint's poll as another's.
    const fx = await fixture();
    const { threadId } = await send(fx);
    const wakeId = await wake(fx, threadId, {
      action: "requested", batchCursor: 1, endpointId: fx.a.endpointId,
    });

    const result = await appendPollObservedEntries({
      root: fx.root, threadId, endpointId: fx.b.endpointId, pollCursor: 99, wakeIds: [wakeId],
    });

    expect(result.get(wakeId)).toBe("not-eligible");
    expect(await observed(fx.root, threadId)).toHaveLength(0);
  });

  it("returns no-request when no requested entry carries that wakeId", async () => {
    const fx = await fixture();
    const { threadId } = await send(fx);

    const result = await appendPollObservedEntries({
      root: fx.root, threadId, endpointId: fx.b.endpointId, pollCursor: 99,
      wakeIds: [randomUUID()],
    });

    expect([...result.values()]).toEqual(["no-request"]);
    expect(await observed(fx.root, threadId)).toHaveLength(0);
  });

  it("returns no-request when only a FAILED entry carries that wakeId: a failure is never a basis", async () => {
    // A failed wake never started a turn, so a later poll is not attributable to
    // it. Recording one would put a fabricated success in the denominator's
    // numerator.
    const fx = await fixture();
    const { threadId } = await send(fx);
    const wakeId = await wake(fx, threadId, {
      action: "failed", batchCursor: 1, reason: "version",
    });

    const result = await appendPollObservedEntries({
      root: fx.root, threadId, endpointId: fx.b.endpointId, pollCursor: 99, wakeIds: [wakeId],
    });

    expect(result.get(wakeId)).toBe("no-request");
    expect(await observed(fx.root, threadId)).toHaveLength(0);
  });

  it("returns duplicate and appends nothing when a poll_observed already exists for that wakeId", async () => {
    // Idempotence is what makes the caller safe to retry after a crash.
    const fx = await fixture();
    const { threadId } = await send(fx);
    const wakeId = await wake(fx, threadId, { action: "requested", batchCursor: 1 });
    await wake(fx, threadId, { action: "poll_observed", batchCursor: 1, wakeId });

    const result = await appendPollObservedEntries({
      root: fx.root, threadId, endpointId: fx.b.endpointId, pollCursor: 1, wakeIds: [wakeId],
    });

    expect(result.get(wakeId)).toBe("duplicate");
    expect(await observed(fx.root, threadId)).toHaveLength(1);
  });

  it("copies the canonical endpointId and attempt onto the entry and records the POLL cursor", async () => {
    // The poll cursor and the wake cursor are DIFFERENT here, and the canonical
    // attempt is 2 rather than the default 1, so every copied field is
    // distinguishable from the value a lazier implementation would reach for.
    const fx = await fixture();
    const { threadId } = await send(fx);
    const wakeId = await wake(fx, threadId, {
      action: "requested", batchCursor: 2, attempt: 2,
    });

    await appendPollObservedEntries({
      root: fx.root, threadId, endpointId: fx.b.endpointId, pollCursor: 7, wakeIds: [wakeId],
    });

    const entries = await observed(fx.root, threadId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.batchCursor, "poll_observed carries the POLL cursor").toBe(7);
    expect(entries[0]!.endpointId).toBe(fx.b.endpointId);
    expect(entries[0]!.attempt).toBe(2);
  });

  // NAMED FOR WHAT IT VERIFIES. An earlier name claimed "under ONE lock
  // acquisition", which this test cannot see: removing the lock entirely, or taking
  // it once per wakeId, satisfies every assertion here. Counting acquisitions needs
  // the lock instrumentation filed as ISS-1158, so the claim is withdrawn rather
  // than left standing on assertions that do not support it.
  it("appends every eligible wakeId in one call, leaving a contiguous verified chain and a mixed result map", async () => {
    const fx = await fixture();
    const { threadId } = await send(fx);
    const one = await wake(fx, threadId, { action: "requested", batchCursor: 1 });
    const two = await wake(fx, threadId, { action: "requested", batchCursor: 1 });
    const late = await wake(fx, threadId, { action: "requested", batchCursor: 50 });
    const absent = randomUUID();
    const before = await foldBusThread(fx.root, threadId);

    const result = await appendPollObservedEntries({
      root: fx.root, threadId, endpointId: fx.b.endpointId, pollCursor: 5,
      wakeIds: [one, two, late, absent],
    });

    expect(result.get(one)).toBe("appended");
    expect(result.get(two)).toBe("appended");
    expect(result.get(late)).toBe("not-eligible");
    expect(result.get(absent)).toBe("no-request");
    const after = await foldBusThread(fx.root, threadId);
    expect(after.integrity).toBe("verified");
    expect(after.validThroughSeq).toBe(before.validThroughSeq + 2);
  });

  it("throws on a quarantined thread rather than appending", async () => {
    // The second half of the name is the half worth checking: an implementation that
    // writes an entry and THEN throws satisfies `rejects.toThrow()` while corrupting
    // the chain further. The entries directory is compared byte for byte.
    const fx = await fixture();
    const { threadId } = await send(fx);
    const wakeId = await wake(fx, threadId, { action: "requested", batchCursor: 1 });
    await quarantine(fx.root, threadId);
    const before = await entryFiles(fx.root, threadId);

    await expect(appendPollObservedEntries({
      root: fx.root, threadId, endpointId: fx.b.endpointId, pollCursor: 1, wakeIds: [wakeId],
    })).rejects.toThrow();

    expect(await entryFiles(fx.root, threadId)).toEqual(before);
  });

  it("does not advance hopCount", async () => {
    // fold.ts increments hopCount only for `message` entries. Pinned rather than
    // assumed: an observation that consumed a hop would silently shorten every
    // conversation the wake tier touched.
    const fx = await fixture();
    const { threadId } = await send(fx);
    const wakeId = await wake(fx, threadId, { action: "requested", batchCursor: 1 });
    const before = await foldBusThread(fx.root, threadId);

    const result = await appendPollObservedEntries({
      root: fx.root, threadId, endpointId: fx.b.endpointId, pollCursor: 1, wakeIds: [wakeId],
    });

    // Prove the entry LANDED before drawing any conclusion from hopCount: an
    // appender that did nothing at all would leave hopCount unchanged too, and this
    // test would then certify a property of a no-op.
    expect(result.get(wakeId)).toBe("appended");
    expect(await observed(fx.root, threadId)).toHaveLength(1);
    const after = await foldBusThread(fx.root, threadId);
    expect(after.hopCount).toBe(before.hopCount);
    expect(after.integrity).toBe("verified");
  });
});

/**
 * The sweep, end to end through `pollBus`.
 *
 * Two test-only seams are used here and are null in production:
 * `setPollObservedCallHook` fires at the appender's entry (so a test can prove the
 * appender was NOT called, which is the only way to tell a working pre-filter from
 * a missing one, and so a test can force a deterministic append failure), and
 * `setPollObservedFoldHook` fires after each of the appender's folds (so the
 * repeated-fold cost is a measured number rather than an assumption).
 */
describe("ISS-1153 the sweep in pollBus", () => {
  afterEach(() => {
    __storeTesting.setPollObservedCallHook(null);
    __storeTesting.setPollObservedFoldHook(null);
    __storeTesting.setPollPointerFoldHook(null);
  });

  it("writes exactly one poll_observed when a poll passes the wake cursor", async () => {
    const fx = await fixture();
    const { threadId } = await send(fx);
    const wakeId = await wake(fx, threadId, { action: "requested", batchCursor: 1 });

    const result = await poll(fx);

    expect(result.messages).toHaveLength(1);
    const entries = await observed(fx.root, threadId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.wakeId).toBe(wakeId);
  });

  it("writes nothing while the poll is short of the cursor, and one once a later poll passes it", async () => {
    const fx = await fixture();
    const { threadId } = await send(fx);
    await wake(fx, threadId, { action: "requested", batchCursor: 3 });

    await poll(fx);
    expect(await observed(fx.root, threadId)).toHaveLength(0);

    await send(fx);
    await send(fx);
    await poll(fx);

    expect(await observed(fx.root, threadId)).toHaveLength(1);
  });

  it("records an observation whose cursor was reached by an EARLIER poll, not by this one", async () => {
    // The condition is on the endpoint's polled cursor VALUE, not on whether this
    // invocation crossed it. `pollBus` initialises its cursor from
    // `lastPolledMailboxSeq`, so the property is inherent rather than bolted on,
    // and this test is what pins it: the second poll surfaces only sequence 1
    // while the wake needs 2, and the observation still lands because the endpoint
    // reached 2 on the first poll.
    const fx = await fixture();
    const first = await send(fx);
    const second = await send(fx);
    await poll(fx, 2);
    await acknowledgeBusMessage(fx.root, {
      endpointId: fx.b.endpointId, clientTaskId: fx.bTask,
      messageId: second.messageId, disposition: "accepted",
    });
    await wake(fx, first.threadId, { action: "requested", batchCursor: 2 });

    const result = await poll(fx, 1);

    expect(result.messages.map((m) => m.mailboxSeq)).toEqual([1]);
    expect(await observed(fx.root, first.threadId)).toHaveLength(1);
  });

  it("records a wake appended AFTER the poll that reached its cursor", async () => {
    const fx = await fixture();
    const { threadId } = await send(fx);
    await poll(fx);
    await wake(fx, threadId, { action: "requested", batchCursor: 1 });

    await poll(fx);

    expect(await observed(fx.root, threadId)).toHaveLength(1);
  });

  it("takes NO thread lock on a later poll once the wake is already observed", async () => {
    const fx = await fixture();
    const { threadId } = await send(fx);
    await wake(fx, threadId, { action: "requested", batchCursor: 1 });
    await poll(fx);
    expect(await observed(fx.root, threadId)).toHaveLength(1);

    let calls = 0;
    __storeTesting.setPollObservedCallHook(() => { calls += 1; });
    await poll(fx);

    expect(calls, "an already-observed thread must not reopen the appender").toBe(0);
    expect(await observed(fx.root, threadId)).toHaveLength(1);
  });

  it("never opens the appender for a request belonging to a DIFFERENT endpoint", async () => {
    // The no-call assertion is the load-bearing one. The appender's own canonical
    // check already refuses a foreign request, so asserting only that nothing was
    // written cannot tell a working pre-filter from a missing one; direct test 3
    // covers the canonical refusal separately.
    const fx = await fixture();
    const { threadId } = await send(fx);
    await wake(fx, threadId, {
      action: "requested", batchCursor: 1, endpointId: fx.a.endpointId,
    });

    let calls = 0;
    __storeTesting.setPollObservedCallHook(() => { calls += 1; });
    await poll(fx);

    expect(calls).toBe(0);
    expect(await observed(fx.root, threadId)).toHaveLength(0);
  });

  it("observes several requests on one thread in a SINGLE appender call", async () => {
    const fx = await fixture();
    const { threadId } = await send(fx);
    await wake(fx, threadId, { action: "requested", batchCursor: 1 });
    await wake(fx, threadId, { action: "requested", batchCursor: 1 });
    await wake(fx, threadId, { action: "requested", batchCursor: 1 });

    const calls: string[][] = [];
    __storeTesting.setPollObservedCallHook((_threadId, wakeIds) => { calls.push([...wakeIds]); });
    await poll(fx);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(3);
    expect(await observed(fx.root, threadId)).toHaveLength(3);
  });

  it("MEASURES its repeated-fold cost against a long thread rather than assuming a bound", async () => {
    // The appender re-folds between appends, so the work is O(K x thread history)
    // and the history is not bounded. The number is recorded here rather than
    // claimed in a comment: one fold to decide, then one per appended entry.
    const fx = await fixture();
    const { threadId } = await send(fx);
    for (let i = 0; i < 40; i += 1) {
      await wake(fx, threadId, { action: "failed", batchCursor: 1, reason: "timeout" });
    }
    await wake(fx, threadId, { action: "requested", batchCursor: 1 });
    await wake(fx, threadId, { action: "requested", batchCursor: 1 });

    let folds = 0;
    __storeTesting.setPollObservedFoldHook(() => { folds += 1; });
    await poll(fx);

    expect(await observed(fx.root, threadId)).toHaveLength(2);
    expect(folds, "one deciding fold plus one per appended entry").toBe(3);
  });

  it("turns an append failure into a finding and still returns the poll's messages", async () => {
    const fx = await fixture();
    const { threadId } = await send(fx);
    await wake(fx, threadId, { action: "requested", batchCursor: 1 });
    __storeTesting.setPollObservedCallHook(() => { throw new Error("injected append failure"); });

    const result = await poll(fx);

    expect(result.messages).toHaveLength(1);
    expect(result.cursor).toBe(1);
    expect(result.findings.some((f) => f.includes(threadId))).toBe(true);
    expect(await observed(fx.root, threadId)).toHaveLength(0);
  });

  it("continues to the next thread after one thread's append fails, in the SAME poll", async () => {
    // Containment is per thread. One outer catch would let a repeatedly failing
    // thread starve every healthy thread behind it on every poll, which is the
    // same starvation a per-poll budget would have had, minus the durable state.
    const fx = await fixture();
    const first = await send(fx);
    const second = await send(fx);
    await wake(fx, first.threadId, { action: "requested", batchCursor: 1 });
    await wake(fx, second.threadId, { action: "requested", batchCursor: 2 });
    __storeTesting.setPollObservedCallHook((threadId) => {
      if (threadId === first.threadId) throw new Error("injected append failure");
    });

    const result = await poll(fx);

    expect(await observed(fx.root, first.threadId)).toHaveLength(0);
    expect(await observed(fx.root, second.threadId), "the healthy thread is not starved").toHaveLength(1);
    expect(result.findings.some((f) => f.includes(first.threadId))).toBe(true);
    expect(result.messages).toHaveLength(2);
  });

  it("uses the LATER fold when a request lands between two folds of the same thread in one poll", async () => {
    // The poll walks one pointer at a time and folds per pointer, so a thread with
    // two pointers is folded twice in one poll. If the sweep keeps the FIRST fold, a
    // `requested` entry written between them is read by this poll and then ignored,
    // and an ack in the same poll can make that miss permanent. Keeping the latest
    // fold is what makes the miss impossible, and this hook is the only way to place
    // the write deterministically between the two folds.
    const fx = await fixture();
    const first = await send(fx);
    await send(fx, first.threadId);
    let folds = 0;
    let wakeId = "";
    __storeTesting.setPollPointerFoldHook(async (threadId) => {
      folds += 1;
      if (folds === 1 && threadId === first.threadId) {
        wakeId = await wake(fx, first.threadId, { action: "requested", batchCursor: 1 });
      }
    });

    await poll(fx);
    __storeTesting.setPollPointerFoldHook(null);

    expect(folds, "the thread must be folded more than once for this to test anything")
      .toBeGreaterThan(1);
    const entries = await observed(fx.root, first.threadId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.wakeId).toBe(wakeId);
  });

  it("leaves a wake-free mailbox completely untouched: same messages, same cursor, no appender call", async () => {
    // "Same messages" means identity and order, not a count: replacing, duplicating
    // or reordering the envelopes while keeping the count would pass a length check.
    const fx = await fixture();
    const first = await send(fx);
    const second = await send(fx);

    let calls = 0;
    __storeTesting.setPollObservedCallHook(() => { calls += 1; });
    const result = await poll(fx);

    expect(calls).toBe(0);
    expect(result.messages.map((m) => m.message.messageId)).toEqual([first.messageId, second.messageId]);
    expect(result.messages.map((m) => m.mailboxSeq)).toEqual([1, 2]);
    expect(result.messages.map((m) => m.threadId)).toEqual([first.threadId, second.threadId]);
    expect(result.cursor).toBe(2);
    expect(result.findings).toEqual([]);
  });
});

/**
 * The documented limitation, pinned so it stays visible.
 *
 * Recording an observation requires ONE poll to collect a fold containing the
 * `requested` entry, hold a cursor at or past that entry's canonical cursor, AND
 * commit the observation. When any of the three does not happen, recording depends
 * entirely on a later poll folding that thread again, and where no later poll ever
 * does, the wake stays `requested` forever even though its mail was read.
 *
 * These are contract tests for a stated limit, not defects asserted as correct.
 * Each corresponds to a sentence in `bus-mode.md`; if one of them starts failing,
 * the recorded rate got BETTER and the documentation is what needs updating.
 */
describe("ISS-1153 documented limitation: recording needs one poll to do all three", () => {
  afterEach(() => {
    __storeTesting.setPollObservedCallHook(null);
  });

  it("documented limitation: a limit-truncated poll plus an ack loses the thread before the cursor is reached", async () => {
    const fx = await fixture();
    const first = await send(fx);
    await send(fx);
    await wake(fx, first.threadId, { action: "requested", batchCursor: 2 });

    await poll(fx, 1);
    expect(await observed(fx.root, first.threadId)).toHaveLength(0);
    await acknowledgeBusMessage(fx.root, {
      endpointId: fx.b.endpointId, clientTaskId: fx.bTask,
      messageId: first.messageId, disposition: "accepted",
    });
    await poll(fx);

    expect(await observed(fx.root, first.threadId)).toHaveLength(0);
  });

  it("documented limitation: a request appended after its pointer was reclaimed is never recorded", async () => {
    const fx = await fixture();
    const { threadId, messageId } = await send(fx);
    await poll(fx);
    await acknowledgeBusMessage(fx.root, {
      endpointId: fx.b.endpointId, clientTaskId: fx.bTask, messageId, disposition: "accepted",
    });
    await wake(fx, threadId, { action: "requested", batchCursor: 1 });

    await poll(fx);

    expect(await observed(fx.root, threadId)).toHaveLength(0);
  });

  it("documented limitation: an eligible append that fails has no retry once the pointer is gone", async () => {
    const fx = await fixture();
    const { threadId, messageId } = await send(fx);
    await wake(fx, threadId, { action: "requested", batchCursor: 1 });
    __storeTesting.setPollObservedCallHook(() => { throw new Error("injected append failure"); });

    const failed = await poll(fx);
    expect(failed.findings.some((f) => f.includes(threadId))).toBe(true);

    __storeTesting.setPollObservedCallHook(null);
    await acknowledgeBusMessage(fx.root, {
      endpointId: fx.b.endpointId, clientTaskId: fx.bTask, messageId, disposition: "accepted",
    });
    await poll(fx);

    expect(await observed(fx.root, threadId)).toHaveLength(0);
  });
});

describe("ISS-1153 wake statistics in bus status", () => {
  it("reports ABSENT, not zero, when no thread carries a wake entry", async () => {
    const fx = await fixture();
    await send(fx);

    const summary = await busSummary(fx.root);
    expect(summary.wake.entries).toBeNull();
    expect(summary.wake.lastOutcomes).toBeNull();

    const { stdout } = await runBusCli(fx.root, ["bus", "status"]);
    expect(stdout).toContain("no wake entries recorded");
    expect(stdout).not.toMatch(/0 requested/);
  });

  it("reports a null ratio, not zero, when there are failures but no requests", async () => {
    // A rate over an empty denominator is not zero. Reporting 0 would say the
    // woken peers never polled, when in fact no wake ever reached a peer.
    const fx = await fixture();
    const { threadId } = await send(fx);
    await wake(fx, threadId, { action: "failed", batchCursor: 1, reason: "version" });

    const summary = await busSummary(fx.root);
    expect(summary.wake.entries).not.toBeNull();
    expect(summary.wake.entries!.requested).toBe(0);
    expect(summary.wake.entries!.pollObserved).toBe(0);
    expect(summary.wake.entries!.observedPerRequested).toBeNull();
  });

  it("counts a mixed population exactly, with failure reasons ordered by count then name", async () => {
    const fx = await fixture();
    const one = await send(fx);
    const two = await send(fx);
    const first = await wake(fx, one.threadId, { action: "requested", batchCursor: 1 });
    const second = await wake(fx, one.threadId, { action: "requested", batchCursor: 1 });
    await wake(fx, two.threadId, { action: "requested", batchCursor: 2 });
    await wake(fx, one.threadId, { action: "poll_observed", batchCursor: 1, wakeId: first });
    await wake(fx, one.threadId, { action: "poll_observed", batchCursor: 1, wakeId: second });
    await wake(fx, two.threadId, { action: "failed", batchCursor: 2, reason: "version" });
    await wake(fx, two.threadId, { action: "failed", batchCursor: 2, reason: "version" });
    await wake(fx, two.threadId, { action: "failed", batchCursor: 2, reason: "timeout" });
    await wake(fx, two.threadId, { action: "failed", batchCursor: 2, reason: "io" });

    const summary = await busSummary(fx.root);

    expect(summary.wake.entries!.requested).toBe(3);
    expect(summary.wake.entries!.pollObserved).toBe(2);
    expect(summary.wake.entries!.observedPerRequested).toBeCloseTo(2 / 3, 10);
    expect(summary.wake.entries!.failed).toEqual([
      { reason: "version", count: 2 },
      { reason: "io", count: 1 },
      { reason: "timeout", count: 1 },
    ]);
  });

  it("counts ENDPOINTS in the last-outcome tally, never attempts", async () => {
    // `lastWakeResult` is one overwritten value per endpoint, so this tally can
    // only ever be "how many endpoints ended their most recent wake this way". A
    // thread carrying twenty wake entries must not move it.
    const fx = await fixture();
    const { threadId } = await send(fx);
    for (const endpointId of [fx.a.endpointId, fx.b.endpointId]) {
      await updateEndpoint(fx.root, endpointId, (current) => ({
        ...current, lastWakeAt: new Date().toISOString(), lastWakeResult: "skipped:not-codex",
      }));
    }
    for (let i = 0; i < 5; i += 1) {
      await wake(fx, threadId, { action: "requested", batchCursor: 1 });
    }

    const summary = await busSummary(fx.root);

    expect(summary.wake.lastOutcomes).toEqual([{ result: "skipped:not-codex", endpoints: 2 }]);
  });

  it("renders the lower-bound caveat and the observation-not-cause caveat", async () => {
    const fx = await fixture();
    const { threadId } = await send(fx);
    const wakeId = await wake(fx, threadId, { action: "requested", batchCursor: 1 });
    await wake(fx, threadId, { action: "poll_observed", batchCursor: 1, wakeId });

    const { stdout } = await runBusCli(fx.root, ["bus", "status"]);

    expect(stdout).toContain("lower bound");
    expect(stdout).toContain("not proof the wake caused the poll");
  });
});
