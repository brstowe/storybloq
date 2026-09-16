/**
 * T-499: `computeSample`, the PURE half of the sampler. Given a scan, a
 * ceiling and the presence record as it stands, it decides the state:
 *
 *   advisory    contextTokens >= advisoryPct x ceiling, or the ceiling
 *               carries a conflict;
 *   imperative  contextTokens + jumpAllowance >= imperativePct x ceiling,
 *               jumpAllowance = clamp(p90 of per-assistant deltas since
 *               the epoch, floor, cap), floor when fewer than 5 deltas;
 *   compact-needed
 *               contextTokens >= compactNeededPct x ceiling, decided before
 *               the imperative rule and without the jump allowance, and never
 *               suppressed by a handover (ISS-1197 commit 2);
 *   suppressed  an imperative raw state reads advisory when the record's
 *               handover belongs to the CURRENT compaction
 *               (handoverBoundaryAt === lastBoundaryAt) and any one of the
 *               three re-arm gates is still closed: growth, interval, prompts
 *               (ISS-1197).
 *
 * `imperativeSince` is informational only and takes no part in suppression.
 * The I/O half (locate, scan, reconcile, persist) lives with the presence
 * bridge; this file has no file access at all.
 */

import type { SessionIntelPresence, TokenPressureState } from "../../presence/session-intel-fields.js";
import type { SessionIntelConfig } from "./config.js";
import type { CeilingResolution, SampledBy, ScanResult, TokenPressureSample, UsageAdvisory, UsageAdvisoryInput } from "./types.js";

export interface ComputeSampleInput {
  readonly scan: ScanResult;
  readonly ceiling: CeilingResolution;
  readonly cfg: SessionIntelConfig;
  readonly sampledBy: SampledBy;
  readonly sampledAt: string;
  /** The target's presence subtree as it is NOW (null when none). */
  readonly record: SessionIntelPresence | null;
  /** T-501: resolved by the caller (query.ts) from the TARGET's capture; this file reads no settings file. */
  readonly usage: UsageAdvisoryInput;
}

export const MIN_DELTAS_FOR_P90 = 5;

export function p90(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1);
  return s[Math.max(0, idx)]!;
}

export function jumpAllowanceFor(deltas: readonly number[], cfg: SessionIntelConfig): { value: number; basis: string } {
  const floor = cfg.jumpAllowanceFloorTokens;
  const cap = cfg.jumpAllowanceCapTokens;
  if (deltas.length < MIN_DELTAS_FOR_P90) {
    return { value: floor, basis: `floor ${floor} (${deltas.length} deltas since epoch, fewer than ${MIN_DELTAS_FOR_P90})` };
  }
  const p = p90(deltas)!;
  const value = Math.min(cap, Math.max(floor, p));
  const clamped = value === p ? "" : value === floor ? ", raised to floor" : ", capped";
  return { value, basis: `p90 of ${deltas.length} per-turn deltas since epoch = ${p}${clamped}` };
}

/** The re-arm gate that is still closed, and so is holding the advisory. */
export type HandoverRearmGate = "step" | "interval" | "prompts";

/**
 * Suppression as a function of the record alone (recomputed after acceptance
 * against the record as it is THEN). Null means nothing holds and the
 * imperative stands.
 *
 * ISS-1197: growth alone re-armed roughly a jump allowance past the handover,
 * so the imperative came back on the very next prompt and an agent wrote
 * eleven handovers in one session. Three gates now guard the re-arm and the
 * advisory holds while ANY of them is closed: the context has to have grown,
 * time has to have passed since the handover or the last imperative, and the
 * session has to have taken a few prompts.
 */
export function handoverSuppresses(
  record: SessionIntelPresence | null,
  contextTokens: number,
  ceiling: number,
  cfg: SessionIntelConfig,
  sampledAt: string,
): HandoverRearmGate | null {
  if (!record || record.tokensAtHandover === null || record.handoverWrittenAt === null) return null;
  if (record.handoverBoundaryAt !== record.lastBoundaryAt) return null;
  const step = Math.min(cfg.stepPct * ceiling, cfg.handoverRearmStepCapTokens);
  if (contextTokens < record.tokensAtHandover + step) return "step";
  const written = Date.parse(record.handoverWrittenAt);
  const latch = record.lastImperativeAt === null ? written : Math.max(written, Date.parse(record.lastImperativeAt));
  if (Date.parse(sampledAt) - latch < cfg.handoverRearmIntervalMs) return "interval";
  // Only the prompt hook advances the count, so with the hook off this gate
  // could never open and would hold the advisory until the next compaction.
  if (cfg.promptHook && record.promptsSinceHandover < cfg.handoverRearmPrompts) return "prompts";
  return null;
}

