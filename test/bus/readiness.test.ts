import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import { canonicalHash, hashWithoutKey } from "../../src/bus/canonical.js";
import {
  busDoctor,
  busSummary,
  initializeBus,
  joinEndpoint,
  leaveEndpoint,
  sendBusMessage,
  setBusHookPolicy,
} from "../../src/bus/index.js";
import { createBusFixture, type BusFixture } from "./helpers.js";
import { containsUuid, runBusCli } from "./cli-harness.js";

function sign<T extends Record<string, unknown>>(unsigned: T, key: keyof T): T {
  return { ...unsigned, [key]: hashWithoutKey(unsigned, key) };
}

// Hand-builds a v1 runtime with one valid registered endpoint and one message
// thread, plus (a) a malformed endpoint record whose filename carries a UUID and
// (b) a dangling mailbox pointer that references a missing entry. Doctor then
// surfaces an `endpoint:`-prefixed finding (its UUID must be redacted in Markdown)
// alongside a mailbox-pointer finding naming a message UUID (must stay verbatim).
async function createV1DoctorRuntime(): Promise<{ root: string; extraEndpointUuid: string; danglingMessageId: string; threadId: string }> {
  const root = await mkdtemp(join(tmpdir(), "bus-v1-doctor-"));
  roots.push(root);
  await initProject(root, { name: "bus-v1-doctor" });
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

  const endpointId = randomUUID();
  await writeFile(join(busRoot, "endpoints", `${endpointId}.json`), JSON.stringify({
    schema: "storybloq-bus-endpoint/v1",
    endpointId,
    role: "implementer",
    client: "codex",
    surface: "codex_desktop",
    clientTaskId: "codex-task-drain",
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

  // A malformed endpoint record named with a UUID: doctor reports it as an
  // `endpoint:`-prefixed finding, so its UUID enters the redaction set.
  const extraEndpointUuid = randomUUID();
  await writeFile(join(busRoot, "endpoints", `${extraEndpointUuid}.json`), "{ not valid endpoint json", "utf-8");

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
  const entry = sign({
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
      body: "doctor redaction body",
    },
    createdAt: now,
    entryHash: "0".repeat(64),
  }, "entryHash");
  const threadDir = join(busRoot, "threads", threadId);
  await mkdir(join(threadDir, "entries"), { recursive: true, mode: 0o700 });
  await writeFile(join(threadDir, "thread.json"), JSON.stringify(thread, null, 2) + "\n", "utf-8");
  await writeFile(join(threadDir, "entries", `000001-message-${entry.entryId}.json`), JSON.stringify(entry, null, 2) + "\n", "utf-8");

  // A dangling pointer that references a nonexistent entry seq: its filename
  // carries a message UUID that doctor names in a NON-`endpoint:` finding, so it
  // must survive redaction verbatim.
  const danglingMessageId = randomUUID();
  await writeFile(join(busRoot, "mailboxes", "implementer", `000000000009-${danglingMessageId}.json`), JSON.stringify({
    schema: "storybloq-bus-mailbox/v1",
    role: "implementer",
    mailboxSeq: 9,
    messageId: danglingMessageId,
    threadId,
    entrySeq: 9,
    entryHash: "a".repeat(64),
  }, null, 2) + "\n", "utf-8");

  return { root, extraEndpointUuid, danglingMessageId, threadId };
}

// D7 readiness: setupState, deliveryMode, participants, nextActions. Markdown is
// action-oriented with no endpoint UUIDs; doctor separates integrity from
// readiness and reports retired-endpoint pointers + orphaned receipts.

const fixtures: BusFixture[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...fixtures.splice(0).map((fixture) => rm(fixture.root, { recursive: true, force: true })),
    ...roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ]);
});

async function fx(): Promise<BusFixture> {
  const value = await createBusFixture("bus-readiness");
  fixtures.push(value);
  return value;
}

async function project(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  roots.push(root);
  await initProject(root, { name });
  return root;
}

