/**
 * Multi-lens review preparation on the @storybloq/lenses package API
 * (ISS-823, pen ruling R2).
 *
 * prepare = carry-over consumer harness (context packaging, secrets gate,
 * path safety, per-lens caching) + package activate() + per-activation
 * buildLensPrompt(). The package is the single source for lens bodies,
 * shared preamble, and activation rules; this module only decides what each
 * lens sees (context-packager), redacts secrets before prompts leave the
 * process (secrets-gate), and mints/persists the round's cache keys and
 * anchoring artifact for the synthesize step.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LENSES,
  activate,
  buildLensPrompt,
  PreambleConfigSchema,
  type LensFinding,
  type Stage,
  type StartParams,
} from "@storybloq/lenses";
import { packageContext } from "./context-packager.js";
import { runSecretsGate, redactArtifactSecrets } from "./secrets-gate.js";
import { buildCacheKey, getFromCache } from "./cache.js";

// ISS-716: the assembled lens prompt is bounded upstream (per-lens artifact
// by the token budget, project rules by the 2000-char slice in
// context-packager), so this cap is a backstop against a pathological
// prompt, not the primary size control.
const MAX_PROMPT_SIZE = 200_000;

const TOKEN_BUDGET_PER_LENS = 32_000;

/** Session file carrying prepare-minted state into synthesize. */
export const HARNESS_META_FILE = "lens-harness-meta.json";

export interface HarnessMeta {
  readonly reviewId: string;
  readonly stage: Stage;
  readonly cacheKeys: Record<string, string>;
  /**
   * The full artifact the lenses actually saw, persisted ONLY when secrets
   * redaction changed it (synthesize must anchor quotes against the redacted
   * bytes, not the raw diff the agent passes back).
   */
  readonly anchorArtifact?: string;
  readonly secretsMetaFinding?: LensFinding | null;
}

export interface PrepareInput {
  readonly stage: Stage;
  readonly diff: string;
  readonly changedFiles: readonly string[];
  readonly ticketDescription?: string;
  readonly reviewRound?: number;
  readonly priorDeferrals?: readonly string[];
  readonly projectRoot: string;
  readonly sessionDir?: string;
  readonly sessionId?: string;
}

export interface PreparedLensPrompt {
  readonly lens: string;
  readonly model: string;
  readonly prompt: string;
  readonly promptRef: string;
  readonly promptTruncated: boolean;
  readonly cached: boolean;
  readonly cachedFindings?: readonly LensFinding[];
}

export interface PrepareOutput {
  readonly lensPrompts: readonly PreparedLensPrompt[];
  readonly artifact: string;
  readonly metadata: {
    readonly activeLenses: readonly string[];
    readonly skippedLenses: readonly string[];
    /** Per-lens activation status disclosure (pen ruling R2). */
    readonly activationReasons: Record<string, string>;
    readonly secretsGateActive: boolean;
    readonly reviewRound: number;
    readonly reviewId: string;
    readonly secretsMetaFinding: LensFinding | null;
  };
}

const ALL_LENS_IDS = Object.keys(LENSES) as readonly (keyof typeof LENSES)[];