/**
 * T-501: the usage-cost advisory as a pure function of the resolved inputs
 * and the CURRENT config, so raising, lowering or zeroing
 * `recommendedWindowMax` changes the outcome without a new sample.
 *
 * An observed window decides on its own: above the max it is the advisory,
 * at or under it there is nothing to say -- including for a 1M-context model,
 * which compacts at the window, not at its native capacity. The model kind is
 * therefore reserved for the case where NO window was observed and nothing
 * bounds the context below 1,000,000.
 */
export function usageAdvisoryFrom(
  input: Pick<UsageAdvisoryInput, "window" | "source">,
  oneMillionFlag: boolean | null,
  cfg: SessionIntelConfig,
): UsageAdvisory | null {
  const recommendedMax = cfg.recommendedWindowMax;
  if (recommendedMax === 0) return null;
  if (input.window !== null) {
    return input.window > recommendedMax
      ? { kind: "window", observed: input.window, source: input.source, recommendedMax }
      : null;
  }
  return oneMillionFlag === true ? { kind: "model", nativeWindow: 1_000_000, recommendedMax } : null;
}

export function computeSample(input: ComputeSampleInput): TokenPressureSample {
  const { scan, ceiling, cfg, record } = input;
  const common = {
    sampledAt: input.sampledAt,
    sampledBy: input.sampledBy,
    observation: scan.observation,
    contextTokens: scan.contextTokens,
    lastAssistantAt: scan.lastAssistantAt,
    lastAssistantModel: scan.lastAssistantModel,
    oneMillionFlag: scan.oneMillionFlag,
    modelEvidence: scan.modelEvidence,
    ceiling,
    usageInput: input.usage,
    usageAdvisory: usageAdvisoryFrom(input.usage, scan.oneMillionFlag, cfg),
  };
  const previousSince = record?.lastSample?.imperativeSince ?? null;

  if (scan.contextTokens === null) {
    return { ...common, pct: null, headroom: null, jumpAllowance: null, jumpAllowanceBasis: "no assistant usage record in the scanned window", state: "unknown", rawState: "unknown", suppressedBy: null, imperativeSince: null, reason: "no assistant usage record in the scanned window" };
  }
  if (ceiling.ceiling === null) {
    return { ...common, pct: null, headroom: null, jumpAllowance: null, jumpAllowanceBasis: "no ceiling", state: "unknown", rawState: "unknown", suppressedBy: null, imperativeSince: null, reason: `ceiling unknown: ${ceiling.basis}` };
  }

  const tokens = scan.contextTokens;
  const c = ceiling.ceiling;
  const jump = jumpAllowanceFor(scan.deltas, cfg);
  const pct = tokens / c;
  const headroom = Math.max(0, Math.round(c - tokens));

  let rawState: TokenPressureState = "ok";
  // ISS-1197 commit 2: compact-needed is decided FIRST, on the measured tokens
  // alone. Before the imperative rule, because the two overlap by construction
  // and imperative would otherwise win every time; and without the jump
  // allowance, because the allowance is headroom reserved for the NEXT turn,
  // while this line is about where the context already is.
  if (tokens >= cfg.compactNeededPct * c) rawState = "compact-needed";
  else if (tokens + jump.value >= cfg.imperativePct * c) rawState = "imperative";
  else if (tokens >= cfg.advisoryPct * c || ceiling.conflict !== null) rawState = "advisory";

  let state = rawState;
  let suppressedBy: "handover" | null = null;
  // Only an imperative is ever held. A handover cannot answer compact-needed:
  // the whole point of the state is that writing one more is not the fix, so
  // routing it through the re-arm gates would hide the one state the surfaces
  // exist to show.
  const heldBy = rawState === "imperative" ? handoverSuppresses(record, tokens, c, cfg, input.sampledAt) : null;
  if (heldBy !== null) {
    state = "advisory";
    suppressedBy = "handover";
  }
  // At compact-needed the imperative condition is satisfied too (the tokens
  // alone already clear the higher line), so the stamp continues rather than
  // being cleared and re-taken on the way past.
  const imperativeSince = rawState === "imperative" || rawState === "compact-needed" ? previousSince ?? input.sampledAt : null;
  const reason =
    rawState === "compact-needed"
      ? `${tokens} >= ${cfg.compactNeededPct} x ${Math.round(c)}; past this point a handover does not help and only /compact does`
      : rawState === "imperative"
        ? `${tokens} + jump allowance ${jump.value} >= ${cfg.imperativePct} x ${Math.round(c)}${heldBy ? `; suppressed by a handover written for this compaction (the ${heldBy} gate holds the re-arm)` : ""}`
        : rawState === "advisory"
          ? ceiling.conflict && tokens < cfg.advisoryPct * c
            ? `ceiling conflict: ${ceiling.conflict}`
            : `${tokens} >= ${cfg.advisoryPct} x ${Math.round(c)}`
          : null;

  return { ...common, pct, headroom, jumpAllowance: jump.value, jumpAllowanceBasis: jump.basis, state, rawState, suppressedBy, imperativeSince, reason };
}
