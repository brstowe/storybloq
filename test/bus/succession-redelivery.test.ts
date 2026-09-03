import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeBusMessage,
  busDoctor,
  checkBusShip,
  countUndeliveredMessages,
  getBusThread,
  joinEndpoint,
  leaveEndpoint,
  listEndpoints,
  materializeSuccessorMailbox,
  mailboxHasPointerCandidate,
  pollBus,
  readMailboxHighwater,
  sendBusMessage,
  setBusHookPolicy,
  updateBusThread,
  type BusEndpoint,
} from "../../src/bus/index.js";
import { endpointMailboxPath, resolveBusPaths } from "../../src/bus/paths.js";
import { claimBusToolDelivery } from "../../src/cli/commands/hook-status.js";
import { createBusFixture, createIssue, type BusFixture } from "./helpers.js";

const fixtures: BusFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture.root, { recursive: true, force: true })));
});

async function fixture(): Promise<BusFixture> {
  const value = await createBusFixture();
  fixtures.push(value);
  return value;
}

const POINTER_FILENAME = /^(\d{12})-([0-9a-f-]{36})\.json$/;

// Forge an endpoint positively offline: a processRef whose pid does not exist reads
// as dead, so `--replace`'s offline proof passes. Only works on a claude_cli endpoint
// (a codex_desktop endpoint always reads "unknown").
async function forgeOffline(root: string, endpointId: string): Promise<void> {
  const path = join(root, ".story", "bus", "endpoints", `${endpointId}.json`);
  const endpoint = JSON.parse(await readFile(path, "utf-8"));
  await writeFile(path, JSON.stringify({
    ...endpoint,
    state: "attached",
    processRef: { pid: 999999999, signature: "darwin:deadbeef", capturedAt: new Date().toISOString() },
  }, null, 2) + "\n", "utf-8");
}

// Replace a proven-offline incumbent with a fresh claude successor.
async function replaceWithSuccessor(root: string, replaceId: string, taskId: string): Promise<BusEndpoint> {
  return (await joinEndpoint(root, {
    client: "claude",
    clientTaskId: taskId,
    surface: "claude_cli",
    replace: replaceId,
  })).endpoint;
}

// Critical message a (codex sender) -> b (sole peer), backed by a critical issue.
async function sendCriticalToPeer(value: BusFixture, issueId: string, key: string, body: string) {
  return sendBusMessage(value.root, {
    endpointId: value.a.endpointId,
    clientTaskId: value.aTaskId,
    threadKind: "question",
    messageKind: "question",
    severity: "critical",
    body,
    refs: { issue: issueId },
    idempotencyKey: key,
  });
}

// Assert a corrupt/illegitimate predecessor chain grants ZERO inherited authority:
// the inherited message is invisible and every read/ack/administer seam fails closed.
async function assertChainFailsClosed(
  root: string,
  successor: BusEndpoint,
  taskId: string,
  messageId: string,
  threadId: string,
): Promise<void> {
  const polled = await pollBus(root, { endpointId: successor.endpointId, clientTaskId: taskId });
  expect(polled.messages).toHaveLength(0);
  await expect(acknowledgeBusMessage(root, {
    endpointId: successor.endpointId,
    clientTaskId: taskId,
    messageId,
    disposition: "accepted",
  })).rejects.toMatchObject({ code: "unauthorized" });
  await expect(getBusThread(root, {
    endpointId: successor.endpointId,
    clientTaskId: taskId,
    threadId,
  })).rejects.toMatchObject({ code: "unauthorized" });
  // updateBusThread (park/resolve) must also fail closed -- a corrupt chain never grants
  // administration authority even if reads were somehow preserved.
  await expect(updateBusThread(root, {
    endpointId: successor.endpointId,
    clientTaskId: taskId,
    threadId,
    action: "park",
    reason: "Should not be authorized through a corrupt chain",
  })).rejects.toMatchObject({ code: "unauthorized" });
}

async function pointerFilesIn(root: string, endpointId: string): Promise<string[]> {
  const paths = await resolveBusPaths(root, false);
  const mailbox = endpointMailboxPath(paths, endpointId);
  const names: string[] = [];
  for (const directory of [mailbox, join(mailbox, "pending")]) {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of entries) if (POINTER_FILENAME.test(name)) names.push(name);
  }
  return names;
}

