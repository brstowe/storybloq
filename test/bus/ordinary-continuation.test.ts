/**
 * ISS-1116 (re-scoped to A2): continue an ordinary successor from a predecessor
 * that is parked at the hop cap.
 *
 * Before this change, `store.ts`'s ordinary successor path required the predecessor
 * to be RESOLVED, so a question thread that hit the cap had no continuation path at
 * all: redelivery was issue_notice-only, and `--predecessor-thread` refused a parked
 * thread. This file pins the relaxed precondition and, just as importantly, pins what
 * the relaxation deliberately does NOT grant.
 *
 * WHAT AN ORDINARY SUCCESSOR IS. It records LINEAGE and nothing more. It carries no
 * `refusedEntryHash`, no content match against the refused artifact, no redeliver
 * marker (so no uniqueness), and no `predecessorRelation` -- which is why it never
 * reaches `verifiedSuccessorState` and never discharges the predecessor's refusal
 * disposition. Tests 11 and 11b pin that separation, because an ordinary successor
 * being mistakable for a verified redelivery is the one way this change could do
 * real harm.
 *
 * WHY THREE FIXTURES ARE HAND-BUILT. Tests 4, 8, 9 and 11b construct chain entries
 * or a marker directly, and each says why at its own site. The short version: a
 * genuine automatic park always sets a trigger and always carries `droppedMessage`,
 * so the shapes those tests need are unreachable through any real send. Codex plan
 * round 1 rejected an earlier version of 8 and 9 that edited a genuine park while
 * KEEPING `droppedMessage`: `BusStatePayloadSchema`'s superRefine rejects that
 * combination, so the thread quarantined and the predicate under test was never
 * reached. The tests would have been green while observing nothing. Each synthetic
 * fixture now asserts its own preconditions before invoking the code under test,
 * which is what makes the observation real.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkBusShip,
  foldBusThread,
  initializeBus,
  joinEndpoint,
  sendBusMessage,
  updateBusThread,
  type BusEndpoint,
  type FoldedBusThread,
} from "../../src/bus/index.js";
import { hashWithoutKey } from "../../src/bus/canonical.js";
import { initProject } from "../../src/core/init.js";
import { createIssue } from "./helpers.js";

/**
 * Same reasoning as the ISS-1153 file: every test builds a real project, a real Bus
 * runtime and two real endpoints on disk, and the hop-cap fixtures then drive eight
 * or more real sends through their locks. That is several seconds per test under
 * `--maxWorkers=4`, so the 5s default passes in isolation and times out in the full
 * suite. A test that only passes when run alone is not a gate.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })));
});

interface Fixture {
  readonly root: string;
  readonly a: BusEndpoint;
  readonly b: BusEndpoint;
  readonly aTask: string;
  readonly bTask: string;
}

async function fixture(name = "iss1116"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  roots.push(root);
  await initProject(root, { name });
  await initializeBus(root);
  const aTask = "task-a";
  const bTask = "task-b";
  const a = (await joinEndpoint(root, {
    client: "claude", clientTaskId: aTask, surface: "claude_cli",
  })).endpoint;
  const b = (await joinEndpoint(root, {
    client: "codex", clientTaskId: bTask, surface: "codex_cli",
  })).endpoint;
  return { root, a, b, aTask, bTask };
}

let bodySeq = 0;

/** One message on a thread, from whichever side is named. A fresh body every time,
 *  so the duplicate-fingerprint park never fires except where a test wants it. */
async function send(fx: Fixture, from: "a" | "b", threadId?: string, body?: string) {
  bodySeq += 1;
  const sender = from === "a" ? fx.a : fx.b;
  const task = from === "a" ? fx.aTask : fx.bTask;
  return sendBusMessage(fx.root, {
    endpointId: sender.endpointId,
    clientTaskId: task,
    ...(threadId ? { threadId } : { threadKind: "question" as const }),
    messageKind: threadId ? ("reply" as const) : ("question" as const),
    severity: "info",
    body: body ?? `message ${bodySeq}`,
    refs: { ciRun: "ci-iss1116" },
    idempotencyKey: randomUUID(),
  });
}

