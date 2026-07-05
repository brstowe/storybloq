/**
 * Multi-lens review synthesis on the @storybloq/lenses package API
 * (ISS-823, pen rulings R2/R4/R6).
 *
 * synthesize collects the raw lens subagent outputs, parses each at the
 * LensOutputSchema boundary (mirroring the server's per-lens phase
 * classification), builds the exact-set lensCoverage disclosure, and runs
 * `runMergerPipeline` programmatically with T-026 anchoring against the
 * artifact the lenses actually saw. It returns the package ReviewVerdict:
 * no merger prompt, no LLM hop.
 *
 * Consumer add-ons preserved from the fork:
 *  - origin classification (diff-scope) for pre-existing issue filing
 *  - anchoring telemetry + deferral log in the legacy file shapes (R4)
 *  - review-progress.json display projection for the Mac dashboard (R6)
 *  - per-lens cache write-back using the keys prepare minted
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LENSES,
  ReviewVerdictSchema,
  LensOutputSchema,
  MergerConfigSchema,
  runMergerPipeline,
  type AnchoringInput,
  type LensCoverageEntry,
  type LensFinding,
  type LensOutput,
  type LensRunResult,
  type MergedFinding,
  type MergerConfig,
  type ParseError,
  type ReviewVerdict,
  type Stage,
} from "@storybloq/lenses";
import { parseDiffScope, classifyOrigin } from "./diff-scope.js";
import { writeToCache } from "./cache.js";
import { SECRETS_GATE_FINDING_ID } from "./secrets-gate.js";
import {
  appendAnchoringTelemetry,
  appendDeferralRejections,
} from "./verification-log.js";
import { HARNESS_META_FILE, type HarnessMeta } from "./prepare.js";

export interface SynthesizeInput {
  readonly stage?: Stage;
  /**
   * One entry per spawned lens: the lens id and its RAW output (the single
   * JSON object the package preamble instructs every lens to emit). `output`
   * may be the parsed object or a JSON string. `cached: true` marks results
   * echoed from prepare's cache hits.
   */
  readonly lensResults: readonly {
    readonly lens: string;
    readonly output: unknown;
    readonly cached?: boolean;
  }[];
  readonly metadata: {
    readonly activeLenses: readonly string[];
    readonly skippedLenses: readonly string[];
    readonly reviewRound: number;
    readonly reviewId: string;
    readonly secretsMetaFinding?: LensFinding | null;
  };
  readonly sessionDir?: string;
  readonly sessionId?: string;
  readonly projectRoot?: string;
  readonly diff?: string;
  readonly changedFiles?: readonly string[];
}

export interface SynthesizeOutput {
  /** The package verdict envelope: the single review currency (R1). */
  readonly reviewVerdict: ReviewVerdict;
  readonly lensesCompleted: readonly string[];
  readonly lensesFailed: readonly string[];
  readonly lensesSkipped: readonly string[];
  /** Verdict findings classified pre-existing (origin off the diff scope). */
  readonly preExistingFindings: readonly MergedFinding[];
  readonly preExistingCount: number;
  readonly telemetryWriteFailed: boolean;
}

/**
 * Structural view of a Zod error coming out of the package's own zod
 * instance. The package bundles its zod, so its ZodError is a different
 * nominal type than this workspace's; the fields we read are stable.
 */
interface WireZodError {
  readonly issues: readonly { readonly path: readonly (string | number)[]; readonly message: string }[];
}

/** T-022 phase classifier, mirrored from the server's complete.ts. */
function classifyPhase(err: WireZodError): ParseError["phase"] {
  for (const issue of err.issues) {
    if (issue.path.length > 0 && issue.path[0] === "findings") return "finding";
  }
  return "envelope";
}

