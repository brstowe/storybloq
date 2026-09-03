import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BusError } from "./errors.js";
import { durableUnlink, durableWrite, readJsonNoFollow, rejectPathSymlink, syncDirectory } from "./io.js";
import { assertContainedPath, type BusPaths } from "./paths.js";

// Durable receipt index (D3). One receipt per (endpoint, idempotency key) binds
// the resolved operation, including the recipient, into payloadHash. Replay
// lookup is O(1) and never folds an unrelated thread, so a single quarantined
// thread can no longer block traffic (ISS-855). Receipts live as long as the
// runtime (no pruning this release; doctor reports orphans).
// `outcome` distinguishes a published message ("delivered") from an automatic
// park ("parked"). A DELIVERED receipt (pending OR final) MUST carry both
// messageId and mailboxSeq (allocated before the pending receipt is written, so
// crash recovery addresses the exact pointer by them) and MUST NOT carry a
// stateEntryHash. A PARKED receipt (pending OR final) carries no message and no
// mailbox pointer, so both are absent, and MUST carry the stateEntryHash of the
// automatic-park entry it commits: the pending parked receipt is written (with
// that hash) BEFORE appending the park entry and finalized after, so the
// pre-append crash window is recoverable and the committed park is bound to an
// exact entry. Because every parked writer preallocates the hash, a parked
// receipt without one is malformed, not "not yet landed" -- recovery must fail
// closed rather than treat it as an uncommitted attempt and drop it. `outcome`
// is left optional (absent means "delivered"); see the schema note below. The
// publication fields are non-nullable optional: a value is a valid identity and
// absence is the only permitted "not set", so an explicit null never sneaks a
// parked receipt past the "no publication identity" rule.
export const BusReceiptSchema = z.object({
  schema: z.literal("storybloq-bus-receipt/v1"),
  endpointId: z.string().uuid(),
  keyHash: z.string().regex(/^[a-f0-9]{64}$/),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  threadId: z.string().uuid(),
  toEndpoint: z.string().uuid(),
  messageId: z.string().uuid().optional(),
  mailboxSeq: z.number().int().positive().optional(),
  state: z.enum(["pending", "final"]),
  // Absent means "delivered" (a published message). A parked receipt (pending OR
  // final) sets "parked". Left optional (not defaulted) so the schema's input and
  // output types stay identical for the generic JSON reader.
  outcome: z.enum(["delivered", "parked"]).optional(),
  // The entryHash of the automatic-park state entry a parked receipt commits.
  // Recovery locates that exact entry in the folded chain (regardless of the
  // thread's later state) AND verifies its park semantics, so a subsequent
  // resolve/reopen or an unrelated park cannot lose or misattribute the committed
  // parked outcome. Required for parked receipts, forbidden for delivered ones.
  stateEntryHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  createdAt: z.string().datetime({ offset: true }),
}).passthrough().superRefine((receipt, ctx) => {
  if (receipt.outcome !== "parked") {
    // Delivered receipts (pending or final) MUST carry both publication fields and
    // MUST NOT carry a park-entry binding.
    if (receipt.messageId == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["messageId"], message: "messageId is required for a delivered receipt" });
    }
    if (receipt.mailboxSeq == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mailboxSeq"], message: "mailboxSeq is required for a delivered receipt" });
    }
    if (receipt.stateEntryHash != null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["stateEntryHash"], message: "stateEntryHash must be absent for a delivered receipt" });
    }
  } else {
    // Parked receipts (pending or final) have no message and no mailbox pointer, so
    // a present publication field is a malformed record, not a valid park. They MUST
    // carry the automatic-park entry binding recovery verifies by hash and semantics.
    if (receipt.messageId != null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["messageId"], message: "messageId must be absent for a parked receipt" });
    }
    if (receipt.mailboxSeq != null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mailboxSeq"], message: "mailboxSeq must be absent for a parked receipt" });
    }
    if (receipt.stateEntryHash == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["stateEntryHash"], message: "stateEntryHash is required for a parked receipt" });
    }
  }
});
export type BusReceipt = z.infer<typeof BusReceiptSchema>;

const KeyHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const EndpointIdSchema = z.string().uuid();

