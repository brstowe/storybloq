import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ensureGitignoreEntries } from "../core/init.js";
import { withProjectLock, writeConfigUnlocked } from "../core/project-loader.js";
import { compareVersionStrings, currentCliVersion } from "../core/team-capabilities.js";
import { canonicalHash } from "./canonical.js";
import { BusError } from "./errors.js";
import { durableCreate, durableRename, readJsonNoFollow, syncDirectory, syncFile } from "./io.js";
import {
  appendTombstone,
  buildEvidence,
  buildTombstone,
  BUS_EVIDENCE_GITIGNORE_ENTRY,
  readBusEvidence,
  writeBusEvidence,
  type BusEvidenceRead,
} from "./runtime-evidence.js";
import {
  evaluateV1Drain,
  listV1Endpoints,
  v1EndpointLiveness,
  v1PathsFrom,
  V1InstanceSchema,
} from "./legacy-v1.js";
import { acquireHardenedLock, releaseHardenedLock, withHardenedLock, type HardenedLockHandle } from "./lock.js";
import {
  assertBaseBusLayout,
  assertBusLayout,
  assertBusIgnoreFileSafe,
  assertBusRuntimeIgnored,
  busRuntimeExists,
  createBusPathsForInitialization,
  requiredBusDirectories,
  resolveBusPaths,
  type BusPaths,
} from "./paths.js";

export const BUS_PROTOCOL_VERSION = 2 as const;
export const BUS_MIN_CLI_VERSION = "1.8.0" as const;

// v2 instance carries the protocol fence (D5). A future-versioned runtime is
// refused with a clear upgrade message; a 1.7.0 CLI fails the v1 BusInstanceSchema
// parse on this v2 literal, so its Bus ops fail closed while non-Bus commands run.
export const BusInstanceSchema = z.object({
  schema: z.literal("storybloq-bus-instance/v2"),
  instanceId: z.string().uuid(),
  projectRootHash: z.string().regex(/^[a-f0-9]{64}$/),
  protocolVersion: z.literal(2),
  minCliVersion: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
}).passthrough();
export type BusInstance = z.infer<typeof BusInstanceSchema>;

// Tolerant reader: enough to detect the schema literal and protocol version of
// any runtime (v1, v2, or a future version) without failing closed on additive
// fields.
const AnyInstanceSchema = z.object({
  schema: z.string(),
  instanceId: z.string().uuid(),
  projectRootHash: z.string().regex(/^[a-f0-9]{64}$/),
  protocolVersion: z.number().int().optional(),
  minCliVersion: z.string().optional(),
  createdAt: z.string().datetime({ offset: true }),
}).passthrough();

export interface InitializeBusResult {
  readonly enabled: boolean;
  readonly existing: boolean;
  readonly instanceId: string;
  readonly migrated: boolean;
  /**
   * The unread noncritical v1 mail entries this invocation actually force-archived
   * during migration, captured from the drain evaluation performed UNDER the
   * migration + v1 locks (commit-time truth), never a pre-lock preflight snapshot.
   * Empty unless this call both migrated a v1 runtime and force-archived unread
   * mail; a resume path that only finished a prior migrator's archive reports none.
   */
  readonly archivedUnread: readonly string[];
}

export interface InitializeBusOptions {
  /** Client task id of the caller, exempted from the drain gate's offline check. */
  readonly callerTaskId?: string;
  /** Overrides UNREAD NONCRITICAL delivery only; never ship-gate blockers. */
  readonly forceArchive?: boolean;
}

function protocolOf(raw: z.infer<typeof AnyInstanceSchema>): "v1" | "v2" | "future" | "unknown" {
  if (raw.schema === "storybloq-bus-instance/v1") return "v1";
  if (raw.schema === "storybloq-bus-instance/v2") {
    return (raw.protocolVersion ?? 2) > BUS_PROTOCOL_VERSION ? "future" : "v2";
  }
  // Fail closed: a schema that is neither the exact v1 nor exact v2 literal (a
  // corrupt, typo'd, or unknown instance that still parses under the tolerant
  // AnyInstanceSchema) is unrecognized, never a v1 that could be migrated.
  return "unknown";
}

function refuseFutureRuntime(raw: z.infer<typeof AnyInstanceSchema>): never {
  const current = currentCliVersion() ?? "unknown";
  const required = raw.minCliVersion ?? "a newer";
  throw new BusError(
    "upgrade_required",
    `This Bus runtime (protocol ${raw.protocolVersion ?? "?"}) requires storybloq ${required}; current CLI is ${current}. Run: npm update -g @storybloq/storybloq`,
  );
}

// The v2 minCliVersion fence (D5), mirroring assertTeamWriteCapabilities: a valid
// v2 runtime whose instance.json demands a newer CLI is refused with the same
// upgrade_required shape as refuseFutureRuntime so both messages read alike.
function refuseMinCliFence(raw: z.infer<typeof AnyInstanceSchema>): never {
  const current = currentCliVersion() ?? "unknown";
  const required = raw.minCliVersion ?? "a newer";
  throw new BusError(
    "upgrade_required",
    `This Bus runtime's instance.json requires storybloq ${required}; current CLI is ${current}. Run: npm update -g @storybloq/storybloq`,
  );
}

async function readInstanceRaw(paths: BusPaths): Promise<z.infer<typeof AnyInstanceSchema>> {
  return readJsonNoFollow(join(paths.busRoot, "instance.json"), AnyInstanceSchema);
}