function zodIssuesToWire(err: WireZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/**
 * R-C4b mirror: strip SERVER-OWNED finding fields before findings enter the
 * cache. The anchor pass strips them again on the next round's pipeline run
 * (defense-in-depth), but the cache must never store what a lens was not
 * entitled to mint.
 */
function stripServerFields(f: LensFinding): LensFinding {
  if (f.anchorRealignedFrom === undefined && f.integrityKey === undefined) return f;
  const { anchorRealignedFrom: _a, integrityKey: _b, ...rest } = f;
  return rest;
}

function readHarnessMeta(
  sessionDir: string | undefined,
  reviewId: string,
): HarnessMeta | null {
  if (!sessionDir) return null;
  try {
    const raw = JSON.parse(
      readFileSync(join(sessionDir, HARNESS_META_FILE), "utf-8"),
    ) as HarnessMeta;
    // A stale meta file from an earlier round must not leak into this one.
    if (raw && raw.reviewId === reviewId) return raw;
  } catch {
    /* absent or unreadable */
  }
  return null;
}

function loadMergerConfig(projectRoot: string | undefined, stage: Stage): MergerConfig {
  const candidate: Record<string, unknown> = {};
  if (projectRoot) {
    try {
      const raw = JSON.parse(
        readFileSync(join(projectRoot, ".story", "config.json"), "utf-8"),
      );
      const overrides = raw?.recipeOverrides;
      const floor = stage === "CODE_REVIEW"
        ? overrides?.stages?.CODE_REVIEW?.confidenceFloor
        : overrides?.stages?.PLAN_REVIEW?.confidenceFloor;
      if (typeof floor === "number") candidate.confidenceFloor = floor;
      const bp = overrides?.blockingPolicy;
      if (bp && typeof bp === "object") {
        const policy: Record<string, unknown> = {};
        if (Array.isArray(bp.alwaysBlock)) policy.alwaysBlock = bp.alwaysBlock;
        if (Array.isArray(bp.neverBlock)) policy.neverBlock = bp.neverBlock;
        if (Object.keys(policy).length > 0) candidate.blockingPolicy = policy;
      }
    } catch {
      /* no config or parse error -- defaults */
    }
  }
  const parsed = MergerConfigSchema.safeParse(
    Object.keys(candidate).length > 0 ? candidate : undefined,
  );
  return parsed.success ? parsed.data : MergerConfigSchema.parse(undefined);
}

export function handleSynthesize(input: SynthesizeInput): SynthesizeOutput {
  const stage: Stage = input.stage ?? "CODE_REVIEW";
  const reviewId = input.metadata.reviewId;
  const meta = readHarnessMeta(input.sessionDir, reviewId);
  const mergerConfig = loadMergerConfig(input.projectRoot, stage);

  const knownLensIds = new Set(Object.keys(LENSES));
  const activeSet = new Set(input.metadata.activeLenses);

  // ── Per-lens parse boundary (mirrors the server's complete.ts) ────
  const parsed = new Map<string, { output: LensOutput; cached: boolean }>();
  const parseErrors: ParseError[] = [];
  const parseFailed = new Set<string>();

  for (const r of input.lensResults) {
    if (!activeSet.has(r.lens) || !knownLensIds.has(r.lens)) {
      parseErrors.push({
        lensId: r.lens || "unknown",
        attempt: 1,
        phase: "internal",
        zodIssues: [
          { path: "lens", message: `not an expected lens for this review` },
        ],
      });
      continue;
    }
    if (parsed.has(r.lens) || parseFailed.has(r.lens)) {
      parseErrors.push({
        lensId: r.lens,
        attempt: 1,
        phase: "internal",
        zodIssues: [{ path: "lens", message: "duplicate lens submission" }],
      });
      continue;
    }
    // Tolerate agents handing the raw JSON back as a string.
    let candidate = r.output;
    if (typeof candidate === "string") {
      try {
        candidate = JSON.parse(candidate);
      } catch {
        /* fall through: the schema parse below records the failure */
      }
    }
    const res = LensOutputSchema.safeParse(candidate);
    if (res.success) {
      parsed.set(r.lens, { output: res.data, cached: r.cached === true });
    } else {
      parseFailed.add(r.lens);
      parseErrors.push({
        lensId: r.lens,
        attempt: 1,
        phase: classifyPhase(res.error),
        zodIssues: zodIssuesToWire(res.error),
      });
    }
  }

  // Defense in depth: strip the orchestrator secrets meta-finding from every
  // parsed output before it can reach the pipeline. It is re-derived fresh
  // from the live secrets gate each round, so a stale copy replayed from a
  // cache entry (e.g. one written by an older build) must never double with
  // the fresh injection below.
  for (const [lens, entry] of parsed) {
    if (entry.output.status !== "ok") continue;
    if (!entry.output.findings.some((f) => f.id === SECRETS_GATE_FINDING_ID)) continue;
    parsed.set(lens, {
      ...entry,
      output: {
        ...entry.output,
        findings: entry.output.findings.filter(
          (f) => f.id !== SECRETS_GATE_FINDING_ID,
        ),
      },
    });
  }

  // ── Secrets meta-finding injection (pre-pipeline) ─────────────────
  // Non-localized blocking finding: the anchor pass lets it through
  // untouched and the alwaysBlock category keeps it blocking -> reject.
  const secretsMeta =
    input.metadata.secretsMetaFinding ?? meta?.secretsMetaFinding ?? null;
  if (secretsMeta) {
    const existing = parsed.get("security");
    if (existing && existing.output.status === "ok") {
      parsed.set("security", {
        ...existing,
        output: {
          ...existing.output,
          findings: [...existing.output.findings, secretsMeta],
        },
      });
    } else {
      parsed.set("security", {
        output: {
          status: "ok",
          findings: [secretsMeta],
          error: null,
          notes: "orchestrator secrets gate (storybloq harness)",
        },
        cached: false,
      });
      parseFailed.delete("security");
    }
  }

  // ── Exact-set lens coverage disclosure ────────────────────────────
  // The coverage set must include every lens present in `perLens` so it stays
  // an exact superset of what the merger sees. Normally that is just
  // activeLenses, but the orchestrator secrets meta-finding is injected under
  // `security`, which an explicit lens allow-list could exclude from
  // activeLenses -- union in the parsed keys so an injected lens can never
  // contribute a finding with no coverage entry.
  const expectedLenses = [
    ...new Set([...input.metadata.activeLenses, ...parsed.keys()]),
  ];
  const lensCoverage: LensCoverageEntry[] = [];
  const lensesCompleted: string[] = [];
  const lensesFailed: string[] = [];
  for (const lens of expectedLenses) {
    const entry = parsed.get(lens);
    if (entry) {
      const status =
        entry.output.status === "ok"
          ? entry.cached
            ? ("cached" as const)
            : ("ok" as const)
          : entry.output.status === "skipped"
            ? ("skipped" as const)
            : ("error" as const);
      lensCoverage.push({
        lensId: lens,
        status,
        attempts: 1,
        contributedFindings:
          entry.output.status === "ok" ? entry.output.findings.length : 0,
      });
      if (entry.output.status === "ok") lensesCompleted.push(lens);
      else lensesFailed.push(lens);
    } else if (parseFailed.has(lens)) {
      lensCoverage.push({
        lensId: lens,
        status: "parse_failed",
        attempts: 1,
        contributedFindings: 0,
      });
      lensesFailed.push(lens);
    } else {
      // Active lens with no submission at all: failed/no result.
      lensCoverage.push({
        lensId: lens,
        status: "error",
        attempts: 0,
        contributedFindings: 0,
      });
      lensesFailed.push(lens);
    }
  }

  // Canonical skipped set: never-activated lenses minus any now present in the
  // coverage set (e.g. an injected secrets lens completes under `security`),
  // plus active lenses whose package output came back skipped. A lens can never
  // be both completed and skipped.
  const coveredLensIds = new Set(lensCoverage.map((e) => e.lensId));
  const lensesSkipped = [
    ...input.metadata.skippedLenses.filter((l) => !coveredLensIds.has(l)),
    ...lensCoverage.filter((e) => e.status === "skipped").map((e) => e.lensId),
  ];

  // ── Anchoring input (T-026): the artifact the lenses actually saw ─
  const anchorArtifact = meta?.anchorArtifact ?? input.diff;
  const anchoring: AnchoringInput | undefined =
    stage === "CODE_REVIEW" && anchorArtifact
      ? {
          stage,
          artifact: anchorArtifact,
          changedFiles: input.changedFiles ?? [],
        }
      : undefined;

  // ── Programmatic merger pipeline ──────────────────────────────────
  const perLens: LensRunResult[] = [...parsed.entries()].map(
    ([lensId, { output }]) => ({ lensId: lensId as LensRunResult["lensId"], output }),
  );
  const rawVerdict = runMergerPipeline({
    reviewId,
    sessionId: input.sessionId ?? reviewId,
    perLens,
    mergerConfig,
    parseErrors,
    nextActions: [],
    lensCoverage,
    reviewComplete: true,
    ...(anchoring !== undefined ? { anchoring } : {}),
  });
  // Mirror the server: the verdict must satisfy every schema invariant
  // before it leaves the tool boundary.
  const reviewVerdict = ReviewVerdictSchema.parse(rawVerdict);

  // ── Origin classification for pre-existing filing ─────────────────
  let preExistingFindings: MergedFinding[] = [];
  if (stage === "CODE_REVIEW" && input.diff) {
    const scope = parseDiffScope(input.diff);
    preExistingFindings = reviewVerdict.findings.filter(
      (f) =>
        f.severity !== "suggestion" &&
        classifyOrigin(f, scope, stage) === "pre-existing",
    );
  }

  // ── R4: anchoring telemetry + deferral log in legacy shapes ───────
  let proposed = 0;
  for (const { output } of perLens) {
    if (output.status === "ok") proposed += output.findings.length;
  }
  let telemetryWriteFailed = false;
  if (input.sessionDir) {
    const logWriteFailures = appendDeferralRejections(
      input.sessionDir,
      reviewVerdict,
      stage,
    );
    const anchoringRan = anchoring !== undefined;
    telemetryWriteFailed = !appendAnchoringTelemetry(input.sessionDir, {
      reviewId,
      proposed,
      verified: anchoringRan ? reviewVerdict.findings.length : 0,
      rejected: reviewVerdict.evidenceUnverifiedCount,
      snapshotIntegrityFailure: false,
      verificationSkipped: !anchoringRan,
      verificationDegraded: false,
      verificationRuntimeErrors: 0,
      logWriteFailures,
      anchorRealignedCount: reviewVerdict.anchorRealignedCount,
      integrityFlagged: reviewVerdict.reviewIntegrity.length,
      coverage: reviewVerdict.coverage,
      timestamp: new Date().toISOString(),
    }).ok;
  }

  // ── R6: review-progress.json display projection (legacy + new) ────
  if (input.sessionDir) {
    const skipped = lensesSkipped;
    const progress = {
      reviewId,
      stage,
      activeLensCount: input.metadata.activeLenses.length,
      lensesCompleted,
      lensesInsufficientContext: [] as string[],
      lensesFailed,
      lensesSkipped: skipped,
      // One row per lens, keyed by id so a lens can never appear twice (a
      // coverage entry always wins over the skipped-lens fallback).
      lensDetails: (() => {
        const rows = new Map<string, {
          lens: string;
          status: "complete" | "skipped" | "failed";
          findingCount: number;
          duration: number | null;
          model: string | null;
          error: string | null;
        }>();
        for (const e of lensCoverage) {
          rows.set(e.lensId, {
            lens: e.lensId,
            status:
              e.status === "ok" || e.status === "cached"
                ? "complete"
                : e.status === "skipped"
                  ? "skipped"
                  : "failed",
            findingCount: reviewVerdict.findings.filter((f) =>
              f.contributingLenses.includes(e.lensId),
            ).length,
            duration: null,
            model: null,
            error: null,
          });
        }
        for (const l of input.metadata.skippedLenses) {
          if (rows.has(l)) continue;
          rows.set(l, {
            lens: l,
            status: "skipped",
            findingCount: 0,
            duration: null,
            model: null,
            error: null,
          });
        }
        return [...rows.values()];
      })(),
      totalFindings: reviewVerdict.findings.length,
      timestamp: new Date().toISOString(),
      verdict: reviewVerdict.verdict,
      verdictReason: `${reviewVerdict.verdict}: ${reviewVerdict.blocking} blocking, ${reviewVerdict.major} major, coverage ${reviewVerdict.coverage}`,
      // Legacy display projection (R6): isPartial := coverage !== "full".
      isPartial: reviewVerdict.coverage !== "full",
      // New fields alongside.
      coverage: reviewVerdict.coverage,
      errorCodes: reviewVerdict.errorCodes,
      blocking: reviewVerdict.blocking,
      major: reviewVerdict.major,
      minor: reviewVerdict.minor,
      suggestion: reviewVerdict.suggestion,
    };
    try {
      writeFileSync(
        join(input.sessionDir, "review-progress.json"),
        JSON.stringify(progress, null, 2),
      );
    } catch {
      /* best-effort */
    }
  }

  // ── Cache write-back with the keys prepare minted ─────────────────
  if (input.sessionDir && meta) {
    for (const [lens, entry] of parsed) {
      if (entry.cached) continue;
      if (entry.output.status !== "ok") continue;
      const key = meta.cacheKeys[lens];
      if (!key) continue;
      try {
        writeToCache(
          input.sessionDir,
          key,
          // Never cache the orchestrator secrets meta-finding: it is injected
          // fresh each round from the live secrets gate. Caching it would
          // replay a stale meta-finding as a lens finding AND double it with
          // the fresh injection on the next identical round.
          entry.output.findings
            .filter((f) => f.id !== SECRETS_GATE_FINDING_ID)
            .map(stripServerFields),
        );
      } catch {
        /* best-effort caching */
      }
    }
  }

  return {
    reviewVerdict,
    lensesCompleted,
    lensesFailed,
    lensesSkipped,
    preExistingFindings,
    preExistingCount: preExistingFindings.length,
    telemetryWriteFailed,
  };
}
