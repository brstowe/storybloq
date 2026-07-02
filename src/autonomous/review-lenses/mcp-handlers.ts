/**
 * MCP tool handlers for the multi-lens review system.
 *
 * Three tools that wrap the orchestrator's programmatic logic:
 * - storybloq_review_lenses_prepare: activation, secrets, context, cache, prompts
 * - storybloq_review_lenses_synthesize: validation, blocking, origin/scope tagging
 * - storybloq_review_lenses_judge: verdict calibration, convergence
 *
 * The agent owns LLM orchestration (spawning subagents). These tools own the
 * programmatic logic that should not be reimplemented in prose instructions.
 *
 * T-189
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { prepareLensReview } from "./orchestrator.js";
import { writeReviewSnapshot } from "./review-snapshot.js";
import { validateFindings } from "./schema-validator.js";
import { generateIssueKey } from "./issue-key.js";
import { computeBlocking } from "./blocking-policy.js";
import { parseDiffScope, classifyOrigin } from "./diff-scope.js";
import { buildMergerPrompt, parseMergerResult } from "./merger.js";
import { buildJudgePrompt } from "./judge.js";
import {
  loadSnapshot,
  verifyLensFindingPreloaded,
  SnapshotIntegrityError,
} from "./verification.js";
import type { SnapshotContext, VerifyFail } from "./verification.js";
import { appendRejection, buildRejectionEntry } from "./verification-log.js";
import type {
  BlockingPolicy,
  LensFinding,
  LensName,
  MergerResult,
  ReviewStage,
} from "./types.js";
import {
  CORE_LENSES,
  DEFAULT_BLOCKING_POLICY,
  LENS_MAX_SEVERITY,
} from "./types.js";

// ISS-716: the assembled lens prompt is already bounded upstream (the artifact
// by config.tokenBudgetPerLens, the project rules by the 2000-char slice in
// context-packager), so this cap is a backstop against a pathological prompt,
// not the primary size control. The previous value of 10_000 was below the
// security lens's fixed prompt size (~10.6k chars with a real RULES.md, even
// with an empty diff), so the security lens (a core, critical, always-active
// lens) was silently blanked to "" on every realistic CODE_REVIEW. Sized to
// clear the worst-case assembled prompt (artifact tokenBudget ~128k chars plus
// preamble/body) with headroom.
const MAX_PROMPT_SIZE = 200_000;

// ── Prepare ───────────────────────────────────────────────────

export interface PrepareInput {
  readonly stage: ReviewStage;
  readonly diff: string;
  readonly changedFiles: readonly string[];
  readonly ticketDescription?: string;
  readonly reviewRound?: number;
  readonly priorDeferrals?: readonly string[];
  readonly projectRoot: string;
  readonly sessionDir?: string;
  // ISS-714: when present, prepare writes a byte-exact review snapshot of the
  // changed files keyed by the <stage>-r<round> reviewId, so the synthesize
  // verification gate has something to verify findings against.
  readonly sessionId?: string;
}

// ISS-714: map the workflow stage to the snapshot stage vocabulary.
function snapshotStage(stage: ReviewStage): "code-review" | "plan-review" {
  return stage === "PLAN_REVIEW" ? "plan-review" : "code-review";
}

// ISS-714: capture a byte-exact snapshot of the reviewed files so the
// verification gate can check lens evidence quotes against it, and return the
// reviewId that addresses it. A FRESH snapshot slot is allocated on every call
// (next free <stage>-r<n> under the session) so re-running prepare after the
// reviewed content changed never reuses a stale immutable snapshot -- synthesize
// always verifies against the bytes this call captured. Fail soft: if no file
// can be snapshotted (bad path, unreadable/deleted file, write error) it returns
// null and the caller falls back to a non-snapshot reviewId, so the gate skips
// verification (ISS-715) rather than crashing prepare.
function writeFreshReviewSnapshot(opts: {
  projectRoot: string;
  sessionId: string;
  sessionDir: string;
  stage: "code-review" | "plan-review";
  changedFiles: readonly string[];
}): string | null {
  const files: string[] = [];
  for (const f of opts.changedFiles) {
    if (typeof f !== "string" || f.length === 0) continue;
    // The snapshot writer requires root-relative posix paths and rejects
    // absolute/backslash/dot segments; pre-filter so one bad path does not
    // abort the whole snapshot.
    if (f.startsWith("/") || f.includes("\\")) continue;
    if (f.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) continue;
    if (existsSync(join(opts.projectRoot, f))) files.push(f);
  }
  if (files.length === 0) return null;

  // Allocate the next free snapshot slot for this stage so the write never
  // collides with an existing (possibly stale) immutable snapshot.
  const snapshotParent = join(opts.sessionDir, "review-snapshot");
  let maxIndex = 0;
  if (existsSync(snapshotParent)) {
    const slot = new RegExp(`^${opts.stage}-r(\\d+)$`);
    try {
      for (const name of readdirSync(snapshotParent)) {
        const m = name.match(slot);
        if (m?.[1]) maxIndex = Math.max(maxIndex, parseInt(m[1], 10));
      }
    } catch {
      // unreadable parent: fall through with maxIndex 0
    }
  }
  const reviewId = `${opts.stage}-r${maxIndex + 1}`;

  try {
    const written = writeReviewSnapshot({
      projectRoot: opts.projectRoot,
      sessionId: opts.sessionId,
      reviewId,
      stage: opts.stage,
      round: maxIndex + 1,
      files,
    });
    // ISS-760: per-entry source failures no longer abort the snapshot (they
    // are recorded in manifest.failedPaths and the gate runs degraded), but
    // if EVERY entry failed there is nothing to verify against -- preserve
    // the established ISS-715 skip semantics instead of rejecting the whole
    // round against an empty snapshot.
    if (written.manifest.fileCount === 0) return null;
    return reviewId;
  } catch {
    // Best effort: a write failure leaves no snapshot at this slot, so the gate
    // skips. Never propagate out of prepare.
    return null;
  }
}

export interface PrepareOutput {
  readonly lensPrompts: readonly {
    readonly lens: string;
    readonly model: string;
    readonly prompt: string;
    readonly promptRef: string;
    readonly promptTruncated: boolean;
    readonly cached: boolean;
    readonly cachedFindings?: readonly LensFinding[];
  }[];
  readonly artifact: string;
  readonly metadata: {
    readonly activeLenses: readonly string[];
    readonly skippedLenses: readonly string[];
    readonly secretsGateActive: boolean;
    readonly reviewRound: number;
    readonly reviewId: string;
    // ISS-760(b): the orchestrator secrets meta-finding, surfaced so it can
    // reach the synthesize step (see the post-gate injection there).
    readonly secretsMetaFinding: LensFinding | null;
  };
}

export function handlePrepare(input: PrepareInput): PrepareOutput {
  // Guard: CODE_REVIEW with no changed files produces no lenses
  if (input.stage === "CODE_REVIEW" && input.changedFiles.length === 0) {
    return {
      lensPrompts: [],
      artifact: input.diff,
      metadata: {
        activeLenses: [],
        skippedLenses: [],
        secretsGateActive: false,
        reviewRound: input.reviewRound ?? 1,
        reviewId: `lens-empty-${Date.now().toString(36)}`,
        secretsMetaFinding: null,
      },
    };
  }

  const sessionDir = input.sessionDir;
  const knownFP = (input.priorDeferrals ?? []).join("\n");

  // ISS-714: snapshot the reviewed files at prepare time (CODE_REVIEW only,
  // where changedFiles are real source files the lens evidence quotes against)
  // and use the fresh snapshot's slot as the reviewId, so the synthesize
  // verification gate -- which loads by the reviewId echoed back through
  // metadata.reviewId -- verifies against exactly these bytes. The reviewId is
  // addressable (resolves to a snapshot) ONLY when a snapshot was actually
  // written by this call. In every other case (no session, PLAN_REVIEW, no
  // snapshottable file, or a write error) it stays a non-addressable lens-<ts>
  // id that the snapshot reader rejects as snapshot_absent, so synthesize skips
  // verification rather than ever loading a stale or coincidentally-matching
  // pre-existing snapshot (ISS-715).
  const stagePrefix = snapshotStage(input.stage);
  let reviewId = `lens-${Date.now().toString(36)}`;
  if (input.sessionId && input.stage === "CODE_REVIEW") {
    const snapshotSessionDir = sessionDir
      ?? join(input.projectRoot, ".story", "sessions", input.sessionId);
    // ISS-722: the agent builds changedFiles with `git diff --name-only`, which omits
    // newly-added/untracked files that the reviewed diff DOES include. Snapshotting only
    // changedFiles left those files unsnapshotted, so a lens finding quoting a new file hit
    // file_not_snapshotted -> rejected -> silently dropped from the merged verdict. Union in
    // the paths the diff itself touches (parseDiffScope reads the +++ b/<path> headers) so the
    // snapshot file set matches what the lenses actually reviewed. writeFreshReviewSnapshot
    // still existsSync-filters, so paths with no on-disk file (e.g. pure deletions) are ignored.
    const snapshotFiles = [
      ...new Set([...input.changedFiles, ...parseDiffScope(input.diff).changedFiles]),
    ];
    const snapReviewId = writeFreshReviewSnapshot({
      projectRoot: input.projectRoot,
      sessionId: input.sessionId,
      sessionDir: snapshotSessionDir,
      stage: stagePrefix,
      changedFiles: snapshotFiles,
    });
    if (snapReviewId) reviewId = snapReviewId;
  }

  const prepared = prepareLensReview({
    stage: input.stage,
    diff: input.diff,
    changedFiles: input.changedFiles,
    ticketDescription: input.ticketDescription ?? "Manual review",
    projectRoot: input.projectRoot,
    sessionDir,
    knownFalsePositives: knownFP || undefined,
    reviewId,
  });

  const lensPrompts = [];

  for (const lens of prepared.activeLenses) {
    const cached = prepared.cachedFindings.get(lens);
    const subagent = prepared.subagentPrompts.get(lens);

    const ref = `references/lens-${lens}.md`;
    if (cached) {
      lensPrompts.push({
        lens,
        model: subagent?.model ?? "sonnet",
        prompt: "",
        promptRef: ref,
        promptTruncated: false,
        cached: true,
        cachedFindings: cached,
      });
    } else if (subagent) {
      const truncated = subagent.prompt.length > MAX_PROMPT_SIZE;
      lensPrompts.push({
        lens,
        model: subagent.model,
        prompt: truncated ? "" : subagent.prompt,
        promptRef: ref,
        promptTruncated: truncated,
        cached: false,
      });
    }
  }

  // ISS-760(b): when the secrets gate fires, persist the meta-finding keyed
  // by this reviewId so handleSynthesize (a separate MCP call whose metadata
  // is echoed field-by-field by the agent) can inject it into the merger
  // findings without relying on the agent to round-trip it.
  if (prepared.secretsMetaFinding) {
    const persistDir = sessionDir
      ?? (input.sessionId ? join(input.projectRoot, ".story", "sessions", input.sessionId) : undefined);
    if (persistDir) {
      try {
        writeFileSync(
          join(persistDir, "secrets-meta-finding.json"),
          JSON.stringify({ reviewId: prepared.reviewId, metaFinding: prepared.secretsMetaFinding }, null, 2),
        );
      } catch { /* best-effort: metadata passthrough still carries it */ }
    }
  }

  return {
    lensPrompts,
    artifact: input.diff,
    metadata: {
      activeLenses: [...prepared.activeLenses],
      skippedLenses: [...prepared.skippedLenses],
      secretsGateActive: prepared.secretsGateActive,
      reviewRound: input.reviewRound ?? 1,
      reviewId: prepared.reviewId,
      secretsMetaFinding: prepared.secretsMetaFinding,
    },
  };
}