// Centralized D5 version fence. Every reader routes through this so no code path
// returns a usable v2 instance for a runtime that demands a newer CLI: a future
// protocol or an unsupported minCliVersion is refused with the shared
// upgrade_required message, an unrecognized schema is corrupt, and a v1 runtime
// is reported so callers can migrate or refuse it. Returns the recognized
// protocol ("v1" | "v2") for the runtimes this CLI can operate.
function enforceRuntimeFence(raw: z.infer<typeof AnyInstanceSchema>): "v1" | "v2" {
  const protocol = protocolOf(raw);
  if (protocol === "future") refuseFutureRuntime(raw);
  if (protocol === "unknown") {
    throw new BusError(
      "corrupt",
      "Bus instance.json is unrecognized or corrupt. Run `storybloq bus doctor` for details, or `storybloq bus setup` to rebuild the runtime.",
    );
  }
  // v1 and valid v2 both pass the protocol check; only a v2 runtime carries the
  // instance.json minCliVersion fence (a v1 runtime is handled by its own
  // upgrade path).
  if (
    protocol === "v2" &&
    raw.minCliVersion !== undefined &&
    compareVersionStrings(currentCliVersion() ?? "0.0.0", raw.minCliVersion) < 0
  ) {
    refuseMinCliFence(raw);
  }
  return protocol;
}

async function readBusInstanceAtPaths(paths: BusPaths): Promise<BusInstance> {
  // Tolerant read first so the centralized version fence can refuse a future /
  // unknown / minCli-too-new runtime with its precise upgrade message before the
  // strict v2 parse would surface a generic schema-corrupt error.
  const raw = await readInstanceRaw(paths);
  enforceRuntimeFence(raw);
  const parsed = BusInstanceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BusError("corrupt", `Invalid schema in instance.json: ${parsed.error.issues[0]?.message ?? "unknown error"}`);
  }
  if (parsed.data.projectRootHash !== canonicalHash(paths.projectRoot)) {
    throw new BusError("conflict", "Bus instance belongs to a different canonical project root");
  }
  return parsed.data;
}

export async function readBusInstance(root: string): Promise<BusInstance> {
  return readBusInstanceAtPaths(await resolveBusPaths(root));
}

export type BusRuntimeProtocol = "none" | "v1" | "v2" | "future";

// Cheap, tolerant classification of the live runtime (D5). Lets the command and
// store layers route the legacy-drain surface (poll/ack/thread/export/status/
// doctor) to `legacy-v1.ts` on a v1 runtime while every other op keeps failing
// closed with upgrade_required. Never mutates; returns "none" when there is no
// runtime or no instance.json to classify.
export async function classifyBusRuntime(root: string): Promise<BusRuntimeProtocol> {
  const paths = await resolveBusPaths(root, false);
  if (!(await busRuntimeExists(paths.busRoot))) return "none";
  let raw: z.infer<typeof AnyInstanceSchema>;
  try {
    raw = await readInstanceRaw(paths);
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") return "none";
    throw err;
  }
  // The shared fence refuses a future / unknown / minCli-too-new runtime here so
  // this classifier cannot hand a bypassing v2 to the command layer.
  const protocol = enforceRuntimeFence(raw);
  if (protocol === "v2") {
    // A v2-literal instance can satisfy the tolerant AnyInstanceSchema while
    // missing required v2 fields, because protocolOf defaults an ABSENT
    // protocolVersion on a v2 literal to 2. Strict-validate the full v2 schema
    // and projectRootHash through the shared reader before returning "v2"; a
    // malformed v2 fails closed as `corrupt` (or a foreign-root `conflict`)
    // rather than being reported as a usable v2 runtime.
    await readBusInstanceAtPaths(paths);
  }
  return protocol;
}

// T-428: instance-level validation of a PRESENT v2 runtime, extracted from the
// resolver body. Returns the validated instance; deliberately does NOT assert the
// full layout so the assessment can share one code path with the join resolver
// (which heals a missing per-endpoint mailbox child). The strict resolver runs
// assertBusLayout afterward; the join resolver runs a base-directory check.
// v1 -> upgrade_required; missing/garbage instance.json -> corrupt; future / minCli
// -> upgrade_required; foreign projectRootHash -> conflict. Every throw propagates.
export async function validatePresentV2Runtime(paths: BusPaths): Promise<BusInstance> {
  let raw: z.infer<typeof AnyInstanceSchema>;
  try {
    raw = await readInstanceRaw(paths);
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") {
      throw new BusError("corrupt", "Bus runtime is missing instance.json. Run `storybloq bus doctor` for details.", err);
    }
    throw err;
  }
  if (protocolOf(raw) === "v1") {
    throw new BusError("upgrade_required", "This checkout has a v1 Bus runtime. Run `storybloq bus setup` to drain and upgrade it.");
  }
  // Shared reader enforces the version fence (future / minCli) + projectRootHash.
  return readBusInstanceAtPaths(paths);
}

// T-428: the layered runtime/evidence classification (round-3 precedence). A
// PRESENT runtime's validation OUTRANKS evidence interpretation: its
// upgrade_required / conflict / corrupt throws propagate before any evidence is
// read as loss. `lost` REQUIRES an evidence id (the single L-031 guard: no
// evidence -> never lost -> a fresh clone can never false-positive).
export type BusRuntimeAssessment =
  | { readonly kind: "fresh" }
  | { readonly kind: "ok"; readonly instance: BusInstance }
  | { readonly kind: "legacy_unmirrored"; readonly instance: BusInstance }
  | {
      readonly kind: "lost";
      readonly expectedInstanceId: string;
      readonly expectedCreatedAt?: string;
      readonly reason: "absent" | "mismatch";
      readonly foundInstanceId?: string;
      readonly instance?: BusInstance;
    }
  | { readonly kind: "evidence_corrupt"; readonly detail: string };

