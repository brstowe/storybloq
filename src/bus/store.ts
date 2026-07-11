import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadProject } from "../core/project-loader.js";
import { displayIdOf } from "../core/resolver.js";
import type { ProjectState } from "../core/project-state.js";
import { assertBusEnabled } from "./config.js";
import { canonicalHash, hashWithoutKey } from "./canonical.js";
import { listEndpoints, withEndpointCaller } from "./endpoints.js";
import { BusError } from "./errors.js";
import { ensureDerivedThread, foldBusThread, writeDerivedThread } from "./fold.js";
import {
  durableCreate,
  durableRename,
  durableUnlink,
  durableWrite,
  listRegularJsonFiles,
  readJsonNoFollow,
  syncDirectory,
} from "./io.js";
import { withHardenedLock } from "./lock.js";
import { readBusHookPolicy } from "./hooks.js";
import { readBusInstance } from "./admin.js";
import { resolveBusPaths, roleMailboxPath, type BusPaths } from "./paths.js";
import {
  BUS_MAX_ENTRY_BYTES,
  BusEntrySchema,
  BusEvidenceRefSchema,
  BusMailboxCounterSchema,
  BusMailboxPointerSchema,
  BusMessageKindSchema,
  BusMessageRefsSchema,
  BusRoleSchema,
  BusSeveritySchema,
  BusSuccessionSchema,
  BusThreadKindSchema,
  type BusAckPayload,
  type BusEndpoint,
  type BusEntry,
  type BusEvidenceRef,
  type BusMailboxPointer,
  type BusMessageKind,
  type BusMessagePayload,
  type BusMessageRefs,
  type BusRole,
  type BusSeverity,
  type BusStatePayload,
  type BusSummary,
  type BusThreadKind,
  type BusThreadRecord,
  type FoldedBusThread,
} from "./schemas.js";
import {
  actionableFingerprint,
  assertNoHighConfidenceSecret,
  evidenceKey,
  idempotencyKeyHash,
  normalizeBusText,
  normalizeMessageBody,
  normalizeMessageRefs,
} from "./security.js";

const ThreadIdSchema = z.string().uuid();
const EndpointIdSchema = z.string().uuid();
const MessageIdSchema = z.string().uuid();
const POINTER_FILENAME = /^(\d{12})-([0-9a-f-]{36})\.json$/;
const ACTIONABLE_KINDS = new Set<BusMessageKind>(["issue_notice", "question", "reply", "patch_request"]);

export interface BusSendInput {
  readonly endpointId: string;
  readonly clientTaskId: string;
  readonly threadId?: string;
  readonly threadKind?: BusThreadKind;
  readonly toRole: BusRole;
  readonly messageKind: BusMessageKind;
  readonly severity: BusSeverity;
  readonly body: string;
  readonly refs?: BusMessageRefs;
  readonly inReplyTo?: string | null;
  readonly idempotencyKey: string;
  readonly predecessorThreadId?: string;
}

export interface BusSendResult {
  readonly threadId: string;
  readonly messageId: string | null;
  readonly state: "open" | "parked" | "resolved";
  readonly hopCount: number;
  readonly replayed: boolean;
  readonly parked: boolean;
}

export interface BusPollEnvelope {
  readonly source: "storybloq_bus";
  readonly authority: "peer_agent";
  readonly integrity: "verified" | "quarantined";
  readonly sender: { readonly role: BusRole; readonly client: "claude" | "codex" };
  readonly threadId: string;
  readonly mailboxSeq: number;
  readonly message: BusMessagePayload;
}

export interface BusPollResult {
  readonly endpointId: string;
  readonly role: BusRole;
  readonly cursor: number;
  readonly messages: readonly BusPollEnvelope[];
  readonly findings: readonly string[];
}

interface NormalizedSend {
  readonly toRole: BusRole;
  readonly messageKind: BusMessageKind;
  readonly severity: BusSeverity;
  readonly body: string;
  readonly refs: BusMessageRefs;
  readonly inReplyTo: string | null;
  readonly keyHash: string;
  readonly payloadHash: string;
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function padSeq(seq: number, width = 6): string {
  return String(seq).padStart(width, "0");
}

function entryFilename(entry: BusEntry): string {
  return `${padSeq(entry.seq)}-${entry.type}-${entry.entryId}.json`;
}

function pointerFilename(pointer: BusMailboxPointer): string {
  return `${padSeq(pointer.mailboxSeq, 12)}-${pointer.messageId}.json`;
}

function makeEntry<T extends BusEntry["type"]>(input: {
  type: T;
  threadId: string;
  seq: number;
  prevHash: string;
  payload: Extract<BusEntry, { type: T }>["payload"];
}): Extract<BusEntry, { type: T }> {
  const unsigned = {
    schema: "storybloq-bus-entry/v1" as const,
    entryId: randomUUID(),
    threadId: input.threadId,
    seq: input.seq,
    type: input.type,
    prevHash: input.prevHash,
    payload: input.payload,
    createdAt: new Date().toISOString(),
    entryHash: "0".repeat(64),
  };
  const signed = { ...unsigned, entryHash: hashWithoutKey(unsigned, "entryHash") };
  return BusEntrySchema.parse(signed) as Extract<BusEntry, { type: T }>;
}

async function listThreadIds(paths: BusPaths): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(paths.threads, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new BusError("io_error", "Cannot enumerate Bus threads", err);
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => ThreadIdSchema.safeParse(name).success)
    .sort();
}

async function allocateMailboxSeq(paths: BusPaths, role: BusRole): Promise<number> {
  const mailbox = roleMailboxPath(paths, role);
  return withHardenedLock(join(paths.locks, `mailbox-${role}.lock`), async () => {
    const counterPath = join(mailbox, "counter.json");
    let nextSeq = 1;
    try {
      nextSeq = (await readJsonNoFollow(counterPath, BusMailboxCounterSchema)).nextSeq;
    } catch (err) {
      if (!(err instanceof BusError) || err.code !== "not_found") throw err;
    }
    let pointerFloor = 1;
    for (const directory of [mailbox, join(mailbox, "pending")]) {
      for (const filename of await listRegularJsonFiles(directory)) {
        const match = POINTER_FILENAME.exec(filename);
        if (match) pointerFloor = Math.max(pointerFloor, Number(match[1]) + 1);
      }
    }
    nextSeq = Math.max(nextSeq, pointerFloor);
    await durableWrite(counterPath, serialize({
      schema: "storybloq-bus-mailbox-counter/v1",
      nextSeq: nextSeq + 1,
      updatedAt: new Date().toISOString(),
    }));
    return nextSeq;
  });
}