export function handlePrepare(input: PrepareInput): PrepareOutput {
  // Guard: CODE_REVIEW with no changed files produces no lenses
  if (input.stage === "CODE_REVIEW" && input.changedFiles.length === 0) {
    const emptyReviewId = `lens-empty-${Date.now().toString(36)}`;
    // Overwrite any harness meta a prior round left behind so a later
    // synthesize can never anchor against a stale artifact or replay a stale
    // secrets meta-finding. (readHarnessMeta is also reviewId-gated, but this
    // keeps the on-disk state consistent with the round that just ran.)
    if (input.sessionDir) {
      try {
        writeFileSync(
          join(input.sessionDir, HARNESS_META_FILE),
          JSON.stringify(
            { reviewId: emptyReviewId, stage: input.stage, cacheKeys: {} } satisfies HarnessMeta,
            null,
            2,
          ),
        );
      } catch {
        /* best-effort */
      }
    }
    return {
      lensPrompts: [],
      artifact: input.diff,
      metadata: {
        activeLenses: [],
        skippedLenses: [],
        activationReasons: {},
        secretsGateActive: false,
        reviewRound: input.reviewRound ?? 1,
        reviewId: emptyReviewId,
        secretsMetaFinding: null,
      },
    };
  }

  const reviewId = `lens-${Date.now().toString(36)}`;
  const ticketDescription = input.ticketDescription ?? "Manual review";
  const reviewRound = input.reviewRound ?? 1;
  const knownFP = (input.priorDeferrals ?? []).join("\n");

  // 1. Activation via the package registry (surface rules + core set).
  const activations = activate({
    stage: input.stage,
    changedFiles: input.changedFiles,
  });
  const activeLenses = activations.map((a) => a.lensId as string);
  const skippedLenses = ALL_LENS_IDS.filter(
    (l) => !activeLenses.includes(l),
  ) as string[];
  const activationReasons: Record<string, string> = {};
  for (const a of activations) activationReasons[a.lensId] = a.activationReason;

  // 2. Secrets gate BEFORE any prompt is assembled (redaction must happen
  // before content leaves the process).
  const secrets =
    input.changedFiles.length > 0
      ? runSecretsGate(input.changedFiles, input.projectRoot, false)
      : { active: false, secretsFound: false, redactedLines: new Map(), metaFinding: null };

  const redacted =
    secrets.secretsFound && input.stage === "CODE_REVIEW"
      ? redactArtifactSecrets(input.diff, secrets.redactedLines)
      : input.diff;

  // 3. Context packaging on the (possibly redacted) artifact.
  const ctx = packageContext({
    stage: input.stage,
    diff: redacted,
    changedFiles: input.changedFiles,
    activeLenses,
    ticketDescription,
    projectRoot: input.projectRoot,
    tokenBudgetPerLens: TOKEN_BUDGET_PER_LENS,
  });

  const preambleConfig = PreambleConfigSchema.parse({});
  const projectContext = {
    projectRules: `${ctx.sharedHeader}\n\n${ctx.fileManifest}`,
    ...(knownFP ? { knownFalsePositives: knownFP } : {}),
  };

  // 4. Per activation: cache check, then package prompt construction.
  const lensPrompts: PreparedLensPrompt[] = [];
  const cacheKeys: Record<string, string> = {};

  for (const activation of activations) {
    const lens = activation.lensId;
    const artifact = ctx.perLensArtifacts.get(lens) ?? redacted;
    const cacheKey = buildCacheKey(
      lens,
      LENSES[lens].version,
      input.stage,
      artifact,
      ticketDescription,
      ctx.projectRules,
      knownFP,
    );
    cacheKeys[lens] = cacheKey;

    // Informational pointer: the prompt body's single source of truth.
    const ref = `@storybloq/lenses#${lens}`;
    const cached = input.sessionDir ? getFromCache(input.sessionDir, cacheKey) : null;
    if (cached) {
      lensPrompts.push({
        lens,
        model: activation.model,
        prompt: "",
        promptRef: ref,
        promptTruncated: false,
        cached: true,
        cachedFindings: cached,
      });
      continue;
    }

    const startParams: StartParams =
      input.stage === "CODE_REVIEW"
        ? {
            stage: "CODE_REVIEW",
            changedFiles: [...input.changedFiles] as [string, ...string[]],
            artifact,
            ticketDescription,
            reviewRound,
            priorDeferrals: [],
          }
        : {
            stage: "PLAN_REVIEW",
            artifact,
            ticketDescription,
            reviewRound,
            priorDeferrals: [],
          };

    const { prompt } = buildLensPrompt({
      activation,
      startParams,
      preambleConfig,
      projectContext,
    });
    const truncated = prompt.length > MAX_PROMPT_SIZE;
    lensPrompts.push({
      lens,
      model: activation.model,
      prompt: truncated ? "" : prompt,
      promptRef: ref,
      promptTruncated: truncated,
      cached: false,
    });
  }

  // 5. Persist harness meta for the synthesize step: cache keys for the
  // write-back, the redacted anchoring artifact (only when redaction changed
  // it), and the secrets meta-finding keyed by reviewId so a stale file from
  // an earlier round can never leak into a later one.
  if (input.sessionDir) {
    const meta: HarnessMeta = {
      reviewId,
      stage: input.stage,
      cacheKeys,
      ...(redacted !== input.diff ? { anchorArtifact: redacted } : {}),
      ...(secrets.metaFinding ? { secretsMetaFinding: secrets.metaFinding } : {}),
    };
    try {
      writeFileSync(
        join(input.sessionDir, HARNESS_META_FILE),
        JSON.stringify(meta, null, 2),
      );
    } catch {
      // Best-effort: synthesize falls back to the agent-supplied inputs.
    }
  }

  return {
    lensPrompts,
    artifact: redacted,
    metadata: {
      activeLenses,
      skippedLenses,
      activationReasons,
      secretsGateActive: secrets.active,
      reviewRound,
      reviewId,
      secretsMetaFinding: secrets.metaFinding,
    },
  };
}