export async function assessBusRuntimeAtPaths(paths: BusPaths): Promise<BusRuntimeAssessment> {
  const evidence = await readBusEvidence(paths);
  // A present evidence file always carries an instanceId (the schema requires it;
  // an id-less file failed the parse and reads back `corrupt`), so no id guard is
  // needed below.
  if (!(await busRuntimeExists(paths.busRoot))) {
    if (evidence.kind === "corrupt") return { kind: "evidence_corrupt", detail: evidence.detail };
    if (evidence.kind === "present") {
      return {
        kind: "lost",
        expectedInstanceId: evidence.evidence.instanceId,
        ...(evidence.evidence.instanceCreatedAt ? { expectedCreatedAt: evidence.evidence.instanceCreatedAt } : {}),
        reason: "absent",
      };
    }
    return { kind: "fresh" };
  }
  // Runtime present: validate it FIRST; its throws win over evidence_corrupt.
  const instance = await validatePresentV2Runtime(paths);
  if (evidence.kind === "corrupt") return { kind: "evidence_corrupt", detail: evidence.detail };
  if (evidence.kind === "none") {
    return { kind: "legacy_unmirrored", instance };
  }
  if (evidence.evidence.instanceId === instance.instanceId) return { kind: "ok", instance };
  return {
    kind: "lost",
    expectedInstanceId: evidence.evidence.instanceId,
    ...(evidence.evidence.instanceCreatedAt ? { expectedCreatedAt: evidence.evidence.instanceCreatedAt } : {}),
    reason: "mismatch",
    foundInstanceId: instance.instanceId,
    instance,
  };
}

export async function assessBusRuntime(root: string): Promise<BusRuntimeAssessment> {
  return assessBusRuntimeAtPaths(await resolveBusPaths(root, false));
}

export function runtimeLostError(assessment: Extract<BusRuntimeAssessment, { kind: "lost" }>): BusError {
  const detail = assessment.reason === "absent"
    ? `the runtime for instance ${assessment.expectedInstanceId} is gone from this checkout`
    : `the runtime was replaced (expected instance ${assessment.expectedInstanceId}, found ${assessment.foundInstanceId})`;
  return new BusError(
    "runtime_lost",
    `Storybloq Bus runtime was lost: ${detail}. Prior peer coordination in \`.story/bus/\` cannot be recovered. Run \`storybloq bus setup\` to re-establish the Bus.`,
  );
}

function evidenceCorruptError(detail: string): BusError {
  return new BusError("corrupt", `Bus deletion-evidence is unreadable (${detail}). Run \`storybloq bus doctor\`.`);
}

const busNotInitializedError = () =>
  new BusError("not_found", "Bus is not initialized in this checkout. Run `storybloq bus setup` first.");

export async function resolveInitializedBusPaths(root: string): Promise<BusPaths> {
  const paths = await resolveBusPaths(root);
  // T-428: classify loss/evidence FIRST. A present runtime's validation throws
  // (v1 -> upgrade_required, garbage -> corrupt, foreign -> conflict) propagate
  // out of assessBusRuntimeAtPaths, preserving the prior resolver contract.
  const assessment = await assessBusRuntimeAtPaths(paths);
  if (assessment.kind === "lost") throw runtimeLostError(assessment);
  if (assessment.kind === "evidence_corrupt") throw evidenceCorruptError(assessment.detail);
  if (assessment.kind === "fresh") throw busNotInitializedError();
  // ok | legacy_unmirrored: the instance is already validated; assert the full layout.
  await assertBusLayout(paths);
  return paths;
}

// Like resolveInitializedBusPaths but validates ONLY the base runtime layout
// (busRoot/threads/endpoints/succession/mailboxes/locks/idempotency), not each
// endpoint's own mailbox + pending child. A same-task rejoin must be able to HEAL
// a crash that dropped an endpoint's `mailboxes/<id>/pending` directory; routing
// join through the full assertBusLayout would instead fail closed with `corrupt`
// on exactly that state, making the heal unreachable. The instance fence, v1
// refusal, and projectRootHash checks are identical to the strict resolver;
// callers run full assertBusLayout after healing.
export async function resolveInitializedBusPathsForJoin(root: string): Promise<BusPaths> {
  const paths = await resolveBusPaths(root);
  // T-428: same loss/evidence classification as the strict resolver; a present
  // runtime's validation throws (v1 / future / minCli / foreign / garbage)
  // propagate identically.
  const assessment = await assessBusRuntimeAtPaths(paths);
  if (assessment.kind === "lost") throw runtimeLostError(assessment);
  if (assessment.kind === "evidence_corrupt") throw evidenceCorruptError(assessment.detail);
  if (assessment.kind === "fresh") throw busNotInitializedError();
  // Base directories only; per-endpoint mailbox children are intentionally not
  // required here so a rejoin can recreate a missing one.
  await assertBaseBusLayout(paths);
  // The instance fence (version + projectRootHash) already ran inside
  // assessBusRuntimeAtPaths for the ok / legacy_unmirrored branches above.
  return paths;
}

function v2Instance(projectRoot: string): BusInstance {
  return BusInstanceSchema.parse({
    schema: "storybloq-bus-instance/v2",
    instanceId: randomUUID(),
    projectRootHash: canonicalHash(projectRoot),
    protocolVersion: BUS_PROTOCOL_VERSION,
    minCliVersion: BUS_MIN_CLI_VERSION,
    createdAt: new Date().toISOString(),
  });
}

async function pathPresent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    // Only a genuine absence is "not present"; an EACCES/EIO stat failure must
    // not be read as false-absence by the migration-resume decisions.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new BusError("io_error", `Cannot inspect ${path}: ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