function makePointer(role: BusRole, mailboxSeq: number, entry: Extract<BusEntry, { type: "message" }>): BusMailboxPointer {
  return BusMailboxPointerSchema.parse({
    schema: "storybloq-bus-mailbox/v1",
    role,
    mailboxSeq,
    messageId: entry.payload.messageId,
    threadId: entry.threadId,
    entrySeq: entry.seq,
    entryHash: entry.entryHash,
    createdAt: entry.createdAt,
  });
}

async function publishPointerIntent(paths: BusPaths, pointer: BusMailboxPointer): Promise<{ pending: string; active: string }> {
  const mailbox = roleMailboxPath(paths, pointer.role);
  const filename = pointerFilename(pointer);
  const pending = join(mailbox, "pending", filename);
  const active = join(mailbox, filename);
  await durableCreate(pending, serialize(pointer));
  return { pending, active };
}

async function activatePointer(intent: { pending: string; active: string }): Promise<void> {
  try {
    await durableRename(intent.pending, intent.active);
  } catch {
    // The immutable pending intent is sufficient for poll recovery.
  }
}

function normalizeRefsAgainstProject(state: ProjectState, refs: BusMessageRefs): BusMessageRefs {
  const normalized = normalizeMessageRefs(refs);
  if (normalized.issue) {
    const resolved = state.resolveIssueRef(normalized.issue);
    if (resolved.kind !== "found") throw new BusError("invalid_input", `Issue reference not found or ambiguous: ${normalized.issue}`);
    normalized.issue = resolved.item.id;
  }
  if (normalized.ticket) {
    const resolved = state.resolveTicketRef(normalized.ticket);
    if (resolved.kind !== "found") throw new BusError("invalid_input", `Ticket reference not found or ambiguous: ${normalized.ticket}`);
    normalized.ticket = resolved.item.id;
  }
  return normalized;
}

function validateIssueNotice(state: ProjectState, kind: BusMessageKind, severity: BusSeverity, refs: BusMessageRefs): void {
  if (kind !== "issue_notice") return;
  if (!refs.issue) throw new BusError("invalid_input", "An issue notice requires an issue reference");
  const issue = state.issueByID(refs.issue);
  if (!issue) throw new BusError("invalid_input", `Issue does not exist: ${refs.issue}`);
  if (issue.status === "resolved") throw new BusError("invalid_input", `${displayIdOf(issue)} is already resolved`);
  if (issue.severity !== severity) {
    throw new BusError("invalid_input", `Issue notice severity must match ${displayIdOf(issue)} (${issue.severity})`);
  }
}

function validateCriticalReference(
  state: ProjectState,
  severity: BusSeverity,
  refs: BusMessageRefs,
  required: boolean,
): void {
  if (severity !== "critical" || !required) return;
  if (!refs.issue) throw new BusError("invalid_input", "A critical Bus message requires an issue reference");
  const issue = state.issueByID(refs.issue);
  if (!issue || issue.status === "resolved" || issue.severity !== "critical") {
    throw new BusError("invalid_input", "A critical Bus message requires an unresolved critical issue");
  }
}

function normalizeSend(
  state: ProjectState,
  maxBodyBytes: number,
  requireIssueForCritical: boolean,
  endpoint: BusEndpoint,
  input: BusSendInput,
): NormalizedSend {
  const toRole = BusRoleSchema.parse(input.toRole);
  if (toRole === endpoint.role) throw new BusError("invalid_input", "An endpoint cannot address its own role");
  const messageKind = BusMessageKindSchema.parse(input.messageKind);
  const severity = BusSeveritySchema.parse(input.severity);
  const body = normalizeMessageBody(input.body, maxBodyBytes);
  const refs = normalizeRefsAgainstProject(state, BusMessageRefsSchema.parse(input.refs ?? {}));
  validateIssueNotice(state, messageKind, severity, refs);
  validateCriticalReference(state, severity, refs, requireIssueForCritical);
  const inReplyTo = input.inReplyTo ?? null;
  if (inReplyTo && !MessageIdSchema.safeParse(inReplyTo).success) throw new BusError("invalid_input", "Invalid reply message id");
  const keyHash = idempotencyKeyHash(endpoint.endpointId, input.idempotencyKey);
  const payloadHash = canonicalHash({
    fromEndpoint: endpoint.endpointId,
    fromRole: endpoint.role,
    toRole,
    messageKind,
    severity,
    body,
    refs,
    inReplyTo,
    threadKind: input.threadKind ?? null,
    targetThreadId: input.threadId ?? null,
    predecessorThreadId: input.predecessorThreadId ?? null,
  });
  return { toRole, messageKind, severity, body, refs, inReplyTo, keyHash, payloadHash };
}

function topicRefFrom(refs: BusMessageRefs): Record<string, string> {
  const topic = {
    ...(refs.issue ? { issue: refs.issue } : {}),
    ...(refs.ticket ? { ticket: refs.ticket } : {}),
    ...(refs.commit ? { commit: refs.commit } : {}),
    ...(refs.ciRun ? { ciRun: refs.ciRun } : {}),
  };
  if (Object.keys(topic).length === 0) {
    throw new BusError("invalid_input", "A new thread requires an issue, ticket, commit, or CI run reference");
  }
  return topic;
}

function validateInitialKinds(threadKind: BusThreadKind, messageKind: BusMessageKind): void {
  const valid = threadKind === "coordination"
    ? ["status", "claim", "release"].includes(messageKind)
    : threadKind === messageKind;
  if (!valid) throw new BusError("invalid_input", `Initial ${messageKind} message does not match ${threadKind} thread`);
}

