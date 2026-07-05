/**
 * Lens consumer harness -- public API (ISS-823).
 *
 * The storybloq-side harness around @storybloq/lenses: the package owns the
 * lens registry, prompts, schemas, and merge semantics; this directory owns
 * what the lenses see (context packaging, secrets redaction, path safety),
 * round bookkeeping (caching, telemetry, display projections), and the
 * deterministic judge mapping.
 */

export { handlePrepare, HARNESS_META_FILE } from "./prepare.js";
export type { PrepareInput, PrepareOutput, PreparedLensPrompt, HarnessMeta } from "./prepare.js";

export { handleSynthesize } from "./synthesize.js";
export type { SynthesizeInput, SynthesizeOutput } from "./synthesize.js";

export { handleJudge } from "./judge.js";
export type { JudgeInput, JudgeOutput, ConvergenceHistoryEntry } from "./judge.js";

export { packageContext } from "./context-packager.js";
export { runSecretsGate, redactContent, redactArtifactSecrets } from "./secrets-gate.js";
export { parseDiffScope, classifyOrigin } from "./diff-scope.js";
export type { DiffScope } from "./diff-scope.js";
export { generateIssueKey } from "./issue-key.js";
export { resolveAndValidate } from "./path-safety.js";
export {
  buildCacheKey,
  getFromCache,
  writeToCache,
  clearCache,
  getCacheMetrics,
  resetCacheMetrics,
} from "./cache.js";
export {
  appendAnchoringTelemetry,
  appendDeferralRejections,
  accumulateVerificationCounters,
} from "./verification-log.js";