// Reject a symlinked migration path before any mkdir/rm/durableRename through it.
// The bus-migration tree is created and destructively renamed/removed during the
// archive protocol and, unlike the live Bus paths, is NOT covered by assertBusLayout,
// so a tampered checkout could point bus-migration, its v2-staging, or its v1 archive
// outside .story and have migration acquire locks or recursively rm/rename external
// state. lstat without following; tolerate ENOENT (the normal not-yet-created case),
// fail closed (corrupt) on a symlink or a non-directory.
async function assertMigrationPathSafe(path: string, label: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new BusError("corrupt", `Migration path ${label} is not a regular directory`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    if (err instanceof BusError) throw err;
    throw new BusError("corrupt", `Cannot inspect migration path ${label}: ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

async function isValidV2Live(paths: BusPaths): Promise<boolean> {
  // Migration-resume guard: proof of a committed, usable v2 runtime is the full
  // v2 layout AND the shared reader (strict v2 schema, projectRootHash, and the
  // centralized version fence).
  //
  // Validity is TRI-STATE, not a plain boolean. Only proven schema/layout
  // corruption (`corrupt`) or an absent runtime (`not_found`) makes the live tree
  // invalid / quarantine-eligible and returns false. A VALID-but-incompatible
  // runtime (fence `upgrade_required` from a newer protocol / minCliVersion) or a
  // genuine project-root `conflict` (projectRootHash mismatch) is a GOOD committed
  // runtime this stale migrator must not touch: rethrow so the caller aborts
  // migration and leaves the live tree UNTOUCHED, rather than quarantining a valid
  // newer runtime and rebuilding an older one (DATA LOSS). Any other/ambiguous
  // failure (io_error, etc.) also propagates fail-closed rather than triggering a
  // destructive rebuild.
  try {
    await assertBusLayout(paths);
    await readBusInstanceAtPaths(paths);
    return true;
  } catch (err) {
    if (err instanceof BusError && (err.code === "corrupt" || err.code === "not_found")) {
      return false;
    }
    throw err;
  }
}

// True when the live path holds a VALID v1 runtime: its instance.json parses as the
// strict V1InstanceSchema. Used to disambiguate the "leftover bus-migration/v1 while
// a v1 is live" resume state: a live valid v1 plus a leftover archive is ambiguous
// (which v1 is authoritative?), so migration must fail closed and touch neither tree
// rather than rename the live v1 to `alien-*` and rebuild from the stale leftover.
//
// Validity is TRI-STATE, exactly like isValidV2Live: only proven absence (`not_found`)
// or schema/symlink corruption (`corrupt`) returns false. Failure to PROVE validity is
// not proof of non-authority: an io_error/EACCES/EIO reading the live instance must
// propagate fail-closed so the caller aborts, rather than collapsing to false and
// falling through to a destructive `durableRename(liveBus, alien-*)` + rebuild from the
// possibly-stale leftover archive (DATA LOSS during a transient I/O failure).
// Exported for direct tri-state unit coverage: the resume ambiguity guard depends on
// this returning false ONLY for proven-absent/corrupt and PROPAGATING io_error, and
// that branch is not reachable end-to-end (the pre-flight fence reads the same instance
// first), so it is pinned by a targeted unit test rather than through initializeBus.
export async function isValidV1Live(busRoot: string): Promise<boolean> {
  try {
    await readJsonNoFollow(join(busRoot, "instance.json"), V1InstanceSchema);
    return true;
  } catch (err) {
    if (err instanceof BusError && (err.code === "corrupt" || err.code === "not_found")) {
      return false;
    }
    throw err;
  }
}

// Build (or rebuild) the v2 staging tree and validate it. Idempotent in every
// resume state.
async function buildV2Staging(stagingRoot: string, projectRoot: string): Promise<void> {
  // `force: true` already ignores ENOENT (a not-yet-created staging root), so no
  // catch is needed. Do NOT swallow a real failure here (EACCES, ENOTDIR, EBUSY): a
  // silently-suppressed rm would leave stale staging content that the rebuild below
  // then trusts as clear. Any non-ENOENT error must propagate and abort the rebuild.
  await rm(stagingRoot, { recursive: true, force: true });
  const stagingPaths = {
    ...(await resolveBusPaths(projectRoot)),
    busRoot: stagingRoot,
    threads: join(stagingRoot, "threads"),
    endpoints: join(stagingRoot, "endpoints"),
    succession: join(stagingRoot, "succession"),
    mailboxes: join(stagingRoot, "mailboxes"),
    idempotency: join(stagingRoot, "idempotency"),
    locks: join(stagingRoot, "locks"),
  } as BusPaths;
  for (const directory of requiredBusDirectories(stagingPaths)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await durableCreate(join(stagingRoot, "instance.json"), JSON.stringify(v2Instance(projectRoot), null, 2) + "\n");
  await assertBusLayout(stagingPaths);
  await syncDirectory(stagingRoot);
}

// Per-endpoint child locks, enumerated while endpoints.lock is already held so no
// v1 creator can add an endpoint between enumeration and acquisition. Fails closed
// (throws corrupt) on any corrupt endpoint record rather than proceeding with a
// partial lock set. Deterministic sorted order within the tier.
async function enumerateV1EndpointLocks(busRoot: string): Promise<string[]> {
  const locksDir = join(busRoot, "locks");
  const scan = await listV1Endpoints(v1PathsFrom(busRoot));
  if (scan.findings.length > 0) {
    throw new BusError(
      "corrupt",
      `Cannot enumerate v1 locks: corrupt endpoint records must be resolved before migration:\n${scan.findings.map((finding) => `- ${finding}`).join("\n")}`,
    );
  }
  // Dedupe by lock path (belt-and-suspenders). listV1Endpoints now requires every
  // record's filename stem to equal its endpointId, so two records sharing an
  // endpointId always surface as a finding above and this enumerator throws before
  // reaching here. The dedupe is retained defensively: were two records ever to map
  // to the same endpoint-<id>.lock, acquiring the non-reentrant hardened lock twice
  // would self-block until timeout and stall migration, so each unique lock is
  // acquired once.
  const lockPaths = new Set(
    scan.endpoints.map((endpoint) => join(locksDir, `endpoint-${endpoint.endpointId}.lock`)),
  );
  return [...lockPaths].sort();
}

// Per-thread child locks, enumerated while threads.lock is already held so no v1
// creator can add a thread between enumeration and acquisition. A genuinely absent
// threads dir yields no thread locks; any other read failure fails closed (throws
// corrupt) rather than proceeding with a partial lock set. Deterministic sorted
// order within the tier.
async function enumerateV1ThreadLocks(busRoot: string): Promise<string[]> {
  const locksDir = join(busRoot, "locks");
  let threadEntries;
  try {
    threadEntries = await readdir(join(busRoot, "threads"), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new BusError("corrupt", `Cannot enumerate v1 thread locks: ${err instanceof Error ? err.message : String(err)}`, err);
    }
  }
  const names: string[] = [];
  for (const entry of threadEntries ?? []) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) names.push(`thread-${entry.name}.lock`);
  }
  return names.sort().map((name) => join(locksDir, name));
}

// The fixed per-role mailbox + reconcile locks and the hook-policy lock, acquired
// last (they are not scoped to a creation lock and sort after the endpoint-/thread-
// creation-scoped tiers in the v1 send order). Deterministic sorted order.
function v1FixedChildLocks(busRoot: string): string[] {
  const locksDir = join(busRoot, "locks");
  const names = new Set<string>(["hook-policy.lock"]);
  for (const role of ["implementer", "reviewer"]) {
    names.add(`mailbox-${role}.lock`);
    names.add(`mailbox-reconcile-${role}.lock`);
  }
  return [...names].sort().map((name) => join(locksDir, name));
}

async function withV1Locks<T>(busRoot: string, handler: () => Promise<T>): Promise<T> {
  const locksDir = join(busRoot, "locks");
  const handles: HardenedLockHandle[] = [];
  const acquire = async (lockPath: string): Promise<void> => {
    handles.push(await acquireHardenedLock(lockPath, { timeoutMs: 15_000 }));
  };
  try {
    // Acquire migration locks in an order COMPATIBLE with a v1 send, which is
    // endpoint-scoped first (holds endpoint-<id>.lock) and only then acquires the
    // threads.lock creation lock. Acquiring endpoints.lock -> per-endpoint locks
    // -> threads.lock -> per-thread locks -> the fixed mailbox/reconcile/hook-
    // policy locks matches that ordering, so migration never holds threads.lock
    // while waiting on an endpoint-<id>.lock (the previous inversion that
    // deadlocked against a concurrent v1 send). Holding a creation lock
    // (endpoints.lock / threads.lock) before enumerating its child locks prevents
    // a v1 creator from adding an endpoint or thread between enumeration and
    // acquisition. Each tier is acquired in deterministic sorted order, and the
    // top-level creation locks are held exactly once (excluded from the child
    // enumerations).
    await acquire(join(locksDir, "endpoints.lock"));
    for (const lockPath of await enumerateV1EndpointLocks(busRoot)) await acquire(lockPath);
    await acquire(join(locksDir, "threads.lock"));
    for (const lockPath of await enumerateV1ThreadLocks(busRoot)) await acquire(lockPath);
    for (const lockPath of v1FixedChildLocks(busRoot)) await acquire(lockPath);
    return await handler();
  } finally {
    for (const handle of handles.reverse()) await releaseHardenedLock(handle).catch(() => undefined);
  }
}

/**
 * v1 -> v2 upgrade (D5): drain gate, then an atomic, resumable archive protocol.
 * Runs under a single migration lock so concurrent setup/init calls serialize.
 */
async function migrateV1Runtime(paths: BusPaths, options: InitializeBusOptions): Promise<readonly string[]> {
  const migrationRoot = join(paths.storyRoot, "bus-migration");
  const stagingRoot = join(migrationRoot, "v2-staging");
  const archivedV1 = join(migrationRoot, "v1");
  const liveBus = paths.busRoot;

  // Guard the migration root BEFORE the mkdir below (which would follow a symlink)
  // and before the migration.lock is acquired at join(migrationRoot, ...).
  await assertMigrationPathSafe(migrationRoot, "bus-migration");
  await ensureGitignoreEntries(join(paths.storyRoot, ".gitignore"), ["bus/", "bus-migration/"]);
  await mkdir(migrationRoot, { recursive: true, mode: 0o700 });
  await syncDirectory(paths.storyRoot);

  return withHardenedLock(join(migrationRoot, "migration.lock"), async (): Promise<readonly string[]> => {
    // Re-validate the migration paths under the lock, immediately before any
    // destructive resume/staging/commit operation, so a symlink swapped in after the
    // pre-lock guard still fails closed rather than mutating outside .story.
    await assertMigrationPathSafe(migrationRoot, "bus-migration");
    await assertMigrationPathSafe(stagingRoot, "bus-migration/v2-staging");
    await assertMigrationPathSafe(archivedV1, "bus-migration/v1");
    // Resume driven by on-disk validity, never mere path presence. A resume path
    // finishes a PRIOR migrator's work, so THIS call force-archived nothing: it
    // reports no archived-unread entries (that prior migrator owned that report).
    if (await isValidV2Live(paths) && await pathPresent(archivedV1)) {
      // Committed v2 already live; finish archive.
      await finishArchive(paths, archivedV1, stagingRoot);
      return [];
    }
    if (await pathPresent(archivedV1) && !(await isValidV2Live(paths))) {
      // v1 archived, no valid v2 live: rebuild staging and re-commit. But if the live
      // path is itself a VALID v1 runtime, two v1 trees coexist (the live one and the
      // leftover bus-migration/v1) and neither can be proven authoritative. Renaming
      // the live v1 to `alien-*` and archiving the STALE leftover as authoritative
      // would risk losing the real work. Fail closed and leave BOTH trees untouched.
      if (await pathPresent(liveBus) && await isValidV1Live(liveBus)) {
        throw new BusError(
          "corrupt",
          "Ambiguous Bus migration state: a valid v1 runtime is live while a leftover bus-migration/v1 archive is also present. Cannot determine which v1 is authoritative. Resolve manually (remove or rename one) before re-running `storybloq bus setup`.",
        );
      }
      if (await pathPresent(liveBus)) {
        await durableRename(liveBus, join(migrationRoot, `alien-${Date.now()}`));
      }
      await buildV2Staging(stagingRoot, paths.projectRoot);
      await commitStaging(paths, stagingRoot, migrationRoot);
      await finishArchive(paths, archivedV1, stagingRoot);
      return [];
    }
    // Another migrator completed the upgrade while this call waited on the
    // migration lock: the live path is already a valid v2 runtime and its v1
    // archive has been finished (no `bus-migration/v1` remains). A fresh
    // migration here would durableRename the good v2 tree out of the live path
    // and quarantine it, losing the archived v1 threads. Stop -- the pre-lock
    // instance read that routed this call into migration is simply stale.
    if (await isValidV2Live(paths)) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      return [];
    }

    // Fresh migration. Evaluate the drain gate while holding the v1 locks. The
    // commit-time unread noncritical list captured here (not any pre-lock
    // preflight snapshot) is the authoritative record of what was force-archived.
    let forcedUnread: readonly string[] = [];
    await withV1Locks(liveBus, async () => {
      const v1 = v1PathsFrom(liveBus);
      // 1. Every OTHER active v1 endpoint must be positively offline.
      const { endpoints: v1Endpoints, findings: v1EndpointFindings } = await listV1Endpoints(v1);
      if (v1EndpointFindings.length > 0) {
        throw new BusError(
          "corrupt",
          `Cannot upgrade: the v1 Bus runtime has corrupt endpoint records that must be resolved before migration:\n${v1EndpointFindings.map((finding) => `- ${finding}`).join("\n")}`,
        );
      }
      for (const endpoint of v1Endpoints) {
        if (endpoint.retiredAt) continue;
        if (options.callerTaskId && endpoint.clientTaskId === options.callerTaskId) continue;
        const liveness = await v1EndpointLiveness(endpoint);
        if (liveness !== "offline") {
          throw new BusError(
            "conflict",
            `Cannot upgrade: endpoint ${endpoint.endpointId} is ${liveness}. Every peer must be positively offline before migration.`,
          );
        }
      }
      // 2. Nothing pending: ship gate clear and no unread noncritical mail.
      // This is the AUTHORITATIVE drain gate, evaluated under withV1Locks with every v1
      // writer quiesced, and it decides whether to archive the v1 tree. It folds strict:
      // no legitimate durable-write temp can exist here, so a temp-shaped entry can only be
      // a committed tail renamed to hide it, which must fail closed rather than be archived
      // as truncated-verified. Lock-free advisory callers (preflight, ship check) stay tolerant.
      const drain = await evaluateV1Drain(v1, { strictTemps: true });
      if (drain.shipBlockers.length > 0) {
        throw new BusError(
          "conflict",
          `Cannot upgrade: the v1 ship gate is blocked and requires canonical resolution first:\n${drain.shipBlockers.map((blocker) => `- ${blocker}`).join("\n")}`,
        );
      }
      if (drain.unreadNoncritical.length > 0 && options.forceArchive !== true) {
        throw new BusError(
          "conflict",
          `Cannot upgrade: unread noncritical Bus mail remains. Ack it, or pass --force-archive to archive it read-only:\n${drain.unreadNoncritical.map((entry) => `- ${entry}`).join("\n")}`,
        );
      }
      // Reaching here with unread noncritical mail means --force-archive is set,
      // so these exact entries are what this migration archives read-only.
      forcedUnread = drain.unreadNoncritical;

      await buildV2Staging(stagingRoot, paths.projectRoot);
      // From this rename every new v1 operation fails closed.
      await durableRename(liveBus, archivedV1);
    });

    await commitStaging(paths, stagingRoot, migrationRoot);
    await finishArchive(paths, archivedV1, stagingRoot);
    return forcedUnread;
  });
}

// Step 4 (commit point): move staging into the live path, quarantining any alien
// tree that reoccupied it (a paused pre-rename 1.7.0 process) and retrying.
async function commitStaging(paths: BusPaths, stagingRoot: string, migrationRoot: string): Promise<void> {
  if (!(await pathPresent(stagingRoot))) return; // already committed
  for (let attempt = 0; attempt < 3; attempt++) {
    // Quarantine only a PRE-rename alien tree provably occupying the live path (a
    // paused 1.7.0 process that reoccupied it). isValidV2Live distinguishes our
    // own committed v2 from an alien, so a valid committed v2 is never quarantined;
    // an incompatible-but-valid runtime propagates (never destroyed).
    if (await pathPresent(paths.busRoot) && !(await isValidV2Live(paths))) {
      await durableRename(paths.busRoot, join(migrationRoot, `alien-${Date.now()}-${attempt}`));
    }
    try {
      await durableRename(stagingRoot, paths.busRoot);
      return;
    } catch (err) {
      // durableRename can fail AFTER the underlying rename already succeeded (e.g.
      // an EIO during the parent-directory fsync). Re-inspect both ends before
      // retrying: if the live path is now a valid committed v2 tree and staging is
      // gone, the commit actually completed -- treat it as success, never
      // quarantine the committed tree.
      const committed = await isValidV2Live(paths);
      const stagingGone = !(await pathPresent(stagingRoot));
      if (committed && stagingGone) return;
      // Retry only when the rename provably never took effect: staging intact AND
      // the live path is still occupied by a pre-rename alien (not our valid v2).
      // Any other shape (destination indeterminate) is an ambiguous IO/fsync
      // failure -- propagate WITHOUT moving either tree.
      const renameNeverTookEffect = !committed && !stagingGone;
      if (!renameNeverTookEffect || attempt === 2) throw err;
    }
  }
}

// Step 5: archive the v1 runtime under the committed v2 tree, then clear staging.
async function finishArchive(paths: BusPaths, archivedV1: string, stagingRoot: string): Promise<void> {
  const archiveDir = join(paths.busRoot, "archive");
  // `archive` is created lazily here and is not part of the validated Bus layout,
  // so a tampered runtime could pre-place it (or its `v1` child) as a symlink to an
  // external directory; mkdir/durableRename would then follow it and move the
  // archived v1 runtime outside `.story/bus`. Reject a symlinked or non-directory
  // archive path before mkdir and again before the rename (both tolerate ENOENT).
  await assertMigrationPathSafe(archiveDir, "bus/archive");
  await mkdir(archiveDir, { recursive: true, mode: 0o700 });
  const archiveTarget = join(archiveDir, "v1");
  await assertMigrationPathSafe(archiveTarget, "bus/archive/v1");
  const archivedV1Present = await pathPresent(archivedV1);
  const archiveTargetPresent = await pathPresent(archiveTarget);
  // A rename is atomic, so the staged archive and its destination can never both
  // exist after a normal (crash-)interrupted finalize. Both present is an
  // inconsistent/tampered state: fail closed rather than silently skip the rename
  // and strand `bus-migration/v1` while reporting success.
  if (archivedV1Present && archiveTargetPresent) {
    throw new BusError("corrupt", "Both the staged v1 archive and its archive destination exist; cannot finalize safely");
  }
  if (archivedV1Present && !archiveTargetPresent) {
    await durableRename(archivedV1, archiveTarget);
  }
  await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  // Post-validation: the live path must contain exactly the v2 layout.
  await assertBusLayout(paths);
}

// Read-only classification + version fence of any EXISTING runtime (D5). Returns
// the recognized protocol ("v1" | "v2") this CLI can operate, or null when there
// is no runtime / no instance.json to classify. A future / unknown / minCli-
// incompatible runtime throws (upgrade_required / corrupt) so a caller can refuse
// it BEFORE any persistent mutation. Never mutates.
async function fenceExistingRuntime(paths: BusPaths): Promise<"v1" | "v2" | null> {
  if (!(await busRuntimeExists(paths.busRoot))) return null;
  let raw: z.infer<typeof AnyInstanceSchema> | null = null;
  try {
    raw = await readInstanceRaw(paths);
  } catch (err) {
    if (!(err instanceof BusError) || err.code !== "not_found") throw err;
    return null;
  }
  const protocol = enforceRuntimeFence(raw);
  if (protocol === "v2") {
    // A v2-literal instance can satisfy the tolerant AnyInstanceSchema while
    // missing required v2 fields (protocolOf defaults an ABSENT protocolVersion
    // on a v2 literal to 2). Strict-validate the full v2 schema + projectRootHash
    // here so a malformed v2 fails closed as `corrupt`/`conflict` BEFORE the
    // initializer mutates .gitignore or features.bus, mirroring classifyBusRuntime.
    await readBusInstanceAtPaths(paths);
  }
  return protocol;
}

export async function initializeBus(root: string, options: InitializeBusOptions = {}): Promise<InitializeBusResult> {
  const paths = await resolveBusPaths(root);

  // Read-only pre-flight fence on any EXISTING runtime BEFORE the project-lock
  // mutation block. A future / unknown / minCli-incompatible runtime is refused
  // (upgrade_required / corrupt) here, so `bus init` never flips features.bus nor
  // writes .gitignore entries against a runtime it cannot operate. The decision is
  // re-validated under the lock below to close the read-to-lock race; the
  // zero-mutation-before-refusal guarantee is what this pre-flight secures.
  await fenceExistingRuntime(paths);

  let enabledNow = false;
  let existingProtocol: "v1" | "v2" | null = null;
  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const storyRoot = join(root, ".story");
    await assertBusIgnoreFileSafe(storyRoot);
    // Re-read + fence the existing runtime UNDER the lock, before any mutation, so
    // a runtime that appeared or changed between the pre-flight read and lock
    // acquisition is still refused with zero mutation. This is the authoritative
    // decision that drives the migrate step below.
    existingProtocol = await fenceExistingRuntime(paths);
    // T-428: install the deletion-evidence ignore glob alongside bus/ BEFORE any
    // evidence write (ignore-rule-before-evidence invariant). The glob covers the
    // evidence file and every atomic-write temp sibling, so a crash mid-write can
    // never leak an un-ignored file into tracked `.story/`.
    await ensureGitignoreEntries(join(storyRoot, ".gitignore"), ["bus/", "bus-migration/", BUS_EVIDENCE_GITIGNORE_ENTRY]);
    // Durably flush the ignore rule so a power loss cannot preserve a
    // durably-written evidence file while losing the rule that hides it.
    await syncFile(join(storyRoot, ".gitignore"));
    await assertBusRuntimeIgnored(storyRoot);
    if (state.config.features.bus !== true) {
      await writeConfigUnlocked({
        ...state.config,
        features: { ...state.config.features, bus: true },
      }, root);
      enabledNow = true;
    }
  });

  let migrated = false;
  let archivedUnread: readonly string[] = [];
  if (existingProtocol === "v1") {
    // A v1 runtime is drained and upgraded. A future / unknown / minCli-too-new
    // runtime already threw under the lock above, before any mutation.
    archivedUnread = await migrateV1Runtime(paths, options);
    migrated = true;
  } else if (existingProtocol === "v2" &&
             await pathPresent(join(paths.storyRoot, "bus-migration", "v1"))) {
    // Resume a migration that crashed AFTER committing the v2 tree but BEFORE
    // finalizing the archive (step 4 done, step 5 not). A fresh call reads the
    // committed instance as v2 and would otherwise never re-enter migration,
    // stranding `bus-migration/v1` forever (and breaking `bus export` of archived
    // v1 threads). migrateV1Runtime's resume branch finishes the archive under the
    // migration lock; it force-archives nothing (the original migrator owned that).
    await migrateV1Runtime(paths, options);
  }

  // T-428: mint-or-reuse the instance AND reconcile deletion-evidence under a
  // FRESH project lock. Migration above ran with its own locks (the project lock
  // was NOT held), so this re-acquisition cannot deadlock. The .gitignore evidence
  // glob was installed (and fsynced) under the earlier lock block BEFORE any
  // evidence write, so the file (and its atomic-write temp) is ignored the instant
  // it lands. All mint/adopt/tombstone decisions are made from UNDER-LOCK state.
  let result: InitializeBusResult | null = null;
  await withProjectLock(root, { strict: true }, async () => {
    const paths2 = await resolveBusPaths(root);
    // Read evidence FIRST, before touching the runtime. Corrupt evidence is an
    // integrity failure (ops/doctor/ship all treat it as `corrupt`); setup must
    // NOT silently overwrite it (which would erase loss history). Fail closed and
    // leave both runtime and evidence untouched so the owner can inspect it.
    const priorEvidence = await readBusEvidence(paths2);
    if (priorEvidence.kind === "corrupt") {
      throw new BusError(
        "corrupt",
        `Bus deletion-evidence is unreadable (${priorEvidence.detail}). Inspect or remove \`.story/.bus-evidence.json\`, then run \`storybloq bus setup\`.`,
      );
    }
    // A PRESENT runtime must validate as a genuine v2 AND carry its full base
    // layout. A missing/garbage instance.json or a missing base directory over an
    // existing busRoot is a PARTIAL runtime (an L-031 integrity failure), never a
    // mint opportunity: minting there would silently re-identify a corrupt runtime.
    // Mint ONLY for a proven-absent runtime.
    const runtimePresent = await busRuntimeExists(paths2.busRoot);

    let instance: BusInstance;
    let minted: boolean;
    if (runtimePresent) {
      // Do NOT call createBusPathsForInitialization here: its recursive mkdir would
      // SILENTLY re-create a base directory that was deleted, masking the very
      // partial-deletion loss this ticket surfaces. Validate the instance and
      // assert the base layout instead; a missing base dir throws `corrupt`.
      instance = await validatePresentV2Runtime(paths2);
      await assertBaseBusLayout(paths2);
      minted = false;
    } else {
      // Proven-absent runtime: create the base layout and mint a fresh instance.
      const created = await createBusPathsForInitialization(root);
      const instancePath = join(created.busRoot, "instance.json");
      await durableCreate(instancePath, JSON.stringify(v2Instance(created.projectRoot), null, 2) + "\n");
      // Re-read the published instance under the lock before writing evidence, so
      // the evidence id reflects what actually landed on disk (crash-recovery
      // design): a torn or divergent write surfaces here rather than in evidence.
      instance = await readBusInstanceAtPaths(created);
      minted = true;
    }

    await reconcileEvidenceOnInit(paths2, instance, priorEvidence, minted);
    result = { enabled: true, existing: !minted, instanceId: instance.instanceId, migrated, archivedUnread };
  });
  // The handler always assigns `result` before returning (or throws, which
  // propagates); the guard keeps the type non-null for the caller.
  if (!result) throw new BusError("io_error", "Bus initialization did not complete.");
  return result;
}

