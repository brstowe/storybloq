import { join } from "node:path";
import { z } from "zod";
import { canonicalHash, hashWithoutKey } from "./canonical.js";
import { BusError } from "./errors.js";
import { durableWrite, listRegularJsonFiles, readJsonNoFollow } from "./io.js";
import { resolveBusPaths } from "./paths.js";
import {
  BUS_MAX_ENTRY_BYTES,
  BusEntrySchema,
  BusThreadRecordSchema,
  type BusAckPayload,
  type BusEntry,
  type BusMessagePayload,
  type FoldedBusThread,
} from "./schemas.js";
import { evidenceKey } from "./security.js";

const ThreadIdSchema = z.string().uuid();
const ENTRY_FILENAME = /^(\d{6})-(message|ack|state|wake)-([0-9a-f-]{36})\.json$/;
const BusDerivedRecordSchema = z.object({
  schema: z.literal("storybloq-bus-derived/v1"),
  threadId: z.string().uuid(),
  lastSeq: z.number().int().nonnegative(),
  lastHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["open", "parked", "resolved"]),
  hopCount: z.number().int().nonnegative(),
  pendingMessageIds: z.array(z.string().uuid()),
  integrity: z.enum(["verified", "quarantined"]),
  finding: z.string().nullable(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

function entryHash(entry: BusEntry): string {
  return hashWithoutKey(entry as unknown as Record<string, unknown>, "entryHash");
}

function threadHash(thread: z.infer<typeof BusThreadRecordSchema>): string {
  return hashWithoutKey(thread as unknown as Record<string, unknown>, "threadHash");
}

function ackTransitionAllowed(previous: BusAckPayload | undefined, next: BusAckPayload): boolean {
  if (!previous) return true;
  if (previous.disposition === next.disposition && previous.reason === next.reason) return true;
  return previous.disposition === "deferred" &&
    (next.disposition === "accepted" || next.disposition === "rejected");
}

function actionableMessage(message: BusMessagePayload): boolean {
  return ["issue_notice", "question", "reply", "patch_request"].includes(message.kind);
}

export async function foldBusThread(root: string, threadId: string): Promise<FoldedBusThread> {
  const parsedId = ThreadIdSchema.safeParse(threadId);
  if (!parsedId.success) throw new BusError("invalid_input", "Invalid Bus thread id");
  const paths = await resolveBusPaths(root, false);
  const threadDir = join(paths.threads, threadId);
  const thread = await readJsonNoFollow(join(threadDir, "thread.json"), BusThreadRecordSchema);
  if (thread.threadId !== threadId) throw new BusError("corrupt", "Thread id does not match its directory");

  const entries: BusEntry[] = [];
  const messages: BusMessagePayload[] = [];
  const acknowledgments = new Map<string, BusAckPayload>();
  const seenEvidence = new Set<string>();
  let state: "open" | "parked" | "resolved" = "open";
  let hopCount = 0;
  let lastHash = thread.threadHash;
  let finding: string | undefined;

  if (threadHash(thread) !== thread.threadHash) {
    finding = "thread.json hash mismatch";
  }

  const filenames = finding ? [] : await listRegularJsonFiles(join(threadDir, "entries"));
  for (let index = 0; !finding && index < filenames.length; index++) {
    const filename = filenames[index]!;
    const match = ENTRY_FILENAME.exec(filename);
    const expectedSeq = index + 1;
    if (!match || Number(match[1]) !== expectedSeq) {
      finding = `${filename}: expected contiguous sequence ${expectedSeq}`;
      break;
    }
    let entry: BusEntry;
    try {
      entry = await readJsonNoFollow(join(threadDir, "entries", filename), BusEntrySchema, BUS_MAX_ENTRY_BYTES);
    } catch (err) {
      finding = `${filename}: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
    if (entry.threadId !== thread.threadId || entry.seq !== expectedSeq ||
        entry.type !== match[2] || entry.entryId !== match[3]) {
      finding = `${filename}: envelope does not match filename or thread`;
      break;
    }
    if (entry.prevHash !== lastHash || entryHash(entry) !== entry.entryHash) {
      finding = `${filename}: integrity chain mismatch`;
      break;
    }

    if (entry.type === "message") {
      const message = entry.payload;
      if (state === "resolved") {
        finding = `${filename}: resolved thread received a message`;
        break;
      }
      if (!thread.participantRoles.includes(message.from.role) ||
          !thread.participantRoles.includes(message.toRole) ||
          message.from.role === message.toRole) {
        finding = `${filename}: invalid message direction`;
        break;
      }
      if (message.inReplyTo && !messages.some((candidate) => candidate.messageId === message.inReplyTo)) {
        finding = `${filename}: reply target does not exist in the valid prefix`;
        break;
      }
      messages.push(message);
      if (actionableMessage(message)) hopCount += 1;
      if (message.refs.commit) seenEvidence.add(evidenceKey({ commit: message.refs.commit }));
      if (message.refs.ciRun) seenEvidence.add(evidenceKey({ ciRun: message.refs.ciRun }));
    } else if (entry.type === "ack") {
      const message = messages.find((candidate) => candidate.messageId === entry.payload.messageId);
      if (!message || !ackTransitionAllowed(acknowledgments.get(entry.payload.messageId), entry.payload)) {
        finding = `${filename}: invalid acknowledgment transition`;
        break;
      }
      acknowledgments.set(entry.payload.messageId, entry.payload);
    } else if (entry.type === "state") {
      const transition = entry.payload;
      if (transition.action === "park") {
        if (state !== "open" || !transition.reason) {
          finding = `${filename}: invalid park transition`;
          break;
        }
        state = "parked";
      } else if (transition.action === "resolve") {
        if (state === "resolved" || !transition.resolution || !transition.evidence) {
          finding = `${filename}: invalid resolve transition`;
          break;
        }
        state = "resolved";
      } else {
        if (state !== "parked" || !transition.reason || !transition.evidence) {
          finding = `${filename}: invalid reopen transition`;
          break;
        }
        const key = evidenceKey(transition.evidence);
        if (seenEvidence.has(key)) {
          finding = `${filename}: reopen evidence was already present`;
          break;
        }
        state = "open";
      }
      if (transition.evidence) seenEvidence.add(evidenceKey(transition.evidence));
    }

    entries.push(entry);
    lastHash = entry.entryHash;
  }

  if (!finding && entries.length === 0) finding = "thread has no immutable entries";

  return {
    thread,
    entries,
    validThroughSeq: entries.length,
    lastHash,
    state,
    hopCount,
    acknowledgments,
    messages,
    seenEvidence,
    integrity: finding ? "quarantined" : "verified",
    ...(finding ? { finding } : {}),
  };
}

function derivedContent(folded: FoldedBusThread) {
  return {
    schema: "storybloq-bus-derived/v1",
    threadId: folded.thread.threadId,
    lastSeq: folded.validThroughSeq,
    lastHash: folded.lastHash,
    state: folded.state,
    hopCount: folded.hopCount,
    pendingMessageIds: folded.messages
      .filter((message) => !folded.acknowledgments.has(message.messageId))
      .map((message) => message.messageId),
    integrity: folded.integrity,
    finding: folded.finding ?? null,
  } as const;
}

export async function writeDerivedThread(root: string, folded: FoldedBusThread): Promise<void> {
  const paths = await resolveBusPaths(root, false);
  const record = BusDerivedRecordSchema.parse({
    ...derivedContent(folded),
    updatedAt: new Date().toISOString(),
  });
  await durableWrite(
    join(paths.threads, folded.thread.threadId, "derived.json"),
    JSON.stringify(record, null, 2) + "\n",
  );
}

export async function ensureDerivedThread(root: string, folded: FoldedBusThread): Promise<boolean> {
  const paths = await resolveBusPaths(root, false);
  const path = join(paths.threads, folded.thread.threadId, "derived.json");
  try {
    const current = await readJsonNoFollow(path, BusDerivedRecordSchema);
    const { updatedAt: _updatedAt, ...currentContent } = current;
    if (canonicalHash(currentContent) === canonicalHash(derivedContent(folded))) return false;
  } catch {
    // Derived state is disposable and can be rebuilt from the verified prefix.
  }
  await writeDerivedThread(root, folded);
  return true;
}