// ── Shared helpers ────────────────────────────────────────────

function buildLensMetadata(
  completed: readonly string[],
  failed: readonly string[],
  insufficientContext: readonly string[],
): { name: string; maxSeverity: "critical" | "major"; isRequired: boolean; status: "complete" | "failed" | "insufficient-context" }[] {
  const all = new Set([...completed, ...failed, ...insufficientContext]);
  return [...all].map((l) => ({
    name: l,
    maxSeverity: LENS_MAX_SEVERITY[l as LensName] ?? ("major" as const),
    isRequired: (CORE_LENSES as readonly string[]).includes(l),
    status: completed.includes(l)
      ? ("complete" as const)
      : failed.includes(l)
        ? ("failed" as const)
        : ("insufficient-context" as const),
  }));
}

// ── Verification gate helper (ISS-398) ──────────────────────

interface VerificationGateInput {
  readonly projectRoot?: string;
  readonly sessionId?: string;
  readonly reviewId: string;
  readonly sessionDir?: string;
  readonly stage: ReviewStage;
}

interface VerificationGateResult {
  verifiedFindings: LensFinding[];
  verifiedForFiling: LensFinding[];
  rejectedCount: number;
  snapshotIntegrityFailure: boolean;
  verificationSkipped: boolean;
  // ISS-760: true when the gate RAN against a partial snapshot (the writer
  // recorded failedPaths). Distinguishes gate-ran-degraded from skipped.
  verificationDegraded: boolean;
  logWriteFailures: number;
  verificationRuntimeErrors: number;
}