function receiptDir(paths: BusPaths, endpointId: string): string {
  // Validate the endpointId as a bare UUID BEFORE joining it into a path. Lexical
  // containment alone does not stop symlink traversal through an INTERMEDIATE
  // component: a multi-component id such as `link/<uuid>` stays lexically contained
  // while `idempotency/link` (a symlink) redirects every subsequent lstat/mkdir/
  // read/write/unlink outside the runtime, because the per-endpoint symlink guard
  // only lstats the final path component. A UUID id can contain no separator.
  if (!EndpointIdSchema.safeParse(endpointId).success) {
    throw new BusError("invalid_input", "Invalid endpoint id");
  }
  const dir = join(paths.idempotency, endpointId);
  assertContainedPath(paths.idempotency, dir);
  return dir;
}

export function receiptPath(paths: BusPaths, endpointId: string, keyHash: string): string {
  if (!KeyHashSchema.safeParse(keyHash).success) {
    throw new BusError("invalid_input", "Invalid idempotency key hash");
  }
  const path = join(receiptDir(paths, endpointId), `${keyHash}.json`);
  assertContainedPath(paths.idempotency, path);
  return path;
}

// Reject a symlinked per-endpoint receipt directory before any read, write, or
// unlink through it. assertBusLayout does not cover these lazily-created children,
// so a tampered runtime could point idempotency/<endpointId> outside .story/bus;
// readJsonNoFollow and durableUnlink only guard the final path component with
// O_NOFOLLOW, not a symlinked PARENT, and lexical containment does not stop symlink
// traversal. Tolerates a genuinely absent directory (first write / no receipt yet).
async function assertReceiptDirSafe(paths: BusPaths, endpointId: string): Promise<string> {
  const dir = receiptDir(paths, endpointId);
  await rejectPathSymlink(dir);
  return dir;
}

export async function readReceipt(
  paths: BusPaths,
  endpointId: string,
  keyHash: string,
): Promise<BusReceipt | null> {
  await assertReceiptDirSafe(paths, endpointId);
  try {
    const receipt = await readJsonNoFollow(receiptPath(paths, endpointId, keyHash), BusReceiptSchema);
    // Bind the loaded receipt to its own location: a receipt copied or misfiled
    // into another endpoint's directory or another keyHash filename must fail
    // closed rather than be honored as the requested idempotency record.
    if (receipt.endpointId !== endpointId || receipt.keyHash !== keyHash) {
      throw new BusError("corrupt", "Receipt identity does not match its storage location");
    }
    return receipt;
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") return null;
    throw err;
  }
}

export async function writeReceipt(paths: BusPaths, receipt: BusReceipt): Promise<void> {
  // Validate the receipt AND resolve its guarded target path BEFORE any filesystem
  // mutation. Previously the per-endpoint dir was created and fsynced before the
  // receipt was parsed, so a malformed receipt left an empty idempotency directory
  // behind. receiptPath runs the receiptDir UUID guard and the keyHash guard, so an
  // invalid endpointId/keyHash also throws here with zero filesystem mutation.
  const parsedReceipt = BusReceiptSchema.safeParse(receipt);
  if (!parsedReceipt.success) {
    const issue = parsedReceipt.error.issues[0];
    throw new BusError(
      "invalid_input",
      `Invalid receipt${issue ? `: ${issue.path.join(".")} ${issue.message}` : ""}`,
    );
  }
  const parsed = parsedReceipt.data;
  const path = receiptPath(paths, parsed.endpointId, parsed.keyHash);
  const dir = await assertReceiptDirSafe(paths, parsed.endpointId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Make the per-endpoint receipt directory entry durable in paths.idempotency
  // BEFORE the receipt content is published. Otherwise a power loss can preserve
  // the published message + mailbox pointer while losing the receipt directory
  // entry, and a retry would republish a duplicate.
  await syncDirectory(paths.idempotency);
  await durableWrite(path, JSON.stringify(parsed, null, 2) + "\n");
}

export async function removeReceipt(paths: BusPaths, endpointId: string, keyHash: string): Promise<void> {
  await assertReceiptDirSafe(paths, endpointId);
  await durableUnlink(receiptPath(paths, endpointId, keyHash));
}