/**
 * Drive a real thread all the way to its hop cap and return it PARKED by a genuine
 * automatic hop_cap park. Built from real sends rather than hand-written entries, so
 * a change to the park trigger breaks these tests instead of passing them.
 */
async function parkedAtCap(
  fx: Fixture,
  kind: "question" | "coordination" | "patch_request" = "question",
  finalSeverity: "info" | "critical" = "info",
) {
  // A critical Bus message requires an UNRESOLVED CRITICAL issue reference
  // (validateCriticalReference, store.ts): create one whenever the cap-parking
  // fixture is asked for a critical park, so the real send path can produce it
  // rather than needing severity hand-edited onto an entry after the fact.
  const criticalIssueId = finalSeverity === "critical" ? await createIssue(fx.root, "critical") : undefined;
  const refs = criticalIssueId ? { ciRun: "ci-iss1116", issue: criticalIssueId } : { ciRun: "ci-iss1116" };
  bodySeq += 1;
  const opened = await sendBusMessage(fx.root, {
    endpointId: fx.a.endpointId,
    clientTaskId: fx.aTask,
    threadKind: kind,
    messageKind: kind === "coordination" ? "status" : kind,
    severity: "info",
    body: `open ${bodySeq}`,
    refs: { ciRun: "ci-iss1116" },
    idempotencyKey: randomUUID(),
  });
  const threadId = opened.threadId;
  // Alternate sides until an actionable send is refused by the cap. The FINAL
  // send (the one the cap actually drops) carries `finalSeverity`, so a caller
  // can produce a genuinely critical refusal through the real send path rather
  // than hand-editing severity onto an entry after the fact.
  for (let hop = 0; hop < 40; hop += 1) {
    const from = hop % 2 === 0 ? "b" : "a";
    bodySeq += 1;
    const sender = from === "a" ? fx.a : fx.b;
    const task = from === "a" ? fx.aTask : fx.bTask;
    const params = {
      endpointId: sender.endpointId,
      clientTaskId: task,
      threadId,
      messageKind: "reply" as const,
      severity: finalSeverity,
      body: `hop ${bodySeq}`,
      refs,
      idempotencyKey: randomUUID(),
    };
    const sent = await sendBusMessage(fx.root, params);
    if (sent.parked) {
      const folded = await foldBusThread(fx.root, threadId);
      if (folded.state !== "parked") throw new Error(`fixture: expected parked, got ${folded.state}`);
      return { threadId, folded, parkingSend: params };
    }
  }
  throw new Error("fixture: thread never reached the hop cap");
}

/** The last state entry of the valid prefix, which is what decides current state. */
function lastStateEntry(folded: FoldedBusThread) {
  return [...folded.entries].reverse().find((entry) => entry.type === "state");
}

function entriesDir(root: string, threadId: string): string {
  return join(root, ".story", "bus", "threads", threadId, "entries");
}

async function entryFiles(root: string, threadId: string): Promise<[string, string][]> {
  const dir = entriesDir(root, threadId);
  const names = (await readdir(dir)).sort();
  return Promise.all(names.map(async (name) =>
    [name, await readFile(join(dir, name), "utf-8")] as [string, string]));
}

/** Every content-addressed refused artifact, name and content, for a byte-level
 *  comparison across the whole runtime -- not just the predecessor's own park,
 *  since an ordinary successor must touch none of them. */
async function refusedArtifactFiles(root: string): Promise<[string, string][]> {
  const dir = join(root, ".story", "bus", "refused");
  const names = (await readdir(dir).catch(() => [] as string[])).sort();
  return Promise.all(names.map(async (name) =>
    [name, await readFile(join(dir, name), "utf-8")] as [string, string]));
}