// Clones an existing endpoint record into a fresh active endpoint plus its mailbox,
// bypassing the two-endpoint join guard, to build an invariant-violating (>2
// active) runtime that assertBusLayout still accepts.
async function forgeExtraEndpoint(root: string, templateEndpointId: string): Promise<string> {
  const busRoot = join(root, ".story", "bus");
  const template = JSON.parse(await readFile(join(busRoot, "endpoints", `${templateEndpointId}.json`), "utf-8"));
  const endpointId = randomUUID();
  const record = { ...template, endpointId, clientTaskId: `forged-${endpointId}`, resumeHandle: `forged-${endpointId}` };
  await writeFile(join(busRoot, "endpoints", `${endpointId}.json`), JSON.stringify(record, null, 2) + "\n", "utf-8");
  await mkdir(join(busRoot, "mailboxes", endpointId, "pending"), { recursive: true, mode: 0o700 });
  return endpointId;
}

// Writes a THIRD endpoint file whose CONTENTS are malformed (so listEndpoints
// drops it and returns a registry finding) while its <uuid>.json filename is
// well-formed. The bus layout requires a mailbox directory for every <uuid>.json
// endpoint file, so an empty one is created to keep assertBusLayout / the doctor
// layout check passing; only the record contents are corrupt. Returns the UUID.
async function writeMalformedEndpoint(root: string): Promise<string> {
  const busRoot = join(root, ".story", "bus");
  const endpointId = randomUUID();
  await writeFile(join(busRoot, "endpoints", `${endpointId}.json`), "{ not valid endpoint json", "utf-8");
  await mkdir(join(busRoot, "mailboxes", endpointId, "pending"), { recursive: true, mode: 0o700 });
  return endpointId;
}

function reviewSend(value: BusFixture) {
  return sendBusMessage(value.root, {
    endpointId: value.reviewer.endpointId,
    clientTaskId: value.reviewerTaskId,
    threadKind: "question",
    messageKind: "question",
    severity: "medium",
    body: "Verify the readiness boundary",
    refs: { ciRun: "ci-ready" },
    idempotencyKey: "ready-question-1",
  });
}