function replayForKey(folded: FoldedBusThread, endpointId: string, keyHash: string, payloadHash: string): BusSendResult | null {
  const match = folded.messages.find((message) =>
    message.from.endpointId === endpointId && message.idempotencyKeyHash === keyHash,
  );
  if (!match) return null;
  if (match.payloadHash !== payloadHash) {
    throw new BusError("idempotency_conflict", "Idempotency key was already used with a different payload");
  }
  return {
    threadId: folded.thread.threadId,
    messageId: match.messageId,
    state: folded.state,
    hopCount: folded.hopCount,
    replayed: true,
    parked: folded.state === "parked",
  };
}

async function findReplayAcrossThreads(
  paths: BusPaths,
  endpointId: string,
  keyHash: string,
  payloadHash: string,
): Promise<BusSendResult | null> {
  for (const threadId of await listThreadIds(paths)) {
    const folded = await foldBusThread(paths.projectRoot, threadId);
    if (folded.integrity !== "verified") {
      throw new BusError("corrupt", `Cannot establish idempotency while ${threadId} is quarantined`);
    }
    const replay = replayForKey(folded, endpointId, keyHash, payloadHash);
    if (replay) return replay;
  }
  return null;
}

function messagePayload(endpoint: BusEndpoint, normalized: NormalizedSend): BusMessagePayload {
  return {
    messageId: randomUUID(),
    from: {
      endpointId: endpoint.endpointId,
      role: endpoint.role,
      client: endpoint.client,
      authority: "peer_agent",
    },
    toRole: normalized.toRole,
    kind: normalized.messageKind,
    severity: normalized.severity,
    body: normalized.body,
    refs: normalized.refs,
    inReplyTo: normalized.inReplyTo,
    idempotencyKeyHash: normalized.keyHash,
    payloadHash: normalized.payloadHash,
  };
}

async function createThread(
  paths: BusPaths,
  endpoint: BusEndpoint,
  normalized: NormalizedSend,
  input: BusSendInput,
  maxHops: number,
): Promise<BusSendResult> {
  const threadKind = BusThreadKindSchema.parse(input.threadKind);
  validateInitialKinds(threadKind, normalized.messageKind);
  if (input.predecessorThreadId && !ThreadIdSchema.safeParse(input.predecessorThreadId).success) {
    throw new BusError("invalid_input", "Invalid predecessor thread id");
  }
  return withHardenedLock(join(paths.locks, "threads.lock"), async () => {
    const replay = await findReplayAcrossThreads(paths, endpoint.endpointId, normalized.keyHash, normalized.payloadHash);
    if (replay) return replay;

    if (input.predecessorThreadId) {
      const predecessor = await foldBusThread(paths.projectRoot, input.predecessorThreadId);
      if (predecessor.integrity !== "verified" || predecessor.state !== "resolved") {
        throw new BusError("conflict", "A predecessor thread must be integrity-verified and resolved");
      }
      if (!predecessor.thread.participantRoles.includes(endpoint.role) ||
          !predecessor.thread.participantRoles.includes(normalized.toRole)) {
        throw new BusError("unauthorized", "A successor must retain the predecessor participants");
      }
    }

    const threadId = randomUUID();
    const message = messagePayload(endpoint, normalized);
    const unsignedThread = {
      schema: "storybloq-bus-thread/v1" as const,
      threadId,
      kind: threadKind,
      topicRef: topicRefFrom(normalized.refs),
      participantRoles: [endpoint.role, normalized.toRole] as [BusRole, BusRole],
      maxHops,
      createdByEndpoint: endpoint.endpointId,
      createdAt: new Date().toISOString(),
      ...(input.predecessorThreadId ? { predecessorThreadId: input.predecessorThreadId } : {}),
      threadHash: "0".repeat(64),
    };
    const thread: BusThreadRecord = {
      ...unsignedThread,
      threadHash: hashWithoutKey(unsignedThread, "threadHash"),
    };
    const entry = makeEntry({ type: "message", threadId, seq: 1, prevHash: thread.threadHash, payload: message });
    if (Buffer.byteLength(serialize(entry), "utf-8") > BUS_MAX_ENTRY_BYTES) {
      throw new BusError("invalid_input", `Message entry exceeds ${BUS_MAX_ENTRY_BYTES} bytes`);
    }
    const mailboxSeq = await allocateMailboxSeq(paths, normalized.toRole);
    const pointer = makePointer(normalized.toRole, mailboxSeq, entry);
    const intent = await publishPointerIntent(paths, pointer);
    const tempDir = join(paths.threads, `.tmp-${threadId}-${randomUUID()}`);
    const finalDir = join(paths.threads, threadId);
    try {
      await mkdir(join(tempDir, "entries"), { recursive: true, mode: 0o700 });
      await durableCreate(join(tempDir, "thread.json"), serialize(thread));
      await durableCreate(join(tempDir, "entries", entryFilename(entry)), serialize(entry));
      await syncDirectory(join(tempDir, "entries"));
      await syncDirectory(tempDir);
      await durableRename(tempDir, finalDir);
    } catch (err) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    await activatePointer(intent);
    const folded = await foldBusThread(paths.projectRoot, threadId);
    await writeDerivedThread(paths.projectRoot, folded).catch(() => undefined);
    return { threadId, messageId: message.messageId, state: folded.state, hopCount: folded.hopCount, replayed: false, parked: false };
  });
}

function duplicateActionable(folded: FoldedBusThread, endpoint: BusEndpoint, normalized: NormalizedSend): boolean {
  if (!ACTIONABLE_KINDS.has(normalized.messageKind)) return false;
  const candidate = actionableFingerprint({
    fromRole: endpoint.role,
    toRole: normalized.toRole,
    kind: normalized.messageKind,
    body: normalized.body,
    refs: normalized.refs,
  });
  return folded.messages.some((message) =>
    ACTIONABLE_KINDS.has(message.kind) &&
    actionableFingerprint({
      fromRole: message.from.role,
      toRole: message.toRole,
      kind: message.kind,
      body: message.body,
      refs: message.refs,
    }) === candidate,
  );
}

