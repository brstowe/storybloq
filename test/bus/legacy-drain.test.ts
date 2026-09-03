import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import { canonicalHash, hashWithoutKey } from "../../src/bus/canonical.js";
import {
  acknowledgeBusMessage,
  busDoctor,
  busSummary,
  classifyBusRuntime,
  evaluateV1Drain,
  exportBusThread,
  foldV1Thread,
  initializeBus,
  listV1Endpoints,
  pollV1,
  sendBusMessage,
  updateV1Thread,
  v1MailboxPointers,
  v1PathsFrom,
} from "../../src/bus/index.js";
import { resolveBusPaths } from "../../src/bus/paths.js";

// D5 legacy-drain surface: a v1-instance runtime is frozen for new traffic but
// stays drainable (poll/ack/park-resolve/export/status/doctor) so the migration
// drain gate can clear without a 1.7.0 binary. This exercises the happy path;
// crash-window and lock-race coverage is owned by the test-coverage agent.

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sign<T extends Record<string, unknown>>(unsigned: T, key: keyof T): T {
  return { ...unsigned, [key]: hashWithoutKey(unsigned, key) };
}

interface V1Fixture {
  readonly root: string;
  readonly endpointId: string;
  readonly taskId: string;
  readonly threadId: string;
  readonly messageId: string;
}

// Hand-builds a single-endpoint v1 runtime with one unacknowledged noncritical
// message, matching the 1.7.0 record shapes read by legacy-v1.ts.
async function createV1Runtime(name = "bus-v1-drain"): Promise<V1Fixture> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  roots.push(root);
  await initProject(root, { name });
  const canonical = await realpath(root);

  // Enable the Bus feature so assertBusEnabled passes on the drain surface.
  const configPath = join(root, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.features = { ...(config.features ?? {}), bus: true };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await writeFile(join(root, ".story", ".gitignore"), "bus/\nbus-migration/\n", "utf-8");

  const busRoot = join(root, ".story", "bus");
  for (const dir of [
    "threads", "endpoints", "succession", "locks",
    "mailboxes/implementer", "mailboxes/implementer/pending",
    "mailboxes/reviewer", "mailboxes/reviewer/pending",
  ]) {
    await mkdir(join(busRoot, dir), { recursive: true, mode: 0o700 });
  }

  const now = new Date().toISOString();
  await writeFile(join(busRoot, "instance.json"), JSON.stringify({
    schema: "storybloq-bus-instance/v1",
    instanceId: randomUUID(),
    projectRootHash: canonicalHash(canonical),
    createdAt: now,
  }, null, 2) + "\n", "utf-8");

  const endpointId = randomUUID();
  const taskId = "codex-task-drain";
  await writeFile(join(busRoot, "endpoints", `${endpointId}.json`), JSON.stringify({
    schema: "storybloq-bus-endpoint/v1",
    endpointId,
    role: "implementer",
    client: "codex",
    surface: "codex_desktop",
    clientTaskId: taskId,
    processRef: null,
    state: "unknown",
    joinedAt: now,
    lastSeenAt: now,
    wakePolicy: "never",
    lastPolledMailboxSeq: 0,
    lastBlockedMailboxSeq: 0,
    retiredAt: null,
    retiredReason: null,
  }, null, 2) + "\n", "utf-8");

  const threadId = randomUUID();
  const messageId = randomUUID();
  const thread = sign({
    schema: "storybloq-bus-thread/v1",
    threadId,
    kind: "question",
    topicRef: { ticket: "T-001" },
    participantRoles: ["reviewer", "implementer"],
    maxHops: 6,
    createdAt: now,
    threadHash: "0".repeat(64),
  }, "threadHash");

  const message = {
    messageId,
    from: { endpointId: randomUUID(), role: "reviewer", client: "claude" },
    toRole: "implementer",
    kind: "question",
    severity: "info",
    body: "drain me",
  };
  const entry = sign({
    schema: "storybloq-bus-entry/v1",
    entryId: randomUUID(),
    threadId,
    seq: 1,
    type: "message",
    prevHash: thread.threadHash,
    payload: message,
    createdAt: now,
    entryHash: "0".repeat(64),
  }, "entryHash");

  const threadDir = join(busRoot, "threads", threadId);
  await mkdir(join(threadDir, "entries"), { recursive: true, mode: 0o700 });
  await writeFile(join(threadDir, "thread.json"), JSON.stringify(thread, null, 2) + "\n", "utf-8");
  await writeFile(join(threadDir, "entries", `000001-message-${entry.entryId}.json`), JSON.stringify(entry, null, 2) + "\n", "utf-8");

  await writeFile(join(busRoot, "mailboxes", "implementer", `000000000001-${messageId}.json`), JSON.stringify({
    schema: "storybloq-bus-mailbox/v1",
    role: "implementer",
    mailboxSeq: 1,
    messageId,
    threadId,
    entrySeq: 1,
    entryHash: entry.entryHash,
  }, null, 2) + "\n", "utf-8");

  return { root, endpointId, taskId, threadId, messageId };
}

