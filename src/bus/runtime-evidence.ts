import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { BusError } from "./errors.js";
import { durableWrite, readJsonNoFollow, readTextNoFollow, rejectPathSymlink } from "./io.js";
import type { BusPaths } from "./paths.js";

// T-428: checkout-local, gitignored deletion-evidence for the Bus v2 runtime.
//
// The `.story/bus/` runtime is gitignored and can be deleted out from under a
// live coordination (N-083). Without a durable trace, the next `bus setup`
// silently mints a fresh instance over the loss. This evidence file records the
// instance a checkout stood up so a subsequent deletion (or a swap to a
// different instance) is DETECTED rather than papered over.
//
// It lives at `<root>/.story/.bus-evidence.json`, a working-tree sibling of the
// runtime (NOT under `bus/`), gitignored via a `/.bus-evidence.json*` glob. That
// glob covers the file AND every atomic-write temp sibling
// (`.bus-evidence.json.tmp.<pid>.<uuid>`), so a crash mid-write can never leak an
// un-ignored file into tracked `.story/`. Because it is never committed, a fresh
// clone never receives it (classified `fresh`, never a false loss) -- the
// structural L-031 guarantee. It dies with the working tree, so a delete+reclone
// at the same path reads as `fresh`, while a `.story/bus/`-only wipe (the N-083
// reaper) is a detected loss.

export const BUS_EVIDENCE_FILENAME = ".bus-evidence.json" as const;

// gitignore glob installed into `.story/.gitignore` alongside `bus/`. The leading
// `/` anchors it to `.story/`; the trailing `*` also matches the durable-write
// temp siblings (`<name>.tmp.<pid>.<uuid>`), closing the crash-left-temp window.
export const BUS_EVIDENCE_GITIGNORE_ENTRY = "/.bus-evidence.json*" as const;

// Newest-N tombstones retained. Bounds the file while keeping recent history.
export const BUS_TOMBSTONE_CAP = 10 as const;

const BusTombstoneSchema = z.object({
  eventId: z.string().uuid(),
  lostInstanceId: z.string().uuid(),
  lostCreatedAt: z.string().datetime({ offset: true }).optional(),
  detectedAt: z.string().datetime({ offset: true }),
  reason: z.enum(["absent", "mismatch"]),
  foundInstanceId: z.string().uuid().optional(),
  replacedByInstanceId: z.string().uuid(),
}).passthrough();
export type BusTombstone = z.infer<typeof BusTombstoneSchema>;

const BusEvidenceSchema = z.object({
  schema: z.literal("storybloq-bus-evidence/v1"),
  // instanceId is REQUIRED. Evidence is only ever written by buildEvidence, which
  // always names the live instance, so a present evidence file with no instanceId
  // can only be a tampered / hand-corrupted file. Failing the parse (-> `corrupt`)
  // is the correct fail-closed outcome: an id-less evidence file must never be
  // misread as legacy-unmirrored, which would silently mask a genuine loss.
  instanceId: z.string().uuid(),
  instanceCreatedAt: z.string().datetime({ offset: true }).optional(),
  tombstones: z.array(BusTombstoneSchema),
}).passthrough();
export type BusEvidence = z.infer<typeof BusEvidenceSchema>;

// Result of reading the evidence file. `none` = ENOENT (fresh-eligible). `corrupt`
// = ANY other read/parse failure (symlink, bad JSON, schema mismatch, io error):
// the classifier must never treat an unreadable file as absence, which would mask
// a loss. `present` carries the validated evidence.
export type BusEvidenceRead =
  | { readonly kind: "none" }
  | { readonly kind: "corrupt"; readonly detail: string }
  | { readonly kind: "present"; readonly evidence: BusEvidence };

export function busEvidencePath(paths: BusPaths): string {
  return join(paths.storyRoot, BUS_EVIDENCE_FILENAME);
}

export async function readBusEvidence(paths: BusPaths): Promise<BusEvidenceRead> {
  try {
    const evidence = await readJsonNoFollow(busEvidencePath(paths), BusEvidenceSchema);
    return { kind: "present", evidence };
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") return { kind: "none" };
    return { kind: "corrupt", detail: err instanceof Error ? err.message : String(err) };
  }
}