async function appendStateEntry(
  paths: BusPaths,
  folded: FoldedBusThread,
  payload: BusStatePayload,
): Promise<FoldedBusThread> {
  const entry = makeEntry({
    type: "state",
    threadId: folded.thread.threadId,
    seq: folded.validThroughSeq + 1,
    prevHash: folded.lastHash,
    payload,
  });
  await durableCreate(join(paths.threads, folded.thread.threadId, "entries", entryFilename(entry)), serialize(entry));
  const next = await foldBusThread(paths.projectRoot, folded.thread.threadId);
  await writeDerivedThread(paths.projectRoot, next).catch(() => undefined);
  return next;
}

async function replyToThread(
  paths: BusPaths,
  endpoint: BusEndpoint,
  normalized: NormalizedSend,
  threadId: string,
): Promise<BusSendResult> {
  if (!ThreadIdSchema.safeParse(threadId).success) throw new BusError("invalid_input", "Invalid Bus thread id");
  return withHardenedLock(join(paths.locks, `thread-${threadId}.lock`), async () => {
    let folded = await foldBusThread(paths.projectRoot, threadId);
    if (folded.integrity !== "verified") throw new BusError("corrupt", folded.finding ?? "Thread is quarantined");
    const replay = replayForKey(folded, endpoint.endpointId, normalized.keyHash, normalized.payloadHash);
    if (replay) return replay;
    if (folded.state !== "open") throw new BusError("thread_parked", `Thread is ${folded.state}`);
    if (!folded.thread.participantRoles.includes(endpoint.role) || !folded.thread.participantRoles.includes(normalized.toRole)) {
      throw new BusError("unauthorized", "Endpoint is not a participant in this thread");
    }
    if (normalized.inReplyTo && !folded.messages.some((message) => message.messageId === normalized.inReplyTo)) {
      throw new BusError("invalid_input", "Reply target does not exist in this thread");
    }

    const overHopCap = ACTIONABLE_KINDS.has(normalized.messageKind) && folded.hopCount >= folded.thread.maxHops;
    const duplicate = duplicateActionable(folded, endpoint, normalized);
    if (overHopCap || duplicate) {
      folded = await appendStateEntry(paths, folded, {
        action: "park",
        byEndpoint: endpoint.endpointId,
        reason: overHopCap ? `Maximum hop count ${folded.thread.maxHops} reached` : "Duplicate actionable fingerprint",
        automatic: true,
        trigger: overHopCap ? "hop_cap" : "duplicate_fingerprint",
      });
      return { threadId, messageId: null, state: folded.state, hopCount: folded.hopCount, replayed: false, parked: true };
    }

    const message = messagePayload(endpoint, normalized);
    const entry = makeEntry({
      type: "message",
      threadId,
      seq: folded.validThroughSeq + 1,
      prevHash: folded.lastHash,
      payload: message,
    });
    if (Buffer.byteLength(serialize(entry), "utf-8") > BUS_MAX_ENTRY_BYTES) {
      throw new BusError("invalid_input", `Message entry exceeds ${BUS_MAX_ENTRY_BYTES} bytes`);
    }
    const mailboxSeq = await allocateMailboxSeq(paths, normalized.toRole);
    const intent = await publishPointerIntent(paths, makePointer(normalized.toRole, mailboxSeq, entry));
    await durableCreate(join(paths.threads, threadId, "entries", entryFilename(entry)), serialize(entry));
    await activatePointer(intent);
    folded = await foldBusThread(paths.projectRoot, threadId);
    await writeDerivedThread(paths.projectRoot, folded).catch(() => undefined);
    return { threadId, messageId: message.messageId, state: folded.state, hopCount: folded.hopCount, replayed: false, parked: false };
  });
}

export async function sendBusMessage(root: string, input: BusSendInput): Promise<BusSendResult> {
  if (!EndpointIdSchema.safeParse(input.endpointId).success) throw new BusError("invalid_input", "Invalid endpoint id");
  if (input.threadId && (input.threadKind || input.predecessorThreadId)) {
    throw new BusError("invalid_input", "Replies cannot set threadKind or predecessorThreadId");
  }
  if (!input.threadId && !input.threadKind) {
    throw new BusError("invalid_input", "A new Bus thread requires threadKind");
  }
  const loaded = await loadProject(root);
  const config = assertBusEnabled(loaded.state.config);
  const paths = await resolveBusPaths(root, true);
  return withEndpointCaller(paths.projectRoot, input.endpointId, input.clientTaskId, async (endpoint) => {
    const normalized = normalizeSend(
      loaded.state,
      config.maxBodyBytes,
      config.requireIssueForCritical,
      endpoint,
      input,
    );
    const replay = await findReplayAcrossThreads(
      paths,
      endpoint.endpointId,
      normalized.keyHash,
      normalized.payloadHash,
    );
    if (replay) return replay;
    return input.threadId
      ? replyToThread(paths, endpoint, normalized, input.threadId)
      : createThread(paths, endpoint, normalized, input, config.maxHops);
  });
}