describe("Storybloq Bus v1 legacy-drain surface (D5)", () => {
  it("classifies a v1 runtime and refuses new traffic while staying drainable", async () => {
    const fx = await createV1Runtime();
    expect(await classifyBusRuntime(fx.root)).toBe("v1");

    // New coordination state is refused with upgrade_required.
    await expect(sendBusMessage(fx.root, {
      endpointId: fx.endpointId,
      clientTaskId: fx.taskId,
      threadKind: "question",
      messageKind: "question",
      severity: "info",
      body: "should not send",
      idempotencyKey: "k-1",
      refs: { ticket: "T-001" },
    })).rejects.toMatchObject({ code: "upgrade_required" });

    // Reopen is not part of the drain surface.
    await expect(updateV1Thread(fx.root, {
      endpointId: fx.endpointId,
      clientTaskId: fx.taskId,
      threadId: fx.threadId,
      action: "reopen",
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("polls, blocks migration on unread mail, then acks so migration succeeds", async () => {
    const fx = await createV1Runtime();

    // Poll surfaces the pending v1 message with its derived-role sender.
    const polled = await pollV1(fx.root, { endpointId: fx.endpointId, clientTaskId: fx.taskId });
    expect(polled.messages).toHaveLength(1);
    expect(polled.messages[0]).toMatchObject({
      sender: { role: "reviewer" },
      message: { messageId: fx.messageId, kind: "question", severity: "info", body: "drain me" },
    });

    // Ownership: a foreign task cannot poll this endpoint.
    await expect(pollV1(fx.root, { endpointId: fx.endpointId, clientTaskId: "codex-task-other" }))
      .rejects.toMatchObject({ code: "unauthorized" });

    // Unread noncritical mail blocks the migration drain gate.
    await expect(initializeBus(fx.root, { callerTaskId: fx.taskId }))
      .rejects.toMatchObject({ code: "conflict" });

    // Ack routes through the store to legacy-v1 and clears the mailbox pointer.
    const ack = await acknowledgeBusMessage(fx.root, {
      endpointId: fx.endpointId,
      clientTaskId: fx.taskId,
      messageId: fx.messageId,
      disposition: "accepted",
    });
    expect(ack).toMatchObject({ threadId: fx.threadId, replayed: false });
    const reacked = await acknowledgeBusMessage(fx.root, {
      endpointId: fx.endpointId,
      clientTaskId: fx.taskId,
      messageId: fx.messageId,
      disposition: "accepted",
    });
    expect(reacked.replayed).toBe(true);

    const drained = await pollV1(fx.root, { endpointId: fx.endpointId, clientTaskId: fx.taskId });
    expect(drained.messages).toHaveLength(0);

    // With nothing pending, migration drains, archives, and re-inits to v2.
    const migrated = await initializeBus(fx.root, { callerTaskId: fx.taskId });
    expect(migrated.migrated).toBe(true);
    expect(await classifyBusRuntime(fx.root)).toBe("v2");

    // Post-migration reads are v2; the archived v1 thread still exports.
    const summary = await busSummary(fx.root);
    expect(summary.initialized).toBe(true);
    const archived = await exportBusThread(fx.root, fx.threadId, "md");
    expect(archived).toContain("legacy v1");
    expect(archived).toContain("drain me");
  });

  it("promotes a deferred ack to a terminal disposition, then replays it idempotently", async () => {
    const fx = await createV1Runtime();
    const v1 = v1PathsFrom((await resolveBusPaths(fx.root, false)).busRoot);

    // (1) A deferred ack is a fresh, non-replay entry: no prior disposition exists.
    const deferred = await acknowledgeBusMessage(fx.root, {
      endpointId: fx.endpointId,
      clientTaskId: fx.taskId,
      messageId: fx.messageId,
      disposition: "deferred",
      reason: "waiting on CI",
    });
    expect(deferred).toMatchObject({ threadId: fx.threadId, replayed: false });
    expect((await foldV1Thread(v1, fx.threadId)).acknowledgments.get(fx.messageId)).toMatchObject({
      disposition: "deferred",
      reason: "waiting on CI",
    });

    // (1a) A byte-identical replay (same disposition AND reason) is an idempotent no-op:
    // replayed:true and no new thread entry is appended.
    const entriesDir = join(v1.threads, fx.threadId, "entries");
    const entryCountAfterDeferred = (await readdir(entriesDir)).length;
    const replayDeferred = await acknowledgeBusMessage(fx.root, {
      endpointId: fx.endpointId,
      clientTaskId: fx.taskId,
      messageId: fx.messageId,
      disposition: "deferred",
      reason: "waiting on CI",
    });
    expect(replayDeferred.replayed).toBe(true);
    expect((await readdir(entriesDir)).length).toBe(entryCountAfterDeferred);

    // (1b) A deferred ack with a DIFFERENT reason (same disposition) is neither a replay
    // nor a permitted transition: it is refused as invalid_input, and neither the stored
    // ack nor the thread entry count changes (no poison entry is written).
    await expect(acknowledgeBusMessage(fx.root, {
      endpointId: fx.endpointId,
      clientTaskId: fx.taskId,
      messageId: fx.messageId,
      disposition: "deferred",
      reason: "waiting on a different CI",
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await readdir(entriesDir)).length).toBe(entryCountAfterDeferred);
    expect((await foldV1Thread(v1, fx.threadId)).acknowledgments.get(fx.messageId)).toMatchObject({
      disposition: "deferred",
      reason: "waiting on CI",
    });

    // (2) Promoting that deferred ack to accepted appends a NEW entry (not a replay);
    // the fold now exposes the promoted terminal disposition.
    const promoted = await acknowledgeBusMessage(fx.root, {
      endpointId: fx.endpointId,
      clientTaskId: fx.taskId,
      messageId: fx.messageId,
      disposition: "accepted",
    });
    expect(promoted.replayed).toBe(false);
    expect((await foldV1Thread(v1, fx.threadId)).acknowledgments.get(fx.messageId)?.disposition).toBe("accepted");

    // (3) Re-acking with the SAME terminal disposition is an idempotent replay.
    const replay = await acknowledgeBusMessage(fx.root, {
      endpointId: fx.endpointId,
      clientTaskId: fx.taskId,
      messageId: fx.messageId,
      disposition: "accepted",
    });
    expect(replay.replayed).toBe(true);

    // Control: once terminal (accepted), a DIFFERENT disposition is not a promotion
    // and is refused as invalid_input rather than written as a poison entry. A reason
    // is supplied so this fails on the transition rule, not the missing-reason rule.
    await expect(acknowledgeBusMessage(fx.root, {
      endpointId: fx.endpointId,
      clientTaskId: fx.taskId,
      messageId: fx.messageId,
      disposition: "rejected",
      reason: "changed my mind",
    })).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("Cannot change the disposition of an existing acknowledgment"),
    });
  });

  it("serves v1 status and doctor content without migrating", async () => {
    const fx = await createV1Runtime();

    const summary = await busSummary(fx.root);
    expect(summary).toMatchObject({
      setupState: "waiting_for_peer",
      deliveryMode: "poll",
      pendingMessages: 1,
      nextActions: ["run: storybloq bus setup"],
    });

    const doctor = await busDoctor(fx.root);
    expect(doctor.healthy).toBe(false);
    expect(doctor.findings.some((finding) => finding.includes("v1 Bus runtime detected"))).toBe(true);

    // Reading status/doctor never migrates the runtime.
    expect(await classifyBusRuntime(fx.root)).toBe("v1");
  });

  it("fails closed when a v1 mailbox pointer references a missing thread entry", async () => {
    const fx = await createV1Runtime();
    const busPaths = await resolveBusPaths(fx.root, false);
    const v1 = v1PathsFrom(busPaths.busRoot);

    // A pointer whose envelope agrees with its filename but references an entry seq
    // that does not exist in the thread must be a drain-blocking finding, not be
    // silently accepted as absent.
    const missingMessageId = randomUUID();
    await writeFile(
      join(busPaths.busRoot, "mailboxes", "implementer", `000000000009-${missingMessageId}.json`),
      JSON.stringify({
        schema: "storybloq-bus-mailbox/v1",
        role: "implementer",
        mailboxSeq: 9,
        messageId: missingMessageId,
        threadId: fx.threadId,
        entrySeq: 9,
        entryHash: "a".repeat(64),
      }, null, 2) + "\n",
      "utf-8",
    );

    const scan = await v1MailboxPointers(v1, "implementer");
    expect(scan.findings.join("\n")).toContain("references an unavailable or unreadable thread entry");
    // The valid seq-1 pointer still resolves; only the dangling pointer is a finding.
    expect(scan.pointers.map((pointer) => pointer.messageId)).toEqual([fx.messageId]);
  });

  it("parks a v1 thread through the drain surface", async () => {
    const fx = await createV1Runtime();
    const view = await updateV1Thread(fx.root, {
      endpointId: fx.endpointId,
      clientTaskId: fx.taskId,
      threadId: fx.threadId,
      action: "park",
      reason: "draining before upgrade",
    });
    expect(view).toMatchObject({ legacy: "v1_drain", state: "parked" });
    const exported = await exportBusThread(fx.root, fx.threadId, "json");
    expect(JSON.parse(exported).state).toBe("parked");
  });
});

// #12: v1 fold actor authorization. A canonically valid (hash-correct) but
// UNAUTHORIZED ack/state entry must quarantine exactly the thread that relied on
// it, so the migration drain gate treats it as a ship blocker. The endpoint ->
// role map is built from valid endpoints only; per-thread quarantine is what
// blocks migration, distinct from endpoint-registry corruption (a separate gate).

interface V1AuthzFixture {
  readonly root: string;
  readonly callerTaskId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly implEndpointId: string;
  readonly revEndpointId: string;
}

type InjectedEntry = { readonly type: "ack" | "state"; readonly payload: Record<string, unknown> } | null;

// Builds a clean v1 runtime with a reviewer -> implementer question thread and a
// registered endpoint per role. The reviewer endpoint is retired so it does not
// demand an offline proof at migration but is still kept in the fold's role map
// (authorization is by role identity, not liveness). `injected` returns the seq-2
// entry to append after the message; the builder signs and chains it so it is
// hash-valid but possibly unauthorized. The message's sender endpointId is a fresh
// UUID (not the registered reviewer) so a reviewer-role ack isolates the wrong-role
// check from the sender-cannot-ack-own-message check.
async function buildV1Authz(injected: (ctx: { messageId: string; implEndpointId: string; revEndpointId: string }) => InjectedEntry): Promise<V1AuthzFixture> {
  const root = await mkdtemp(join(tmpdir(), "bus-v1-authz-"));
  roots.push(root);
  await initProject(root, { name: "bus-v1-authz" });
  const canonical = await realpath(root);

  const configPath = join(root, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.features = { ...(config.features ?? {}), bus: true };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await writeFile(join(root, ".story", ".gitignore"), "bus/\nbus-migration/\n", "utf-8");

  const busRoot = join(root, ".story", "bus");
  for (const dir of [
    "threads", "endpoints", "succession", "locks",
    "mailboxes/implementer", "mailboxes/implementer/pending",
    "mailboxes/reviewer", "mailboxes/reviewer/pending",
  ]) {
    await mkdir(join(busRoot, dir), { recursive: true, mode: 0o700 });
  }

  const now = new Date().toISOString();
  await writeFile(join(busRoot, "instance.json"), JSON.stringify({
    schema: "storybloq-bus-instance/v1",
    instanceId: randomUUID(),
    projectRootHash: canonicalHash(canonical),
    createdAt: now,
  }, null, 2) + "\n", "utf-8");

  const callerTaskId = "codex-task-drain";
  const implEndpointId = randomUUID();
  const revEndpointId = randomUUID();
  const endpointRecord = (endpointId: string, role: "implementer" | "reviewer", taskId: string, retiredAt: string | null) => ({
    schema: "storybloq-bus-endpoint/v1",
    endpointId,
    role,
    client: role === "implementer" ? "codex" : "claude",
    surface: role === "implementer" ? "codex_desktop" : "claude_cli",
    clientTaskId: taskId,
    processRef: null,
    state: "unknown",
    joinedAt: now,
    lastSeenAt: now,
    wakePolicy: "never",
    lastPolledMailboxSeq: 0,
    lastBlockedMailboxSeq: 0,
    retiredAt,
    retiredReason: retiredAt ? "left" : null,
  });
  await writeFile(join(busRoot, "endpoints", `${implEndpointId}.json`),
    JSON.stringify(endpointRecord(implEndpointId, "implementer", callerTaskId, null), null, 2) + "\n", "utf-8");
  await writeFile(join(busRoot, "endpoints", `${revEndpointId}.json`),
    JSON.stringify(endpointRecord(revEndpointId, "reviewer", "claude-task-peer", now), null, 2) + "\n", "utf-8");

  const threadId = randomUUID();
  const messageId = randomUUID();
  const thread = sign({
    schema: "storybloq-bus-thread/v1",
    threadId,
    kind: "question",
    topicRef: { ticket: "T-001" },
    participantRoles: ["reviewer", "implementer"],
    maxHops: 6,
    createdAt: now,
    threadHash: "0".repeat(64),
  }, "threadHash");
  const message = sign({
    schema: "storybloq-bus-entry/v1",
    entryId: randomUUID(),
    threadId,
    seq: 1,
    type: "message",
    prevHash: thread.threadHash,
    payload: {
      messageId,
      from: { endpointId: randomUUID(), role: "reviewer", client: "claude" },
      toRole: "implementer",
      kind: "question",
      severity: "info",
      body: "authz base message",
    },
    createdAt: now,
    entryHash: "0".repeat(64),
  }, "entryHash");

  const threadDir = join(busRoot, "threads", threadId);
  await mkdir(join(threadDir, "entries"), { recursive: true, mode: 0o700 });
  await writeFile(join(threadDir, "thread.json"), JSON.stringify(thread, null, 2) + "\n", "utf-8");
  await writeFile(join(threadDir, "entries", `000001-message-${message.entryId}.json`),
    JSON.stringify(message, null, 2) + "\n", "utf-8");

  const spec = injected({ messageId, implEndpointId, revEndpointId });
  if (spec) {
    const injectedEntry = sign({
      schema: "storybloq-bus-entry/v1",
      entryId: randomUUID(),
      threadId,
      seq: 2,
      type: spec.type,
      prevHash: message.entryHash,
      payload: spec.payload,
      createdAt: now,
      entryHash: "0".repeat(64),
    }, "entryHash");
    await writeFile(join(threadDir, "entries", `000002-${spec.type}-${injectedEntry.entryId}.json`),
      JSON.stringify(injectedEntry, null, 2) + "\n", "utf-8");
  }

  return { root, callerTaskId, threadId, messageId, implEndpointId, revEndpointId };
}

describe("Storybloq Bus v1 fold actor authorization (#12)", () => {
  const unauthorized: Array<{ name: string; inject: (ctx: { messageId: string; implEndpointId: string; revEndpointId: string }) => InjectedEntry }> = [
    {
      name: "an ack whose byEndpoint holds the wrong (non-recipient) role",
      inject: ({ messageId, revEndpointId }) => ({
        type: "ack",
        payload: { messageId, byEndpoint: revEndpointId, disposition: "accepted" },
      }),
    },
    {
      name: "an ack whose byEndpoint is an unknown UUID",
      inject: ({ messageId }) => ({
        type: "ack",
        payload: { messageId, byEndpoint: randomUUID(), disposition: "accepted" },
      }),
    },
    {
      name: "an ack referencing a messageId that does not exist in the thread",
      inject: ({ implEndpointId }) => ({
        type: "ack",
        payload: { messageId: randomUUID(), byEndpoint: implEndpointId, disposition: "accepted" },
      }),
    },
    {
      name: "a park state entry whose byEndpoint is a non-participant / unknown endpoint",
      inject: () => ({
        type: "state",
        payload: { action: "park", byEndpoint: randomUUID(), reason: "unauthorized park" },
      }),
    },
    {
      name: "an illegal transition (resolve without evidence) by an authorized participant",
      inject: ({ implEndpointId }) => ({
        type: "state",
        payload: { action: "resolve", byEndpoint: implEndpointId, resolution: "resolved without evidence" },
      }),
    },
  ];

  for (const { name, inject } of unauthorized) {
    it(`quarantines the thread and blocks migration for ${name}`, async () => {
      const fx = await buildV1Authz(inject);
      const v1 = v1PathsFrom((await resolveBusPaths(fx.root, false)).busRoot);

      // The thread folds quarantined even though the injected entry is hash-valid.
      const folded = await foldV1Thread(v1, fx.threadId);
      expect(folded.integrity).toBe("quarantined");

      // Doctor surfaces the per-thread quarantine (v1 doctor is never "healthy").
      const doctor = await busDoctor(fx.root);
      expect(doctor.healthy).toBe(false);
      expect(doctor.findings.some((finding) => finding.includes(fx.threadId) && finding.includes("quarantined"))).toBe(true);

      // The quarantined thread is a non-overridable drain ship-blocker, so
      // migration refuses (and never archives the v1 runtime).
      await expect(initializeBus(fx.root, { callerTaskId: fx.callerTaskId }))
        .rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("ship gate") });
      expect(await classifyBusRuntime(fx.root)).toBe("v1");
    });
  }

  const authorized: Array<{ name: string; inject: (ctx: { messageId: string; implEndpointId: string; revEndpointId: string }) => InjectedEntry }> = [
    {
      name: "an ack by the recipient-role endpoint",
      inject: ({ messageId, implEndpointId }) => ({
        type: "ack",
        payload: { messageId, byEndpoint: implEndpointId, disposition: "accepted" },
      }),
    },
    {
      name: "a park by a registered participant endpoint",
      inject: ({ revEndpointId }) => ({
        type: "state",
        payload: { action: "park", byEndpoint: revEndpointId, reason: "authorized park" },
      }),
    },
  ];

  for (const { name, inject } of authorized) {
    it(`still folds verified for ${name} (guards against over-quarantine)`, async () => {
      const fx = await buildV1Authz(inject);
      const v1 = v1PathsFrom((await resolveBusPaths(fx.root, false)).busRoot);

      const folded = await foldV1Thread(v1, fx.threadId);
      expect(folded.integrity).toBe("verified");

      // Doctor reports the runtime as v1 (unhealthy) but never as quarantined.
      const doctor = await busDoctor(fx.root);
      expect(doctor.findings.some((finding) => finding.includes("quarantined"))).toBe(false);

      // A verified thread does not block migration: it drains and upgrades to v2.
      const migrated = await initializeBus(fx.root, { callerTaskId: fx.callerTaskId });
      expect(migrated.migrated).toBe(true);
      expect(await classifyBusRuntime(fx.root)).toBe("v2");
    });
  }
});

// #R6-H: ambiguous/duplicate endpointId authorization. Two valid v1 endpoint
// records that share the SAME internal endpointId but declare CONFLICTING roles
// make that id ambiguous. The fold's endpointId -> role map removes an ambiguous
// id, so any ack/state actor referencing it is unauthorized and quarantines
// exactly the thread that relied on it, while unrelated threads stay verified.
// (`listV1Endpoints` does not dedupe or emit a scan finding for the duplicate; it
// returns both records, and the fold's map builder resolves the ambiguity.)

interface AmbiguousIdFixture {
  readonly root: string;
  readonly callerTaskId: string;
  readonly ackThreadId: string;
  readonly cleanThreadId: string;
  readonly ackActorId: string;
}

// Builds a v1 runtime with two threads, each acked by a distinct endpoint. The
// `ackThreadId` is acked by `ackActorId`; when `opts.ambiguous`, a second endpoint
// file (a DIFFERENT filename) records that same id with a CONFLICTING reviewer role
// so it drops out of the fold's role map. The `cleanThreadId` is acked by a separate
// unambiguous implementer endpoint. All non-caller endpoints are retired so the
// migration offline proof passes and the drain gate reaches the ship-gate check.
async function buildAmbiguousIdRuntime(opts: { ambiguous: boolean }): Promise<AmbiguousIdFixture> {
  const root = await mkdtemp(join(tmpdir(), "bus-v1-ambig-"));
  roots.push(root);
  await initProject(root, { name: "bus-v1-ambig" });
  const canonical = await realpath(root);

  const configPath = join(root, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.features = { ...(config.features ?? {}), bus: true };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await writeFile(join(root, ".story", ".gitignore"), "bus/\nbus-migration/\n", "utf-8");

  const busRoot = join(root, ".story", "bus");
  for (const dir of [
    "threads", "endpoints", "succession", "locks",
    "mailboxes/implementer", "mailboxes/implementer/pending",
    "mailboxes/reviewer", "mailboxes/reviewer/pending",
  ]) {
    await mkdir(join(busRoot, dir), { recursive: true, mode: 0o700 });
  }

  const now = new Date().toISOString();
  await writeFile(join(busRoot, "instance.json"), JSON.stringify({
    schema: "storybloq-bus-instance/v1",
    instanceId: randomUUID(),
    projectRootHash: canonicalHash(canonical),
    createdAt: now,
  }, null, 2) + "\n", "utf-8");

  const callerTaskId = "codex-task-drain";
  const endpointRecord = (endpointId: string, role: "implementer" | "reviewer", taskId: string, retiredAt: string | null) => ({
    schema: "storybloq-bus-endpoint/v1",
    endpointId,
    role,
    client: role === "implementer" ? "codex" : "claude",
    surface: role === "implementer" ? "codex_desktop" : "claude_cli",
    clientTaskId: taskId,
    processRef: null,
    state: "unknown",
    joinedAt: now,
    lastSeenAt: now,
    wakePolicy: "never",
    lastPolledMailboxSeq: 0,
    lastBlockedMailboxSeq: 0,
    retiredAt,
    retiredReason: retiredAt ? "left" : null,
  });

  // The ambiguous actor id: registered as implementer. When `ambiguous`, a SECOND
  // file (distinct filename) records the SAME endpointId with a conflicting role.
  const ackActorId = randomUUID();
  await writeFile(join(busRoot, "endpoints", `${ackActorId}.json`),
    JSON.stringify(endpointRecord(ackActorId, "implementer", "codex-task-ambig-a", now), null, 2) + "\n", "utf-8");
  if (opts.ambiguous) {
    await writeFile(join(busRoot, "endpoints", `${ackActorId}-conflict.json`),
      JSON.stringify(endpointRecord(ackActorId, "reviewer", "claude-task-ambig-b", now), null, 2) + "\n", "utf-8");
  }

  // A clean, unambiguous implementer endpoint owned by the caller task; it acks the
  // unrelated thread and, being caller-owned, is exempt from the offline proof.
  const cleanImplId = randomUUID();
  await writeFile(join(busRoot, "endpoints", `${cleanImplId}.json`),
    JSON.stringify(endpointRecord(cleanImplId, "implementer", callerTaskId, null), null, 2) + "\n", "utf-8");

  // A reviewer -> implementer question thread with an ack (seq 2) by `ackBy`.
  const buildThread = async (ackBy: string): Promise<string> => {
    const threadId = randomUUID();
    const messageId = randomUUID();
    const thread = sign({
      schema: "storybloq-bus-thread/v1",
      threadId,
      kind: "question",
      topicRef: { ticket: "T-001" },
      participantRoles: ["reviewer", "implementer"],
      maxHops: 6,
      createdAt: now,
      threadHash: "0".repeat(64),
    }, "threadHash");
    const message = sign({
      schema: "storybloq-bus-entry/v1",
      entryId: randomUUID(),
      threadId,
      seq: 1,
      type: "message",
      prevHash: thread.threadHash,
      payload: {
        messageId,
        // A fresh sender id (not the acking endpoint) isolates the ambiguity check
        // from the sender-cannot-ack-own-message check.
        from: { endpointId: randomUUID(), role: "reviewer", client: "claude" },
        toRole: "implementer",
        kind: "question",
        severity: "info",
        body: "ambiguous-id authz base message",
      },
      createdAt: now,
      entryHash: "0".repeat(64),
    }, "entryHash");
    const ack = sign({
      schema: "storybloq-bus-entry/v1",
      entryId: randomUUID(),
      threadId,
      seq: 2,
      type: "ack",
      prevHash: message.entryHash,
      payload: { messageId, byEndpoint: ackBy, disposition: "accepted" },
      createdAt: now,
      entryHash: "0".repeat(64),
    }, "entryHash");

    const threadDir = join(busRoot, "threads", threadId);
    await mkdir(join(threadDir, "entries"), { recursive: true, mode: 0o700 });
    await writeFile(join(threadDir, "thread.json"), JSON.stringify(thread, null, 2) + "\n", "utf-8");
    await writeFile(join(threadDir, "entries", `000001-message-${message.entryId}.json`),
      JSON.stringify(message, null, 2) + "\n", "utf-8");
    await writeFile(join(threadDir, "entries", `000002-ack-${ack.entryId}.json`),
      JSON.stringify(ack, null, 2) + "\n", "utf-8");
    return threadId;
  };

  const ackThreadId = await buildThread(ackActorId);
  const cleanThreadId = await buildThread(cleanImplId);

  return { root, callerTaskId, ackThreadId, cleanThreadId, ackActorId };
}

describe("Storybloq Bus v1 fold renamed/duplicate endpointId record (#R6-H, F1)", () => {
  it("reports a renamed conflicting endpoint record as a registry finding and refuses migration corrupt", async () => {
    const fx = await buildAmbiguousIdRuntime({ ambiguous: true });
    const v1 = v1PathsFrom((await resolveBusPaths(fx.root, false)).busRoot);

    // The `<id>-conflict.json` record fails the `<uuid>.json` filename requirement, so
    // listV1Endpoints excludes it and records a finding rather than silently returning a
    // second, conflicting registration for the same id. (Post-F1 there is no way to have
    // two VALID records share an id, so the fold's ambiguity path is unreachable; the
    // duplicate is caught earlier, at the registry scan.)
    const scan = await listV1Endpoints(v1);
    expect(scan.findings.some((finding) => finding.includes("not a regular <uuid>.json file"))).toBe(true);
    expect(scan.endpoints.some((endpoint) => endpoint.role === "reviewer")).toBe(false);

    // With the conflicting record excluded, the ack actor resolves to a single role, so
    // both threads fold verified at the tolerant read layer (the fold ignores registry
    // findings on OTHER records).
    expect((await foldV1Thread(v1, fx.ackThreadId)).integrity).toBe("verified");
    expect((await foldV1Thread(v1, fx.cleanThreadId)).integrity).toBe("verified");

    // Doctor surfaces the endpoint-registry finding and the runtime stays v1 (reads
    // never migrate).
    const doctor = await busDoctor(fx.root);
    expect(doctor.healthy).toBe(false);
    expect(doctor.findings.some((finding) => finding.includes("not a regular <uuid>.json file"))).toBe(true);
    expect(await classifyBusRuntime(fx.root)).toBe("v1");

    // The endpoint finding fails the migration drain gate closed; nothing is committed.
    await expect(initializeBus(fx.root, { callerTaskId: fx.callerTaskId }))
      .rejects.toMatchObject({ code: "corrupt" });
    expect(await classifyBusRuntime(fx.root)).toBe("v1");
  });

  it("still authorizes the same actor id when it is NOT duplicated (guards against over-quarantine)", async () => {
    const fx = await buildAmbiguousIdRuntime({ ambiguous: false });
    const v1 = v1PathsFrom((await resolveBusPaths(fx.root, false)).busRoot);

    // With a single, unambiguous registration the ack actor is authorized, so its
    // thread folds verified: the quarantine above is caused by the ambiguity alone.
    expect((await foldV1Thread(v1, fx.ackThreadId)).integrity).toBe("verified");
    expect((await foldV1Thread(v1, fx.cleanThreadId)).integrity).toBe("verified");
  });
});

describe("Storybloq Bus v1 fold thread-directory identity (F5)", () => {
  it("quarantines a hash-valid thread whose thread.json threadId differs from its directory name", async () => {
    const fx = await createV1Runtime();
    const v1 = v1PathsFrom((await resolveBusPaths(fx.root, false)).busRoot);

    // A hash-valid thread copied under a DIFFERENT UUID directory: thread.json's stored
    // threadId is a valid but different uuid than the directory it lives in. Its hash
    // verifies for the stored id, so without the directory-identity check it would fold
    // verified and pass the migration gate.
    const dirId = randomUUID();
    const otherId = randomUUID();
    const thread = sign({
      schema: "storybloq-bus-thread/v1",
      threadId: otherId,
      kind: "question",
      topicRef: { ticket: "T-001" },
      participantRoles: ["reviewer", "implementer"],
      maxHops: 6,
      createdAt: new Date().toISOString(),
      threadHash: "0".repeat(64),
    }, "threadHash");
    const threadDir = join(fx.root, ".story", "bus", "threads", dirId);
    await mkdir(join(threadDir, "entries"), { recursive: true, mode: 0o700 });
    await writeFile(join(threadDir, "thread.json"), JSON.stringify(thread, null, 2) + "\n", "utf-8");

    expect((await foldV1Thread(v1, dirId)).integrity).toBe("quarantined");
  });
});

// Round-11 H: a duplicate messageId within a single thread must quarantine the
// fold. Acknowledgement is tracked by messageId in a Set, so a single ack of a
// repeated id would mark BOTH messages acknowledged and could clear an earlier
// unacked critical message from the drain ship-gate; the fold fails closed instead.

interface TwoMessageFixture {
  readonly root: string;
  readonly callerTaskId: string;
  readonly threadId: string;
}

// Builds a v1 runtime whose single reviewer -> implementer thread carries TWO
// hash-valid, correctly chained message entries. When `duplicate`, both messages
// share the same messageId; otherwise they carry distinct ids. A caller-owned
// implementer endpoint plus a retired reviewer let migration reach the ship gate
// (the offline proof passes and no unread mail remains).
async function buildV1TwoMessages(opts: { duplicate: boolean }): Promise<TwoMessageFixture> {
  const root = await mkdtemp(join(tmpdir(), "bus-v1-dupmsg-"));
  roots.push(root);
  await initProject(root, { name: "bus-v1-dupmsg" });
  const canonical = await realpath(root);

  const configPath = join(root, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.features = { ...(config.features ?? {}), bus: true };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await writeFile(join(root, ".story", ".gitignore"), "bus/\nbus-migration/\n", "utf-8");

  const busRoot = join(root, ".story", "bus");
  for (const dir of [
    "threads", "endpoints", "succession", "locks",
    "mailboxes/implementer", "mailboxes/implementer/pending",
    "mailboxes/reviewer", "mailboxes/reviewer/pending",
  ]) {
    await mkdir(join(busRoot, dir), { recursive: true, mode: 0o700 });
  }

  const now = new Date().toISOString();
  await writeFile(join(busRoot, "instance.json"), JSON.stringify({
    schema: "storybloq-bus-instance/v1",
    instanceId: randomUUID(),
    projectRootHash: canonicalHash(canonical),
    createdAt: now,
  }, null, 2) + "\n", "utf-8");

  const callerTaskId = "codex-task-drain";
  const implEndpointId = randomUUID();
  const revEndpointId = randomUUID();
  const endpointRecord = (endpointId: string, role: "implementer" | "reviewer", taskId: string, retiredAt: string | null) => ({
    schema: "storybloq-bus-endpoint/v1",
    endpointId,
    role,
    client: role === "implementer" ? "codex" : "claude",
    surface: role === "implementer" ? "codex_desktop" : "claude_cli",
    clientTaskId: taskId,
    processRef: null,
    state: "unknown",
    joinedAt: now,
    lastSeenAt: now,
    wakePolicy: "never",
    lastPolledMailboxSeq: 0,
    lastBlockedMailboxSeq: 0,
    retiredAt,
    retiredReason: retiredAt ? "left" : null,
  });
  await writeFile(join(busRoot, "endpoints", `${implEndpointId}.json`),
    JSON.stringify(endpointRecord(implEndpointId, "implementer", callerTaskId, null), null, 2) + "\n", "utf-8");
  await writeFile(join(busRoot, "endpoints", `${revEndpointId}.json`),
    JSON.stringify(endpointRecord(revEndpointId, "reviewer", "claude-task-peer", now), null, 2) + "\n", "utf-8");

  const threadId = randomUUID();
  const firstMessageId = randomUUID();
  const secondMessageId = opts.duplicate ? firstMessageId : randomUUID();
  const thread = sign({
    schema: "storybloq-bus-thread/v1",
    threadId,
    kind: "question",
    topicRef: { ticket: "T-001" },
    participantRoles: ["reviewer", "implementer"],
    maxHops: 6,
    createdAt: now,
    threadHash: "0".repeat(64),
  }, "threadHash");
  const buildMessage = (seq: number, messageId: string, prevHash: string, body: string) => sign({
    schema: "storybloq-bus-entry/v1",
    entryId: randomUUID(),
    threadId,
    seq,
    type: "message",
    prevHash,
    payload: {
      messageId,
      // A fresh sender id keeps the messages well-formed and self-consistent.
      from: { endpointId: randomUUID(), role: "reviewer", client: "claude" },
      toRole: "implementer",
      kind: "question",
      severity: "info",
      body,
    },
    createdAt: now,
    entryHash: "0".repeat(64),
  }, "entryHash");
  const message1 = buildMessage(1, firstMessageId, thread.threadHash, "first message");
  const message2 = buildMessage(2, secondMessageId, message1.entryHash, "second message");

  const threadDir = join(busRoot, "threads", threadId);
  await mkdir(join(threadDir, "entries"), { recursive: true, mode: 0o700 });
  await writeFile(join(threadDir, "thread.json"), JSON.stringify(thread, null, 2) + "\n", "utf-8");
  await writeFile(join(threadDir, "entries", `000001-message-${message1.entryId}.json`),
    JSON.stringify(message1, null, 2) + "\n", "utf-8");
  await writeFile(join(threadDir, "entries", `000002-message-${message2.entryId}.json`),
    JSON.stringify(message2, null, 2) + "\n", "utf-8");

  return { root, callerTaskId, threadId };
}

describe("Storybloq Bus v1 fold duplicate messageId (round-11 H)", () => {
  it("quarantines a thread whose two message entries share the same messageId", async () => {
    const fx = await buildV1TwoMessages({ duplicate: true });
    const v1 = v1PathsFrom((await resolveBusPaths(fx.root, false)).busRoot);

    // Both message entries are hash-valid and correctly chained, yet the repeated
    // messageId quarantines the fold.
    expect((await foldV1Thread(v1, fx.threadId)).integrity).toBe("quarantined");

    // The quarantined thread is a non-overridable ship blocker, so migration refuses
    // and never archives the v1 runtime.
    await expect(initializeBus(fx.root, { callerTaskId: fx.callerTaskId }))
      .rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("ship gate") });
    expect(await classifyBusRuntime(fx.root)).toBe("v1");
  });

  it("folds verified when the same two-message thread carries DISTINCT messageIds (guards against over-quarantine)", async () => {
    const fx = await buildV1TwoMessages({ duplicate: false });
    const v1 = v1PathsFrom((await resolveBusPaths(fx.root, false)).busRoot);

    // Distinct ids isolate the duplicate as the sole cause of the quarantine above.
    expect((await foldV1Thread(v1, fx.threadId)).integrity).toBe("verified");

    // A verified thread with no unread mail drains and upgrades to v2.
    const migrated = await initializeBus(fx.root, { callerTaskId: fx.callerTaskId });
    expect(migrated.migrated).toBe(true);
    expect(await classifyBusRuntime(fx.root)).toBe("v2");
  });
});

describe("Storybloq Bus v1 fold hardening against hidden/symlinked thread entries (F3)", () => {
  const entriesDirOf = (fx: V1Fixture) => join(fx.root, ".story", "bus", "threads", fx.threadId, "entries");
  const foldIntegrity = async (fx: V1Fixture) =>
    (await foldV1Thread(v1PathsFrom(join(fx.root, ".story", "bus")), fx.threadId)).integrity;

  it("folds a clean v1 thread as verified (guards against over-quarantine)", async () => {
    const fx = await createV1Runtime();
    expect(await foldIntegrity(fx)).toBe("verified");
  });

  it("quarantines the fold when a dot-prefixed entry hides at the chain tail", async () => {
    const fx = await createV1Runtime();
    // listRegularJsonFiles would keep a `.json`-suffixed hidden file but the fold's
    // ENTRY_FILENAME contiguity check would reject it only if it created a seq gap; a
    // TAIL hidden file created no gap and was invisible before the hardened lister.
    await writeFile(join(entriesDirOf(fx), `.000099-message-${randomUUID()}.json`), "{}", "utf-8");
    expect(await foldIntegrity(fx)).toBe("quarantined");
  });

  it("quarantines the fold when a non-.json entry sits in the entries dir", async () => {
    const fx = await createV1Runtime();
    await writeFile(join(entriesDirOf(fx), "stray.txt"), "not an entry", "utf-8");
    expect(await foldIntegrity(fx)).toBe("quarantined");
  });

  it("quarantines the fold when a symlinked entry masquerades as a log record", async () => {
    const fx = await createV1Runtime();
    // A symlink named like a valid entry: listRegularJsonFiles drops it silently; the
    // hardened lister flags it. Placed at the tail so it creates no contiguity gap.
    await symlink(
      join(fx.root, ".story", "config.json"),
      join(entriesDirOf(fx), `000099-message-${randomUUID()}.json`),
    );
    expect(await foldIntegrity(fx)).toBe("quarantined");
  });

  it("quarantines a thread whose entries dir is entirely empty (empty-thread guard)", async () => {
    const fx = await createV1Runtime();
    const entriesDir = entriesDirOf(fx);
    for (const name of await readdir(entriesDir)) await rm(join(entriesDir, name));
    expect(await foldIntegrity(fx)).toBe("quarantined");
  });

  it("blocks migration when a hidden tail entry taints an otherwise-drainable v1 thread", async () => {
    const fx = await buildV1TwoMessages({ duplicate: false });
    const entriesDir = join(fx.root, ".story", "bus", "threads", fx.threadId, "entries");
    // Without the hardened lister this hidden tail entry is dropped, the fold reads
    // verified, and migration proceeds -- silently archiving an inspected-as-empty thread.
    await writeFile(join(entriesDir, `.000099-message-${randomUUID()}.json`), "{}", "utf-8");

    const v1 = v1PathsFrom((await resolveBusPaths(fx.root, false)).busRoot);
    expect((await foldV1Thread(v1, fx.threadId)).integrity).toBe("quarantined");

    // A quarantined thread is a non-overridable ship blocker: migration refuses and the
    // runtime stays v1 (contrast the clean two-message thread, which migrates to v2).
    await expect(initializeBus(fx.root, { callerTaskId: fx.callerTaskId }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await classifyBusRuntime(fx.root)).toBe("v1");
  });

  it("does NOT quarantine when a concurrent durable-write temp sits in the entries dir (temp tolerance)", async () => {
    // foldV1Thread runs LOCK-FREE from poll/export/status/doctor, concurrently with an
    // ack/update `durableCreate` that stages `<target>.tmp.<pid>.<uuid>` before its rename.
    // A regular temp file (never dot-prefixed, never ending in `.json`) must be tolerated
    // so a healthy thread does not spuriously quarantine mid-write. The temp is never
    // folded, so it can neither inject nor hide committed content: the contiguity + chain
    // checks still enforce that, keeping the tamper gap closed.
    const fx = await createV1Runtime();
    const temp = `000099-message-${randomUUID()}.json.tmp.${process.pid}.${randomUUID()}`;
    await writeFile(join(entriesDirOf(fx), temp), "{ partial durable write in progress", "utf-8");
    expect(await foldIntegrity(fx)).toBe("verified");
  });

  it("STILL quarantines when a symlink wears the durable-temp suffix (symlink is not a real write)", async () => {
    // Temp tolerance is scoped to REGULAR non-symlink files. A symlink whose name matches
    // the temp suffix is not a real in-progress durable write, so it must NOT be tolerated;
    // otherwise a symlink named `<x>.tmp.<pid>.<uuid>` would smuggle past the fold.
    const fx = await createV1Runtime();
    const temp = `000099-message-${randomUUID()}.json.tmp.${process.pid}.${randomUUID()}`;
    await symlink(join(fx.root, ".story", "config.json"), join(entriesDirOf(fx), temp));
    expect(await foldIntegrity(fx)).toBe("quarantined");
  });

  it("blocks migration when a committed tail entry is renamed to a durable-temp-shaped name (strict drain fold)", async () => {
    // The migration drain fold must be STRICT about temps. A committed TAIL entry renamed to
    // a durable-temp-shaped regular filename is dropped by the tolerant lock-free fold with
    // no seq gap, so a truncated history reads as verified. If the drain gate used that
    // tolerant fold it would archive the truncated tree; the strict drain fold quarantines it.
    const fx = await buildV1TwoMessages({ duplicate: false });
    const entriesDir = join(fx.root, ".story", "bus", "threads", fx.threadId, "entries");
    const messageFiles = (await readdir(entriesDir)).filter((name) => /^\d{6}-message-.*\.json$/.test(name)).sort();
    const tail = messageFiles.at(-1)!; // the seq-2 committed message entry
    await rename(join(entriesDir, tail), join(entriesDir, `${tail}.tmp.${process.pid}.${randomUUID()}`));

    const v1 = v1PathsFrom((await resolveBusPaths(fx.root, false)).busRoot);
    // The migration drain fold is STRICT: the temp-renamed tail is a finding -> quarantine.
    expect((await foldV1Thread(v1, fx.threadId, { strictTemps: true })).integrity).toBe("quarantined");
    // Lock-free live reads STAY tolerant (the temp could be a real in-progress durable write),
    // so the default fold reads the truncated-but-verified prefix. Only the archival gate is strict.
    expect((await foldV1Thread(v1, fx.threadId)).integrity).toBe("verified");

    // A quarantined thread is a non-overridable ship blocker: migration refuses and stays v1,
    // so the truncated history is never archived (contrast the clean two-message thread).
    await expect(initializeBus(fx.root, { callerTaskId: fx.callerTaskId }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await classifyBusRuntime(fx.root)).toBe("v1");
  });

  it("evaluateV1Drain is tolerant by default (lock-free callers) and strict only on request (migration)", async () => {
    // evaluateV1Drain is shared: the lock-free `bus setup` preflight and `bus check --ship`
    // call it with the default (tolerant), while the authoritative migration drain
    // (migrateV1Runtime under withV1Locks) passes strictTemps. This pins that split so a
    // temp cannot spuriously quarantine the lock-free callers nor slip past the strict gate.
    const fx = await buildV1TwoMessages({ duplicate: false });
    const entriesDir = join(fx.root, ".story", "bus", "threads", fx.threadId, "entries");
    const tail = (await readdir(entriesDir)).filter((name) => /^\d{6}-message-.*\.json$/.test(name)).sort().at(-1)!;
    await rename(join(entriesDir, tail), join(entriesDir, `${tail}.tmp.${process.pid}.${randomUUID()}`));
    const v1 = v1PathsFrom((await resolveBusPaths(fx.root, false)).busRoot);

    // Default (tolerant): the temp-shaped tail is ignored, the verified prefix carries no
    // ship blocker, so the lock-free drain gate stays clear.
    expect((await evaluateV1Drain(v1)).shipBlockers).toEqual([]);
    // Strict (migration under locks): the temp is a finding -> quarantine -> ship blocker.
    const strict = await evaluateV1Drain(v1, { strictTemps: true });
    expect(strict.shipBlockers.some((blocker) => blocker.includes("quarantined") && blocker.includes(fx.threadId))).toBe(true);
  });
});