describe("ISS-872 succession redelivery", () => {
  it("redelivers the predecessor's unacked mail to the successor on first poll", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendCriticalToPeer(value, issueId, "succ-1", "Inherited critical finding");

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-1");
    expect(successor.predecessorEndpointId).toBe(value.b.endpointId);

    const { endpoints } = await listEndpoints(value.root);
    const retiredB = endpoints.find((endpoint) => endpoint.endpointId === value.b.endpointId);
    expect(retiredB?.retiredAt).toBeTruthy();
    expect(retiredB?.retiredReason).toBe("replaced");

    const polled = await pollBus(value.root, {
      endpointId: successor.endpointId,
      clientTaskId: "claude-successor-1",
    });
    expect(polled.messages).toHaveLength(1);
    expect(polled.messages[0].message.messageId).toBe(sent.messageId);
    // The redelivered pointer is stamped with the SUCCESSOR's id and lives in its mailbox
    // (unacked, so poll keeps it); the predecessor's own pointer has been swept away.
    const successorPointers = await pointerFilesIn(value.root, successor.endpointId);
    expect(successorPointers.some((name) => name.endsWith(`${sent.messageId}.json`))).toBe(true);
    const paths = await resolveBusPaths(value.root, false);
    const successorMailbox = endpointMailboxPath(paths, successor.endpointId);
    const record = JSON.parse(await readFile(join(successorMailbox, successorPointers[0]), "utf-8"));
    expect(record.endpointId).toBe(successor.endpointId);
    expect(await pointerFilesIn(value.root, value.b.endpointId)).toHaveLength(0);
  });

  it("sweeps the predecessor pointer files after redelivery and stays stable on re-poll", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    await sendCriticalToPeer(value, issueId, "succ-2", "Inherited critical finding");
    expect(await pointerFilesIn(value.root, value.b.endpointId)).toHaveLength(1);

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-2");

    await pollBus(value.root, { endpointId: successor.endpointId, clientTaskId: "claude-successor-2" });
    expect(await pointerFilesIn(value.root, value.b.endpointId)).toHaveLength(0);

    const doctor = await busDoctor(value.root);
    expect(doctor.findings.join("\n")).not.toMatch(/stranded/);

    // Second poll is stable: no duplicate delivery, predecessor mailbox stays empty.
    const second = await pollBus(value.root, { endpointId: successor.endpointId, clientTaskId: "claude-successor-2" });
    expect(second.messages).toHaveLength(1);
    expect(await pointerFilesIn(value.root, value.b.endpointId)).toHaveLength(0);
  });

  it("lets the successor ack an inherited critical message to clear the ship gate", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendCriticalToPeer(value, issueId, "succ-3", "Inherited critical finding");
    expect((await checkBusShip(value.root)).clear).toBe(false);

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-3");
    await pollBus(value.root, { endpointId: successor.endpointId, clientTaskId: "claude-successor-3" });

    const acked = await acknowledgeBusMessage(value.root, {
      endpointId: successor.endpointId,
      clientTaskId: "claude-successor-3",
      messageId: sent.messageId!,
      disposition: "accepted",
    });
    expect(acked.replayed).toBe(false);
    const folded = await getBusThread(value.root, {
      endpointId: successor.endpointId,
      clientTaskId: "claude-successor-3",
      threadId: sent.threadId,
    });
    expect(folded.integrity).toBe("verified");
    expect(folded.acknowledgments.get(sent.messageId!)?.byEndpoint).toBe(successor.endpointId);
    expect((await checkBusShip(value.root)).clear).toBe(true);
  });

  it("lets the successor get, park, and resolve an inherited thread", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendCriticalToPeer(value, issueId, "succ-4", "Inherited critical finding");

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-4");

    const got = await getBusThread(value.root, {
      endpointId: successor.endpointId,
      clientTaskId: "claude-successor-4",
      threadId: sent.threadId,
    });
    expect(got.thread.threadId).toBe(sent.threadId);

    await updateBusThread(value.root, {
      endpointId: successor.endpointId,
      clientTaskId: "claude-successor-4",
      threadId: sent.threadId,
      action: "park",
      reason: "Successor is triaging the inherited critical finding",
    });
    const resolved = await updateBusThread(value.root, {
      endpointId: successor.endpointId,
      clientTaskId: "claude-successor-4",
      threadId: sent.threadId,
      action: "resolve",
      resolution: "Successor confirmed the inherited finding is handled",
      evidence: { ciRun: "ci-succession-resolve" },
    });
    expect(resolved.state).toBe("resolved");
  });

  it("still refuses a successor SEND into an inherited thread, and refuses a non-successor ack", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendCriticalToPeer(value, issueId, "succ-5", "Inherited critical finding");

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-5");

    // The successor inherits READ/ack/administer authority, never SEND authority: a
    // reply into the inherited thread fails closed (fold would otherwise quarantine it).
    await expect(sendBusMessage(value.root, {
      endpointId: successor.endpointId,
      clientTaskId: "claude-successor-5",
      threadId: sent.threadId,
      messageKind: "reply",
      severity: "medium",
      body: "Successor should not be able to reply here",
      idempotencyKey: "succ-5-reply",
    })).rejects.toMatchObject({ code: "unauthorized" });

    // The original sender (a) is NOT b's successor and cannot ack b's mail.
    await expect(acknowledgeBusMessage(value.root, {
      endpointId: value.a.endpointId,
      clientTaskId: value.aTaskId,
      messageId: sent.messageId!,
      disposition: "accepted",
    })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("propagates authority across two generations of replacement (chain succession)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendCriticalToPeer(value, issueId, "succ-6", "Inherited critical finding");

    // Replace b -> s1 but do NOT poll s1 (so b's mail is never materialized into s1).
    await forgeOffline(value.root, value.b.endpointId);
    const s1 = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-6a");
    // Replace s1 -> s2. s2 inherits b transitively through s1.
    await forgeOffline(value.root, s1.endpointId);
    const s2 = await replaceWithSuccessor(value.root, s1.endpointId, "claude-successor-6b");
    expect(s2.predecessorEndpointId).toBe(s1.endpointId);

    // Before s2 polls, doctor reports b's mail as pending redelivery to s2 (never stranded).
    const beforePoll = await busDoctor(value.root);
    expect(beforePoll.findings.join("\n")).toMatch(/pending redelivery to successor/);
    expect(beforePoll.findings.join("\n")).toContain(s2.endpointId);
    expect(beforePoll.findings.join("\n")).not.toMatch(/stranded/);

    const polled = await pollBus(value.root, { endpointId: s2.endpointId, clientTaskId: "claude-successor-6b" });
    expect(polled.messages.map((m) => m.message.messageId)).toContain(sent.messageId);

    // s2 can ack/resolve b's inherited thread even though b was never s2's direct predecessor.
    await updateBusThread(value.root, {
      endpointId: s2.endpointId,
      clientTaskId: "claude-successor-6b",
      threadId: sent.threadId,
      action: "resolve",
      resolution: "Handled after two generations of replacement",
      evidence: { ciRun: "ci-chain-resolve" },
    });
    expect((await checkBusShip(value.root)).clear).toBe(true);

    // Doctor reports b's mail as pending redelivery to s2, never stranded.
    const doctor = await busDoctor(value.root);
    expect(doctor.findings.join("\n")).not.toMatch(/stranded/);
  });

  it("recovers sender-also-retired critical mail through the successor", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendCriticalToPeer(value, issueId, "succ-7", "Inherited critical finding");
    expect((await checkBusShip(value.root)).clear).toBe(false);

    // The original sender (a) leaves, then b is replaced normally. Both original
    // participants are retired, yet the successor inherits b's authority over the thread.
    await leaveEndpoint(value.root, value.a.endpointId, value.aTaskId);
    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-7");

    await updateBusThread(value.root, {
      endpointId: successor.endpointId,
      clientTaskId: "claude-successor-7",
      threadId: sent.threadId,
      action: "resolve",
      resolution: "Successor resolved after the sender left",
      evidence: { ciRun: "ci-sender-left-resolve" },
    });
    expect((await checkBusShip(value.root)).clear).toBe(true);
    expect(sent.messageId).toBeTruthy();
  });

  it("classifies mail to a retired recipient as resolvable while a participant stays active", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendCriticalToPeer(value, issueId, "succ-8a", "Inherited critical finding");
    // The recipient (b) leaves with NO successor, but the sender (a) stays active.
    await leaveEndpoint(value.root, value.b.endpointId, value.bTaskId);

    const doctor = await busDoctor(value.root);
    const text = doctor.findings.join("\n");
    expect(text).toMatch(/to a retired recipient/);
    expect(text).not.toMatch(/stranded/);
    expect(text).not.toMatch(/pending redelivery/);

    // The active participant (a) can still resolve the thread with evidence to clear the gate.
    expect((await checkBusShip(value.root)).clear).toBe(false);
    await updateBusThread(value.root, {
      endpointId: value.a.endpointId,
      clientTaskId: value.aTaskId,
      threadId: sent.threadId,
      action: "resolve",
      resolution: "Sender resolved after the recipient left",
      evidence: { ciRun: "ci-resolvable-8a" },
    });
    expect((await checkBusShip(value.root)).clear).toBe(true);
  });

  it("classifies all-participants-retired mail as stranded, not falsely redeliverable or resolvable", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    await sendCriticalToPeer(value, issueId, "succ-8b", "Inherited critical finding");

    // Retire EVERY participant: the sender (a) leaves, then b is replaced and the
    // successor also leaves before handling anything. Now no lineage endpoint is active.
    await leaveEndpoint(value.root, value.a.endpointId, value.aTaskId);
    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-8b");
    await leaveEndpoint(value.root, successor.endpointId, "claude-successor-8b");

    const doctor = await busDoctor(value.root);
    const text = doctor.findings.join("\n");
    expect(text).toMatch(/stranded succession thread/);
    expect(text).toMatch(/no active participant or successor/);
    expect(text).not.toMatch(/pending redelivery/);
    expect(text).not.toMatch(/to a retired recipient/);

    // Repeated runs stay stable (idempotent classification).
    const again = await busDoctor(value.root);
    expect(again.findings.join("\n")).toBe(text);
  });

  it("re-sweeps a genuine resurrected ancestor pointer without redelivering it", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    await sendCriticalToPeer(value, issueId, "succ-9", "Inherited critical finding");

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-9");
    // First poll delivers b's mail to the successor and sweeps b's mailbox.
    await pollBus(value.root, { endpointId: successor.endpointId, clientTaskId: "claude-successor-9" });
    expect(await pointerFilesIn(value.root, value.b.endpointId)).toHaveLength(0);

    // The genuine, unacked successor pointer is still present after the poll.
    const successorPointers = await pointerFilesIn(value.root, successor.endpointId);
    const paths = await resolveBusPaths(value.root, false);
    const successorMailbox = endpointMailboxPath(paths, successor.endpointId);
    const genuine = JSON.parse(await readFile(join(successorMailbox, successorPointers[0]), "utf-8"));

    // Resurrect a CANONICALLY VALID ancestor pointer: the genuine successor pointer copied
    // back under b's ownership, preserving threadId/entrySeq/entryHash (a crash-window dup).
    const bMailbox = endpointMailboxPath(paths, value.b.endpointId);
    await mkdir(bMailbox, { recursive: true });
    const resurrected = { ...genuine, endpointId: value.b.endpointId, mailboxSeq: 1 };
    const filename = `${String(1).padStart(12, "0")}-${resurrected.messageId}.json`;
    await writeFile(join(bMailbox, filename), JSON.stringify(resurrected, null, 2) + "\n", "utf-8");

    // Next poll re-sweeps it (canonically valid AND already redelivered) without a second delivery.
    const second = await pollBus(value.root, { endpointId: successor.endpointId, clientTaskId: "claude-successor-9" });
    expect(second.messages).toHaveLength(1);
    expect(await pointerFilesIn(value.root, value.b.endpointId)).toHaveLength(0);
  });

  it("preserves a canonically mismatched ancestor pointer during the sweep", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendCriticalToPeer(value, issueId, "succ-9b", "Inherited critical finding");

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-9b");
    const paths = await resolveBusPaths(value.root, false);
    const bMailbox = endpointMailboxPath(paths, value.b.endpointId);

    // Plant a schema-valid pointer whose entryHash does NOT match the canonical entry:
    // its messageId is redelivered, but the fail-closed sweep must PRESERVE it (never
    // unlink a pointer that does not match a verified thread entry).
    const mismatched = {
      schema: "storybloq-bus-mailbox/v2",
      endpointId: value.b.endpointId,
      mailboxSeq: 5,
      messageId: sent.messageId,
      threadId: sent.threadId,
      entrySeq: 1,
      entryHash: "0".repeat(64),
      createdAt: new Date().toISOString(),
    };
    const filename = `${String(5).padStart(12, "0")}-${sent.messageId}.json`;
    await writeFile(join(bMailbox, filename), JSON.stringify(mismatched, null, 2) + "\n", "utf-8");

    const polled = await pollBus(value.root, { endpointId: successor.endpointId, clientTaskId: "claude-successor-9b" });
    expect(await readdir(bMailbox)).toContain(filename);
    expect(polled.findings.join("\n")).toMatch(/does not match a verified thread entry/);
  });

  it("preserves corruption evidence during the sweep and reports it", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendCriticalToPeer(value, issueId, "succ-10", "Inherited critical finding");

    // Plant a POINTER_FILENAME-shaped but schema-invalid file whose name embeds the
    // redelivered messageId in b's mailbox BEFORE replacement.
    const paths = await resolveBusPaths(value.root, false);
    const bMailbox = endpointMailboxPath(paths, value.b.endpointId);
    const corruptName = `${String(2).padStart(12, "0")}-${sent.messageId}.json`;
    await writeFile(join(bMailbox, corruptName), "{ not valid json", "utf-8");

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-10");
    const polled = await pollBus(value.root, { endpointId: successor.endpointId, clientTaskId: "claude-successor-10" });
    // The corrupt file is NOT unlinked even though its name embeds a redelivered messageId.
    const remaining = await readdir(bMailbox);
    expect(remaining).toContain(corruptName);
    // The reconciliation finding for it surfaces (via poll findings and doctor).
    expect(polled.findings.join("\n")).toMatch(corruptName);
    const doctor = await busDoctor(value.root);
    expect(doctor.findings.join("\n")).toMatch(corruptName);
  });

  it("classifies a crash-stale ACKNOWLEDGED ancestor pointer as routine cleanup, not redelivery", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendCriticalToPeer(value, issueId, "succ-stale-ack", "Inherited critical finding");

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-stale-ack");
    await pollBus(value.root, { endpointId: successor.endpointId, clientTaskId: "claude-successor-stale-ack" });

    // Capture the genuine (canonical) pointer, then ack the message.
    const paths = await resolveBusPaths(value.root, false);
    const successorMailbox = endpointMailboxPath(paths, successor.endpointId);
    const genuine = JSON.parse(await readFile(join(successorMailbox, (await pointerFilesIn(value.root, successor.endpointId))[0]), "utf-8"));
    await acknowledgeBusMessage(value.root, {
      endpointId: successor.endpointId,
      clientTaskId: "claude-successor-stale-ack",
      messageId: sent.messageId!,
      disposition: "accepted",
    });

    // Resurrect the canonical ancestor pointer AFTER the ack (crash-stale duplicate).
    const bMailbox = endpointMailboxPath(paths, value.b.endpointId);
    await mkdir(bMailbox, { recursive: true });
    const filename = `${String(9).padStart(12, "0")}-${genuine.messageId}.json`;
    await writeFile(join(bMailbox, filename), JSON.stringify({ ...genuine, endpointId: value.b.endpointId, mailboxSeq: 9 }, null, 2) + "\n", "utf-8");

    const text = (await busDoctor(value.root)).findings.join("\n");
    expect(text).toMatch(/acknowledged\/resolved pointer/);
    expect(text).not.toMatch(/pending redelivery/);
    expect(text).not.toMatch(/stranded/);
    expect(text).not.toMatch(/to a retired recipient/);

    // The successor's next poll surfaces nothing and reclaims the stale ancestor pointer.
    const repoll = await pollBus(value.root, { endpointId: successor.endpointId, clientTaskId: "claude-successor-stale-ack" });
    expect(repoll.messages).toHaveLength(0);
    expect(await pointerFilesIn(value.root, value.b.endpointId)).toHaveLength(0);
    expect(await pointerFilesIn(value.root, successor.endpointId)).toHaveLength(0);
  });

  it("classifies a crash-stale pointer in a RESOLVED thread as routine cleanup, not resolvable", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendCriticalToPeer(value, issueId, "succ-stale-resolve", "Inherited critical finding");

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-stale-res");
    await pollBus(value.root, { endpointId: successor.endpointId, clientTaskId: "claude-successor-stale-res" });

    const paths = await resolveBusPaths(value.root, false);
    const successorMailbox = endpointMailboxPath(paths, successor.endpointId);
    const genuine = JSON.parse(await readFile(join(successorMailbox, (await pointerFilesIn(value.root, successor.endpointId))[0]), "utf-8"));
    await updateBusThread(value.root, {
      endpointId: successor.endpointId,
      clientTaskId: "claude-successor-stale-res",
      threadId: sent.threadId,
      action: "resolve",
      resolution: "Successor resolved the inherited thread",
      evidence: { ciRun: "ci-stale-resolve" },
    });

    // Resurrect the canonical ancestor pointer into b's mailbox after the thread resolved.
    const bMailbox = endpointMailboxPath(paths, value.b.endpointId);
    await mkdir(bMailbox, { recursive: true });
    const filename = `${String(9).padStart(12, "0")}-${genuine.messageId}.json`;
    await writeFile(join(bMailbox, filename), JSON.stringify({ ...genuine, endpointId: value.b.endpointId, mailboxSeq: 9 }, null, 2) + "\n", "utf-8");

    const text = (await busDoctor(value.root)).findings.join("\n");
    expect(text).toMatch(/acknowledged\/resolved pointer/);
    expect(text).not.toMatch(/pending redelivery/);
    expect(text).not.toMatch(/stranded/);
    expect(text).not.toMatch(/to a retired recipient/);

    // The resolved thread is terminal: a re-poll surfaces nothing (never redelivers the
    // resolved message) and reclaims both the stale ancestor pointer and the successor's own.
    const repoll = await pollBus(value.root, { endpointId: successor.endpointId, clientTaskId: "claude-successor-stale-res" });
    expect(repoll.messages).toHaveLength(0);
    expect(await pointerFilesIn(value.root, value.b.endpointId)).toHaveLength(0);
    expect(await pointerFilesIn(value.root, successor.endpointId)).toHaveLength(0);
  });

  it("reports stale pointers as non-blocking when no active successor can reclaim them", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendCriticalToPeer(value, issueId, "succ-stale-orphan", "Inherited critical finding");

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-stale-orphan");
    await pollBus(value.root, { endpointId: successor.endpointId, clientTaskId: "claude-successor-stale-orphan" });
    const paths = await resolveBusPaths(value.root, false);
    const successorMailbox = endpointMailboxPath(paths, successor.endpointId);
    const genuine = JSON.parse(await readFile(join(successorMailbox, (await pointerFilesIn(value.root, successor.endpointId))[0]), "utf-8"));
    await acknowledgeBusMessage(value.root, {
      endpointId: successor.endpointId,
      clientTaskId: "claude-successor-stale-orphan",
      messageId: sent.messageId!,
      disposition: "accepted",
    });
    // Plant a canonical acked pointer in b's mailbox, THEN retire the successor so no
    // active endpoint's chain covers b any longer.
    const bMailbox = endpointMailboxPath(paths, value.b.endpointId);
    await mkdir(bMailbox, { recursive: true });
    const filename = `${String(9).padStart(12, "0")}-${genuine.messageId}.json`;
    await writeFile(join(bMailbox, filename), JSON.stringify({ ...genuine, endpointId: value.b.endpointId, mailboxSeq: 9 }, null, 2) + "\n", "utf-8");
    await leaveEndpoint(value.root, successor.endpointId, "claude-successor-stale-orphan");

    const text = (await busDoctor(value.root)).findings.join("\n");
    expect(text).toMatch(/non-blocking stale state with no active successor/);
    expect(text).toMatch(/ship gate is already clear/);
    expect(text).not.toMatch(/pending redelivery/);
    expect(text).not.toMatch(/stranded/);
    expect(text).not.toMatch(/reclaims them/);
  });

  it("materializes inherited mail into the physical mailbox for the live hooks before any poll", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    await sendCriticalToPeer(value, issueId, "succ-11", "Inherited critical finding");

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-11");

    // Eager materialization: the successor's PHYSICAL mailbox holds the inherited pointer
    // before any explicit poll, so the live hooks (which gate on the physical mailbox) fire.
    await materializeSuccessorMailbox(value.root, successor);
    const paths = await resolveBusPaths(value.root, false);
    const highwater = await readMailboxHighwater(paths, successor.endpointId);
    expect(highwater).toEqual({ known: true, highwater: 1 });
    expect(await mailboxHasPointerCandidate(paths, successor.endpointId)).toBe(true);

    // The on-tool gate surfaces the inherited mail (poll-prompt) without an explicit poll.
    await setBusHookPolicy(value.root, ["claude"], true);
    const claim = await claimBusToolDelivery(value.root, {
      session_id: "claude-successor-11",
      cwd: value.root,
      hook_event_name: "PostToolUse",
    });
    expect(claim).not.toBeNull();
  });

  it("counts only canonically-bound deliverable mail, excluding a wrong-mailbox pointer", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    await sendCriticalToPeer(value, issueId, "succ-count", "Inherited critical finding");
    // One genuine deliverable message addressed to b.
    expect(await countUndeliveredMessages(value.root, value.b.endpointId)).toBe(1);

    // b sends a message to a (to === a). Copy a's genuine, canonically-valid pointer for it
    // into b's mailbox under b's envelope: schema-valid with a correct hash, but its
    // canonical recipient is a, not b, so countUndeliveredMessages(b) must exclude it.
    await sendBusMessage(value.root, {
      endpointId: value.b.endpointId,
      clientTaskId: value.bTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "low",
      body: "A question addressed to a",
      refs: { ciRun: "ci-b-to-a" },
      idempotencyKey: "b-to-a-question",
    });
    const paths = await resolveBusPaths(value.root, false);
    const aMailbox = endpointMailboxPath(paths, value.a.endpointId);
    const aPointerName = (await pointerFilesIn(value.root, value.a.endpointId))[0];
    const aPointer = JSON.parse(await readFile(join(aMailbox, aPointerName), "utf-8"));
    const bMailbox = endpointMailboxPath(paths, value.b.endpointId);
    const misplaced = { ...aPointer, endpointId: value.b.endpointId, mailboxSeq: 7 };
    await writeFile(join(bMailbox, `${String(7).padStart(12, "0")}-${misplaced.messageId}.json`), JSON.stringify(misplaced, null, 2) + "\n", "utf-8");

    // Still exactly one deliverable to b; the misplaced to-a pointer is excluded.
    expect(await countUndeliveredMessages(value.root, value.b.endpointId)).toBe(1);
  });

  it("classifies a canonically valid but MISFILED acked pointer in a retired mailbox as corrupt, not stale", async () => {
    const value = await fixture();
    // b asks a a question (to === a); capture a's genuine canonical pointer, then a acks it,
    // so the message is in an acked ("would-be routine stale") state.
    const bToA = await sendBusMessage(value.root, {
      endpointId: value.b.endpointId,
      clientTaskId: value.bTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "low",
      body: "A question addressed to a",
      refs: { ciRun: "ci-misfiled" },
      idempotencyKey: "misfiled-b-to-a",
    });
    const paths = await resolveBusPaths(value.root, false);
    const aMailbox = endpointMailboxPath(paths, value.a.endpointId);
    const genuine = JSON.parse(await readFile(join(aMailbox, (await pointerFilesIn(value.root, value.a.endpointId))[0]), "utf-8"));
    await acknowledgeBusMessage(value.root, {
      endpointId: value.a.endpointId,
      clientTaskId: value.aTaskId,
      messageId: bToA.messageId!,
      disposition: "accepted",
    });

    // Retire b BY REPLACEMENT so an ACTIVE successor's chain covers b: this is exactly the
    // case where the old stale branch would falsely promise "a poll of the owning successor
    // reclaims them" even though the sweep rejects the pointer (recipient a is not in the
    // successor's chain).
    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-misfiled");

    // Plant the canonically valid, a-addressed pointer into b's (retired) mailbox. b's chain
    // is [b], so recipient a is OUTSIDE it -- the pointer is misfiled, not b's inherited mail.
    const bMailbox = endpointMailboxPath(paths, value.b.endpointId);
    await mkdir(bMailbox, { recursive: true });
    await writeFile(
      join(bMailbox, `${String(9).padStart(12, "0")}-${genuine.messageId}.json`),
      JSON.stringify({ ...genuine, endpointId: value.b.endpointId, mailboxSeq: 9 }, null, 2) + "\n",
      "utf-8",
    );

    const text = (await busDoctor(value.root)).findings.join("\n");
    // Corruption, never routine stale cleanup, and never a false successor-poll promise.
    expect(text).toMatch(/do not match a verified thread entry addressed to this mailbox/);
    expect(text).not.toMatch(/acknowledged\/resolved pointer/);
    expect(text).not.toMatch(/reclaims them/);
    expect(text).not.toMatch(/pending redelivery/);
  });

  it("materialization follows the REGISTRY chain, ignoring a forged caller predecessor", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendCriticalToPeer(value, issueId, "succ-registry", "Inherited critical finding");

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-registry");

    // Forge the in-memory object to a bogus predecessor; materialize must ignore it and use
    // the REGISTRY record (predecessor = b), redelivering b's mail all the same.
    const forged = { ...successor, predecessorEndpointId: "00000000-0000-4000-8000-000000000000" };
    const result = await materializeSuccessorMailbox(value.root, forged);

    // Assert MATERIALIZATION alone did the redelivery, BEFORE any poll. pollBus would
    // independently reconcile from the canonical registry and could mask a materialization
    // that wrongly followed the forged chain or did nothing, so isolate it: status
    // materialized, no succession-chain finding, the inherited pointer physically in the
    // successor's mailbox stamped to the successor, and the predecessor mailbox swept.
    expect(result.status).toBe("materialized");
    expect(result.findings.some((finding) => finding.includes("succession chain"))).toBe(false);
    const successorPointers = await pointerFilesIn(value.root, successor.endpointId);
    expect(successorPointers).toHaveLength(1);
    expect(await pointerFilesIn(value.root, value.b.endpointId)).toHaveLength(0);
    const paths = await resolveBusPaths(value.root, false);
    const materialized = JSON.parse(
      await readFile(join(endpointMailboxPath(paths, successor.endpointId), successorPointers[0]), "utf-8"),
    );
    expect(materialized.messageId).toBe(sent.messageId);
    expect(materialized.endpointId).toBe(successor.endpointId);

    // Poll only to confirm the already-materialized pointer is readable.
    const polled = await pollBus(value.root, { endpointId: successor.endpointId, clientTaskId: "claude-successor-registry" });
    expect(polled.messages.map((m) => m.message.messageId)).toContain(sent.messageId);
  });

  it("materialization no-ops when the canonical endpoint is retired before it runs", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    await sendCriticalToPeer(value, issueId, "succ-inactive", "Inherited critical finding");

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-inactive");
    // Retire the successor (canonical record now retired) BEFORE materializing.
    await leaveEndpoint(value.root, successor.endpointId, "claude-successor-inactive");

    const result = await materializeSuccessorMailbox(value.root, successor);
    expect(result.status).toBe("endpoint_inactive");
    expect(result.pointers).toHaveLength(0);
    // No pointers were created in the (now retired) successor mailbox.
    expect(await pointerFilesIn(value.root, successor.endpointId)).toHaveLength(0);
  });

  it("fails closed to self-only authority on a corrupt predecessor chain", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendCriticalToPeer(value, issueId, "succ-12", "Inherited critical finding");

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-12");

    // Corrupt the chain: point the successor at a missing ancestor.
    const successorPath = join(value.root, ".story", "bus", "endpoints", `${successor.endpointId}.json`);
    const record = JSON.parse(await readFile(successorPath, "utf-8"));
    await writeFile(successorPath, JSON.stringify({
      ...record,
      predecessorEndpointId: "00000000-0000-4000-8000-000000000000",
    }, null, 2) + "\n", "utf-8");

    // A corrupt chain NEVER grants authority: the inherited message is invisible and
    // every read/ack/administer seam fails closed; doctor emits a chain finding.
    await assertChainFailsClosed(value.root, successor, "claude-successor-12", sent.messageId!, sent.threadId);
    const doctor = await busDoctor(value.root);
    expect(doctor.findings.join("\n")).toMatch(/succession chain/);
  });

  it("fails closed to self-only authority on a predecessor-chain cycle", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendCriticalToPeer(value, issueId, "succ-12b", "Inherited critical finding");

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-12b");

    // Forge a cycle: b now points back at its own successor (successor -> b -> successor).
    const bPath = join(value.root, ".story", "bus", "endpoints", `${value.b.endpointId}.json`);
    const bRecord = JSON.parse(await readFile(bPath, "utf-8"));
    await writeFile(bPath, JSON.stringify({
      ...bRecord,
      predecessorEndpointId: successor.endpointId,
    }, null, 2) + "\n", "utf-8");

    await assertChainFailsClosed(value.root, successor, "claude-successor-12b", sent.messageId!, sent.threadId);
    const doctor = await busDoctor(value.root);
    expect(doctor.findings.join("\n")).toMatch(/succession chain.*cycles/);
  });

  it("refuses succession authority through a link to the active peer or a non-replacement retirement", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendCriticalToPeer(value, issueId, "succ-12d", "Inherited critical finding");

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-12d");
    const successorPath = join(value.root, ".story", "bus", "endpoints", `${successor.endpointId}.json`);
    const record = JSON.parse(await readFile(successorPath, "utf-8"));

    // (a) Link to the ACTIVE peer (a): UUID exists but is not a retired-by-replacement
    // predecessor, so it must grant no authority over a's mail/threads.
    await writeFile(successorPath, JSON.stringify({ ...record, predecessorEndpointId: value.a.endpointId }, null, 2) + "\n", "utf-8");
    await assertChainFailsClosed(value.root, successor, "claude-successor-12d", sent.messageId!, sent.threadId);
    expect((await busDoctor(value.root)).findings.join("\n")).toMatch(/not retired by replacement/);

    // (b) Link to b AFTER re-marking b's retirement as `left` (not `replaced`).
    const bPath = join(value.root, ".story", "bus", "endpoints", `${value.b.endpointId}.json`);
    const bRecord = JSON.parse(await readFile(bPath, "utf-8"));
    await writeFile(bPath, JSON.stringify({ ...bRecord, retiredReason: "left" }, null, 2) + "\n", "utf-8");
    await writeFile(successorPath, JSON.stringify({ ...record, predecessorEndpointId: value.b.endpointId }, null, 2) + "\n", "utf-8");
    await assertChainFailsClosed(value.root, successor, "claude-successor-12d", sent.messageId!, sent.threadId);
    expect((await busDoctor(value.root)).findings.join("\n")).toMatch(/not retired by replacement/);
  });

  it("fails closed to self-only authority on an over-depth predecessor chain", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendCriticalToPeer(value, issueId, "succ-12c", "Inherited critical finding");

    await forgeOffline(value.root, value.b.endpointId);
    const successor = await replaceWithSuccessor(value.root, value.b.endpointId, "claude-successor-12c");

    // Build a predecessor chain deeper than MAX_SUCCESSION_DEPTH (64): clone the successor
    // record into 65 linked retired endpoints and point the active successor at the head.
    const endpointsDir = join(value.root, ".story", "bus", "endpoints");
    const mailboxesDir = join(value.root, ".story", "bus", "mailboxes");
    const successorPath = join(endpointsDir, `${successor.endpointId}.json`);
    const template = JSON.parse(await readFile(successorPath, "utf-8"));
    const chainIds = Array.from({ length: 65 }, () => randomUUID());
    for (let i = 0; i < chainIds.length; i += 1) {
      const record: Record<string, unknown> = {
        ...template,
        endpointId: chainIds[i],
        clientTaskId: `chain-link-${i}`,
        state: "offline",
        retiredAt: new Date().toISOString(),
        retiredReason: "replaced",
      };
      if (i + 1 < chainIds.length) record.predecessorEndpointId = chainIds[i + 1];
      else delete record.predecessorEndpointId;
      await writeFile(join(endpointsDir, `${chainIds[i]}.json`), JSON.stringify(record, null, 2) + "\n", "utf-8");
      // Every registered endpoint must own a mailbox/pending dir or assertBusLayout rejects.
      await mkdir(join(mailboxesDir, chainIds[i], "pending"), { recursive: true });
    }
    await writeFile(successorPath, JSON.stringify({ ...template, predecessorEndpointId: chainIds[0] }, null, 2) + "\n", "utf-8");

    await assertChainFailsClosed(value.root, successor, "claude-successor-12c", sent.messageId!, sent.threadId);
    const doctor = await busDoctor(value.root);
    expect(doctor.findings.join("\n")).toMatch(/succession chain.*max depth/);
  });
});
