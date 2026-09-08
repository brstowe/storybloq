/**
 * T-495: the report-only measurement record for the review contract.
 *
 * REPORT-ONLY IS A PROPERTY OF THE CODE, NOT A PROMISE IN A COMMENT. Nothing
 * in this module returns a value a stage acts on, and `reportRound` cannot
 * throw, because `evaluatePrinciplePolicy` throws BY DESIGN on a caller bug
 * (`review-contract.ts:727-732`) and a report-only feature that fails a live
 * review round is the one outcome this ticket must not produce.
 *
 * Two logs are written, both under the session directory, both best-effort:
 *
 *  - `contract-delivery.jsonl` -- what contract TEXT a reviewer was actually
 *    handed, written by the two packet builders after the payload is CHOSEN.
 *  - `principle-policy.jsonl` -- what the contract WOULD have decided for each
 *    finding of an accepted round, written by the two review stages.
 *
 * They are separate because they are written at different times by different
 * code, and joining them is the reader's job. The join is what lets a capping
 * rate be split into "the reviewer read the contract and named nothing" and
 * "the reviewer never received it", which are the same number until something
 * records the difference.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  evaluatePrinciplePolicy,
  isImplicitPrinciple,
  loadReviewContract,
  projectRoundGate,
  readBlockingPolicy,
  type BaselineDecision,
  type FindingProjection,
} from "./review-contract.js";
import { readFindingPrinciple } from "./review-identity.js";

const DELIVERY_LOG = "contract-delivery.jsonl";
const POLICY_LOG = "principle-policy.jsonl";

// ---------------------------------------------------------------------------
// D2: the delivery record
// ---------------------------------------------------------------------------

export interface ContractDeliveryEntry {
  readonly sessionId: string;
  readonly target: string | null;
  readonly itemAttemptId: string | null;
  readonly stage: string;
  readonly generation: number | null;
  readonly roundNum: number;
  readonly leg: "packet" | "lens";
  /**
   * Whether the REVIEW.md PART reached the reviewer, not whether a section did.
   *
   * `projectRulesBody` builds ONE section from RULES.md AND REVIEW.md, so the
   * section survives the budget fit when RULES.md alone is present. Deriving
   * contract presence from section presence records a delivered contract for a
   * packet that carried only project rules.
   */
  readonly reviewMdIncluded: boolean;
  readonly omissionReason: string | null;
  readonly contentHash: string | null;
  readonly sourceChars: number | null;
  readonly sourceBytes: number | null;
  readonly deliveredChars: number | null;
  readonly truncated: boolean;
  readonly truncatedAtChars: number | null;
  readonly timestamp: string;
}

export type DeliveryBinding = "exact" | "weak" | "ambiguous" | "absent" | "omitted-by-fit";

export interface DeliveryKey {
  readonly sessionId: string;
  readonly target: string | null;
  readonly itemAttemptId: string | null;
  readonly stage: string;
  readonly generation: number | null;
  readonly roundNum: number;
}