function runVerificationGate(
  allFindings: LensFinding[],
  opts: VerificationGateInput,
): VerificationGateResult {
  if (!opts.projectRoot || !opts.sessionId) {
    return {
      verifiedFindings: allFindings,
      verifiedForFiling: [],
      rejectedCount: 0,
      snapshotIntegrityFailure: false,
      verificationSkipped: true,
      verificationDegraded: false,
      logWriteFailures: 0,
      verificationRuntimeErrors: 0,
    };
  }

  const ctx: SnapshotContext = {
    projectRoot: opts.projectRoot,
    sessionId: opts.sessionId,
    reviewId: opts.reviewId,
  };

  const verified: LensFinding[] = [];
  const strictlyVerified: LensFinding[] = [];
  const rejected: Array<{ finding: LensFinding; result: VerifyFail }> = [];
  let verificationRuntimeErrors = 0;
  let logWriteFailures = 0;

  let snapshot;
  try {
    snapshot = loadSnapshot(ctx);
  } catch (err) {
    if (err instanceof SnapshotIntegrityError && err.code === "snapshot_absent") {
      // ISS-715: no snapshot exists for this review (no session, a stage that
      // does not snapshot, or a write that was skipped). There is nothing to
      // verify against, so skip rather than reporting a false integrity
      // failure. Findings still pass through to the merger unverified.
      return {
        verifiedFindings: allFindings,
        verifiedForFiling: [],
        rejectedCount: 0,
        snapshotIntegrityFailure: false,
        verificationSkipped: true,
        verificationDegraded: false,
        logWriteFailures: 0,
        verificationRuntimeErrors: 0,
      };
    }
    // ISS-715: a genuine integrity violation (snapshot present but corrupt or
    // tampered) must not degrade silently. Rethrow so the synthesize MCP tool
    // returns isError and the agent escalates the round instead of treating
    // unverified findings as verified.
    throw err;
  }

  for (const finding of allFindings) {
    try {
      const result = verifyLensFindingPreloaded(finding, snapshot!);
      if (result.pass) {
        verified.push(finding);
        strictlyVerified.push(finding);
      } else {
        rejected.push({ finding, result });
      }
    } catch (err) {
      if (err instanceof SnapshotIntegrityError) {
        // ISS-715: a payload that was present at load but fails its integrity
        // check mid-verification is a genuine tamper signal. Surface it.
        throw err;
      }
      verified.push(finding);
      verificationRuntimeErrors++;
    }
  }

  if (rejected.length > 0 && opts.sessionDir) {
    const stageLabel = opts.stage === "CODE_REVIEW" ? "code-review" : "plan-review";
    for (const { finding, result } of rejected) {
      try {
        const entry = buildRejectionEntry(finding, result, stageLabel);
        if (!appendRejection(opts.sessionDir, entry).ok) {
          logWriteFailures++;
        }
      } catch {
        logWriteFailures++;
      }
    }
  }

  return {
    verifiedFindings: verified,
    verifiedForFiling: strictlyVerified,
    rejectedCount: rejected.length,
    snapshotIntegrityFailure: false,
    verificationSkipped: false,
    verificationDegraded: snapshot!.failedPaths.size > 0,
    logWriteFailures,
    verificationRuntimeErrors,
  };
}

