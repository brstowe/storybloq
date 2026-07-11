import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeBusMessage,
  busDoctor,
  checkBusShip,
  foldBusThread,
  pollBus,
  sendBusMessage,
  setBusHookPolicy,
  updateBusThread,
} from "../../src/bus/index.js";
import { BusError } from "../../src/bus/errors.js";
import { createBusFixture, createIssue, resolveIssue, type BusFixture } from "./helpers.js";

const fixtures: BusFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture.root, { recursive: true, force: true })));
});

async function fixture(): Promise<BusFixture> {
  const value = await createBusFixture();
  fixtures.push(value);
  return value;
}

function reviewSend(value: BusFixture, overrides: Record<string, unknown> = {}) {
  return sendBusMessage(value.root, {
    endpointId: value.reviewer.endpointId,
    clientTaskId: value.reviewerTaskId,
    threadKind: "question",
    toRole: "implementer",
    messageKind: "question",
    severity: "medium",
    body: "Can you verify the recovery boundary?",
    refs: { ciRun: "ci-fixture-1" },
    idempotencyKey: "review-question-1",
    ...overrides,
  });
}

describe("Storybloq Bus store", () => {
  it("sends, polls, acknowledges, and preserves task ownership", async () => {
    const value = await fixture();
    const sent = await reviewSend(value);
    const polled = await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    });

    expect(polled.messages).toHaveLength(1);
    expect(polled.messages[0]).toMatchObject({
      source: "storybloq_bus",
      authority: "peer_agent",
      integrity: "verified",
      sender: { role: "reviewer", client: "claude" },
      message: { messageId: sent.messageId, body: "Can you verify the recovery boundary?" },
    });
    await expect(pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: "foreign-task",
    })).rejects.toMatchObject({ code: "unauthorized" });

    await acknowledgeBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      messageId: sent.messageId!,
      disposition: "accepted",
    });
    expect((await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    })).messages).toHaveLength(0);
  });

  it("makes send retries idempotent and rejects changed payloads", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    const replay = await reviewSend(value);
    expect(replay).toMatchObject({ replayed: true, threadId: first.threadId, messageId: first.messageId });
    await expect(reviewSend(value, { body: "Changed payload" })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
  });

  it("serializes concurrent writers into one contiguous hash chain", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    await Promise.all([
      sendBusMessage(value.root, {
        endpointId: value.implementer.endpointId,
        clientTaskId: value.implementerTaskId,
        threadId: first.threadId,
        toRole: "reviewer",
        messageKind: "reply",
        severity: "medium",
        body: "The first concurrent boundary is verified.",
        refs: { ciRun: "ci-concurrent-2" },
        inReplyTo: first.messageId,
        idempotencyKey: "concurrent-implementer-reply",
      }),
      sendBusMessage(value.root, {
        endpointId: value.reviewer.endpointId,
        clientTaskId: value.reviewerTaskId,
        threadId: first.threadId,
        toRole: "implementer",
        messageKind: "question",
        severity: "medium",
        body: "Can you also verify the second concurrent boundary?",
        refs: { ciRun: "ci-concurrent-3" },
        inReplyTo: first.messageId,
        idempotencyKey: "concurrent-reviewer-question",
      }),
    ]);

    const folded = await foldBusThread(value.root, first.threadId);
    expect(folded).toMatchObject({ integrity: "verified", validThroughSeq: 3, hopCount: 3 });
    expect(folded.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it("recovers a pending pointer and reconstructs a deleted pointer", async () => {
    const value = await fixture();
    await reviewSend(value);
    const mailbox = join(value.root, ".story", "bus", "mailboxes", "implementer");
    const pointer = (await readdir(mailbox)).find((name) => /^\d{12}-.*\.json$/.test(name));
    if (!pointer) throw new Error("pointer not found");
    await rename(join(mailbox, pointer), join(mailbox, "pending", pointer));

    expect((await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    })).messages).toHaveLength(1);
    expect((await readdir(join(mailbox, "pending"))).filter((name) => name.endsWith(".json"))).toHaveLength(0);

    await unlink(join(mailbox, pointer));
    const rebuilt = await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    });
    expect(rebuilt.messages).toHaveLength(1);
    expect((await readdir(mailbox)).filter((name) => /^\d{12}-.*\.json$/.test(name))).toHaveLength(1);
  });

  it("clears an orphan pending intent without serving it", async () => {
    const value = await fixture();
    const mailbox = join(value.root, ".story", "bus", "mailboxes", "implementer");
    const messageId = randomUUID();
    const pointer = {
      schema: "storybloq-bus-mailbox/v1",
      role: "implementer",
      mailboxSeq: 1,
      messageId,
      threadId: randomUUID(),
      entrySeq: 1,
      entryHash: "a".repeat(64),
      createdAt: new Date().toISOString(),
    };
    const filename = `000000000001-${messageId}.json`;
    await writeFile(join(mailbox, "pending", filename), JSON.stringify(pointer), "utf-8");

    const result = await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    });
    expect(result.messages).toHaveLength(0);
    expect(await readdir(join(mailbox, "pending"))).toHaveLength(0);
  });

  it("recovers a deleted mailbox counter without reusing a sequence", async () => {
    const value = await fixture();
    await reviewSend(value);
    const mailbox = join(value.root, ".story", "bus", "mailboxes", "implementer");
    await unlink(join(mailbox, "counter.json"));
    await reviewSend(value, {
      body: "Can you verify the second recovery boundary?",
      refs: { ciRun: "ci-fixture-2" },
      idempotencyKey: "review-question-2",
    });
    const sequences = (await readdir(mailbox))
      .map((filename) => /^(\d{12})-/.exec(filename)?.[1])
      .filter((value): value is string => value !== undefined)
      .sort();
    expect(sequences).toEqual(["000000000001", "000000000002"]);
  });

  it("quarantines a modified immutable entry and does not serve its payload", async () => {
    const value = await fixture();
    const sent = await reviewSend(value);
    const entriesDir = join(value.root, ".story", "bus", "threads", sent.threadId, "entries");
    const filename = (await readdir(entriesDir))[0]!;
    const path = join(entriesDir, filename);
    const entry = JSON.parse(await readFile(path, "utf-8"));
    entry.payload.body = "tampered";
    await writeFile(path, JSON.stringify(entry, null, 2) + "\n", "utf-8");

    const folded = await foldBusThread(value.root, sent.threadId);
    expect(folded).toMatchObject({ integrity: "quarantined", validThroughSeq: 0 });
    const polled = await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    });
    expect(polled.messages).toHaveLength(0);
    expect(polled.findings.join("\n")).toMatch(/valid thread prefix|integrity chain/);
  });

  it("serves only the valid prefix when a middle entry is modified", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    const second = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "The valid-prefix boundary is verified.",
      refs: { ciRun: "ci-prefix-2" },
      inReplyTo: first.messageId,
      idempotencyKey: "prefix-reply-2",
    });
    await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "This corrupt suffix must not be served.",
      refs: { ciRun: "ci-prefix-3" },
      inReplyTo: second.messageId,
      idempotencyKey: "prefix-reply-3",
    });
    const entriesDir = join(value.root, ".story", "bus", "threads", first.threadId, "entries");
    const secondPath = join(entriesDir, (await readdir(entriesDir)).sort()[1]!);
    const entry = JSON.parse(await readFile(secondPath, "utf-8"));
    entry.payload.body = "modified middle entry";
    await writeFile(secondPath, JSON.stringify(entry, null, 2) + "\n", "utf-8");

    const folded = await foldBusThread(value.root, first.threadId);
    expect(folded).toMatchObject({ integrity: "quarantined", validThroughSeq: 1 });
    const polled = await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    });
    expect(polled.messages.map((message) => message.message.body))
      .toEqual(["Can you verify the recovery boundary?"]);
    expect(polled.findings.join("\n")).toContain("valid thread prefix");
  });

  it("rebuilds corrupt derived state and removes a restored post-ack pointer", async () => {
    const value = await fixture();
    const sent = await reviewSend(value);
    const mailbox = join(value.root, ".story", "bus", "mailboxes", "implementer");
    const pointerName = (await readdir(mailbox)).find((name) => /^\d{12}-.*\.json$/.test(name));
    if (!pointerName) throw new Error("pointer not found");
    const pointerBody = await readFile(join(mailbox, pointerName), "utf-8");
    const derived = join(value.root, ".story", "bus", "threads", sent.threadId, "derived.json");
    await writeFile(derived, "not-json", "utf-8");

    await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    });
    expect(JSON.parse(await readFile(derived, "utf-8"))).toMatchObject({
      schema: "storybloq-bus-derived/v1",
      threadId: sent.threadId,
      lastSeq: 1,
      integrity: "verified",
    });

    await acknowledgeBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      messageId: sent.messageId!,
      disposition: "accepted",
    });
    await writeFile(join(mailbox, pointerName), pointerBody, "utf-8");
    expect((await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    })).messages).toHaveLength(0);
    expect((await readdir(mailbox)).filter((name) => /^\d{12}-.*\.json$/.test(name))).toHaveLength(0);
  });

  it("rejects critical messages without a canonical unresolved critical issue", async () => {
    const value = await fixture();
    await expect(reviewSend(value, {
      severity: "critical",
      idempotencyKey: "critical-without-issue",
    })).rejects.toMatchObject({ code: "invalid_input" });

    const issueId = await createIssue(value.root, "critical");
    const sent = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice",
      toRole: "implementer",
      messageKind: "issue_notice",
      severity: "critical",
      body: "The release boundary can lose acknowledged data.",
      refs: { issue: issueId },
      idempotencyKey: "critical-issue-1",
    });
    expect((await checkBusShip(value.root)).blockers.join("\n")).toMatch(/unacknowledged critical/);

    await acknowledgeBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      messageId: sent.messageId!,
      disposition: "accepted",
    });
    expect((await checkBusShip(value.root)).clear).toBe(true);
    await resolveIssue(value.root, issueId);
  });

  it("gates critical questions and parked critical threads, not only issue notices", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      toRole: "implementer",
      messageKind: "question",
      severity: "critical",
      body: "Can the release boundary lose critical state?",
      refs: { issue: issueId },
      idempotencyKey: "critical-question-1",
    });
    expect((await checkBusShip(value.root)).clear).toBe(false);
    await acknowledgeBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      messageId: sent.messageId!,
      disposition: "accepted",
    });
    await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: sent.threadId,
      action: "park",
      reason: "Waiting for critical release evidence",
    });
    expect((await checkBusShip(value.root)).blockers.join("\n"))
      .toMatch(/parked Bus thread with unresolved critical issue/);
  });

  it("rejects high-confidence secrets in bodies, refs, and state text", async () => {
    const value = await fixture();
    await expect(reviewSend(value, {
      body: "token sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      idempotencyKey: "secret-body",
    })).rejects.toMatchObject({ code: "secret_detected" });
    await expect(reviewSend(value, {
      refs: { ciRun: "https://user:password@example.com/run" },
      idempotencyKey: "secret-ref",
    })).rejects.toMatchObject({ code: "secret_detected" });
    await expect(reviewSend(value, {
      refs: { ciRun: "ci-safe", files: ["../secret"] },
      idempotencyKey: "traversal-ref",
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(reviewSend(value, {
      refs: { ciRun: "ci-safe", files: ["src/unsafe\nname.ts"] },
      idempotencyKey: "control-ref",
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(reviewSend(value, {
      body: "x".repeat(16 * 1024 + 1),
      idempotencyKey: "oversized-body",
    })).rejects.toMatchObject({ code: "invalid_input" });

    const sent = await reviewSend(value, {
      body: "Can state text carry credentials?",
      refs: { ciRun: "ci-state-secret" },
      idempotencyKey: "state-secret-thread",
    });
    await expect(updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: sent.threadId,
      action: "park",
      reason: "token sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    })).rejects.toMatchObject({ code: "secret_detected" });
    await expect(acknowledgeBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      messageId: sent.messageId!,
      disposition: "deferred",
      reason: "unsafe\u000bcontrol",
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a symlinked protocol directory", async () => {
    const value = await fixture();
    const threads = join(value.root, ".story", "bus", "threads");
    const target = join(value.root, ".story", "bus-symlink-target");
    await rm(threads, { recursive: true });
    await mkdir(target, { recursive: true });
    await symlink(target, threads, "dir");

    await expect(reviewSend(value)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("reports clean health after ordinary traffic and persists hook policy locally", async () => {
    const value = await fixture();
    await reviewSend(value);
    const policy = await setBusHookPolicy(value.root, ["codex"], true);
    expect(policy).toMatchObject({ claude: false, codex: true });
    expect((await busDoctor(value.root)).healthy).toBe(true);
  });

  it("reports an abandoned lock recovery guard without removing it", async () => {
    const value = await fixture();
    const guard = join(value.root, ".story", "bus", "locks", "thread-dead.lock.reap");
    await writeFile(guard, JSON.stringify({ owner: "unknown" }), "utf-8");

    const doctor = await busDoctor(value.root);

    expect(doctor.healthy).toBe(false);
    expect(doctor.findings).toContain(
      "lock recovery guard requires explicit owner inspection: thread-dead.lock.reap",
    );
    expect(await readFile(guard, "utf-8")).toContain("unknown");
  });

  it("reports a missing protocol directory without recreating it", async () => {
    const value = await fixture();
    const pending = join(value.root, ".story", "bus", "mailboxes", "reviewer", "pending");
    await rm(pending, { recursive: true });

    const doctor = await busDoctor(value.root);

    expect(doctor.healthy).toBe(false);
    expect(doctor.findings.join("\n")).toContain(pending);
    await expect(checkBusShip(value.root)).rejects.toMatchObject({ code: "corrupt" });
    await expect(readdir(pending)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns BusError for ambiguous send modes", async () => {
    const value = await fixture();
    await expect(reviewSend(value, { threadKind: undefined })).rejects.toBeInstanceOf(BusError);
  });

  it("parks before writing an actionable hop beyond the configured cap", async () => {
    const value = await fixture();
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    const first = await reviewSend(value);
    const second = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "The recovery boundary is verified.",
      refs: { ciRun: "ci-fixture-2" },
      inReplyTo: first.messageId,
      idempotencyKey: "implementation-reply-1",
    });
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "Please run one more check.",
      refs: { ciRun: "ci-fixture-3" },
      inReplyTo: second.messageId,
      idempotencyKey: "review-reply-over-cap",
    });
    const folded = await foldBusThread(value.root, first.threadId);

    expect(parked).toMatchObject({ parked: true, messageId: null, hopCount: 2, state: "parked" });
    expect(folded.messages).toHaveLength(2);
    expect(folded.entries.at(-1)).toMatchObject({ type: "state", payload: { trigger: "hop_cap" } });
  });

  it("parks an exact repeated actionable fingerprint in the same direction", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "question",
      severity: "medium",
      body: "Can you verify the recovery boundary?",
      refs: { ciRun: "ci-fixture-1" },
      idempotencyKey: "duplicate-actionable",
    });
    expect(parked).toMatchObject({ parked: true, messageId: null });
    expect((await foldBusThread(value.root, first.threadId)).entries.at(-1))
      .toMatchObject({ type: "state", payload: { trigger: "duplicate_fingerprint" } });
  });

  it("requires unseen evidence to reopen a parked thread", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "park",
      reason: "Waiting for a new CI run",
    });
    const reopened = await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "reopen",
      reason: "New CI evidence is available",
      evidence: { ciRun: "ci-new-evidence" },
    });
    expect(reopened.state).toBe("open");
    await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "park",
      reason: "One more verification is required",
    });
    await expect(updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "reopen",
      reason: "Retry old evidence",
      evidence: { ciRun: "ci-new-evidence" },
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("resolves issue threads only after canonical resolution and links successors", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "high");
    const first = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice",
      toRole: "implementer",
      messageKind: "issue_notice",
      severity: "high",
      body: "The recovery check needs a guard.",
      refs: { issue: issueId },
      idempotencyKey: "high-issue-thread",
    });
    await expect(updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "resolve",
      resolution: "Guard verified",
      evidence: { ciRun: "ci-resolution" },
    })).rejects.toMatchObject({ code: "conflict" });

    await resolveIssue(value.root, issueId);
    expect((await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "resolve",
      resolution: "Guard verified",
      evidence: { ciRun: "ci-resolution" },
    })).state).toBe("resolved");
    await expect(sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "info",
      body: "Late reply",
      refs: { ciRun: "ci-late" },
      idempotencyKey: "late-reply",
    })).rejects.toMatchObject({ code: "thread_parked" });

    const successor = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      predecessorThreadId: first.threadId,
      toRole: "implementer",
      messageKind: "question",
      severity: "info",
      body: "Does the successor evidence hold?",
      refs: { ciRun: "ci-successor" },
      idempotencyKey: "successor-thread",
    });
    expect((await foldBusThread(value.root, successor.threadId)).thread.predecessorThreadId)
      .toBe(first.threadId);
  });
});