export function appendContractDelivery(
  sessionDir: string,
  entry: ContractDeliveryEntry,
): { ok: boolean } {
  try {
    appendFileSync(join(sessionDir, DELIVERY_LOG), `${JSON.stringify(entry)}\n`);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function str(v: unknown): boolean { return typeof v === "string"; }
function nStr(v: unknown): boolean { return v === null || typeof v === "string"; }
function nNum(v: unknown): boolean {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

/**
 * Is this parsed line a delivery entry?
 *
 * VALIDATED, not asserted with a type cast. A cast is a claim about a file this
 * process did not write in this run, and the file is on disk where anything can
 * touch it. Two concrete failures a cast admits, both measured rather than
 * imagined: a JSON `null` line enters the array and makes the very next
 * `.sessionId` access THROW, degrading a round whose own measurement was
 * otherwise fine; and `"reviewMdIncluded": "false"` is a truthy STRING, so a
 * round whose contract was dropped reads as an exact delivery. Codex found
 * both.
 */
function isDeliveryEntry(v: unknown): v is ContractDeliveryEntry {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return str(e.sessionId) && nStr(e.target) && nStr(e.itemAttemptId)
    && str(e.stage) && nNum(e.generation)
    && typeof e.roundNum === "number" && Number.isFinite(e.roundNum)
    && (e.leg === "packet" || e.leg === "lens")
    && typeof e.reviewMdIncluded === "boolean"
    && nStr(e.omissionReason) && nStr(e.contentHash)
    && nNum(e.sourceChars) && nNum(e.sourceBytes) && nNum(e.deliveredChars)
    && typeof e.truncated === "boolean" && nNum(e.truncatedAtChars)
    && str(e.timestamp);
}

/**
 * Read the delivery log.
 *
 * THREE distinguishable answers, not two. An ABSENT log means this round has no
 * delivery observation; a FAILED read means one may exist and could not be
 * consulted, which is a degraded measurement naming its step; and an
 * UNREADABLE LINE means the log is incomplete in a way that matters to
 * uniqueness. Collapsing any pair reports a plumbing fault as evidence about
 * delivery.
 *
 * `unreadableLines` is the third, and it is not cosmetic. A torn or invalid
 * line could be a SECOND observation for the same key, so uniqueness among the
 * lines that parsed is not uniqueness in the log: skipping it silently turns an
 * ambiguous binding into an exact one and certifies a delivery that may have
 * been contradicted. Readable lines are still returned, because they are useful
 * for everything except a uniqueness claim. Codex found this.
 */
export function readContractDeliveries(
  sessionDir: string,
): {
  entries: readonly ContractDeliveryEntry[];
  readFailed: boolean;
  unreadableLines: number;
} {
  let raw: string;
  try {
    raw = readFileSync(join(sessionDir, DELIVERY_LOG), "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { entries: [], readFailed: false, unreadableLines: 0 };
    return { entries: [], readFailed: true, unreadableLines: 0 };
  }
  const entries: ContractDeliveryEntry[] = [];
  let unreadableLines = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unreadableLines += 1;
      continue;
    }
    if (isDeliveryEntry(parsed)) entries.push(parsed);
    else unreadableLines += 1;
  }
  return { entries, readFailed: false, unreadableLines };
}

/**
 * Bind a round to its delivery line.
 *
 * A NULL ON EITHER SIDE NEVER MATCHES AS A WILDCARD, and that rule is the whole
 * point of this function. The lens leg carries no `target` and no `generation`
 * by construction (`prepare.ts:122`), so under wildcard matching a single
 * surviving lens line binds to whatever round asks -- including a round whose
 * own write failed, which is precisely when a wrong answer is most damaging.
 * Its best state is `weak`, which is its own state and is INELIGIBLE for every
 * delivery-bound metric: counted, never used.
 *
 * Two matches are `ambiguous` and NEITHER is chosen. Last-wins on a retried
 * round silently reports the second line's contract as the delivered one.
 */
/**
 * What a delivery line OBSERVED, and WHICH ROUND it says it observed.
 *
 * `timestamp` is the only thing excluded, for the same reason it is excluded
 * from the policy records' canonical equivalence: every append carries a fresh
 * one, so a rule over the whole line can never find two lines equal and every
 * duplicate reads as a conflict.
 *
 * THE IDENTITY FIELDS ARE IN, and leaving them out was a real weakness. Two
 * lines that agree on what was delivered but name DIFFERENT targets are not one
 * observation recorded twice; they are observations of two different rounds,
 * and collapsing them would let a line about another item stand in for this
 * one. A genuine re-entry agrees on identity as well as content, so the
 * collapse this function exists for is untouched. Two key-field mutants
 * survived the gate until this was fixed, which is how it was found.
 */
function observationOf(e: ContractDeliveryEntry): string {
  return JSON.stringify([
    e.sessionId, e.target, e.itemAttemptId, e.stage, e.generation, e.roundNum,
    e.leg, e.reviewMdIncluded, e.omissionReason, e.contentHash,
    e.sourceChars, e.sourceBytes, e.deliveredChars, e.truncated, e.truncatedAtChars,
  ]);
}

export function resolveDelivery(
  entries: readonly ContractDeliveryEntry[],
  key: DeliveryKey,
  /**
   * True when the log held a line that could not be read. A hidden line may be
   * a second observation for this key, so no `exact` claim can be made over a
   * log that is not fully readable.
   */
  logIncomplete = false,
): { binding: DeliveryBinding; entry: ContractDeliveryEntry | null } {
  const present = (v: string | number | null): boolean => v !== null && v !== undefined;
  // `itemAttemptId` is deliberately NOT in this list, and its absence is the
  // point rather than an omission. A null on BOTH sides is AGREEMENT -- neither
  // the round nor the line has an item attempt -- which the filter below tests
  // exactly; a null on one side only already fails that filter. Requiring it to
  // be non-null here would make every round without an item attempt unbindable,
  // which is a large and entirely legitimate population.
  //
  // An earlier form wrote `present(key.itemAttemptId ?? "")`, which is true for
  // every input including null: a clause that reads as a check and can never be
  // false, which is this ticket's own failure class inside its own guard.
  const keyComplete = present(key.sessionId) && present(key.stage)
    && present(key.target) && present(key.generation);

  const full = entries.filter((e) =>
    e.sessionId === key.sessionId
    && e.stage === key.stage
    && e.roundNum === key.roundNum
    && present(e.target) && e.target === key.target
    && present(e.generation) && e.generation === key.generation
    && (e.itemAttemptId ?? null) === (key.itemAttemptId ?? null));

  if (keyComplete) {
    // IDENTICAL OBSERVATIONS COLLAPSE; only DISAGREEING ones are ambiguous.
    //
    // Measured, not assumed: a stage's `enter()` runs again on any re-entry --
    // a bounced payload, a resume, a compaction recovery -- and builds the same
    // packet at the same round, so two identical lines for one key is a NORMAL
    // path, not a retry in any meaningful sense. Treating line count alone as
    // ambiguity made every re-entered round permanently delivery-ineligible and
    // the reader would have reported a coverage gap that did not exist, which
    // is the same false reading this ticket exists to remove, arriving from the
    // other direction.
    //
    // Two lines that DISAGREE are still ambiguous and neither is chosen: that
    // is a genuine conflict about what the reviewer received, and last-wins
    // would silently report the second one.
    const distinct = new Set(full.map(observationOf));
    if (full.length > 1 && distinct.size > 1) return { binding: "ambiguous", entry: null };
    // A match cannot be called UNIQUE over a log with an unreadable line: the
    // line that could not be read may be the contradicting observation, so
    // "the one that parsed" is not "the only one there".
    if (full.length >= 1 && logIncomplete) return { binding: "ambiguous", entry: null };
    if (full.length >= 1) {
      const only = full[0]!;
      // An observation that the contract did NOT arrive is evidence, and it is
      // not an exact delivery. It has its own state so the reader can tell a
      // round whose contract was dropped by the fit from one with no
      // observation at all.
      return only.reviewMdIncluded
        ? { binding: "exact", entry: only }
        : { binding: "omitted-by-fit", entry: only };
    }
  }

  // Nothing bound on the full key. WEAK means a line that could not carry the
  // whole key -- structurally, like the lens leg, which has no target and no
  // generation. It does NOT mean a line with a complete key naming a DIFFERENT
  // target or generation: that line is evidence about ANOTHER round, and
  // reporting it as a weak observation of this one attributes a missing
  // observation to the wrong failure class, which is the coverage number
  // quietly describing the wrong thing. Codex found it.
  const weak = entries.filter((e) =>
    e.sessionId === key.sessionId
    && e.stage === key.stage
    && e.roundNum === key.roundNum
    && (e.target === null || e.target === key.target)
    && (e.generation === null || e.generation === key.generation)
    // A contradiction in ANY identity field present on both sides disqualifies
    // the line, `itemAttemptId` included. An incomplete line that nonetheless
    // NAMES a different item attempt is evidence about that attempt, not a
    // weak observation of this one. Codex found the gap in round 2.
    && (e.itemAttemptId === null || key.itemAttemptId === null
      || e.itemAttemptId === key.itemAttemptId)
    && (e.target === null || e.generation === null));
  if (weak.length > 0) return { binding: "weak", entry: null };
  return { binding: "absent", entry: null };
}

// ---------------------------------------------------------------------------
// D3: the measurement record
// ---------------------------------------------------------------------------

export type PolicyOutcome =
  | "unchanged"
  | "capped-names-none"
  | "capped-names-undeclared"
  | "promoted-declared"
  | "promoted-implicit"
  | "floor-suppressed";

export interface PolicyFindingRecord {
  readonly index: number;
  readonly principle: string | null;
  readonly coverage: string;
  readonly actualSeverity: string;
  readonly projectedSeverity: string;
  readonly policyBlock: string;
  readonly floorSuppressed: boolean;
  readonly outcome: PolicyOutcome;
  readonly reason: string;
  readonly undeclaredName: string | null;
  readonly baseline: { readonly severity: string; readonly blocking: boolean };
}

export interface PolicyGateRecord {
  readonly hasCriticalOrMajor: boolean;
  readonly hasUnresolvedCritical: boolean;
  readonly baselineHasCriticalOrMajor: boolean;
  readonly baselineHasUnresolvedCritical: boolean;
  readonly policyBlockedIndices: readonly number[];
  readonly forcedLandingAllowed: boolean;
}

export interface PolicyRecordIdentity {
  readonly sessionId: string;
  readonly itemId: string;
  readonly target: string;
  readonly itemAttemptId: string | null;
  readonly reviewAttemptId: string | null;
  readonly artifactFileName: string | null;
  readonly artifactContentHash: string | null;
  readonly stage: string;
  readonly round: number;
  readonly generation: number | null;
  readonly backend: string;
  readonly leg: "packet" | "lens";
}

export interface MeasuredPolicyRecord extends PolicyRecordIdentity {
  readonly kind: "measured";
  readonly evaluatedContentHash: string | null;
  readonly contractStatus: string;
  readonly contractActive: boolean;
  readonly effectivePolicy: {
    readonly alwaysBlock: readonly string[];
    readonly neverBlock: readonly string[];
  };
  readonly delivered: {
    readonly contentHash: string | null;
    readonly reviewMdIncluded: boolean;
    readonly truncated: boolean;
    readonly truncatedAtChars: number | null;
    readonly deliveredChars: number | null;
  } | null;
  readonly deliveryBinding: DeliveryBinding;
  readonly deliveryVerified: boolean;
  readonly deliveryVerifiedBy: "key-binding" | null;
  readonly findings: readonly PolicyFindingRecord[];
  readonly gate: PolicyGateRecord;
  readonly stageNextAction: string | null;
  readonly floorSuppressedMinorCount: number;
  readonly floorSuppressedTotal: number;
  readonly timestamp: string;
}

export type DegradedStep = "load" | "lookup" | "baselines" | "project" | "append";

/**
 * A reporter failure. It has NO `findings` key and NO `gate` key -- absent, not
 * empty. `findings: []` is the sentence "this round had no capped findings",
 * which is the exact false zero this whole ticket exists to remove, and a
 * consumer cannot tell an empty list from a list that was never built.
 */
export interface DegradedPolicyRecord extends PolicyRecordIdentity {
  readonly kind: "degraded";
  readonly failedAt: DegradedStep;
  readonly error: string;
  readonly timestamp: string;
}

export type PolicyRecord = MeasuredPolicyRecord | DegradedPolicyRecord;

export interface ReportRoundInput extends PolicyRecordIdentity {
  readonly sessionDir: string;
  readonly projectRoot: string;
  /**
   * The open window's baseline hash, when there is one. Absent means there is
   * nothing to verify delivery AGAINST, so no round can be verified: that is a
   * property of the window, and the reader says so rather than reporting it as
   * a delivery failure.
   */
  readonly windowBaselineHash?: string | null;
  readonly findings: readonly unknown[];
  readonly isRoundBlocker: (finding: unknown) => boolean;
  readonly baselineHasCriticalOrMajor: boolean;
  readonly baselineHasUnresolvedCritical: boolean;
  readonly stageNextAction: string | null;
}

/**
 * The per-finding outcome, derived from the projection's FIELDS.
 *
 * Not from its `reason` prose, which is written for humans and would make this
 * classification break on a wording change. And not collapsed: rev 1 folded the
 * two capping causes and the two promotion causes into one word each, which
 * made two of the printed labels unsupportable by the data behind them.
 *
 * `floorSuppressed` comes FIRST because it is a refused promotion: the finding
 * both named a blocking-class principle and did not move, and reporting it as
 * `unchanged` would lose the only evidence the clause-18 floor is revisitable
 * on.
 */
function outcomeOf(p: FindingProjection, finding: unknown): PolicyOutcome {
  if (p.floorSuppressed) return "floor-suppressed";
  if (p.projectedSeverity !== p.actualSeverity) {
    return p.undeclaredName === undefined ? "capped-names-none" : "capped-names-undeclared";
  }
  if (p.policyBlock === "block") {
    const named = readFindingPrinciple((finding as { principle?: unknown } | null)?.principle);
    return named !== undefined && isImplicitPrinciple(named)
      ? "promoted-implicit"
      : "promoted-declared";
  }
  return "unchanged";
}

/**
 * The baseline adapter: the STAGE's own decision, per finding.
 *
 * `isBlockingFinding` ALONE is never the baseline. It is the unresolved half,
 * and using it by itself projects unresolved MINORS as round blockers, which no
 * stage does. `evaluatePrinciplePolicy` refuses to invent a missing baseline
 * (it throws), so this is the one place a wrong answer could enter and never be
 * seen again.
 */
function baselinesFor(
  findings: readonly unknown[],
  isRoundBlocker: (f: unknown) => boolean,
): BaselineDecision[] {
  return findings.map((f) => {
    const severity = String((f as { severity?: unknown } | null)?.severity ?? "").toLowerCase();
    return {
      severity,
      blocking: (severity === "critical" || severity === "major") && isRoundBlocker(f),
    };
  });
}

function appendPolicyRecord(sessionDir: string, record: PolicyRecord): boolean {
  try {
    appendFileSync(join(sessionDir, POLICY_LOG), `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Measure ONE accepted review round. Decides nothing; returns nothing a stage
 * acts on.
 *
 * ALL FIVE STEPS are inside the boundary, not just the append. The evaluator
 * throws BY DESIGN on a baselines-length mismatch, so a boundary around the
 * append alone would let an integration slip fail a live review round -- a
 * report-only feature changing a review outcome, the one thing this must not
 * do. Where the append still works a `degraded` record is written naming the
 * step; where it does not, nothing is written and the reader sees
 * `measurement-absent`, whose cause it correctly declines to guess.
 */
export function reportRound(
  input: ReportRoundInput,
): { written: "measured" | "degraded" | "none"; failedAt: DegradedStep | null } {
  const identity: PolicyRecordIdentity = {
    sessionId: input.sessionId,
    itemId: input.itemId,
    target: input.target,
    itemAttemptId: input.itemAttemptId,
    reviewAttemptId: input.reviewAttemptId,
    artifactFileName: input.artifactFileName,
    artifactContentHash: input.artifactContentHash,
    stage: input.stage,
    round: input.round,
    generation: input.generation,
    backend: input.backend,
    leg: input.leg,
  };
  const timestamp = new Date().toISOString();

  const degrade = (
    failedAt: DegradedStep,
    err: unknown,
  ): { written: "degraded" | "none"; failedAt: DegradedStep | null } => {
    const record: DegradedPolicyRecord = {
      ...identity,
      kind: "degraded",
      failedAt,
      error: err instanceof Error ? err.message : String(err),
      timestamp,
    };
    return appendPolicyRecord(input.sessionDir, record)
      ? { written: "degraded", failedAt }
      : { written: "none", failedAt };
  };

  let step: DegradedStep = "load";
  try {
    const contract = loadReviewContract(input.projectRoot);
    const policy = readBlockingPolicy(input.projectRoot);

    step = "lookup";
    const log = readContractDeliveries(input.sessionDir);
    if (log.readFailed) {
      throw new Error(`${DELIVERY_LOG} could not be read`);
    }
    const bound = resolveDelivery(log.entries, {
      sessionId: input.sessionId,
      target: input.target,
      itemAttemptId: input.itemAttemptId,
      stage: input.stage,
      generation: input.generation,
      roundNum: input.round,
    }, log.unreadableLines > 0);

    step = "baselines";
    const baselines = baselinesFor(input.findings, input.isRoundBlocker);

    step = "project";
    const projection = evaluatePrinciplePolicy({
      contract,
      findings: input.findings,
      baselines,
      isRoundBlocker: input.isRoundBlocker,
      alwaysBlock: policy.alwaysBlock,
      neverBlock: policy.neverBlock,
    });
    const gate = projectRoundGate({
      projections: projection.projections,
      baselineHasCriticalOrMajor: input.baselineHasCriticalOrMajor,
      baselineHasUnresolvedCritical: input.baselineHasUnresolvedCritical,
    });

    // TWO CONJUNCTS, NOT THREE, and the conjunction is RECORDED rather than
    // left for the reader to infer. An exact key binding says the round is
    // matched to its own delivery line; an equal hash says that line carried
    // the window's contract. The layout guard shipped in T-487 commit 2 already
    // proves the BASELINE's principle list is complete, so a delivered hash
    // equal to the baseline IS a complete principle list; re-deriving
    // completeness by parsing delivered text would measure the surviving subset
    // of a truncation and always answer true.
    //
    // A reader that DEFINED "verified" could quietly widen it. This is why the
    // definition lives at the write site.
    const deliveredHash = bound.entry?.contentHash ?? null;
    const deliveryVerified = bound.binding === "exact"
      && input.windowBaselineHash != null
      && deliveredHash != null
      && deliveredHash === input.windowBaselineHash;

    const record: MeasuredPolicyRecord = {
      ...identity,
      kind: "measured",
      evaluatedContentHash: contract.contentHash,
      contractStatus: contract.status,
      contractActive: projection.active,
      effectivePolicy: { alwaysBlock: policy.alwaysBlock, neverBlock: policy.neverBlock },
      delivered: bound.entry === null ? null : {
        contentHash: bound.entry.contentHash,
        reviewMdIncluded: bound.entry.reviewMdIncluded,
        truncated: bound.entry.truncated,
        truncatedAtChars: bound.entry.truncatedAtChars,
        deliveredChars: bound.entry.deliveredChars,
      },
      deliveryBinding: bound.binding,
      deliveryVerified,
      deliveryVerifiedBy: deliveryVerified ? "key-binding" : null,
      findings: projection.projections.map((p) => ({
        index: p.index,
        principle: readFindingPrinciple(
          (input.findings[p.index] as { principle?: unknown } | null)?.principle,
        ) ?? null,
        coverage: p.coverage,
        actualSeverity: p.actualSeverity,
        projectedSeverity: p.projectedSeverity,
        policyBlock: p.policyBlock,
        floorSuppressed: p.floorSuppressed,
        outcome: outcomeOf(p, input.findings[p.index]),
        reason: p.reason,
        undeclaredName: p.undeclaredName ?? null,
        baseline: baselines[p.index]!,
      })),
      gate,
      stageNextAction: input.stageNextAction,
      floorSuppressedMinorCount: projection.floorSuppressedMinorCount,
      floorSuppressedTotal: projection.floorSuppressedTotal,
      timestamp,
    };

    step = "append";
    return appendPolicyRecord(input.sessionDir, record)
      ? { written: "measured", failedAt: null }
      : { written: "none", failedAt: "append" };
  } catch (err) {
    return degrade(step, err);
  }
}

const DEGRADED_STEPS: ReadonlySet<string> = new Set([
  "load", "lookup", "baselines", "project", "append",
]);
const BINDINGS: ReadonlySet<string> = new Set([
  "exact", "weak", "ambiguous", "absent", "omitted-by-fit",
]);
const OUTCOMES: ReadonlySet<string> = new Set([
  "unchanged", "capped-names-none", "capped-names-undeclared",
  "promoted-declared", "promoted-implicit", "floor-suppressed",
]);

function bool(v: unknown): boolean { return typeof v === "boolean"; }
function count(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}
function strArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function hasIdentity(r: Record<string, unknown>): boolean {
  return str(r.sessionId) && str(r.itemId) && str(r.target) && nStr(r.itemAttemptId)
    && nStr(r.reviewAttemptId) && nStr(r.artifactFileName) && nStr(r.artifactContentHash)
    && str(r.stage) && count(r.round) && nNum(r.generation) && str(r.backend)
    && (r.leg === "packet" || r.leg === "lens") && str(r.timestamp);
}

function isFindingRecord(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const f = v as Record<string, unknown>;
  const b = f.baseline;
  return count(f.index) && nStr(f.principle) && str(f.coverage)
    && str(f.actualSeverity) && str(f.projectedSeverity) && str(f.policyBlock)
    && bool(f.floorSuppressed) && typeof f.outcome === "string" && OUTCOMES.has(f.outcome)
    && str(f.reason) && nStr(f.undeclaredName)
    && b !== null && typeof b === "object" && !Array.isArray(b)
    && str((b as Record<string, unknown>).severity)
    && bool((b as Record<string, unknown>).blocking);
}

function isGateRecord(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const g = v as Record<string, unknown>;
  return bool(g.hasCriticalOrMajor) && bool(g.hasUnresolvedCritical)
    && bool(g.baselineHasCriticalOrMajor) && bool(g.baselineHasUnresolvedCritical)
    && Array.isArray(g.policyBlockedIndices) && g.policyBlockedIndices.every(count)
    && bool(g.forcedLandingAllowed);
}

/**
 * Is this parsed line a policy record?
 *
 * DEEP, not shallow, and every field the reader will touch is checked. A guard
 * that only tests `Array.isArray(findings)` admits `findings: [null]` and
 * `gate: []` and then hands them back as a fully typed record: the consumer
 * crashes on a field access, or worse, aggregates a record whose numbers mean
 * nothing. Codex found that in round 2, after the shallow version had already
 * been added in response to round 1 -- a validator that validates the wrong
 * depth is the same absence reading as a zero, one layer down.
 *
 * The DISCRIMINANT is checked first and the two arms separately, because the
 * union exists to keep `degraded` from carrying findings: a line shaped
 * `{kind: "degraded", findings: []}` would otherwise be read as "this round had
 * no capped findings", which is the false zero the whole ticket is about.
 *
 * An unknown `kind` is UNREADABLE, not accepted. A record this build cannot
 * classify is one it cannot aggregate, and counting it as unreadable is what
 * makes the reader say so instead of quietly dropping it.
 */
function isPolicyRecord(v: unknown): v is PolicyRecord {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (!hasIdentity(r)) return false;
  if (r.kind === "degraded") {
    // ABSENT, not empty, enforced on the way IN as well as on the way out.
    if ("findings" in r || "gate" in r) return false;
    return typeof r.failedAt === "string" && DEGRADED_STEPS.has(r.failedAt) && str(r.error);
  }
  if (r.kind === "measured") {
    const p = r.effectivePolicy;
    return nStr(r.evaluatedContentHash) && str(r.contractStatus) && bool(r.contractActive)
      && p !== null && typeof p === "object" && !Array.isArray(p)
      && strArray((p as Record<string, unknown>).alwaysBlock)
      && strArray((p as Record<string, unknown>).neverBlock)
      && (r.delivered === null
        || (typeof r.delivered === "object" && !Array.isArray(r.delivered)
          && nStr((r.delivered as Record<string, unknown>).contentHash)
          && bool((r.delivered as Record<string, unknown>).reviewMdIncluded)
          && bool((r.delivered as Record<string, unknown>).truncated)
          && nNum((r.delivered as Record<string, unknown>).truncatedAtChars)
          && nNum((r.delivered as Record<string, unknown>).deliveredChars)))
      && typeof r.deliveryBinding === "string" && BINDINGS.has(r.deliveryBinding)
      && bool(r.deliveryVerified)
      && (r.deliveryVerifiedBy === null || r.deliveryVerifiedBy === "key-binding")
      && Array.isArray(r.findings) && r.findings.every(isFindingRecord)
      && isGateRecord(r.gate)
      && nStr(r.stageNextAction)
      && count(r.floorSuppressedMinorCount) && count(r.floorSuppressedTotal);
  }
  return false;
}

export function readPolicyRecords(
  sessionDir: string,
): { records: readonly PolicyRecord[]; readFailed: boolean; unreadableLines: number } {
  let raw: string;
  try {
    raw = readFileSync(join(sessionDir, POLICY_LOG), "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { records: [], readFailed: false, unreadableLines: 0 };
    return { records: [], readFailed: true, unreadableLines: 0 };
  }
  const parsed = parsePolicyRecordLines(raw);
  return { ...parsed, readFailed: false };
}

/**
 * Parse the log's TEXT. Separate from the read so a caller that does its own
 * I/O -- the review-stats scanner, which is async and classifies its own
 * failures by scope -- validates through this exact function rather than
 * through a second copy of the shape rules. Two validators drift, and the one
 * that drifts looser admits a record the other refuses.
 */
export function parsePolicyRecordLines(
  raw: string,
): { records: readonly PolicyRecord[]; unreadableLines: number } {
  const records: PolicyRecord[] = [];
  let unreadableLines = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unreadableLines += 1;
      continue;
    }
    if (isPolicyRecord(parsed)) records.push(parsed);
    else unreadableLines += 1;
  }
  return { records, unreadableLines };
}

/**
 * Canonical equivalence, over an EXPLICIT field list that excludes `timestamp`.
 *
 * "Identical duplicates collapse" can never fire while every append carries a
 * fresh timestamp, so comparing whole records means no duplicate ever collapses
 * and every replay reads as a conflict. The list below is what a replay of the
 * SAME attempt must agree on; `effectivePolicy` is inside it, so a week during
 * which the configuration changed reads as a conflicting evaluation rather than
 * as a change in reviewer behaviour.
 */
const CANONICAL_FIELDS = [
  "sessionId", "itemId", "target", "itemAttemptId", "reviewAttemptId",
  "artifactFileName", "artifactContentHash", "stage", "round", "generation",
  "backend", "leg",
  "evaluatedContentHash", "contractStatus", "contractActive", "effectivePolicy",
  "delivered", "deliveryBinding", "deliveryVerified", "deliveryVerifiedBy",
  "findings", "gate", "stageNextAction",
  "floorSuppressedMinorCount", "floorSuppressedTotal",
] as const;

export function recordsEquivalent(a: MeasuredPolicyRecord, b: MeasuredPolicyRecord): boolean {
  const pick = (r: MeasuredPolicyRecord): string => JSON.stringify(
    CANONICAL_FIELDS.map((k) => (r as unknown as Record<string, unknown>)[k]),
  );
  return pick(a) === pick(b);
}