// ── Synthesize ────────────────────────────────────────────────

/**
 * ISS-760(b): read the secrets meta-finding handlePrepare persisted for this
 * review. Returns null unless the stored reviewId matches (a stale file from
 * an earlier round must not leak into a later one). Best-effort: any read or
 * parse failure yields null.
 */
function readPersistedSecretsMeta(
  sessionDir: string | undefined,
  reviewId: string,
): LensFinding | null {
  if (!sessionDir) return null;
  try {
    const raw = JSON.parse(
      readFileSync(join(sessionDir, "secrets-meta-finding.json"), "utf-8"),
    ) as { reviewId?: unknown; metaFinding?: unknown };
    if (raw && raw.reviewId === reviewId && raw.metaFinding && typeof raw.metaFinding === "object") {
      return raw.metaFinding as LensFinding;
    }
  } catch { /* absent or unreadable: no meta-finding */ }
  return null;
}

export interface SynthesizeInput {
  readonly stage?: ReviewStage;
  readonly lensResults: readonly {
    readonly lens: string;
    readonly status: string;
    readonly findings: readonly unknown[];
  }[];
  readonly metadata: {
    readonly activeLenses: readonly string[];
    readonly skippedLenses: readonly string[];
    readonly reviewRound: number;
    readonly reviewId: string;
    // ISS-760(b): optional direct passthrough of the prepare-step secrets
    // meta-finding (programmatic callers). The MCP flow falls back to the
    // file handlePrepare persists in the session dir, keyed by reviewId.
    readonly secretsMetaFinding?: LensFinding | null;
  };
  readonly sessionDir?: string;
  readonly sessionId?: string;
  readonly projectRoot?: string;
  // T-192: Origin classification inputs
  readonly diff?: string;
  readonly changedFiles?: readonly string[];
}