describe("Storybloq Bus readiness (D7)", () => {
  it("reports setupState disabled for a project without the feature", async () => {
    const root = await project("bus-disabled");
    expect((await busSummary(root)).setupState).toBe("disabled");
  });

  it("reports a disabled project as neither enabled nor initialized", async () => {
    const root = await project("bus-disabled-shape");
    expect(await busSummary(root)).toMatchObject({
      enabled: false,
      initialized: false,
      setupState: "disabled",
    });
  });

  it("reports setupState not_initialized when enabled but no runtime exists", async () => {
    const value = await fx();
    await rm(join(value.root, ".story", "bus"), { recursive: true, force: true });
    // T-428: a genuinely fresh checkout (bus enabled in committed config, but never
    // set up here) has neither a runtime NOR deletion-evidence -- evidence is
    // gitignored, so a clone never receives it. Removing both models that L-031
    // fresh state. Deleting an EVIDENCED runtime is `runtime_lost` instead, which
    // deletion-evidence.test.ts covers.
    await rm(join(value.root, ".story", ".bus-evidence.json"), { force: true });
    expect((await busSummary(value.root)).setupState).toBe("not_initialized");
  });

  it("reports setupState disconnected for a runtime with zero endpoints", async () => {
    const root = await project("bus-disconnected");
    await initializeBus(root);
    const summary = await busSummary(root);
    expect(summary.setupState).toBe("disconnected");
    expect(summary.endpoints).toBe(0);
  });

  it("reports setupState waiting_for_peer for a single endpoint", async () => {
    const root = await project("bus-waiting");
    await initializeBus(root);
    await joinEndpoint(root, { client: "claude", clientTaskId: "claude-solo", surface: "claude_cli" });
    const summary = await busSummary(root);
    expect(summary.setupState).toBe("waiting_for_peer");
    expect(summary.nextActions).toContain("run: storybloq bus setup (in the peer task)");
  });

  it("reports setupState ready for two endpoints", async () => {
    const value = await fx();
    expect((await busSummary(value.root)).setupState).toBe("ready");
  });

  it("reports setupState invalid for a runtime with three or more active endpoints (R7)", async () => {
    const value = await fx();
    // Exactly two active endpoints is ready; a forged third violates the
    // two-endpoint invariant and must report invalid, never ready.
    expect((await busSummary(value.root)).setupState).toBe("ready");
    await forgeExtraEndpoint(value.root, value.implementer.endpointId);
    const summary = await busSummary(value.root);
    expect(summary.endpoints).toBe(3);
    expect(summary.setupState).toBe("invalid");
  });

  it("reports setupState invalid through doctor when the layout is broken", async () => {
    const value = await fx();
    await rm(join(value.root, ".story", "bus", "mailboxes", value.implementer.endpointId, "pending"), { recursive: true });
    const doctor = await busDoctor(value.root);
    expect(doctor.healthy).toBe(false);
    expect(doctor.summary.setupState).toBe("invalid");
  });

  it("reports setupState invalid when an active endpoint record is replaced by a symlink (F3)", async () => {
    const value = await fx();
    // Replace a live endpoint record with a SYMLINK. The prior layout scan skipped
    // non-`<uuid>.json` endpoint entries silently, so a symlinked/renamed active record
    // vanished from validation; busLayoutFindings now reports it and doctor is invalid.
    const record = join(value.root, ".story", "bus", "endpoints", `${value.implementer.endpointId}.json`);
    const decoy = join(value.root, ".story", "endpoint-decoy.json");
    await writeFile(decoy, "{}", "utf-8");
    await rm(record);
    await symlink(decoy, record);

    const doctor = await busDoctor(value.root);
    expect(doctor.healthy).toBe(false);
    expect(doctor.summary.setupState).toBe("invalid");
    expect(doctor.findings.some((finding) => finding.includes("not a regular <uuid>.json endpoint record"))).toBe(true);
  });

  it("derives deliveryMode poll, partial, and live from hook policy", async () => {
    const value = await fx();
    expect((await busSummary(value.root)).deliveryMode).toBe("poll");
    await setBusHookPolicy(value.root, ["codex"], true);
    expect((await busSummary(value.root)).deliveryMode).toBe("partial");
    await setBusHookPolicy(value.root, ["claude"], true);
    expect((await busSummary(value.root)).deliveryMode).toBe("live");
  });

  it("keeps endpoint UUIDs out of the status Markdown", async () => {
    const value = await fx();
    const { stdout } = await runBusCli(value.root, ["bus", "status", "--format", "md"]);
    expect(stdout).toContain("Bus: ready");
    expect(stdout).toContain("connected");
    expect(stdout).toContain("Claude Code");
    expect(stdout).toContain("Codex Desktop");
    // The action-oriented status names clients, never endpoint UUIDs.
    expect(containsUuid(stdout)).toBe(false);
  });

  it("separates integrity from readiness in the doctor Markdown", async () => {
    const value = await fx();
    const ready = await runBusCli(value.root, ["bus", "doctor", "--format", "md"]);
    expect(ready.stdout).toContain("Storage healthy; Bus ready.");
    expect(containsUuid(ready.stdout)).toBe(false);

    const waiting = await project("bus-doctor-waiting");
    await initializeBus(waiting);
    await joinEndpoint(waiting, { client: "claude", clientTaskId: "claude-solo", surface: "claude_cli" });
    const waitingDoctor = await runBusCli(waiting, ["bus", "doctor", "--format", "md"]);
    expect(waitingDoctor.stdout).toContain("Storage healthy; setup waiting for a peer.");
  });

  it("reports an undelivered thread to a retired recipient while the other participant is active", async () => {
    const value = await fx();
    await reviewSend(value); // unacked, addressed to implementer; reviewer stays active
    await leaveEndpoint(value.root, value.implementer.endpointId, value.implementerTaskId);
    const doctor = await busDoctor(value.root);
    expect(doctor.healthy).toBe(false);
    // The reviewer is still active and can resolve the thread, so it is recoverable,
    // never falsely reported as all-participants-retired stranded.
    expect(doctor.findings.join("\n")).toContain("to a retired recipient");
    expect(doctor.findings.join("\n")).not.toContain("stranded");
  });

  it("keeps endpoint UUIDs out of the doctor Markdown even on an endpoint-specific finding", async () => {
    const value = await fx();
    await reviewSend(value); // unacked pointer addressed to the implementer
    await leaveEndpoint(value.root, value.implementer.endpointId, value.implementerTaskId);

    // JSON retains the raw endpoint UUID for correlation.
    const doctor = await busDoctor(value.root);
    expect(doctor.healthy).toBe(false);
    expect(doctor.findings.join("\n")).toContain("to a retired recipient");
    expect(doctor.findings.join("\n")).toContain(value.implementer.endpointId);

    // The Markdown render redacts every raw UUID even when a finding names an
    // endpoint (D7): the endpoint-specific finding is present but no 8-4-4-4-12
    // UUID leaks.
    const { stdout } = await runBusCli(value.root, ["bus", "doctor", "--format", "md"]);
    expect(stdout).toContain("to a retired recipient");
    expect(containsUuid(stdout)).toBe(false);
    expect(stdout).not.toContain(value.implementer.endpointId);
  });

  it("reports an orphaned receipt whose thread is gone", async () => {
    const value = await fx();
    const sent = await reviewSend(value);
    await rm(join(value.root, ".story", "bus", "threads", sent.threadId), { recursive: true });
    const doctor = await busDoctor(value.root);
    expect(doctor.healthy).toBe(false);
    expect(doctor.findings.join("\n")).toContain("references missing thread");
  });

  it("reports a receipt renamed away from .json as a doctor finding (F4)", async () => {
    const value = await fx();
    await reviewSend(value); // writes idempotency/<reviewer>/<keyHash>.json
    const idemDir = join(value.root, ".story", "bus", "idempotency", value.reviewer.endpointId);
    const receipt = (await readdir(idemDir)).find((name) => name.endsWith(".json"));
    expect(receipt).toBeDefined();
    // Rename the receipt off `.json`. The prior scan required `.json`, so a renamed
    // receipt vanished from the integrity scan and a retry could republish a duplicate
    // silently. The enumerating scan now reports it as a finding.
    await rename(join(idemDir, receipt!), join(idemDir, `${receipt!.replace(/\.json$/, "")}.bak`));

    const doctor = await busDoctor(value.root);
    expect(doctor.healthy).toBe(false);
    expect(doctor.findings.some((finding) => finding.includes("not a regular <keyHash>.json file"))).toBe(true);
  });

  it("reports a NON-directory / symlink orphan mailbox entry as a doctor finding (F7)", async () => {
    const value = await fx();
    const mailboxes = join(value.root, ".story", "bus", "mailboxes");

    // A regular FILE named like an endpoint UUID with no backing endpoint record: the
    // prior orphan scan lumped `!isDirectory` into a silent `continue`, so a corrupt or
    // mail-redirecting entry stayed invisible and doctor reported healthy.
    const fileUuid = randomUUID();
    await writeFile(join(mailboxes, fileUuid), "not-a-mailbox-dir", "utf-8");
    const doctorFile = await busDoctor(value.root);
    expect(doctorFile.healthy).toBe(false);
    expect(doctorFile.findings.some((f) => f.startsWith("mailboxes:") && f.includes(fileUuid))).toBe(true);
    await rm(join(mailboxes, fileUuid));

    // A SYMLINK named like an endpoint UUID is equally unexpected and must be reported.
    const symUuid = randomUUID();
    await symlink(value.root, join(mailboxes, symUuid));
    const doctorSym = await busDoctor(value.root);
    expect(doctorSym.healthy).toBe(false);
    expect(doctorSym.findings.some((f) => f.startsWith("mailboxes:") && f.includes(symUuid))).toBe(true);

    // The raw UUID is still redacted in Markdown: doctorEndpointRedactionSet enumerates
    // mailboxes/ by name regardless of entry type.
    const { stdout } = await runBusCli(value.root, ["bus", "doctor", "--format", "md"]);
    expect(stdout).toContain(`endpoint-${symUuid.slice(0, 8)}`);
    expect(stdout).not.toContain(symUuid);
  });

  it("redacts a v1 endpoint-record UUID in the doctor Markdown but preserves thread/message UUIDs (#9)", async () => {
    const fx = await createV1DoctorRuntime();

    // JSON (the doctor result) retains the full UUIDs for correlation: the
    // endpoint-record finding and the mailbox-pointer finding both name theirs.
    const doctor = await busDoctor(fx.root);
    const findingsText = doctor.findings.join("\n");
    expect(findingsText).toContain(fx.extraEndpointUuid);
    expect(findingsText).toContain(fx.danglingMessageId);

    // The Markdown relabels the v1 endpoint UUID to a short stable tag while the
    // unrelated message UUID (and any other thread UUID) survives verbatim.
    const { stdout } = await runBusCli(fx.root, ["bus", "doctor", "--format", "md"]);
    expect(stdout).toContain(`endpoint-${fx.extraEndpointUuid.slice(0, 8)}`);
    expect(stdout).not.toContain(fx.extraEndpointUuid);
    expect(stdout).toContain(fx.danglingMessageId);
  });

  it("redacts only endpoint UUIDs in the doctor Markdown and preserves the thread UUID", async () => {
    const value = await fx();
    const sent = await reviewSend(value);
    // A finding that names BOTH the sender endpoint UUID and the thread UUID: the
    // receipt references a now-missing thread.
    await rm(join(value.root, ".story", "bus", "threads", sent.threadId), { recursive: true });

    // JSON retains the full UUIDs for correlation.
    const doctor = await busDoctor(value.root);
    const findingsText = doctor.findings.join("\n");
    expect(findingsText).toContain(value.reviewer.endpointId);
    expect(findingsText).toContain(sent.threadId);

    // Markdown relabels only the known endpoint UUID; the thread UUID survives
    // verbatim so a user can still inspect or repair it.
    const { stdout } = await runBusCli(value.root, ["bus", "doctor", "--format", "md"]);
    expect(stdout).toContain(sent.threadId);
    expect(stdout).not.toContain(value.reviewer.endpointId);
    expect(stdout).toContain(`endpoint-${value.reviewer.endpointId.slice(0, 8)}`);
  });

  it("redacts an ORPHANED endpoint UUID (registry record deleted) in the doctor Markdown but preserves the thread UUID (R12)", async () => {
    const value = await fx();
    // The reviewer sends a message, creating its idempotency/receipt directory and a
    // thread. Deleting the reviewer's endpoint REGISTRY RECORD (not its mailbox or
    // idempotency directories) unregisters it while its UUID lives on in the orphaned
    // receipt directory. Deleting the thread then makes doctor surface a
    // `receipt <senderUuid>/...: references missing thread <threadUuid>` finding: a
    // NON-`endpoint:`-prefixed finding naming the now-unregistered sender UUID.
    const sent = await reviewSend(value);
    await rm(join(value.root, ".story", "bus", "endpoints", `${value.reviewer.endpointId}.json`));
    await rm(join(value.root, ".story", "bus", "threads", sent.threadId), { recursive: true });

    // JSON (the doctor result) retains the raw UUIDs for correlation: the orphaned
    // receipt finding names both the sender endpoint UUID and the thread UUID.
    const doctor = await busDoctor(value.root);
    expect(doctor.healthy).toBe(false);
    const findingsText = doctor.findings.join("\n");
    expect(findingsText).toContain(value.reviewer.endpointId);
    expect(findingsText).toContain(sent.threadId);

    // The Markdown redaction set now also covers UUID-named mailbox/idempotency
    // directories, so the orphaned sender UUID (absent from the endpoint registry and
    // never `endpoint:`-prefixed) is still relabeled, while the thread UUID survives
    // verbatim for inspection/repair.
    const { stdout } = await runBusCli(value.root, ["bus", "doctor", "--format", "md"]);
    expect(stdout).toContain(`endpoint-${value.reviewer.endpointId.slice(0, 8)}`);
    expect(stdout).not.toContain(value.reviewer.endpointId);
    expect(stdout).toContain(sent.threadId);
  });

  it("redacts an orphaned endpoint UUID whose residual idempotency entry is a NON-directory (symlink/file) (redaction-nondir)", async () => {
    const value = await fx();
    // A preserved thread UUID: drop a sent thread so its receipt surfaces a
    // "references missing thread <threadUuid>" finding (the thread UUID must survive).
    const sent = await reviewSend(value);
    await rm(join(value.root, ".story", "bus", "threads", sent.threadId), { recursive: true });

    // An orphaned endpoint UUID whose residual idempotency entry is a regular FILE (not
    // a directory), named exactly with the UUID. It is absent from the endpoint registry
    // and its doctor finding ("idempotency: unexpected entry <uuid>") is not
    // `endpoint:`-prefixed, so its redaction depends entirely on the runtime scan
    // matching the UUID name regardless of file type.
    const orphanUuid = randomUUID();
    await writeFile(join(value.root, ".story", "bus", "idempotency", orphanUuid), "not-a-receipt-dir", "utf-8");

    const doctor = await busDoctor(value.root);
    expect(doctor.healthy).toBe(false);
    expect(doctor.findings.join("\n")).toContain(orphanUuid);

    const { stdout } = await runBusCli(value.root, ["bus", "doctor", "--format", "md"]);
    // The orphaned UUID is relabeled even though its residual entry is a non-directory.
    expect(stdout).toContain(`endpoint-${orphanUuid.slice(0, 8)}`);
    expect(stdout).not.toContain(orphanUuid);
    // The thread UUID survives verbatim.
    expect(stdout).toContain(sent.threadId);
  });

  it("reports setupState invalid (not ready) on a corrupt endpoint registry, unhealthy through doctor (#R5-B)", async () => {
    const value = await fx();
    // Control: a clean two-endpoint runtime is ready and healthy.
    expect((await busSummary(value.root)).setupState).toBe("ready");
    expect((await busDoctor(value.root)).healthy).toBe(true);

    // A malformed third endpoint record is dropped from the parsed set and surfaces
    // a registry finding, while the two valid endpoints remain. Readiness must
    // fail closed to invalid rather than reporting ready off only the parsed count.
    await writeMalformedEndpoint(value.root);

    const summary = await busSummary(value.root);
    expect(summary.setupState).toBe("invalid");
    // Only the two well-formed endpoints parse into the active set.
    expect(summary.endpoints).toBe(2);
    // Doctor independently reports the corruption.
    expect((await busDoctor(value.root)).healthy).toBe(false);
  });

  it("redacts a malformed v2 endpoint-record UUID in the doctor Markdown but preserves the thread UUID (#R5-J)", async () => {
    const value = await fx();
    const sent = await reviewSend(value);
    const malformedUuid = await writeMalformedEndpoint(value.root);
    // Drop the thread so the sender's receipt surfaces a "references missing thread"
    // finding naming the thread UUID (a NON-`endpoint:` finding that must survive
    // redaction verbatim), alongside the malformed-endpoint finding.
    await rm(join(value.root, ".story", "bus", "threads", sent.threadId), { recursive: true });

    // JSON (the doctor result) retains the full endpoint UUID and thread UUID.
    const doctor = await busDoctor(value.root);
    expect(doctor.healthy).toBe(false);
    const findingsText = doctor.findings.join("\n");
    expect(findingsText).toContain(malformedUuid);
    expect(findingsText).toContain(sent.threadId);

    // The Markdown relabels the malformed endpoint UUID to a short stable tag while
    // the unrelated thread UUID survives verbatim.
    const { stdout } = await runBusCli(value.root, ["bus", "doctor", "--format", "md"]);
    expect(stdout).toContain(`endpoint-${malformedUuid.slice(0, 8)}`);
    expect(stdout).not.toContain(malformedUuid);
    expect(stdout).toContain(sent.threadId);
  });
});