/**
 * Append a hand-built state entry. `prevHash` is the caller's choice on purpose: a
 * correct one extends the valid prefix, a wrong one truncates it, and test 4 needs
 * exactly the second. `entryHash` is computed the way `fold.ts` computes it, so a
 * correctly-chained synthetic entry is indistinguishable from a real one to the fold.
 */
async function appendStateEntry(
  root: string,
  threadId: string,
  seq: number,
  prevHash: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const unsigned = {
    schema: "storybloq-bus-entry/v2" as const,
    entryId: randomUUID(),
    threadId,
    seq,
    type: "state" as const,
    prevHash,
    payload,
    createdAt: new Date().toISOString(),
    entryHash: "0".repeat(64),
  };
  const entry = { ...unsigned, entryHash: hashWithoutKey(unsigned, "entryHash") };
  const filename = `${String(seq).padStart(6, "0")}-state-${entry.entryId}.json`;
  await writeFile(join(entriesDir(root, threadId), filename), JSON.stringify(entry, null, 2) + "\n", "utf-8");
  return entry.entryHash;
}

/** Open an ordinary successor naming `predecessorThreadId`. No redelivery fields. */
async function continueFrom(fx: Fixture, predecessorThreadId: string, from: "a" | "b" = "a") {
  bodySeq += 1;
  const sender = from === "a" ? fx.a : fx.b;
  const task = from === "a" ? fx.aTask : fx.bTask;
  return sendBusMessage(fx.root, {
    endpointId: sender.endpointId,
    clientTaskId: task,
    threadKind: "question",
    messageKind: "question",
    severity: "info",
    body: `continuation ${bodySeq}`,
    refs: { ciRun: "ci-iss1116" },
    idempotencyKey: randomUUID(),
    predecessorThreadId,
  });
}

/**
 * Forge an endpoint positively offline so `replace`'s offline proof passes: a
 * processRef naming a pid that does not exist reads as dead. Copied idiom from
 * `succession-redelivery.test.ts`; works only on a claude_cli endpoint, which is
 * what `a` is in this fixture.
 */
async function forgeOffline(root: string, endpointId: string): Promise<void> {
  const path = join(root, ".story", "bus", "endpoints", `${endpointId}.json`);
  const endpoint = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({
    ...endpoint,
    state: "attached",
    processRef: { pid: 999999999, signature: "darwin:deadbeef", capturedAt: new Date().toISOString() },
  }, null, 2) + "\n", "utf-8");
}