export interface SynthesizeOutput {
  readonly mergerPrompt: string;
  readonly validatedFindings: readonly LensFinding[];
  readonly lensesCompleted: readonly string[];
  readonly lensesFailed: readonly string[];
  readonly lensesInsufficientContext: readonly string[];
  readonly droppedFindings: number;
  readonly droppedDetails: readonly string[];
  // T-192: Pre-existing findings identified by origin classification
  readonly preExistingFindings: readonly LensFinding[];
  readonly preExistingCount: number;
  // T-257: Verification gate outputs
  readonly verificationCounters: {
    readonly proposed: number;
    readonly verified: number;
    readonly rejected: number;
  };
  readonly snapshotIntegrityFailure: boolean;
  readonly verificationSkipped: boolean;
  // ISS-760: the gate ran against a partial snapshot (some paths failed to
  // capture). Rounds with this flag stay lenses-unverified.
  readonly verificationDegraded: boolean;
  readonly logWriteFailures: number;
  readonly verificationRuntimeErrors: number;
  readonly telemetryWriteFailed: boolean;
}

export function handleSynthesize(input: SynthesizeInput): SynthesizeOutput {
  // Load project-level blocking policy if available
  let policy: BlockingPolicy = DEFAULT_BLOCKING_POLICY;
  let confidenceFloor = 0.6;
  let findingBudget = 10;
  if (input.projectRoot) {
    try {
      const configPath = join(input.projectRoot, ".story", "config.json");
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      const overrides = raw?.recipeOverrides;
      if (overrides?.blockingPolicy) {
        policy = { ...DEFAULT_BLOCKING_POLICY, ...overrides.blockingPolicy };
      }
      if (overrides?.stages?.CODE_REVIEW?.confidenceFloor != null) {
        confidenceFloor = overrides.stages.CODE_REVIEW.confidenceFloor;
      }
      if (overrides?.stages?.CODE_REVIEW?.findingBudget != null) {
        findingBudget = overrides.stages.CODE_REVIEW.findingBudget;
      }
    } catch { /* no config or parse error -- use defaults */ }
  }
  const stage: ReviewStage = input.stage ?? "CODE_REVIEW";
  // T-192: Pre-compute diff scope for origin classification (null if inputs missing or PLAN_REVIEW)
  const diffScope = input.diff && input.changedFiles && stage === "CODE_REVIEW"
    ? parseDiffScope(input.diff) : null;
  const lensesCompleted: string[] = [];
  const lensesFailed: string[] = [];
  const lensesInsufficientContext: string[] = [];
  const allFindings: LensFinding[] = [];
  let droppedTotal = 0;
  const dropReasons: string[] = [];

  for (const lr of input.lensResults) {
    if (lr.status === "complete") {
      lensesCompleted.push(lr.lens);
      const { valid, invalid } = validateFindings(lr.findings as unknown[], lr.lens);
      if (invalid.length > 0) {
        droppedTotal += invalid.length;
        for (const inv of invalid.slice(0, 3)) {
          dropReasons.push(`${lr.lens}: ${inv.reason}`);
        }
      }
      // Apply confidence floor then per-lens finding budget (tracked separately)
      const aboveFloor = valid.filter((f) => f.confidence >= confidenceFloor);
      const belowFloor = valid.length - aboveFloor.length;
      if (belowFloor > 0) {
        droppedTotal += belowFloor;
        dropReasons.push(`${lr.lens}: ${belowFloor} below confidence floor ${confidenceFloor}`);
      }
      const filtered = aboveFloor.slice(0, findingBudget);
      const budgetExceeded = aboveFloor.length - filtered.length;
      if (budgetExceeded > 0) {
        droppedTotal += budgetExceeded;
        dropReasons.push(`${lr.lens}: ${budgetExceeded} exceeded finding budget ${findingBudget}`);
      }
      for (const f of filtered) {
        const enriched: LensFinding = {
          ...f,
          issueKey: generateIssueKey(f),
          blocking: computeBlocking(f, stage, policy),
          origin: diffScope ? classifyOrigin(f, diffScope, stage) : undefined,
        };
        allFindings.push(enriched);
      }
    } else if (lr.status === "insufficient-context") {
      lensesInsufficientContext.push(lr.lens);
    } else {
      lensesFailed.push(lr.lens);
    }
  }

  // Check for lenses that were active but not in results (failed/timed out)
  for (const lens of input.metadata.activeLenses) {
    if (
      !lensesCompleted.includes(lens) &&
      !lensesInsufficientContext.includes(lens) &&
      !lensesFailed.includes(lens)
    ) {
      lensesFailed.push(lens);
    }
  }

  // ── T-257: Verification gate (ISS-398: extracted helper) ────────
  const gate = runVerificationGate(allFindings, {
    projectRoot: input.projectRoot,
    sessionId: input.sessionId,
    reviewId: input.metadata.reviewId,
    sessionDir: input.sessionDir,
    stage,
  });
  const {
    verifiedFindings,
    verifiedForFiling,
    rejectedCount,
    snapshotIntegrityFailure,
    verificationSkipped,
    verificationDegraded,
    logWriteFailures,
    verificationRuntimeErrors,
  } = gate;

  // T-192: Collect pre-existing findings from strictly-verified set only
  const preExistingFindings = verifiedForFiling.filter(
    f => f.origin === "pre-existing" && f.severity !== "suggestion",
  );

  // ── ISS-760(b): inject the orchestrator secrets meta-finding ────
  // POST-verification-gate, into the merger findings only. Constraint: the
  // meta-finding has no snapshottable file evidence -- its evidence quotes
  // the "[REDACTED -- potential secret]" placeholder, which can never match
  // the pre-redaction snapshot bytes, so injecting it BEFORE the gate would
  // make the gate self-reject it. It is therefore exempt from the
  // verification counters (proposed/verified/rejected count lens findings
  // only) and from pre-existing filing (verifiedForFiling excludes it).
  const secretsMeta = input.metadata.secretsMetaFinding
    ?? readPersistedSecretsMeta(input.sessionDir, input.metadata.reviewId);
  if (secretsMeta) {
    verifiedFindings.unshift({
      ...secretsMeta,
      resolvedModel: "orchestrator",
      issueKey: "orchestrator:hardcoded-secrets:gate",
      blocking: true,
    });
  }

  const lensMetadata = buildLensMetadata(lensesCompleted, lensesFailed, lensesInsufficientContext);

  const mergerPrompt = buildMergerPrompt(verifiedFindings, lensMetadata, stage);

  // T-257: Verification counters
  const verificationCounters = {
    proposed: allFindings.length,
    verified: (snapshotIntegrityFailure || verificationSkipped)
      ? 0
      : verifiedForFiling.length,
    rejected: rejectedCount,
  };

  // T-257: Write telemetry artifact (best-effort)
  let telemetryWriteFailed = false;
  if (input.sessionDir) {
    try {
      const telemetryEntry = {
        reviewId: input.metadata.reviewId,
        proposed: verificationCounters.proposed,
        verified: verificationCounters.verified,
        rejected: verificationCounters.rejected,
        snapshotIntegrityFailure,
        verificationSkipped,
        // ISS-760: gate-ran-degraded is distinct from skipped; the round
        // still classifies as lenses-unverified (see classifyLensReviewPath).
        verificationDegraded,
        verificationRuntimeErrors,
        logWriteFailures,
        timestamp: new Date().toISOString(),
      };
      appendFileSync(
        join(input.sessionDir, "verification-telemetry.jsonl"),
        JSON.stringify(telemetryEntry) + "\n",
      );
    } catch {
      telemetryWriteFailed = true;
    }
  }

  return {
    mergerPrompt,
    validatedFindings: verifiedFindings,
    lensesCompleted,
    lensesFailed,
    lensesInsufficientContext,
    droppedFindings: droppedTotal,
    droppedDetails: dropReasons.slice(0, 5),
    preExistingFindings,
    preExistingCount: preExistingFindings.length,
    verificationCounters,
    snapshotIntegrityFailure,
    verificationSkipped,
    verificationDegraded,
    logWriteFailures,
    verificationRuntimeErrors,
    telemetryWriteFailed,
  };
}

