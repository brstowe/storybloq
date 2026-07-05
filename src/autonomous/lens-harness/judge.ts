/**
 * Deterministic review judge (ISS-823, pen rulings R2/R3).
 *
 * A pure three-value mapping over the package ReviewVerdict plus convergence
 * history. No LLM hop. The fork's judge-prompt calibration is retired; the
 * package pipeline already computed the verdict (blocking -> reject, majors
 * -> revise, coverage caps). This mapping adds the WF2 third value:
 *
 *   - pipeline reject  -> reject
 *   - pipeline revise  -> revise
 *   - pipeline approve carrying majors or partial coverage
 *                      -> approve + recommendFixRound (approve-recommend-fix-round)
 *   - else             -> approve
 *
 * Convergence history damps repeated majors-only recommendations using the
 * fork's documented stop rule, applied deterministically: once two
 * consecutive rounds ran with zero blocking findings and stable-or-decreasing
 * major counts, and the current round does not regress, stop recommending
 * further fix rounds. A coverage gap is a fresh signal every round and is
 * never damped.
 */

import {
  ReviewVerdictSchema,
  type LensCoverageEntry,
  type MergedFinding,
  type ReviewVerdict,
  type Tension,
} from "@storybloq/lenses";

export interface ConvergenceHistoryEntry {
  readonly round: number;
  readonly verdict: string;
  readonly blocking: number;
  readonly important: number;
  readonly newCode: string;
}

export interface JudgeInput {
  /** The ReviewVerdict returned by synthesize (object or already-parsed). */
  readonly reviewVerdict: unknown;
  readonly convergenceHistory?: readonly ConvergenceHistoryEntry[];
}

export interface JudgeOutput {
  readonly verdict: "approve" | "revise" | "reject";
  /**
   * The WF2 third value: verdict "approve" with recommendFixRound true is
   * approve-recommend-fix-round (ship-safe, but another round would likely
   * pay for itself).
   */
  readonly recommendFixRound: boolean;
  readonly verdictReason: string;
  /** Legacy display projection (R6): coverage !== "full". */
  readonly isPartial: boolean;
  readonly blocking: number;
  readonly major: number;
  readonly minor: number;
  readonly suggestion: number;
  readonly coverage: "full" | "partial";
  readonly errorCodes: readonly string[];
  readonly findings: readonly MergedFinding[];
  readonly tensions: readonly Tension[];
  readonly lensCoverage: readonly LensCoverageEntry[];
}

/**
 * The fork's documented stop rule, made deterministic: blocking = 0 for two
 * consecutive rounds AND major (important) counts stable or decreasing AND
 * no regression in the current round.
 */
function converged(
  history: readonly ConvergenceHistoryEntry[] | undefined,
  currentMajor: number,
): boolean {
  if (!history || history.length < 2) return false;
  const [prev, last] = history.slice(-2) as [
    ConvergenceHistoryEntry,
    ConvergenceHistoryEntry,
  ];
  return (
    prev.blocking === 0 &&
    last.blocking === 0 &&
    last.important <= prev.important &&
    currentMajor <= last.important
  );
}

export function handleJudge(input: JudgeInput): JudgeOutput {
  const parsed = ReviewVerdictSchema.safeParse(input.reviewVerdict);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid reviewVerdict: ${detail}`);
  }
  const v: ReviewVerdict = parsed.data;

  const coverageGap = v.coverage !== "full";
  let verdict: JudgeOutput["verdict"];
  let recommendFixRound: boolean;
  let verdictReason: string;

  if (v.verdict === "reject") {
    // The verdict itself is the fix signal; recommendFixRound is reserved for
    // the approve-recommend-fix-round third value only (pen ruling R2).
    verdict = "reject";
    recommendFixRound = false;
    verdictReason = `reject: ${v.blocking} blocking finding(s)`;
  } else if (v.verdict === "revise") {
    verdict = "revise";
    recommendFixRound = false;
    const capNote = coverageGap ? ", coverage partial" : "";
    verdictReason = `revise: ${v.major} major finding(s)${capNote}`;
  } else {
    verdict = "approve";
    const majorsGap = v.major > 0 && !converged(input.convergenceHistory, v.major);
    recommendFixRound = coverageGap || majorsGap;
    if (recommendFixRound) {
      const reasons: string[] = [];
      if (v.major > 0) reasons.push(`${v.major} major finding(s)`);
      if (coverageGap) reasons.push("coverage partial");
      verdictReason = `approve (recommend fix round: ${reasons.join(", ")})`;
    } else if (v.major > 0) {
      verdictReason = `approve (majors converged across rounds)`;
    } else {
      verdictReason = "approve";
    }
  }

  return {
    verdict,
    recommendFixRound,
    verdictReason,
    isPartial: coverageGap,
    blocking: v.blocking,
    major: v.major,
    minor: v.minor,
    suggestion: v.suggestion,
    coverage: v.coverage,
    errorCodes: v.errorCodes,
    findings: v.findings,
    tensions: v.tensions,
    lensCoverage: v.lensCoverage,
  };
}