async function mailboxPointers(paths: BusPaths, role: BusRole): Promise<{ pointers: BusMailboxPointer[]; findings: string[] }> {
  const mailbox = roleMailboxPath(paths, role);
  const pointers: BusMailboxPointer[] = [];
  const findings: string[] = [];
  for (const directory of [mailbox, join(mailbox, "pending")]) {
    for (const filename of await listRegularJsonFiles(directory)) {
      if (!POINTER_FILENAME.test(filename)) continue;
      try {
        const pointer = await readJsonNoFollow(join(directory, filename), BusMailboxPointerSchema);
        if (pointer.role !== role || pointerFilename(pointer) !== filename) {
          throw new BusError("corrupt", "Mailbox pointer envelope does not match its role or filename");
        }
        pointers.push(pointer);
      } catch (err) {
        findings.push(`${filename}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const unique = new Map<string, BusMailboxPointer>();
  for (const pointer of pointers) unique.set(pointer.messageId, pointer);
  return { pointers: [...unique.values()].sort((a, b) => a.mailboxSeq - b.mailboxSeq), findings };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function recoverPendingIntent(
  paths: BusPaths,
  pointer: BusMailboxPointer,
): Promise<string | null> {
  const mailbox = roleMailboxPath(paths, pointer.role);
  const filename = pointerFilename(pointer);
  const pending = join(mailbox, "pending", filename);
  const lockPath = await pathExists(join(paths.threads, pointer.threadId, "thread.json"))
    ? join(paths.locks, `thread-${pointer.threadId}.lock`)
    : join(paths.locks, "threads.lock");

  return withHardenedLock(lockPath, async () => {
    let folded: FoldedBusThread;
    try {
      folded = await foldBusThread(paths.projectRoot, pointer.threadId);
    } catch (err) {
      if (err instanceof BusError && err.code === "not_found") {
        await durableUnlink(pending);
        return null;
      }
      return `${filename}: ${err instanceof Error ? err.message : String(err)}`;
    }
    const entry = folded.entries[pointer.entrySeq - 1];
    if (entry?.type === "message" && entry.entryHash === pointer.entryHash &&
        entry.payload.messageId === pointer.messageId && entry.payload.toRole === pointer.role) {
      await activatePointer({ pending, active: join(mailbox, filename) });
      return null;
    }
    if (folded.integrity === "verified" || pointer.entrySeq > folded.validThroughSeq) {
      await durableUnlink(pending);
      return null;
    }
    return `${filename}: pending intent does not match the verified thread prefix`;
  });
}

async function reconcileRoleMailbox(
  paths: BusPaths,
  role: BusRole,
): Promise<{ pointers: BusMailboxPointer[]; findings: string[] }> {
  return withHardenedLock(join(paths.locks, `mailbox-reconcile-${role}.lock`), async () => {
    const mailbox = roleMailboxPath(paths, role);
    const findings: string[] = [];
    for (const filename of await listRegularJsonFiles(join(mailbox, "pending"))) {
      if (!POINTER_FILENAME.test(filename)) continue;
      try {
        const pointer = await readJsonNoFollow(join(mailbox, "pending", filename), BusMailboxPointerSchema);
        if (pointer.role !== role || pointerFilename(pointer) !== filename) {
          throw new BusError("corrupt", "Mailbox pointer envelope does not match its role or filename");
        }
        const finding = await recoverPendingIntent(paths, pointer);
        if (finding) findings.push(finding);
      } catch (err) {
        findings.push(`${filename}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let current = await mailboxPointers(paths, role);
    findings.push(...current.findings);
    const known = new Set(current.pointers.map((pointer) => pointer.messageId));
    for (const threadId of await listThreadIds(paths)) {
      let folded: FoldedBusThread;
      try {
        folded = await foldBusThread(paths.projectRoot, threadId);
      } catch (err) {
        findings.push(`${threadId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const entry of folded.entries) {
        if (entry.type !== "message" || entry.payload.toRole !== role ||
            folded.acknowledgments.has(entry.payload.messageId) || known.has(entry.payload.messageId)) continue;
        const latest = await mailboxPointers(paths, role);
        findings.push(...latest.findings);
        if (latest.pointers.some((pointer) => pointer.messageId === entry.payload.messageId)) {
          known.add(entry.payload.messageId);
          continue;
        }
        const mailboxSeq = await allocateMailboxSeq(paths, role);
        const pointer = makePointer(role, mailboxSeq, entry);
        try {
          await durableCreate(join(mailbox, pointerFilename(pointer)), serialize(pointer));
          known.add(entry.payload.messageId);
        } catch (err) {
          if (!(err instanceof BusError) || err.code !== "conflict") throw err;
        }
      }
    }
    current = await mailboxPointers(paths, role);
    return { pointers: current.pointers, findings: [...new Set([...findings, ...current.findings])] };
  });
}

async function pointerPaths(paths: BusPaths, pointer: BusMailboxPointer): Promise<string[]> {
  const mailbox = roleMailboxPath(paths, pointer.role);
  const filename = pointerFilename(pointer);
  return [join(mailbox, filename), join(mailbox, "pending", filename)];
}

async function removePointer(paths: BusPaths, pointer: BusMailboxPointer): Promise<void> {
  for (const path of await pointerPaths(paths, pointer)) await durableUnlink(path).catch(() => undefined);
}

export async function pollBus(root: string, input: {
  endpointId: string;
  clientTaskId: string;
  limit?: number;
}): Promise<BusPollResult> {
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  const paths = await resolveBusPaths(root, true);
  return withEndpointCaller(paths.projectRoot, input.endpointId, input.clientTaskId, async (endpoint, persist) => {
    const requestedLimit = Number.isFinite(input.limit) ? Math.floor(input.limit!) : 20;
    const limit = Math.max(1, Math.min(100, requestedLimit));
    const mailbox = await reconcileRoleMailbox(paths, endpoint.role);
    const messages: BusPollEnvelope[] = [];
    let cursor = endpoint.lastPolledMailboxSeq;

    for (const pointer of mailbox.pointers) {
      if (messages.length >= limit) break;
      let folded: FoldedBusThread;
      try {
        folded = await foldBusThread(paths.projectRoot, pointer.threadId);
      } catch (err) {
        mailbox.findings.push(`${pointer.threadId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const entry = folded.entries[pointer.entrySeq - 1];
      if (!entry || entry.type !== "message" || entry.entryHash !== pointer.entryHash ||
          entry.payload.messageId !== pointer.messageId || entry.payload.toRole !== endpoint.role) {
        mailbox.findings.push(`${pointer.messageId}: mailbox pointer does not match the valid thread prefix`);
        continue;
      }
      await ensureDerivedThread(paths.projectRoot, folded).catch(() => undefined);
      if (folded.acknowledgments.has(pointer.messageId)) {
        await removePointer(paths, pointer);
        continue;
      }
      messages.push({
        source: "storybloq_bus",
        authority: "peer_agent",
        integrity: folded.integrity,
        sender: { role: entry.payload.from.role, client: entry.payload.from.client },
        threadId: pointer.threadId,
        mailboxSeq: pointer.mailboxSeq,
        message: entry.payload,
      });
      cursor = Math.max(cursor, pointer.mailboxSeq);
    }

    if (cursor !== endpoint.lastPolledMailboxSeq || messages.length > 0) {
      await persist((current) => ({
        ...current,
        lastPolledMailboxSeq: Math.max(current.lastPolledMailboxSeq, cursor),
        lastSeenAt: new Date().toISOString(),
      }));
    }
    return { endpointId: endpoint.endpointId, role: endpoint.role, cursor, messages, findings: mailbox.findings };
  });
}

async function findMessageThread(paths: BusPaths, role: BusRole, messageId: string): Promise<string | null> {
  const mailbox = await mailboxPointers(paths, role);
  const pointer = mailbox.pointers.find((candidate) => candidate.messageId === messageId);
  if (pointer) return pointer.threadId;
  for (const threadId of await listThreadIds(paths)) {
    const folded = await foldBusThread(paths.projectRoot, threadId);
    if (folded.messages.some((message) => message.messageId === messageId)) return threadId;
  }
  return null;
}

function validateAckTransition(previous: BusAckPayload | undefined, next: BusAckPayload): "new" | "replay" {
  if (!previous) return "new";
  if (previous.disposition === next.disposition && previous.reason === next.reason) return "replay";
  if (previous.disposition === "deferred" && ["accepted", "rejected"].includes(next.disposition)) return "new";
  throw new BusError("conflict", `Cannot change ${previous.disposition} acknowledgment to ${next.disposition}`);
}

export async function acknowledgeBusMessage(root: string, input: {
  endpointId: string;
  clientTaskId: string;
  messageId: string;
  disposition: "accepted" | "rejected" | "deferred";
  reason?: string;
}): Promise<{ threadId: string; replayed: boolean }> {
  if (!MessageIdSchema.safeParse(input.messageId).success) throw new BusError("invalid_input", "Invalid message id");
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  const paths = await resolveBusPaths(root, true);
  return withEndpointCaller(paths.projectRoot, input.endpointId, input.clientTaskId, async (endpoint) => {
    const threadId = await findMessageThread(paths, endpoint.role, input.messageId);
    if (!threadId) throw new BusError("not_found", "Bus message not found");
    return withHardenedLock(join(paths.locks, `thread-${threadId}.lock`), async () => {
      let folded = await foldBusThread(paths.projectRoot, threadId);
      if (folded.integrity !== "verified") throw new BusError("corrupt", folded.finding ?? "Thread is quarantined");
      const message = folded.messages.find((candidate) => candidate.messageId === input.messageId);
      if (!message || message.toRole !== endpoint.role) throw new BusError("unauthorized", "Message is not addressed to this endpoint");
      const reasonText = input.reason?.trim();
      if ((input.disposition === "rejected" || input.disposition === "deferred") && !reasonText) {
        throw new BusError("invalid_input", `A reason is required for ${input.disposition} acknowledgment`);
      }
      const reason = reasonText
        ? normalizeBusText(input.reason!, "Acknowledgment reason", 4096)
        : undefined;
      const payload: BusAckPayload = {
        messageId: input.messageId,
        byEndpoint: endpoint.endpointId,
        disposition: input.disposition,
        ...(reason ? { reason } : {}),
      };
      const transition = validateAckTransition(folded.acknowledgments.get(input.messageId), payload);
      if (transition === "replay") return { threadId, replayed: true };
      const entry = makeEntry({
        type: "ack",
        threadId,
        seq: folded.validThroughSeq + 1,
        prevHash: folded.lastHash,
        payload,
      });
      await durableCreate(join(paths.threads, threadId, "entries", entryFilename(entry)), serialize(entry));
      const pointers = await mailboxPointers(paths, endpoint.role);
      for (const pointer of pointers.pointers.filter((candidate) => candidate.messageId === input.messageId)) {
        await removePointer(paths, pointer);
      }
      folded = await foldBusThread(paths.projectRoot, threadId);
      await writeDerivedThread(paths.projectRoot, folded).catch(() => undefined);
      return { threadId, replayed: false };
    });
  });
}

export async function getBusThread(root: string, input: {
  endpointId: string;
  clientTaskId: string;
  threadId: string;
}): Promise<FoldedBusThread> {
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  return withEndpointCaller(root, input.endpointId, input.clientTaskId, async (endpoint) => {
    const folded = await foldBusThread(root, input.threadId);
    if (!folded.thread.participantRoles.includes(endpoint.role)) {
      throw new BusError("unauthorized", "Endpoint is not a participant in this thread");
    }
    return folded;
  });
}

async function validateCommitEvidence(root: string, evidence: BusEvidenceRef): Promise<void> {
  if (!evidence.commit) return;
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["rev-parse", "--verify", `${evidence.commit}^{commit}`], { cwd: root, timeout: 3000 }, (err) => {
      if (err) reject(new BusError("invalid_input", `Commit evidence does not resolve: ${evidence.commit}`));
      else resolve();
    });
  });
}

export async function updateBusThread(root: string, input: {
  endpointId: string;
  clientTaskId: string;
  threadId: string;
  action: "park" | "resolve" | "reopen";
  reason?: string;
  resolution?: string;
  evidence?: BusEvidenceRef;
}): Promise<FoldedBusThread> {
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  const paths = await resolveBusPaths(root, true);
  return withEndpointCaller(paths.projectRoot, input.endpointId, input.clientTaskId, async (endpoint) =>
    withHardenedLock(join(paths.locks, `thread-${input.threadId}.lock`), async () => {
    let folded = await foldBusThread(paths.projectRoot, input.threadId);
    if (folded.integrity !== "verified") throw new BusError("corrupt", folded.finding ?? "Thread is quarantined");
    if (!folded.thread.participantRoles.includes(endpoint.role)) throw new BusError("unauthorized", "Endpoint is not a thread participant");
    const reason = input.reason?.trim()
      ? normalizeBusText(input.reason, "Thread-state reason", 4096)
      : undefined;
    const resolution = input.resolution?.trim()
      ? normalizeBusText(input.resolution, "Thread resolution", 8192)
      : undefined;
    let evidence: BusEvidenceRef | undefined;
    if (input.evidence) {
      const parsed = BusEvidenceRefSchema.safeParse(input.evidence);
      if (!parsed.success) throw new BusError("invalid_input", "Invalid thread-state evidence");
      const ciRun = parsed.data.ciRun?.trim();
      if (parsed.data.ciRun && !ciRun) throw new BusError("invalid_input", "CI evidence cannot be empty");
      if (ciRun) assertNoHighConfidenceSecret(ciRun, "Thread-state evidence");
      evidence = {
        ...(parsed.data.commit ? { commit: parsed.data.commit.toLowerCase() } : {}),
        ...(ciRun ? { ciRun } : {}),
      };
    }
    if (input.action === "park" && (folded.state !== "open" || !reason)) {
      throw new BusError("invalid_input", "Parking an open thread requires a reason");
    }
    if (input.action === "resolve") {
      if (folded.state === "resolved" || !resolution || !evidence) {
        throw new BusError("invalid_input", "Resolving a thread requires resolution text and evidence");
      }
      if (folded.thread.kind === "issue_notice" && folded.thread.topicRef.issue) {
        const issue = loaded.state.issueByID(folded.thread.topicRef.issue);
        if (!issue || issue.status !== "resolved") {
          throw new BusError("conflict", "The canonical issue must be resolved before its Bus thread");
        }
      }
    }
    if (input.action === "reopen") {
      if (folded.state !== "parked" || !reason || !evidence) {
        throw new BusError("invalid_input", "Reopening a parked thread requires a reason and new evidence");
      }
      if (folded.seenEvidence.has(evidenceKey(evidence))) {
        throw new BusError("conflict", "Reopen evidence was already present before the park");
      }
    }
    if (evidence) await validateCommitEvidence(paths.projectRoot, evidence);
    const payload: BusStatePayload = {
      action: input.action,
      byEndpoint: endpoint.endpointId,
      ...(reason ? { reason } : {}),
      ...(resolution ? { resolution } : {}),
      ...(evidence ? { evidence } : {}),
    };
    folded = await appendStateEntry(paths, folded, payload);
    return folded;
    }),
  );
}

export interface BusDoctorResult {
  readonly healthy: boolean;
  readonly summary: BusSummary;
  readonly findings: readonly string[];
}

function emptyBusSummary(): BusSummary {
  return {
    enabled: true,
    daemonState: "stopped",
    endpoints: 0,
    pendingMessages: 0,
    unacknowledgedCritical: 0,
    openThreads: 0,
    parkedThreads: 0,
    undeliverable: 0,
    quarantined: 0,
    hookDelivery: { claude: false, codex: false },
  };
}

function requiredBusDirectories(paths: BusPaths): string[] {
  return [
    paths.busRoot,
    paths.threads,
    paths.endpoints,
    paths.succession,
    paths.mailboxes,
    join(paths.mailboxes, "implementer"),
    join(paths.mailboxes, "implementer", "pending"),
    join(paths.mailboxes, "reviewer"),
    join(paths.mailboxes, "reviewer", "pending"),
    paths.locks,
  ];
}

async function busLayoutFindings(paths: BusPaths): Promise<string[]> {
  const findings: string[] = [];
  for (const directory of requiredBusDirectories(paths)) {
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        findings.push(`layout: ${directory} is not a regular directory`);
      }
    } catch (err) {
      findings.push(`layout: ${directory}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return findings;
}

async function assertBusLayout(paths: BusPaths): Promise<void> {
  const findings = await busLayoutFindings(paths);
  if (findings.length > 0) throw new BusError("corrupt", findings.join("; "));
}

export async function busDoctor(root: string): Promise<BusDoctorResult> {
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  const paths = await resolveBusPaths(root, false);
  const findings = await busLayoutFindings(paths);
  if (findings.length > 0) {
    return { healthy: false, summary: emptyBusSummary(), findings };
  }
  try {
    await readBusInstance(paths.projectRoot);
  } catch (err) {
    findings.push(`instance: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    for (const entry of await readdir(paths.locks, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".reap")) {
        findings.push(`lock recovery guard requires explicit owner inspection: ${entry.name}`);
      }
    }
  } catch (err) {
    findings.push(`locks: ${err instanceof Error ? err.message : String(err)}`);
  }
  const endpoints = await listEndpoints(paths.projectRoot);
  findings.push(...endpoints.findings.map((finding) => `endpoint: ${finding}`));
  const activeRoles = new Map<BusRole, number>();
  for (const endpoint of endpoints.endpoints.filter((candidate) => !candidate.retiredAt)) {
    activeRoles.set(endpoint.role, (activeRoles.get(endpoint.role) ?? 0) + 1);
  }
  for (const [role, count] of activeRoles) {
    if (count > 1) findings.push(`role ${role} has ${count} active endpoints`);
  }

  const folds: FoldedBusThread[] = [];
  try {
    for (const entry of await readdir(paths.threads, { withFileTypes: true })) {
      if (entry.name.startsWith(".tmp-")) findings.push(`thread staging directory was not published: ${entry.name}`);
      else if (entry.isDirectory() && !ThreadIdSchema.safeParse(entry.name).success) {
        findings.push(`invalid thread directory: ${entry.name}`);
      }
    }
  } catch (err) {
    findings.push(`threads: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const threadId of await listThreadIds(paths)) {
    try {
      const folded = await foldBusThread(paths.projectRoot, threadId);
      folds.push(folded);
      if (folded.integrity !== "verified") findings.push(`thread ${threadId}: ${folded.finding ?? "quarantined"}`);
    } catch (err) {
      findings.push(`thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const role of BusRoleSchema.options) {
    const mailbox = await mailboxPointers(paths, role);
    findings.push(...mailbox.findings.map((finding) => `${role} mailbox: ${finding}`));
    const pendingCount = (await listRegularJsonFiles(join(roleMailboxPath(paths, role), "pending")))
      .filter((filename) => POINTER_FILENAME.test(filename)).length;
    if (pendingCount > 0) findings.push(`${role} mailbox: ${pendingCount} pending intent(s) require poll recovery`);
    const maxSeq = mailbox.pointers.reduce((maximum, pointer) => Math.max(maximum, pointer.mailboxSeq), 0);
    try {
      const counter = await readJsonNoFollow(
        join(roleMailboxPath(paths, role), "counter.json"),
        BusMailboxCounterSchema,
      );
      if (counter.nextSeq <= maxSeq) findings.push(`${role} mailbox counter is behind sequence ${maxSeq}`);
    } catch (err) {
      if (!(err instanceof BusError) || err.code !== "not_found" || maxSeq > 0) {
        findings.push(`${role} mailbox counter: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  for (const filename of await listRegularJsonFiles(paths.succession)) {
    try {
      const record = await readJsonNoFollow(join(paths.succession, filename), BusSuccessionSchema);
      if (filename !== `${record.tokenHash}.json`) {
        findings.push(`succession: ${filename} does not match its token hash`);
      }
    } catch (err) {
      findings.push(`succession ${filename}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    await readBusHookPolicy(paths.projectRoot);
  } catch (err) {
    findings.push(`hook policy: ${err instanceof Error ? err.message : String(err)}`);
  }
  const summary = await summarizeFrom(paths, loaded.state, endpoints.endpoints, folds);
  return { healthy: findings.length === 0, summary, findings };
}

async function summarizeFrom(
  paths: BusPaths,
  state: ProjectState,
  endpoints: readonly BusEndpoint[],
  suppliedFolds?: readonly FoldedBusThread[],
): Promise<BusSummary> {
  const folds = suppliedFolds ? [...suppliedFolds] : await Promise.all(
    (await listThreadIds(paths)).map((threadId) => foldBusThread(paths.projectRoot, threadId)),
  );
  const pendingIds = new Set<string>();
  let unacknowledgedCritical = 0;
  for (const folded of folds) {
    for (const message of folded.messages) {
      if (!folded.acknowledgments.has(message.messageId)) {
        pendingIds.add(message.messageId);
        if (message.severity === "critical") unacknowledgedCritical += 1;
      }
    }
  }
  let hookDelivery = { claude: false, codex: false };
  try {
    const policy = await readBusHookPolicy(paths.projectRoot);
    hookDelivery = { claude: policy.claude, codex: policy.codex };
  } catch {
    // Doctor reports policy corruption; status remains available.
  }
  return {
    enabled: true,
    daemonState: "stopped",
    endpoints: endpoints.filter((endpoint) => !endpoint.retiredAt).length,
    pendingMessages: pendingIds.size,
    unacknowledgedCritical,
    openThreads: folds.filter((folded) => folded.state === "open").length,
    parkedThreads: folds.filter((folded) => folded.state === "parked").length,
    undeliverable: 0,
    quarantined: folds.filter((folded) => folded.integrity !== "verified").length,
    hookDelivery,
  };
}

export async function busSummary(root: string, state?: ProjectState): Promise<BusSummary> {
  const loadedState = state ?? (await loadProject(root)).state;
  assertBusEnabled(loadedState.config);
  const paths = await resolveBusPaths(root, false);
  await assertBusLayout(paths);
  await readBusInstance(paths.projectRoot);
  return summarizeFrom(paths, loadedState, (await listEndpoints(paths.projectRoot)).endpoints);
}

export interface BusShipCheck {
  readonly clear: boolean;
  readonly blockers: readonly string[];
}

export async function checkBusShip(root: string): Promise<BusShipCheck> {
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  const paths = await resolveBusPaths(root, false);
  await assertBusLayout(paths);
  await readBusInstance(paths.projectRoot);
  const blockers: string[] = [];
  for (const threadId of await listThreadIds(paths)) {
    const folded = await foldBusThread(paths.projectRoot, threadId);
    const issue = folded.thread.topicRef.issue
      ? loaded.state.issueByID(folded.thread.topicRef.issue)
      : undefined;
    const critical = issue?.severity === "critical" || folded.messages.some((message) => message.severity === "critical");
    if (!critical) continue;
    const label = issue ? displayIdOf(issue) : `Bus thread ${threadId}`;
    if (folded.integrity !== "verified") blockers.push(`${label}: quarantined Bus thread ${threadId}`);
    if (folded.messages.some((message) => message.severity === "critical" && !folded.acknowledgments.has(message.messageId))) {
      blockers.push(`${label}: unacknowledged critical Bus message`);
    }
    if (folded.state === "parked" && (!issue || issue.status !== "resolved")) {
      blockers.push(`${label}: parked Bus thread with unresolved critical issue`);
    }
  }
  return { clear: blockers.length === 0, blockers: [...new Set(blockers)] };
}

export async function exportBusThread(root: string, threadId: string, format: "json" | "md"): Promise<string> {
  const folded = await foldBusThread(root, threadId);
  if (format === "json") {
    return JSON.stringify({
      thread: folded.thread,
      entries: folded.entries,
      state: folded.state,
      hopCount: folded.hopCount,
      integrity: folded.integrity,
      finding: folded.finding ?? null,
    }, null, 2);
  }
  const lines = [
    `# Storybloq Bus thread ${threadId}`,
    "",
    `Kind: ${folded.thread.kind} | State: ${folded.state} | Integrity: ${folded.integrity}`,
    `Topic: ${JSON.stringify(folded.thread.topicRef)}`,
    "",
  ];
  for (const entry of folded.entries) {
    if (entry.type === "message") {
      lines.push(`## ${entry.seq}. ${entry.payload.from.role} to ${entry.payload.toRole}`, "", entry.payload.body, "");
    } else {
      lines.push(`## ${entry.seq}. ${entry.type}`, "", "```json", JSON.stringify(entry.payload, null, 2), "```", "");
    }
  }
  return lines.join("\n").trimEnd();
}

export async function pendingMailboxCursor(root: string, role: BusRole): Promise<{ cursor: number; count: number }> {
  const paths = await resolveBusPaths(root, false);
  const mailbox = await mailboxPointers(paths, role);
  let cursor = 0;
  let count = 0;
  for (const pointer of mailbox.pointers) {
    try {
      const folded = await foldBusThread(paths.projectRoot, pointer.threadId);
      const entry = folded.entries[pointer.entrySeq - 1];
      if (entry?.type === "message" && entry.payload.messageId === pointer.messageId &&
          !folded.acknowledgments.has(pointer.messageId)) {
        cursor = Math.max(cursor, pointer.mailboxSeq);
        count += 1;
      }
    } catch {
      // Hook delivery fails open; doctor provides the durable diagnostic.
    }
  }
  return { cursor, count };
}