// The evidence-glob body with its leading anchor stripped.
const EVIDENCE_ANCHORED_BODY = BUS_EVIDENCE_GITIGNORE_ENTRY.replace(/^\//, "");

// Gitignore wildcard / unmodellable-construct characters: `*`, `?`, character
// classes `[...]`, and escapes `\`. A body containing any of them is never treated
// as a proven-harmless negation, because no single sample can prove it is disjoint
// from every temp sibling `.bus-evidence.json.tmp.<pid>.<uuid>`.
const EVIDENCE_GLOB_META = /[*?[\]\\]/;

// Does this POSITIVE pattern body (anchor stripped) keep the evidence file AND every
// atomic-write temp sibling ignored? Only a prefix-glob `<literal>*` whose literal is
// a prefix of the evidence filename PROVABLY covers the whole `.bus-evidence.json*`
// namespace (it matches the file and any suffix). Anything else -- a temp-less exact
// rule, a suffix glob like `*.json`, or an unmodellable construct -- is not proven
// coverage and does not count as protection.
function evidencePositiveMatch(body: string): boolean {
  if (body === "" || body.endsWith("/")) return false;
  if (body === EVIDENCE_ANCHORED_BODY) return true;
  const prefixGlob = /^([^*?[\]\\]*)\*$/.exec(body);
  return prefixGlob !== null && BUS_EVIDENCE_FILENAME.startsWith(prefixGlob[1]!);
}

// Does this NEGATION body (anchor stripped) possibly RE-INCLUDE the evidence file or
// a temp sibling? Fail closed: ANY wildcard or unmodellable construct is treated as a
// possible re-inclusion (a `!*.tmp.<pid>.*` re-includes a real temp for that pid even
// though it matches neither the base filename nor any fixed sample), and a pure
// literal that targets the evidence namespace re-includes it. Only a pure literal
// aimed at some OTHER path is harmless.
function evidenceNegationMatch(body: string): boolean {
  if (body === "" || body.endsWith("/")) return false;
  if (EVIDENCE_GLOB_META.test(body)) return true;
  return body.startsWith(BUS_EVIDENCE_FILENAME);
}

// Enforce the ignore-rule-before-evidence invariant at WRITE time (not just at
// setup): compute the FINAL ignore state of the evidence file under gitignore's
// last-match-wins ordering, and refuse the write unless it stays ignored. A crash
// between the ignore install and the evidence write could otherwise leave a
// durably-written, un-ignored file that git would surface. Fail closed: any
// negation construct we cannot model is treated as a re-inclusion, and a positive
// rule only protects when it confidently covers the file AND its temp siblings.
export async function assertEvidenceIgnored(paths: BusPaths): Promise<void> {
  let raw: string;
  try {
    // No-follow: git does not honor a symlinked working-tree `.gitignore`, so a
    // symlink whose target carries the evidence glob would fool a following read
    // while git leaves the file exposed. Re-checking here (not only at setup) also
    // closes the TOCTOU race against a symlink swapped in before the evidence write.
    raw = await readTextNoFollow(join(paths.storyRoot, ".gitignore"));
  } catch (err) {
    throw new BusError(
      "io_error",
      "Cannot confirm .story/.gitignore protects the Bus deletion-evidence file (it must be a regular, non-symlink file). Run `storybloq bus setup`.",
      err,
    );
  }
  // last-match-wins: walk in order, a matching positive sets ignored, a matching
  // negation clears it. The final state decides. Leading whitespace is SIGNIFICANT
  // in gitignore, so it is preserved (a leading space makes a rule not ours, hence
  // fail-closed); only trailing unescaped whitespace is stripped, per git's rule.
  let ignored = false;
  for (const rawLine of raw.split(/\r?\n/)) {
    const entry = rawLine.replace(/\r$/, "").replace(/(?<!\\)[ \t]+$/, "");
    if (entry === "" || entry.startsWith("#")) continue;
    if (entry.startsWith("!")) {
      if (evidenceNegationMatch(entry.slice(1).replace(/^\//, ""))) ignored = false;
    } else if (evidencePositiveMatch(entry.replace(/^\//, ""))) {
      ignored = true;
    }
  }
  if (!ignored) {
    throw new BusError(
      "io_error",
      `.story/.gitignore does not keep the Bus deletion-evidence file ignored (the \`${BUS_EVIDENCE_GITIGNORE_ENTRY}\` rule is missing, or a later negation re-includes it); refusing to write an exposable evidence file. Run \`storybloq bus setup\`.`,
    );
  }
}

// Durable, symlink-rejecting write. Reuses the shared durable path (temp file
// mode 0600 + fsync + atomic rename); the temp name shares the evidence prefix so
// the gitignore glob covers it. Rejects a symlink at the target first, and refuses
// to write unless the ignore rule is already present. Never chmods `.story`
// (durableWrite's mkdir is a no-op on the existing project dir).
export async function writeBusEvidence(paths: BusPaths, evidence: BusEvidence): Promise<void> {
  const path = busEvidencePath(paths);
  await assertEvidenceIgnored(paths);
  await rejectPathSymlink(path);
  // Validate the shape we are about to persist so a programming error can never
  // write a malformed evidence file that the next read would classify corrupt.
  const validated = BusEvidenceSchema.parse(evidence);
  await durableWrite(path, JSON.stringify(validated, null, 2) + "\n");
}

// Append a tombstone, keeping only the newest BUS_TOMBSTONE_CAP. Newest last.
export function appendTombstone(
  tombstones: readonly BusTombstone[],
  tombstone: BusTombstone,
): BusTombstone[] {
  return [...tombstones, tombstone].slice(-BUS_TOMBSTONE_CAP);
}

// Build the tombstone recorded when a checkout's known instance is superseded by
// a different one. `reason: "absent"` when the prior runtime was gone and a new
// instance was minted; `reason: "mismatch"` when a different valid instance was
// found present (crash-recovery: mint committed before evidence).
export function buildTombstone(args: {
  lostInstanceId: string;
  lostCreatedAt?: string;
  reason: "absent" | "mismatch";
  foundInstanceId?: string;
  replacedByInstanceId: string;
}): BusTombstone {
  return BusTombstoneSchema.parse({
    eventId: randomUUID(),
    lostInstanceId: args.lostInstanceId,
    ...(args.lostCreatedAt ? { lostCreatedAt: args.lostCreatedAt } : {}),
    detectedAt: new Date().toISOString(),
    reason: args.reason,
    ...(args.foundInstanceId ? { foundInstanceId: args.foundInstanceId } : {}),
    replacedByInstanceId: args.replacedByInstanceId,
  });
}

export function buildEvidence(args: {
  instanceId: string;
  instanceCreatedAt?: string;
  tombstones: readonly BusTombstone[];
}): BusEvidence {
  return BusEvidenceSchema.parse({
    schema: "storybloq-bus-evidence/v1",
    instanceId: args.instanceId,
    ...(args.instanceCreatedAt ? { instanceCreatedAt: args.instanceCreatedAt } : {}),
    // Enforce the retention cap defensively even though appendTombstone already
    // slices: buildEvidence is the single serialization chokepoint, so a caller
    // that assembled tombstones by another path can never grow the file unbounded.
    tombstones: [...args.tombstones].slice(-BUS_TOMBSTONE_CAP),
  });
}
