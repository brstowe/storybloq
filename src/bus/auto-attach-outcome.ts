// T-430: auto-attach outcome records. The detached child owns every write to these; the
// SessionStart hook and per-turn retry only READ them (constant-time, no lock, no /bin/ps)
// to decide spawn-suppression + backoff, and `bus status` reads them to surface degraded
// attempts. Keyed per task by canonicalHash({client, clientTaskId}) so the filename is a
// portable, non-reversible hash (hence `client` is also stored in the body).

import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BusClientSchema, type BusClient } from "./schemas.js";
import { canonicalHash } from "./canonical.js";
import { BusError } from "./errors.js";
import { durableWrite, durableUnlink, readJsonNoFollow } from "./io.js";
import { resolveBusPaths, type BusPaths } from "./paths.js";

// Bounded recovery-reason enum. Each maps to one concrete instruction in status/doctor, so
// no free-form exception text is ever persisted.
export const AUTO_ATTACH_REASONS = [
  "materialization_failed",
  "succession_chain_corrupt",
  "endpoint_inactive",
  "delivery_policy_failed",
  "tool_hook_failed",
  "capacity_full",
  "runtime_absent",
  "registry_corrupt",
  "runtime_incompatible",
  "race_lost",
  "internal_failure",
] as const;
export type AutoAttachReason = (typeof AUTO_ATTACH_REASONS)[number];

export const AUTO_ATTACH_KINDS = [
  "running",     // transient, written on lock-acquire; finalized to a terminal kind on exit
  "attached",
  "replaced",
  "converged",
  "degraded",
  "skipped_full",
  "failed",
] as const;
export type AutoAttachKind = (typeof AUTO_ATTACH_KINDS)[number];

// Terminal kinds that MUST carry a bounded reason (they represent a shortfall the user may
// need to act on); the success/transient kinds must NOT carry one.
const REASON_REQUIRED_KINDS = new Set<AutoAttachKind>(["degraded", "failed", "skipped_full"]);

export const AutoAttachOutcomeSchema = z.object({
  v: z.literal(1),
  client: BusClientSchema,
  kind: z.enum(AUTO_ATTACH_KINDS),
  endpointId: z.string().uuid().optional(),
  reason: z.enum(AUTO_ATTACH_REASONS).optional(),
  at: z.string().datetime({ offset: true }),
}).strict().superRefine((record, ctx) => {
  const needsReason = REASON_REQUIRED_KINDS.has(record.kind);
  if (needsReason && record.reason === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `kind '${record.kind}' requires a reason` });
  }
  if (!needsReason && record.reason !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `kind '${record.kind}' must not carry a reason` });
  }
});
export type AutoAttachOutcome = z.infer<typeof AutoAttachOutcomeSchema>;

// A `running` record older than this is treated as a dead child: the suppression hint stops
// honoring it and the next hook is allowed to spawn (the fresh child's try-lock reclaims).
export const RUNNING_FRESHNESS_MS = 30_000;
// After a terminal record, retries back off for this long so a just-failed child does not
// re-spawn on the very next tool event.
export const TERMINAL_BACKOFF_MS = 10_000;
// `bus status` surfaces recent no-endpoint attempts (skipped_full / failed) within this window.
export const STATUS_FRESHNESS_MS = 300_000;

export function autoAttachOutcomeKey(client: BusClient, clientTaskId: string): string {
  return canonicalHash({ client, clientTaskId });
}

// Exact outcome filename shape (a 64-hex canonical hash). Cleanup only ever touches files
// matching this, so unrelated evidence dropped in the dir is left for doctor to report.
const OUTCOME_FILENAME = /^[a-f0-9]{64}\.json$/;