// ── Judge ─────────────────────────────────────────────────────

export interface JudgeInput {
  readonly mergerResultRaw: string;
  readonly stage?: ReviewStage;
  readonly convergenceHistory?: readonly {
    readonly round: number;
    readonly verdict: string;
    readonly blocking: number;
    readonly important: number;
    readonly newCode: string;
  }[];
  readonly lensesCompleted: readonly string[];
  readonly lensesFailed: readonly string[];
  readonly lensesInsufficientContext: readonly string[];
  readonly lensesSkipped: readonly string[];
  // CDX-13: pre-merger source set for source-authoritative marker restoration
  // inside `parseMergerResult`. Callers pass the `validatedFindings` field
  // returned from `handleSynthesize`.
  readonly sourceFindings?: readonly LensFinding[];
}

export interface JudgeOutput {
  readonly judgePrompt: string;
  readonly isPartial: boolean;
  readonly mergerResult: ReturnType<typeof parseMergerResult>;
}

export function handleJudge(input: JudgeInput): JudgeOutput {
  const mergerResult = parseMergerResult(
    input.mergerResultRaw,
    input.sourceFindings ?? [],
  );
  // isPartial: true if any core lens failed OR returned insufficient-context
  const isPartial = CORE_LENSES.some((l) =>
    input.lensesFailed.includes(l) || input.lensesInsufficientContext.includes(l),
  );

  const lensMetadata = buildLensMetadata(
    [...input.lensesCompleted],
    [...input.lensesFailed],
    [...input.lensesInsufficientContext],
  );

  const stage: ReviewStage = input.stage ?? "CODE_REVIEW";
  const fallbackMergerResult: MergerResult = { findings: [], tensions: [], mergeLog: [] };

  let judgePrompt = buildJudgePrompt(
    mergerResult ?? fallbackMergerResult,
    lensMetadata,
    stage,
    [...input.lensesCompleted],
    [...input.lensesInsufficientContext],
    [...input.lensesFailed],
    [...input.lensesSkipped],
  );

  // Inject convergence history if provided
  if (input.convergenceHistory && input.convergenceHistory.length > 0) {
    // Sanitize user-controlled strings to prevent prompt injection via markdown table
    const sanitize = (s: string) => s.replace(/[|\n\r#>`*_~\[\]]/g, " ").slice(0, 50);
    const historyTable = input.convergenceHistory
      .map((h) => `| R${h.round} | ${sanitize(h.verdict)} | ${h.blocking} | ${h.important} | ${sanitize(h.newCode)} |`)
      .join("\n");
    judgePrompt += `\n\n## Convergence History\n\n| Round | Verdict | Blocking | Important | New Code |\n|-------|---------|----------|-----------|----------|\n${historyTable}\n\nUse this history to determine recommendNextRound. Stop reviewing when: blocking = 0 for 2 consecutive rounds AND important count stable or decreasing AND no regressions.`;
  }

  // Inject partial review warning
  if (isPartial) {
    judgePrompt += `\n\nCRITICAL: This is a PARTIAL review -- required lens(es) failed: ${CORE_LENSES.filter((l) => input.lensesFailed.includes(l)).join(", ")}. You MUST NOT output "approve". Maximum verdict is "revise".`;
  }

  return { judgePrompt, isPartial, mergerResult: mergerResult ?? fallbackMergerResult };
}