// T-428: after mint-or-reuse under the project lock, persist evidence naming the
// live instance. When the prior evidence named a DIFFERENT instance, record a
// tombstone before overwriting so a genuine loss is never silently erased.
// FAIL-CLOSED: a failure to persist evidence throws, aborting setup; evidence
// shares the writable `.story/` domain the runtime already needs, so "cannot write
// evidence" implies "cannot write runtime". Corrupt prior evidence is rejected by
// the caller BEFORE any mutation, so `priorEvidence` here is only none | present.
async function reconcileEvidenceOnInit(
  paths: BusPaths,
  instance: BusInstance,
  priorEvidence: BusEvidenceRead,
  minted: boolean,
): Promise<void> {
  const priorInstanceId = priorEvidence.kind === "present" ? priorEvidence.evidence.instanceId : undefined;
  const priorCreatedAt = priorEvidence.kind === "present" ? priorEvidence.evidence.instanceCreatedAt : undefined;
  let tombstones = priorEvidence.kind === "present" ? [...priorEvidence.evidence.tombstones] : [];

  if (priorInstanceId && priorInstanceId !== instance.instanceId) {
    tombstones = appendTombstone(tombstones, buildTombstone({
      lostInstanceId: priorInstanceId,
      ...(priorCreatedAt ? { lostCreatedAt: priorCreatedAt } : {}),
      // A freshly minted instance means the prior runtime was ABSENT; a different
      // present instance means it was REPLACED (crash-before-evidence recovery).
      reason: minted ? "absent" : "mismatch",
      ...(minted ? {} : { foundInstanceId: instance.instanceId }),
      replacedByInstanceId: instance.instanceId,
    }));
  }

  try {
    await writeBusEvidence(paths, buildEvidence({
      instanceId: instance.instanceId,
      instanceCreatedAt: instance.createdAt,
      tombstones,
    }));
  } catch (err) {
    if (err instanceof BusError) throw err;
    throw new BusError("io_error", `Failed to persist Bus deletion-evidence: ${err instanceof Error ? err.message : String(err)}`, err);
  }
}