// Resolve the auto-attach dir, rejecting a symlink at the dir itself before returning its path.
// THREAT MODEL (narrow, deliberate): this is the SAME lstat-validate-then-operate contract every
// other Bus path op uses (resolveBusPaths validates, callers then operate on the returned path).
// It is not claimed to be safe against an attacker who can swap the dir for a symlink in the
// window between this validation and the caller's op -- defeating that would require openat-style
// relative-descriptor operations Node does not portably expose, and it is out of scope here. What
// IS guaranteed: (a) the dir is a real directory at validation time; (b) the LEAF file operations
// go through no-follow primitives (readJsonNoFollow uses O_NOFOLLOW + inode identity; durableWrite
// writes via temp+rename; durableUnlink/lstat never follow a final-component symlink); and (c) on
// create, the leaf is made ONLY under an already-existing, non-symlink busRoot (non-recursive
// mkdir) so a deleted runtime is never resurrected. Returns null when absent and create=false.
async function validatedAutoAttachDir(paths: BusPaths, opts: { create: boolean }): Promise<string | null> {
  const dir = paths.autoAttach;
  try {
    const st = await lstat(dir);
    if (st.isSymbolicLink()) throw new BusError("corrupt", ".story/bus/auto-attach is a symlink");
    if (!st.isDirectory()) throw new BusError("corrupt", ".story/bus/auto-attach is not a directory");
    return dir;
  } catch (err) {
    if (err instanceof BusError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (!opts.create) return null;
  // Absent: require an existing, non-symlink busRoot and create only the leaf. lstat throws
  // ENOENT if the runtime was deleted, so the write fails closed instead of resurrecting it.
  const rootStat = await lstat(paths.busRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new BusError("corrupt", ".story/bus is a symlink or not a directory");
  }
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // Revalidate the leaf after create: an EEXIST here can mean a symlink was planted at the path
  // between the initial lstat and this mkdir, so require a real, non-symlink directory before
  // returning it (closing that specific create-race; the general swap window is per the threat
  // model above).
  const created = await lstat(dir);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new BusError("corrupt", ".story/bus/auto-attach is a symlink or not a directory");
  }
  return dir;
}

export interface WriteOutcomeInput {
  readonly client: BusClient;
  readonly clientTaskId: string;
  readonly kind: AutoAttachKind;
  readonly endpointId?: string;
  readonly reason?: AutoAttachReason;
  readonly at: string;
}

export async function writeAutoAttachOutcome(root: string, input: WriteOutcomeInput): Promise<void> {
  const paths = await resolveBusPaths(root, false);
  const dir = await validatedAutoAttachDir(paths, { create: true });
  const record: AutoAttachOutcome = {
    v: 1,
    client: input.client,
    kind: input.kind,
    ...(input.endpointId ? { endpointId: input.endpointId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    at: input.at,
  };
  // Validate before persisting so a caller can never write a record the reader would reject
  // (e.g. a degraded kind with no reason).
  AutoAttachOutcomeSchema.parse(record);
  await durableWrite(join(dir!, `${autoAttachOutcomeKey(input.client, input.clientTaskId)}.json`), JSON.stringify(record));
}

export async function readAutoAttachOutcome(
  root: string,
  client: BusClient,
  clientTaskId: string,
): Promise<AutoAttachOutcome | null> {
  try {
    const paths = await resolveBusPaths(root, false);
    const dir = await validatedAutoAttachDir(paths, { create: false });
    if (!dir) return null;
    return await readJsonNoFollow(join(dir, `${autoAttachOutcomeKey(client, clientTaskId)}.json`), AutoAttachOutcomeSchema);
  } catch {
    // Missing / corrupt / unresolved runtime: the reader is a best-effort hint. A read error
    // never blocks a needed child (spawn proceeds), so treat it as "no record".
    return null;
  }
}

export async function removeAutoAttachOutcome(
  root: string,
  client: BusClient,
  clientTaskId: string,
): Promise<void> {
  const paths = await resolveBusPaths(root, false);
  const dir = await validatedAutoAttachDir(paths, { create: false });
  if (!dir) return;
  await durableUnlink(join(dir, `${autoAttachOutcomeKey(client, clientTaskId)}.json`));
}

// Remove every auto-attach outcome record for this project. Called by `bus auto-attach off`
// (the feature is disabled, so all records are moot) -- a write path, so read commands stay
// read-only. Only canonical-hash outcome files that are regular non-symlink files are removed;
// anything else is left for doctor to report. Best-effort: individual failures are swallowed.
export async function clearAutoAttachOutcomes(root: string): Promise<void> {
  let dir: string | null;
  try {
    dir = await validatedAutoAttachDir(await resolveBusPaths(root, false), { create: false });
  } catch {
    return;
  }
  if (!dir) return;
  let filenames: string[];
  try {
    filenames = await readdir(dir);
  } catch {
    return;
  }
  for (const filename of filenames) {
    if (!OUTCOME_FILENAME.test(filename)) continue;
    const target = join(dir, filename);
    try {
      const st = await lstat(target);
      if (!st.isFile()) continue; // never follow/remove a symlink or directory
    } catch {
      continue;
    }
    await durableUnlink(target).catch(() => undefined);
  }
}

export interface ListedOutcome {
  readonly key: string;
  readonly outcome: AutoAttachOutcome;
}

export async function listAutoAttachOutcomes(root: string): Promise<ListedOutcome[]> {
  let dir: string | null;
  try {
    dir = await validatedAutoAttachDir(await resolveBusPaths(root, false), { create: false });
  } catch {
    return [];
  }
  if (!dir) return [];
  let filenames: string[];
  try {
    filenames = await readdir(dir);
  } catch {
    return [];
  }
  const listed: ListedOutcome[] = [];
  for (const filename of filenames) {
    if (!OUTCOME_FILENAME.test(filename)) continue;
    try {
      const outcome = await readJsonNoFollow(join(dir, filename), AutoAttachOutcomeSchema);
      listed.push({ key: filename.slice(0, -".json".length), outcome });
    } catch {
      // Skip unreadable / unexpected files; never throw from a diagnostic list.
    }
  }
  return listed;
}

// Pure churn gate shared by the SessionStart hook and the per-turn retry. Given the current
// outcome record (or null) and the caller's live clock, decide whether spawning another child
// is worthwhile. Correctness never depends on this -- the child's try-lock is the sole
// concurrency authority -- it only suppresses redundant process launches.
export function shouldSpawnAutoAttach(
  outcome: AutoAttachOutcome | null,
  nowMs: number,
  opts: { runningFreshnessMs?: number; terminalBackoffMs?: number } = {},
): boolean {
  if (!outcome) return true;
  const ageMs = nowMs - Date.parse(outcome.at);
  if (!Number.isFinite(ageMs) || ageMs < 0) return true; // unparseable / clock skew -> allow
  if (outcome.kind === "running") {
    return ageMs >= (opts.runningFreshnessMs ?? RUNNING_FRESHNESS_MS);
  }
  return ageMs >= (opts.terminalBackoffMs ?? TERMINAL_BACKOFF_MS);
}