describe("ISS-1116 A2: ordinary continuation from a hop-cap-parked predecessor", () => {
  it("1. creates a successor carrying predecessorThreadId and neither redelivery field", async () => {
    const fx = await fixture();
    const { threadId } = await parkedAtCap(fx);
    const successor = await continueFrom(fx, threadId);
    expect(successor.threadId).not.toBe(threadId);
    const folded = await foldBusThread(fx.root, successor.threadId);
    expect(folded.thread.predecessorThreadId).toBe(threadId);
    expect(folded.thread.predecessorRelation).toBeUndefined();
    expect(folded.thread.predecessorEntryHash).toBeUndefined();
  });

  it("2. still accepts a RESOLVED predecessor, unchanged", async () => {
    const fx = await fixture();
    const opened = await send(fx, "a");
    await updateBusThread(fx.root, {
      endpointId: fx.a.endpointId, clientTaskId: fx.aTask, threadId: opened.threadId,
      action: "resolve", resolution: "done", evidence: { ciRun: "ci-resolve" },
    });
    const successor = await continueFrom(fx, opened.threadId);
    const folded = await foldBusThread(fx.root, successor.threadId);
    expect(folded.thread.predecessorThreadId).toBe(opened.threadId);
  });

  it("3. still refuses an OPEN predecessor", async () => {
    const fx = await fixture();
    const opened = await send(fx, "a");
    const folded = await foldBusThread(fx.root, opened.threadId);
    expect(folded.state).toBe("open");
    await expect(continueFrom(fx, opened.threadId)).rejects.toThrow(/integrity-verified/);
  });

  it("4. refuses a QUARANTINED predecessor whose valid prefix is hop-cap-parked", async () => {
    // The construction is the whole point of this test. A quarantined predecessor
    // whose valid prefix is merely OPEN would be refused by the state predicate even
    // with the integrity guard removed, so it would establish nothing about that
    // guard. This fixture keeps the valid prefix PARKED by the automatic hop_cap
    // park and breaks the chain only AFTER it, with a trailing entry whose prevHash
    // does not match. Declared synthetic: no real send can produce a broken chain.
    const fx = await fixture();
    const { threadId, folded: parked } = await parkedAtCap(fx);
    await appendStateEntry(fx.root, threadId, parked.validThroughSeq + 1, "f".repeat(64), {
      action: "reopen", byEndpoint: fx.a.endpointId, reason: "trailing entry with a broken prevHash",
      evidence: { ciRun: "ci-broken" },
    });
    const folded = await foldBusThread(fx.root, threadId);
    expect(folded.integrity).not.toBe("verified");
    expect(folded.state).toBe("parked");
    const last = lastStateEntry(folded);
    expect(last?.type === "state" && last.payload.action).toBe("park");
    expect(last?.type === "state" && last.payload.automatic).toBe(true);
    expect(last?.type === "state" && last.payload.trigger).toBe("hop_cap");
    await expect(continueFrom(fx, threadId)).rejects.toThrow(/integrity-verified/);
  });

  it("5. refuses a duplicate_fingerprint-parked predecessor", async () => {
    // Reached through a REAL send, below the cap: at or above it `overHopCap` wins
    // and the trigger would be hop_cap instead.
    const fx = await fixture();
    const opened = await send(fx, "a", undefined, "the duplicated body");
    await send(fx, "b", opened.threadId, "a reply");
    const first = await send(fx, "a", opened.threadId, "duplicate me");
    expect(first.parked).toBe(false);
    const dup = await sendBusMessage(fx.root, {
      endpointId: fx.a.endpointId, clientTaskId: fx.aTask, threadId: opened.threadId,
      messageKind: "reply", severity: "info", body: "duplicate me",
      refs: { ciRun: "ci-iss1116" }, idempotencyKey: randomUUID(),
    });
    expect(dup.parked).toBe(true);
    const folded = await foldBusThread(fx.root, opened.threadId);
    const last = lastStateEntry(folded);
    expect(last?.type === "state" && last.payload.trigger).toBe("duplicate_fingerprint");
    await expect(continueFrom(fx, opened.threadId)).rejects.toThrow(/parked at the hop cap/);
  });

  it("6. refuses after the hop-cap park is REOPENED", async () => {
    const fx = await fixture();
    const { threadId } = await parkedAtCap(fx);
    await updateBusThread(fx.root, {
      endpointId: fx.a.endpointId, clientTaskId: fx.aTask, threadId,
      action: "reopen", reason: "back to it", evidence: { ciRun: "ci-reopen-1116" },
    });
    const folded = await foldBusThread(fx.root, threadId);
    expect(folded.state).toBe("open");
    await expect(continueFrom(fx, threadId)).rejects.toThrow(/integrity-verified/);
  });

  it("7. refuses when the state is parked but the effective transition is a MANUAL park", async () => {
    // The thread IS parked and a genuine automatic hop_cap park IS in its history.
    // Only the LAST state entry differs. This is the fixture that separates "the
    // park that produced the current state" from "some park somewhere".
    const fx = await fixture();
    const { threadId } = await parkedAtCap(fx);
    await updateBusThread(fx.root, {
      endpointId: fx.a.endpointId, clientTaskId: fx.aTask, threadId,
      action: "reopen", reason: "back to it", evidence: { ciRun: "ci-reopen-1116" },
    });
    await updateBusThread(fx.root, {
      endpointId: fx.a.endpointId, clientTaskId: fx.aTask, threadId,
      action: "park", reason: "stopping this by hand",
    });
    const folded = await foldBusThread(fx.root, threadId);
    expect(folded.state).toBe("parked");
    const last = lastStateEntry(folded);
    expect(last?.type === "state" && last.payload.automatic).not.toBe(true);
    const hadAutomaticHopCap = folded.entries.some((entry) =>
      entry.type === "state" && entry.payload.action === "park" &&
      entry.payload.automatic === true && entry.payload.trigger === "hop_cap");
    expect(hadAutomaticHopCap).toBe(true);
    await expect(continueFrom(fx, threadId)).rejects.toThrow(/parked at the hop cap/);
  });

  it("8. refuses a park entry with automatic true and NO trigger", async () => {
    // SYNTHETIC. A genuine automatic park always sets a trigger (store.ts:1686), so
    // this shape is unreachable through any real send. It must OMIT droppedMessage:
    // BusStatePayloadSchema's superRefine rejects droppedMessage unless the entry is
    // an automatic park WITH a valid trigger, so keeping it would quarantine the
    // thread and the predicate under test would never be reached. Omitting it is
    // schema-legal by that field's own backward-compat contract for historical parks.
    const fx = await fixture();
    const opened = await send(fx, "a");
    const before = await foldBusThread(fx.root, opened.threadId);
    await appendStateEntry(fx.root, opened.threadId, before.validThroughSeq + 1, before.lastHash, {
      action: "park", byEndpoint: fx.a.endpointId, reason: "automatic with no trigger",
      automatic: true,
    });
    const folded = await foldBusThread(fx.root, opened.threadId);
    expect(folded.integrity).toBe("verified");
    expect(folded.state).toBe("parked");
    const last = lastStateEntry(folded);
    expect(last?.type === "state" && last.payload.automatic).toBe(true);
    expect(last?.type === "state" && last.payload.trigger).toBeUndefined();
    await expect(continueFrom(fx, opened.threadId)).rejects.toThrow(/parked at the hop cap/);
  });

  it("9. refuses a park entry with a hop_cap trigger but automatic ABSENT", async () => {
    // SYNTHETIC, same construction and the same reason as test 8, with the presence
    // expectations inverted. This is the only fixture that isolates the `automatic`
    // clause: test 7's manual park carries no trigger, so it would be refused by the
    // trigger clause alone even if the automatic check were removed.
    const fx = await fixture();
    const opened = await send(fx, "a");
    const before = await foldBusThread(fx.root, opened.threadId);
    await appendStateEntry(fx.root, opened.threadId, before.validThroughSeq + 1, before.lastHash, {
      action: "park", byEndpoint: fx.a.endpointId, reason: "hop_cap trigger without automatic",
      trigger: "hop_cap",
    });
    const folded = await foldBusThread(fx.root, opened.threadId);
    expect(folded.integrity).toBe("verified");
    expect(folded.state).toBe("parked");
    const last = lastStateEntry(folded);
    expect(last?.type === "state" && last.payload.trigger).toBe("hop_cap");
    expect(last?.type === "state" && last.payload.automatic).not.toBe(true);
    await expect(continueFrom(fx, opened.threadId)).rejects.toThrow(/parked at the hop cap/);
  });

  it("10. still enforces the LITERAL participant check against a successor endpoint", async () => {
    // The Bus holds exactly two active endpoints, so there is no third party to
    // refuse: an earlier version of this test tried to join one and went red on
    // "the Bus already has two active endpoints", which would have read as a pass
    // had the join sat inside the rejects assertion. The only reachable way to be a
    // non-participant here is SUCCESSION: the ordinary path's check is literal
    // equality with no chain fallback, so an endpoint that REPLACED a participant is
    // refused even though its succession chain reaches one. That limitation is
    // deliberate and unchanged by this item; this test pins it rather than leaving
    // the relaxed precondition to be read as having widened it.
    const fx = await fixture();
    const { threadId } = await parkedAtCap(fx);
    await forgeOffline(fx.root, fx.a.endpointId);
    const successorEndpoint = (await joinEndpoint(fx.root, {
      client: "claude", clientTaskId: "task-a2", surface: "claude_cli", replace: fx.a.endpointId,
    })).endpoint;
    expect(successorEndpoint.endpointId).not.toBe(fx.a.endpointId);
    await expect(sendBusMessage(fx.root, {
      endpointId: successorEndpoint.endpointId, clientTaskId: "task-a2",
      threadKind: "question", messageKind: "question", severity: "info",
      body: "successor continuation", refs: { ciRun: "ci-iss1116" },
      idempotencyKey: randomUUID(), predecessorThreadId: threadId,
    })).rejects.toThrow(/must retain the predecessor participants/);
  });

  it("11. leaves the predecessor's refusal outstanding, by ship-gate identity, not a redelivery", async () => {
    // Codex code round 1 rejected an earlier version of this test: it checked
    // disposition on an INFO-severity park, which checkBusShip's refusal scan
    // never blocks on (only a critical drop trips that blocker), and it accepted
    // ANY non-"redelivered" disposition rather than confirming the SAME entry
    // stays outstanding by its own hash. Both gaps are closed below: the park is
    // driven to a genuinely CRITICAL severity through the real send path, and the
    // assertion matches the refusal by `entryHash` so an unrelated blocker could
    // not satisfy it.
    const fx = await fixture();
    const { threadId } = await parkedAtCap(fx, "question", "critical");
    const before = await checkBusShip(fx.root);
    expect(before.clear).toBe(false);
    const beforeFolded = await foldBusThread(fx.root, threadId, { includeRefusals: true });
    const refusal = beforeFolded.refusals.find((entry) => entry.droppedMessage.severity === "critical");
    if (!refusal) throw new Error("fixture: expected a critical refusal");
    expect(refusal.disposition).toBe("unresolved");
    const blockerFor = (check: { blockers: readonly string[] }) =>
      check.blockers.some((line) => line.includes(refusal.entryHash));
    expect(blockerFor(before)).toBe(true);

    const successor = await continueFrom(fx, threadId);

    const after = await checkBusShip(fx.root);
    expect(after.clear).toBe(false);
    expect(blockerFor(after)).toBe(true);
    const afterFolded = await foldBusThread(fx.root, threadId, { includeRefusals: true });
    const afterRefusal = afterFolded.refusals.find((entry) => entry.entryHash === refusal.entryHash);
    expect(afterRefusal?.disposition).toBe("unresolved");

    const markerDir = join(fx.root, ".story", "bus", "threads", threadId, "redeliver-markers");
    const markers = await readdir(markerDir).catch(() => [] as string[]);
    expect(markers).toHaveLength(0);
    const successorFold = await foldBusThread(fx.root, successor.threadId);
    expect(successorFold.thread.predecessorRelation).toBeUndefined();
  });

  it("11b. a forged redeliver marker naming an ordinary successor does not verify", async () => {
    // SYNTHETIC, and a standing guard rather than coverage of a reachable path: the
    // real path never produces a marker for an ordinary successor, which is exactly
    // the claim under test. Planting one by hand is the only way to check that the
    // separation holds because of what verifiedSuccessorState CHECKS, and not merely
    // because nothing happens to call it. The successor carries predecessorThreadId
    // alone, so fold.ts's `predecessorRelation !== "hop_cap_successor"` gate refuses
    // it and the refusal stays outstanding.
    const fx = await fixture();
    const { threadId } = await parkedAtCap(fx);
    const successor = await continueFrom(fx, threadId);
    const parked = await foldBusThread(fx.root, threadId);
    const parkEntry = lastStateEntry(parked);
    if (!parkEntry) throw new Error("fixture: no park entry");
    const markerDir = join(fx.root, ".story", "bus", "threads", threadId, "redeliver-markers");
    await mkdir(markerDir, { recursive: true, mode: 0o700 });
    await writeFile(join(markerDir, `${parkEntry.entryHash}.json`), JSON.stringify({
      schema: "storybloq-bus-redeliver-marker/v1",
      predecessorThreadId: threadId,
      predecessorEntryHash: parkEntry.entryHash,
      originalByEndpoint: parkEntry.type === "state" ? parkEntry.payload.byEndpoint : fx.a.endpointId,
      successorThreadId: successor.threadId,
      createdAt: new Date().toISOString(),
    }, null, 2) + "\n", "utf-8");
    const folded = await foldBusThread(fx.root, threadId, { includeRefusals: true });
    expect(folded.refusals).toBeDefined();
    expect(folded.refusals!.length).toBeGreaterThan(0);
    for (const refusal of folded.refusals!) expect(refusal.disposition).not.toBe("redelivered");
  });

  it("12. permits several ordinary successors off one park", async () => {
    const fx = await fixture();
    const { threadId } = await parkedAtCap(fx);
    const first = await continueFrom(fx, threadId);
    const second = await continueFrom(fx, threadId);
    expect(second.threadId).not.toBe(first.threadId);
    for (const id of [first.threadId, second.threadId]) {
      const folded = await foldBusThread(fx.root, id);
      expect(folded.thread.predecessorThreadId).toBe(threadId);
    }
  });

  it("13. permits ordinary continuation off a patch_request predecessor", async () => {
    const fx = await fixture();
    const { threadId } = await parkedAtCap(fx, "patch_request");
    const successor = await continueFrom(fx, threadId);
    const folded = await foldBusThread(fx.root, successor.threadId);
    expect(folded.thread.predecessorThreadId).toBe(threadId);
  });

  it("14. leaves the predecessor's entries, thread.json and refused artifacts byte-identical", async () => {
    // Codex code round 1: comparing entries alone does not observe thread.json (a
    // separate on-disk record, rewritten by some paths as a derived projection) or
    // the content-addressed refused artifact the park references. All three are
    // snapshotted, since the claim is that NOTHING about the predecessor changes.
    const fx = await fixture();
    const { threadId } = await parkedAtCap(fx);
    const beforeEntries = await entryFiles(fx.root, threadId);
    const beforeThread = await readFile(join(fx.root, ".story", "bus", "threads", threadId, "thread.json"), "utf-8");
    const beforeRefused = await refusedArtifactFiles(fx.root);
    await continueFrom(fx, threadId);
    expect(await entryFiles(fx.root, threadId)).toEqual(beforeEntries);
    expect(await readFile(join(fx.root, ".story", "bus", "threads", threadId, "thread.json"), "utf-8")).toBe(beforeThread);
    expect(await refusedArtifactFiles(fx.root)).toEqual(beforeRefused);
  });

  it("15. leaves the predecessor's hopCount, state and replayed nextAction unaffected", async () => {
    // Codex code round 1: "nextAction unaffected" was asserted in the test name but
    // never actually observed. It is obtained the way store.test.ts's own replay
    // tests obtain it: resending the EXACT parking send (same idempotencyKey)
    // replays rather than re-executes, and its result carries a freshly recomputed
    // `nextAction`. For a bare `question` predecessor (no A1 redelivery relaxation
    // in this item) that is null both times; the point is that continuation does
    // not change it, not that it becomes non-null.
    const fx = await fixture();
    const { threadId, folded: before, parkingSend } = await parkedAtCap(fx);
    const beforeReplay = await sendBusMessage(fx.root, parkingSend);
    expect(beforeReplay.replayed).toBe(true);
    await continueFrom(fx, threadId);
    const after = await foldBusThread(fx.root, threadId);
    expect(after.state).toBe(before.state);
    expect(after.hopCount).toBe(before.hopCount);
    expect(after.lastHash).toBe(before.lastHash);
    const afterReplay = await sendBusMessage(fx.root, parkingSend);
    expect(afterReplay.replayed).toBe(true);
    expect(afterReplay.nextAction).toEqual(beforeReplay.nextAction);
  });
});
