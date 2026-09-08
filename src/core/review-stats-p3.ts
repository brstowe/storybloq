/**
 * T-495 D6: the review-contract population, inside T-432's honesty contract.
 *
 * WHY THIS LIVES HERE AND NOT BESIDE `review-stats`. That module already
 * encodes in TYPES what this reader needs in prose: `metric()` is the single
 * site where an empty denominator becomes `null` and never `0`; `renderValue`
 * prints `-` for null; `renderCoverage` prints "readable / total unknown";
 * `RecordCounts` keeps `missing` and `invalid` apart from `readFailures`;
 * `Provenance` separates observed from derived from reconstructed. A parallel
 * reader would reimplement all of that or quietly lack it.
 *
 * THE VERDICT IS COMPUTED HERE AND ONLY READ BY THE RENDERER, per that
 * module's own rule. A renderer that derived its own PASS would print a
 * disclosure beside a number the disclosure does not describe.
 *
 * THE ONE STANDING DESIGN RULE THIS FILE IS BUILT AROUND: a metric selector may
 * never presuppose the outcome the metric exists to reveal. The
 * delivered-versus-evaluated metric therefore selects on the PRESENCE of a
 * delivered hash, never on delivery having been verified: verification already
 * requires the delivered hash to equal the baseline, so a selector keyed on it
 * has an unreachable numerator by construction and would print a clean zero for
 * a question it cannot ask.
 */
import {
  recordsEquivalent,
  type MeasuredPolicyRecord,
  type PolicyRecord,
} from "../autonomous/principle-policy-report.js";
import type { P3Record } from "./review-stats-scan.js";
import {
  metric,
  type Metric,
  type MetricInput,
  type P1Artifact,
  type RecordCounts,
  type ScanReport,
  type ScanState,
} from "./review-stats-types.js";
import { CLOCK_SKEW_MS, MIN_POPULATION, type ContractWindow } from "./review-stats-window.js";

/** REVIEW.md as the scan found it. Header material, never a denominator. */
export interface ContractAtScan {
  readonly status: string;
  readonly principleCount: number;
  readonly invalidCount: number;
}

/**
 * The ONLY input `computeP3` accepts.
 *
 * No session array and no event can arrive through it, so pooling with P2 is a
 * type error rather than a review finding. That is the same guarantee `P1Input`
 * and `P2Input` carry and it is the reason each has its own type.
 */
export interface P3Input {
  readonly records: readonly P3Record[];
  readonly artifacts: readonly P1Artifact[];
  readonly window: ContractWindow | null;
  readonly scan: ScanReport;
  /** The scan clock. The five-minute skew allowance is measured from here. */
  readonly nowMs: number;
  readonly contractAtScan?: ContractAtScan;
}

/** Exclusions that mean the round's OUTCOME is unknown. These carry the 20%. */
export type OutcomeExclusionClass =
  | "degraded"
  | "conflicting-evaluation"
  | "measurement-absent"
  | "join-mismatch"
  | "hash-mismatch";

/**
 * Exclusions that mean the round's outcome IS known and what reached the
 * reviewer is not. They have their own rate, per leg, and NEVER invalidate.
 */
export type DeliveryExclusionClass =
  | "weak-binding"
  | "null-delivery"
  | "omitted-by-fit"
  | "ambiguous-delivery"
  | "delivered-hash-differs";

export interface ExclusionCount {
  readonly cls: string;
  readonly count: number;
  readonly packet: number;
  readonly lens: number;
  /** Said on the class, not left for a reader to infer from the name. */
  readonly note?: string;
}

export interface ExclusionFamily {
  readonly excluded: number;
  readonly of: number;
  readonly rate: number | null;
  readonly byClass: readonly ExclusionCount[];
}

export interface P3Population {
  /**
   * FALSE when no usable window selects a population.
   *
   * The counts below are then all zero because nothing was selected, not
   * because nothing happened, and a renderer that prints them as measured
   * numbers contradicts the verdict, which already says the floor cannot be
   * evaluated. Carried as a field so the renderer READS it rather than
   * re-deriving the condition from the window.
   */
  readonly membershipDefined: boolean;
  readonly inWindow: number;
  readonly outOfWindowPast: number;
  readonly outOfWindowFuture: number;
  readonly undated: number;
  readonly outOfScopeRoots: readonly { readonly root: string; readonly artifacts: number }[];
  readonly windowRootsNotScanned: readonly string[];
  readonly orphanRecords: number;
  /**
   * Records that joined a member artifact and AGREED with its stored hash.
   *
   * Includes the agreeing records of a round excluded for a sibling's
   * disagreement: they joined, whatever the round turned out to be worth.
   *
   * ASSUMING MEMBER ARTIFACTS HAVE UNIQUE JOIN KEYS, a record is in exactly one
   * of `joinedRecords`, `joinMismatchRecords`, `recordsOutsideWindow` and
   * `orphanRecords`, which is what lets the reconciliation line be checked
   * rather than believed. That precondition is NOT enforced anywhere: the loop
   * runs per artifact and looks up the same candidate list by
   * `(root, sessionId, reviewAttemptId)`, so two member artifacts sharing a key
   * with different content hashes each classify the same record, once as
   * agreeing and once as disagreeing, and the buckets then exceed the input
   * count. Stated rather than implied, because an unqualified invariant that
   * rests on an unenforced precondition is a line that reads as checkable and
   * is not. Codex found it in round 4.
   */
  readonly joinedRecords: number;
  /** Records joining an artifact that is not a member of the window. */
  readonly recordsOutsideWindow: number;
  /** Records rejected because their stored artifact hash disagreed. */
  readonly joinMismatchRecords: number;
  readonly measuredRounds: number;
  readonly degradedRounds: number;
  readonly artifactsWithNoRecord: number;
  readonly unjoinableArtifacts: number;
  readonly degradedAlongsideMeasured: number;
  readonly verifiedRounds: number;
  readonly unverifiedRounds: number;
}

export interface DeliveryCoverage {
  readonly leg: "packet" | "lens";
  readonly verified: number;
  readonly rounds: number;
  readonly rate: number | null;
}

export type P3StatusCode =
  | "void-contract-changed"
  | "divergence-unobserved"
  | "no-window"
  | "window-open"
  | "scan-incomplete"
  | "indeterminate-membership"
  | "insufficient-population"
  | "no-blocking-condition";

export interface P3Status {
  readonly code: P3StatusCode;
  readonly headline: string;
  readonly reason: string;
}

export interface ThresholdRow {
  readonly family: "outcome" | "delivery-coverage" | "population";
  readonly label: string;
  readonly measured: string;
  readonly against: string;
  /** NULL when the threshold cannot be evaluated. Never a default PASS. */
  readonly pass: boolean | null;
}

export interface P3Verdict {
  readonly status: P3Status;
  readonly rows: readonly ThresholdRow[];
  readonly notAnAuthorisation: string;
  readonly observationalLimit: string;
}

export interface PolicyForm {
  readonly alwaysBlock: readonly string[];
  readonly neverBlock: readonly string[];
  readonly rounds: number;
}

export interface P3Result {
  readonly window: ContractWindow | null;
  readonly contractAtScan: ContractAtScan | null;
  readonly scanState: ScanState;
  readonly population: P3Population;
  readonly headline: readonly Metric[];
  readonly unverified: readonly Metric[];
  readonly projection: readonly Metric[];
  readonly deliveryDetail: readonly Metric[];
  readonly headlineFindings: number;
  readonly unverifiedFindings: number;
  readonly unverifiedFindingsByLeg: { readonly packet: number; readonly lens: number };
  readonly deliveryCoverage: readonly DeliveryCoverage[];
  readonly outcomeExclusions: ExclusionFamily;
  readonly deliveryExclusions: ExclusionFamily;
  readonly totalDeliveryIneligible: number;
  readonly pooled: ExclusionFamily;
  readonly policyForms: readonly PolicyForm[];
  readonly verdict: P3Verdict;
}


/** Ruled thresholds. Only the OUTCOME family's is allowed to invalidate. */
const OUTCOME_MAX = 0.2;
const DELIVERY_MIN = 0.8;

const OUTCOME_CLASSES: readonly OutcomeExclusionClass[] = [
  "degraded", "conflicting-evaluation", "measurement-absent", "join-mismatch", "hash-mismatch",
];
const DELIVERY_CLASSES: readonly DeliveryExclusionClass[] = [
  "weak-binding", "delivered-hash-differs", "omitted-by-fit", "null-delivery", "ambiguous-delivery",
];

const NOT_AN_AUTHORISATION =
  "This printout is NOT an authorisation. Flip authorisation is a pen ruling that cites these "
  + "three lines, and a week failing any of them is not a basis for one.";

const OBSERVATIONAL_LIMIT =
  "Observational limit, stated once: an uncommitted edit to REVIEW.md made and reverted between "
  + "two rounds leaves every recorded hash equal to the baseline, no commit in the window, and a "
  + "clean tree at close, and is therefore not detectable by any of the divergence checks.";

const CONDITIONAL_ON_DELIVERY =
  "Conditional on VERIFIED delivery. This rate describes only the rounds where the contract "
  + "provably reached the reviewer; round coverage is not representativeness.";

const CAUSE_UNKNOWN =
  "cause unknown: a crash before the reporter ran, a call site that never reported, a deleted log "
  + "and an incomplete write are indistinguishable from the join, so none of them is claimed";

const LENS_ZERO_DISCLOSURE =
  "zero BY DISCLOSURE, not by measurement: the lens leg has no target and no generation, so it can "
  + "never bind exact, and the attestation that would have observed it is withdrawn to ISS-1148";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function rateOf(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function pct(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

/**
 * Aggregate the P3 scan state across roots.
 *
 * PARTIAL and UNAVAILABLE are not degrees of one thing, and the aggregate keeps
 * that: anything read anywhere makes the worst case PARTIAL, nothing read
 * anywhere leaves it UNAVAILABLE.
 */
export function aggregateP3ScanState(
  scan: ScanReport,
  scopedRoots: readonly string[],
): ScanState {
  // BOTH POPULATIONS, because MEMBERSHIP comes from P1. The scanner classifies
  // an unreadable artifact file and a failed reviews-directory listing as
  // affecting `p1` only, which is right for P1's own metrics and wrong here:
  // those are the accepted rounds this week is made of. Reading only the `p3`
  // states let a week with unreadable artifacts report a COMPLETE scan and no
  // blocking condition while silently omitting rounds. Codex found it.
  const scope = new Set(scopedRoots);
  const states = Object.entries(scan.state)
    .filter(([k]) => {
      const sep = k.indexOf(":");
      const population = k.slice(0, sep);
      return (population === "p1" || population === "p3") && scope.has(k.slice(sep + 1));
    })
    .map(([, v]) => v);
  if (states.length === 0) return "EMPTY";
  const anyRead = states.some((s) => s === "COMPLETE" || s === "PARTIAL");
  if (states.some((s) => s === "PARTIAL" || s === "UNAVAILABLE")) {
    return anyRead ? "PARTIAL" : "UNAVAILABLE";
  }
  return states.some((s) => s === "COMPLETE") ? "COMPLETE" : "EMPTY";
}

/**
 * Which leg a round belongs to.
 *
 * From the RECORD whenever one joined, because that is what the reporter
 * observed. The artifact's free-text `reviewer` is the fallback for a round
 * with no record at all, which is the only case where a leg still has to be
 * decided and nothing authoritative exists to decide it from.
 */
function legOfArtifact(artifact: P1Artifact): "packet" | "lens" {
  return artifact.reviewerRaw.toLowerCase().includes("lens") ? "lens" : "packet";
}

/**
 * The delivery exclusion a measured, unverified round falls in.
 *
 * NULL for a verified round. An `exact` binding that is still not verified is
 * `delivered-hash-differs`: the round was matched to its own delivery line and
 * that line carried a contract other than the window's baseline, which is a
 * different failure from having no line at all.
 */
export function deliveryExclusionOf(record: MeasuredPolicyRecord): DeliveryExclusionClass | null {
  if (record.deliveryVerified) return null;
  switch (record.deliveryBinding) {
    case "weak": return "weak-binding";
    case "absent": return "null-delivery";
    case "omitted-by-fit": return "omitted-by-fit";
    case "ambiguous": return "ambiguous-delivery";
    case "exact": return "delivered-hash-differs";
    default: return "null-delivery";
  }
}

/**
 * Classify one accepted round from the records that joined its artifact.
 *
 * Order matters and is stated: a round with NO measured record is `degraded`
 * only when a degraded record explains why, and `measurement-absent` when
 * nothing at all was written. Those are different facts and the second one's
 * cause is not knowable from the join.
 */
export function classifyRound(
  records: readonly PolicyRecord[],
  baselineHash: string,
): { readonly kind: "measured"; readonly record: MeasuredPolicyRecord }
  | { readonly kind: "excluded"; readonly cls: OutcomeExclusionClass } {
  const measured = records.filter((r): r is MeasuredPolicyRecord => r.kind === "measured");
  if (measured.length === 0) {
    return records.length === 0
      ? { kind: "excluded", cls: "measurement-absent" }
      : { kind: "excluded", cls: "degraded" };
  }
  // IDENTICAL RECORDS COLLAPSE, disagreeing ones do not. `recordsEquivalent`
  // compares over an explicit field list that excludes `timestamp`, because
  // every append carries a fresh one and comparing whole records means no
  // duplicate ever collapses and every re-entry reads as a conflict.
  const first = measured[0]!;
  if (measured.some((r) => !recordsEquivalent(first, r))) {
    return { kind: "excluded", cls: "conflicting-evaluation" };
  }
  // The evaluated hash is READ, never recomputed here. Recomputing would report
  // a mismatch for a contract that has since changed, which VOIDs a week for an
  // edit made after it closed.
  if (first.evaluatedContentHash !== baselineHash) {
    return { kind: "excluded", cls: "hash-mismatch" };
  }
  return { kind: "measured", record: first };
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

interface Round {
  readonly artifact: P1Artifact;
  readonly leg: "packet" | "lens";
  readonly state:
    | { readonly kind: "measured"; readonly record: MeasuredPolicyRecord }
    | { readonly kind: "excluded"; readonly cls: OutcomeExclusionClass };
}

function joinKey(root: string, sessionId: string, reviewAttemptId: string): string {
  return JSON.stringify([root, sessionId, reviewAttemptId]);
}

export function computeP3(input: P3Input): P3Result {
  const window = input.window;
  // The roots the week is ABOUT. With no window there is no scope, so the
  // scanned roots stand in: a scan problem is still a scan problem.
  const scanState = aggregateP3ScanState(
    input.scan,
    window === null || window.roots.length === 0 ? input.scan.roots : window.roots,
  );
  const openedMs = window === null ? Number.NaN : Date.parse(window.openedAt);
  const closedMs = window === null || window.closedAt === null
    ? null
    : Date.parse(window.closedAt);
  // `readContractWindow` already refuses a window whose instants do not parse,
  // so this is defence in depth for a window handed in directly. It routes to
  // `no-window`, which is the honest answer: a week whose start cannot be
  // placed is not a week whose contract changed.
  const windowUsable = window !== null && !Number.isNaN(openedMs)
    && (window.closedAt === null || (closedMs !== null && !Number.isNaN(closedMs)));

  // ── membership, by ARTIFACT timestamp ──────────────────────────
  const rootScope = new Set(windowUsable ? window!.roots : []);
  const members: P1Artifact[] = [];
  const outOfScope = new Map<string, number>();
  let outOfWindowPast = 0;
  let outOfWindowFuture = 0;
  let undated = 0;
  if (windowUsable) {
    for (const a of input.artifacts) {
      if (!rootScope.has(a.root)) {
        outOfScope.set(a.root, (outOfScope.get(a.root) ?? 0) + 1);
        continue;
      }
      // An artifact with no usable instant cannot be placed relative to the
      // window AT ALL. It is counted, reported, and it makes the verdict
      // UNDETERMINED: indeterminate MEMBERSHIP and an incomplete SCAN are
      // different defects and only the second is a scan problem.
      if (a.epochMs === null) { undated += 1; continue; }
      if (a.epochMs < openedMs) { outOfWindowPast += 1; continue; }
      if (closedMs !== null && !Number.isNaN(closedMs) && a.epochMs > closedMs) {
        outOfWindowFuture += 1;
        continue;
      }
      // Clock skew produces a NAMED count rather than a silent admission.
      if (a.epochMs > input.nowMs + CLOCK_SKEW_MS) { outOfWindowFuture += 1; continue; }
      members.push(a);
    }
  }
  const windowRootsNotScanned = windowUsable
    ? window!.roots.filter((r) => !input.scan.roots.includes(r))
    : [];

  // ── the join, on artifact identity ─────────────────────────────
  const recordsByKey = new Map<string, PolicyRecord[]>();
  let orphanRecords = 0;
  const artifactKeys = new Set<string>();
  for (const a of input.artifacts) {
    if (a.reviewAttemptId !== null) artifactKeys.add(joinKey(a.root, a.sessionId, a.reviewAttemptId));
  }
  for (const { root, record } of input.records) {
    // A record with no `reviewAttemptId` has no join key and is an ORPHAN, not
    // a weak match against whichever artifact shares its session.
    if (record.reviewAttemptId === null) { orphanRecords += 1; continue; }
    const key = joinKey(root, record.sessionId, record.reviewAttemptId);
    if (!artifactKeys.has(key)) { orphanRecords += 1; continue; }
    const list = recordsByKey.get(key);
    if (list === undefined) recordsByKey.set(key, [record]);
    else list.push(record);
  }

  const memberKeys = new Set(members
    .filter((a) => a.reviewAttemptId !== null)
    .map((a) => joinKey(a.root, a.sessionId, a.reviewAttemptId!)));
  // A record joining an artifact that is NOT a member is in neither bucket: it
  // is not an orphan, and it is not counted among the joined records, so the
  // reconciliation line would claim to account for every record while one class
  // stayed invisible. It gets its own count.
  let recordsOutsideWindow = 0;
  for (const [key, list] of recordsByKey) {
    if (!memberKeys.has(key)) recordsOutsideWindow += list.length;
  }

  const rounds: Round[] = [];
  let joinedRecords = 0;
  let unjoinableArtifacts = 0;
  let degradedAlongsideMeasured = 0;
  let joinMismatchRecords = 0;
  // EVALUATED-HASH DIVERGENCE IS ITS OWN OBSERVATION, tracked across every
  // joined measured record rather than derived from the exclusion class. Two
  // records for one attempt evaluating two different contracts are classified
  // `conflicting-evaluation` and return before the hash comparison, so a VOID
  // derived from `hash-mismatch` alone missed the most explicit evidence of a
  // mid-window contract change there is. Codex found it.
  let hashDivergentRounds = 0;
  for (const artifact of members) {
    const leg = legOfArtifact(artifact);
    if (artifact.reviewAttemptId === null) {
      // No join key at all. Reported as its own count beside
      // `measurement-absent`, because here the cause IS known.
      unjoinableArtifacts += 1;
      rounds.push({ artifact, leg, state: { kind: "excluded", cls: "measurement-absent" } });
      continue;
    }
    const candidates = recordsByKey.get(
      joinKey(artifact.root, artifact.sessionId, artifact.reviewAttemptId),
    ) ?? [];
    // A DISAGREEING STORED HASH IS A JOIN MISMATCH, never a silent match. A
    // measurement describing a different artifact is worse than a missing one.
    //
    // ANY explicit disagreement disqualifies the round, not merely a set where
    // every candidate disagrees. An earlier form filtered the disagreeing
    // records out and used whatever agreed, so an attempt with records naming
    // artifact hashes A and B against an artifact holding A produced an
    // apparently unique usable measurement and the B record vanished from every
    // count. Contradictory evidence about one round is not a round with good
    // evidence. Codex found it.
    const disagreeing = candidates.filter((r) =>
      r.artifactContentHash !== null && artifact.contentHash !== null
      && r.artifactContentHash !== artifact.contentHash);
    const agreeing = candidates.filter((r) => !disagreeing.includes(r));
    // DIVERGENCE IS ESTABLISHED BEFORE THE EXCLUSION, and once per round.
    //
    // The two round-1 fixes interacted: divergence was recorded after the
    // join-mismatch early return, so a round holding one hash-matching record
    // that evaluated a contract other than the baseline PLUS one record with a
    // disagreeing artifact hash became a join-mismatch and set no VOID. Adding
    // a contradictory record therefore HID valid evidence that the contract
    // changed, which is the opposite of what an extra record should be able to
    // do. Codex found it in round 2.
    if (windowUsable && agreeing.some((r) =>
      r.kind === "measured" && r.evaluatedContentHash !== window!.baselineHash)) {
      hashDivergentRounds += 1;
    }
    // COUNTED BEFORE THE RETURN, for the same reason divergence is. A round
    // with one agreeing and one disagreeing record used to contribute only its
    // disagreeing record to any count, so the agreeing one -- the record the
    // fix above made load-bearing -- was in no bucket and the reconciliation
    // silently lost it. Joining and being usable are different claims: this
    // counts the first, and the round is still excluded from the second.
    // Codex found it in round 3.
    joinedRecords += agreeing.length;
    if (disagreeing.length > 0) {
      joinMismatchRecords += disagreeing.length;
      rounds.push({ artifact, leg, state: { kind: "excluded", cls: "join-mismatch" } });
      continue;
    }
    if (agreeing.some((r) => r.kind === "degraded") && agreeing.some((r) => r.kind === "measured")) {
      degradedAlongsideMeasured += 1;
    }
    const state = classifyRound(agreeing, windowUsable ? window!.baselineHash : "");
    rounds.push({
      artifact,
      // The RECORD's leg wins whenever one joined: it is what the reporter
      // observed, while the artifact's `reviewer` is free text.
      leg: state.kind === "measured" ? state.record.leg : (agreeing[0]?.leg ?? leg),
      state,
    });
  }

  const measuredRounds = rounds.filter(
    (r): r is Round & { state: { kind: "measured"; record: MeasuredPolicyRecord } } =>
      r.state.kind === "measured");
  const excludedRounds = rounds.filter((r) => r.state.kind === "excluded");
  const verifiedRounds = measuredRounds.filter((r) => r.state.record.deliveryVerified);
  const unverifiedRounds = measuredRounds.filter((r) => !r.state.record.deliveryVerified);
  const degradedRounds = excludedRounds.filter((r) =>
    r.state.kind === "excluded" && r.state.cls === "degraded").length;
  const artifactsWithNoRecord = excludedRounds.filter((r) =>
    r.state.kind === "excluded" && r.state.cls === "measurement-absent").length;

  const inWindow = members.length;
  const population: P3Population = {
    membershipDefined: windowUsable,
    inWindow,
    outOfWindowPast,
    outOfWindowFuture,
    undated,
    outOfScopeRoots: [...outOfScope.entries()]
      .map(([root, artifacts]) => ({ root, artifacts }))
      .sort((a, b) => a.root.localeCompare(b.root)),
    windowRootsNotScanned,
    orphanRecords,
    joinedRecords,
    recordsOutsideWindow,
    joinMismatchRecords,
    measuredRounds: measuredRounds.length,
    degradedRounds,
    artifactsWithNoRecord,
    unjoinableArtifacts,
    degradedAlongsideMeasured,
    verifiedRounds: verifiedRounds.length,
    unverifiedRounds: unverifiedRounds.length,
  };

  // ── metrics ────────────────────────────────────────────────────
  const totalKnown = scanState === "PARTIAL" || scanState === "UNAVAILABLE" ? null : inWindow;
  const counts: RecordCounts = {
    total: totalKnown,
    readable: measuredRounds.length + degradedRounds,
    missing: artifactsWithNoRecord,
    invalid: excludedRounds.filter((r) =>
      r.state.kind === "excluded"
      && (r.state.cls === "join-mismatch" || r.state.cls === "conflicting-evaluation")).length,
  };
  const shared = {
    population: "p3",
    scanState,
    kind: "proportion",
    conditional: totalKnown === null,
    records: counts,
  } as const;
  const make = (m: Omit<MetricInput, keyof typeof shared>): Metric =>
    metric({ ...shared, ...m } as MetricInput);

  const findingsOn = (rs: readonly typeof measuredRounds[number][]): number =>
    rs.reduce((a, r) => a + r.state.record.findings.length, 0);
  const outcomeCount = (
    rs: readonly typeof measuredRounds[number][],
    outcome: string,
  ): number => rs.reduce(
    (a, r) => a + r.state.record.findings.filter((f) => f.outcome === outcome).length, 0);

  const headlineFindings = findingsOn(verifiedRounds);
  const unverifiedFindings = findingsOn(unverifiedRounds);

  const headline: Metric[] = [
    ["p3-capped-names-none", "Findings capped for naming no principle", "capped-names-none"],
    ["p3-capped-names-undeclared", "Findings capped for naming an undeclared principle",
      "capped-names-undeclared"],
    ["p3-promoted-declared", "Findings promoted by a declared blocking-class principle",
      "promoted-declared"],
    ["p3-promoted-implicit", "Findings promoted by an implicit principle", "promoted-implicit"],
  ].map(([id, label, outcome]) => make({
    id: id!, label: label!, unit: "finding", provenance: "derived",
    numerator: outcomeCount(verifiedRounds, outcome!), denominator: headlineFindings,
    note: CONDITIONAL_ON_DELIVERY,
  }));
  headline.push(make({
    id: "p3-floor-suppressed-minors",
    label: "Minors the clause-18 floor refused to promote",
    unit: "finding",
    // OBSERVED: a stored per-round count, not a re-derivation from the finding
    // list. The two agree by construction and only one of them is read.
    provenance: "observed",
    numerator: verifiedRounds.reduce((a, r) => a + r.state.record.floorSuppressedMinorCount, 0),
    denominator: headlineFindings,
    note: CONDITIONAL_ON_DELIVERY,
  }));

  const unverified: Metric[] = [make({
    id: "p3-capped-names-none-unverified",
    label: "Capped for naming no principle, delivery unverified",
    unit: "finding",
    provenance: "derived",
    numerator: outcomeCount(unverifiedRounds, "capped-names-none"),
    denominator: unverifiedFindings,
    note:
      "NOT part of the headline. A reviewer who read the contract and named nothing, and one who "
      + "never received it, produce the same finding; only the first is evidence about capping.",
  })];

  // The blocker check is a property of the PROJECTION, not of what reached the
  // reviewer, so it keeps every measured round, verified or not.
  const cmChanged = (r: typeof measuredRounds[number]): boolean =>
    r.state.record.gate.hasCriticalOrMajor !== r.state.record.gate.baselineHasCriticalOrMajor;
  const ucChanged = (r: typeof measuredRounds[number]): boolean =>
    r.state.record.gate.hasUnresolvedCritical !== r.state.record.gate.baselineHasUnresolvedCritical;
  const projection: Metric[] = [
    make({
      id: "p3-blocker-check-changed",
      label: "Blocker check changed (either boolean)",
      unit: "round", provenance: "derived",
      // THE UNION, COUNTED ONCE. Comparing only `hasCriticalOrMajor` misses a
      // critical capped to a policy-blocking major, which moves the
      // criticals-only check while leaving the first one alone; adding the two
      // counts double counts a round that moved both.
      numerator: measuredRounds.filter((r) => cmChanged(r) || ucChanged(r)).length,
      denominator: measuredRounds.length,
    }),
    make({
      id: "p3-critical-or-major-changed",
      label: "Blocker check changed: critical-or-major moved",
      unit: "round", provenance: "derived",
      numerator: measuredRounds.filter(cmChanged).length,
      denominator: measuredRounds.length,
      note: "Printed beside the union, which alone cannot say which check moved.",
    }),
    make({
      id: "p3-unresolved-critical-changed",
      label: "Blocker check changed: unresolved-critical moved",
      unit: "round", provenance: "derived",
      numerator: measuredRounds.filter(ucChanged).length,
      denominator: measuredRounds.length,
      note: "Printed beside the union, which alone cannot say which check moved.",
    }),
  ];

  // SELECTED ON PRESENCE OF A DELIVERED CONTRACT, never on delivery having been
  // verified. Verification already requires the delivered hash to EQUAL the
  // baseline, so a selector keyed on it has an unreachable numerator and would
  // print a clean zero for the question this metric exists to ask. The
  // `reviewMdIncluded` conjunct is not the same thing: the packet builder
  // records the hash it READ whether or not the fit kept the section, so a
  // round with a hash and no delivered contract would otherwise be admitted and
  // reported as agreeing.
  const deliverySelected = measuredRounds.filter((r) => {
    const d = r.state.record.delivered;
    return d !== null && d.reviewMdIncluded && d.contentHash !== null
      && r.state.record.evaluatedContentHash !== null;
  });
  const truncationReachable = deliverySelected.some((r) => r.state.record.leg === "lens");
  const deliveryDetail: Metric[] = [
    make({
      id: "p3-delivered-differs-from-evaluated",
      label: "Rounds where delivered and evaluated contracts differ",
      unit: "round", provenance: "observed",
      numerator: deliverySelected.filter((r) =>
        r.state.record.delivered!.contentHash !== r.state.record.evaluatedContentHash).length,
      denominator: deliverySelected.length,
      note:
        "Delivered-versus-evaluated and evaluated-versus-baseline are DIFFERENT fields. A round "
        + "here can trigger no VOID at all.",
    }),
    make({
      id: "p3-delivery-truncated",
      label: "Rounds whose delivered contract was truncated",
      unit: "round", provenance: "observed",
      // AN UNREACHABLE NUMERATOR IS PRINTED AS UNREACHABLE, never as a clean
      // zero. Only the lens leg truncates and the lens leg is never key-bound,
      // so on this route no selected round can carry the signal at all.
      numerator: truncationReachable
        ? deliverySelected.filter((r) => r.state.record.delivered!.truncated).length
        : null,
      denominator: deliverySelected.length,
      ...(truncationReachable ? {} : {
        note:
          "UNREACHABLE on this route, not zero: only the lens leg truncates, the lens leg is never "
          + "key-bound, and the attestation that would have observed it is withdrawn to ISS-1148.",
      }),
    }),
  ];

  // ── exclusions, in TWO families ────────────────────────────────
  const legCount = (
    rs: readonly Round[],
    pred: (r: Round) => boolean,
  ): { count: number; packet: number; lens: number } => {
    const hit = rs.filter(pred);
    return {
      count: hit.length,
      packet: hit.filter((r) => r.leg === "packet").length,
      lens: hit.filter((r) => r.leg === "lens").length,
    };
  };

  const outcomeByClass: ExclusionCount[] = OUTCOME_CLASSES.map((cls) => ({
    cls,
    ...legCount(rounds, (r) => r.state.kind === "excluded" && r.state.cls === cls),
    ...(cls === "measurement-absent" ? { note: CAUSE_UNKNOWN } : {}),
  }));
  const outcomeExclusions: ExclusionFamily = {
    excluded: excludedRounds.length,
    of: inWindow,
    rate: rateOf(excludedRounds.length, inWindow),
    byClass: outcomeByClass,
  };

  // Their own rate, per leg, and they NEVER invalidate. Under one pooled
  // threshold any project whose lens rounds exceed twenty percent is INVALID by
  // construction, because the lens leg can never bind exact: that measures the
  // plumbing and never the contract.
  const deliveryByClass: ExclusionCount[] = DELIVERY_CLASSES.map((cls) => ({
    cls,
    ...legCount(measuredRounds, (r) =>
      r.state.kind === "measured" && deliveryExclusionOf(r.state.record) === cls),
    ...(cls === "weak-binding" ? { note: LENS_ZERO_DISCLOSURE } : {}),
  }));
  const deliveryExclusions: ExclusionFamily = {
    excluded: unverifiedRounds.length,
    of: inWindow,
    rate: rateOf(unverifiedRounds.length, inWindow),
    byClass: deliveryByClass,
  };

  // The two families are disjoint by construction: an outcome-excluded round is
  // not measured, so it carries no delivery evidence either. The union is the
  // total the week does not know about delivery, and it is printed beside the
  // delivery-only count because they answer different questions.
  const totalDeliveryIneligible = excludedRounds.length + unverifiedRounds.length;
  const pooled: ExclusionFamily = {
    excluded: totalDeliveryIneligible,
    of: inWindow,
    rate: rateOf(totalDeliveryIneligible, inWindow),
    byClass: [],
  };

  // ── delivery coverage, per leg ─────────────────────────────────
  const legsPresent = (["packet", "lens"] as const)
    .filter((leg) => rounds.some((r) => r.leg === leg));
  const deliveryCoverage: DeliveryCoverage[] = legsPresent.map((leg) => {
    const legRounds = rounds.filter((r) => r.leg === leg).length;
    const legVerified = verifiedRounds.filter((r) => r.leg === leg).length;
    return { leg, verified: legVerified, rounds: legRounds, rate: rateOf(legVerified, legRounds) };
  });

  // ── policy forms, DISCLOSED rather than treated as a conflict ──
  const formCounts = new Map<string, PolicyForm>();
  for (const r of measuredRounds) {
    const p = r.state.record.effectivePolicy;
    const key = JSON.stringify([p.alwaysBlock, p.neverBlock]);
    const existing = formCounts.get(key);
    formCounts.set(key, existing === undefined
      ? { alwaysBlock: p.alwaysBlock, neverBlock: p.neverBlock, rounds: 1 }
      : { ...existing, rounds: existing.rounds + 1 });
  }

  // ── the verdict ────────────────────────────────────────────────
  // The VOID trigger reads the INDEPENDENT observation, not the exclusion
  // class: a round can carry a divergent evaluated hash and still be classified
  // `conflicting-evaluation`, and that round is exactly the evidence VOID
  // exists for.
  const hashMismatches = hashDivergentRounds;
  const observations = window?.closeObservations ?? null;
  const divergence: string[] = [];
  if (hashMismatches > 0) {
    divergence.push(`${hashMismatches} in-window round(s) evaluated a contract that is not the baseline`);
  }
  if (observations !== null) {
    if (observations.reReadHash !== null && window !== null
      && observations.reReadHash !== window.baselineHash) {
      divergence.push("the close-time re-read of REVIEW.md differs from the baseline");
    }
    if (observations.commitsTouchingReview !== null && observations.commitsTouchingReview > 0) {
      divergence.push(
        `${observations.commitsTouchingReview} commit(s) touching REVIEW.md inside the window`);
    }
    if (observations.reviewDirty === true) divergence.push("REVIEW.md was dirty at close");
  }
  const unobserved: string[] = [];
  if (window !== null && window.closedAt !== null) {
    if (observations === null) unobserved.push("no close-time observations were recorded");
    else {
      if (observations.reReadHash === null) unobserved.push("the close-time re-read did not happen");
      if (observations.commitsTouchingReview === null) {
        unobserved.push("the commits-touching-REVIEW.md check did not happen");
      }
      if (observations.reviewDirty === null) unobserved.push("the dirty-tree check did not happen");
      unobserved.push(...observations.notes);
    }
  }

  const rows: ThresholdRow[] = [
    {
      family: "outcome",
      label: "OUTCOME",
      measured: `${outcomeExclusions.excluded} of ${outcomeExclusions.of} excluded, `
        + `${pct(outcomeExclusions.rate)}`,
      against: "20%",
      pass: outcomeExclusions.rate === null ? null : outcomeExclusions.rate <= OUTCOME_MAX,
    },
    ...(deliveryCoverage.length > 0
      ? deliveryCoverage.map((c): ThresholdRow => ({
        family: "delivery-coverage",
        label: `DELIVERY COVERAGE ${c.leg}`,
        measured: `${c.verified}/${c.rounds} ${pct(c.rate)}`
          + (c.leg === "lens" && c.verified === 0 ? ` (${LENS_ZERO_DISCLOSURE})` : ""),
        against: "80%",
        pass: c.rate === null ? null : c.rate >= DELIVERY_MIN,
      }))
      : [{
        family: "delivery-coverage" as const,
        label: "DELIVERY COVERAGE",
        measured: "no in-window rounds on any leg",
        against: "80%",
        pass: null,
      }]),
    {
      family: "population",
      label: "POPULATION",
      // WITH NO USABLE WINDOW THIS ROW ASSERTS NOTHING. `0 >= 20` is false, so
      // an earlier form printed FAIL, which reads as "this week had too few
      // rounds" when the truth is that no week is selected at all. An
      // unestablished claim printed as a verdict is this ticket's own failure
      // class inside its own verdict block.
      measured: windowUsable
        ? `${inWindow} in-window rounds`
        : "no usable window, so membership is undefined",
      against: `${MIN_POPULATION}`,
      pass: windowUsable ? inWindow >= MIN_POPULATION : null,
    },
  ];

  const status = decideStatus({
    divergence,
    unobserved,
    window,
    windowUsable,
    scanState,
    windowRootsNotScanned,
    undated,
    inWindow,
  });

  return {
    window,
    contractAtScan: input.contractAtScan ?? null,
    scanState,
    population,
    headline,
    unverified,
    projection,
    deliveryDetail,
    headlineFindings,
    unverifiedFindings,
    unverifiedFindingsByLeg: {
      packet: findingsOn(unverifiedRounds.filter((r) => r.leg === "packet")),
      lens: findingsOn(unverifiedRounds.filter((r) => r.leg === "lens")),
    },
    deliveryCoverage,
    outcomeExclusions,
    deliveryExclusions,
    totalDeliveryIneligible,
    pooled,
    policyForms: [...formCounts.values()],
    verdict: {
      status,
      rows,
      notAnAuthorisation: NOT_AN_AUTHORISATION,
      observationalLimit: OBSERVATIONAL_LIMIT,
    },
  };
}

/**
 * The blocking conditions, FIRST MATCH WINS, in the ruled order.
 *
 * Ordered rather than merely enumerated, and the order is load-bearing: a
 * fixture that trips exactly one condition passes after any reordering, which
 * is why the tests trip two at once. Divergence beats everything because a week
 * that measured two different contracts is not a week whose exclusion rate is
 * the question; an unobserved divergence check sits in the same slot because a
 * check that did not run cannot be reported as one that found nothing.
 */
function decideStatus(args: {
  readonly divergence: readonly string[];
  readonly unobserved: readonly string[];
  readonly window: ContractWindow | null;
  readonly windowUsable: boolean;
  readonly scanState: ScanState;
  readonly windowRootsNotScanned: readonly string[];
  readonly undated: number;
  readonly inWindow: number;
}): P3Status {
  if (args.divergence.length > 0) {
    return {
      code: "void-contract-changed",
      headline: "VOID (contract changed mid-window)",
      reason:
        `The week measured more than one contract: ${args.divergence.join("; ")}. A week that `
        + "measured two contracts is not a week whose exclusion rate is the question.",
    };
  }
  if (args.unobserved.length > 0) {
    return {
      code: "divergence-unobserved",
      headline: "UNDETERMINED (divergence unobserved)",
      reason:
        `A divergence check did not run: ${args.unobserved.join("; ")}. A check that did not `
        + "happen and a check that found nothing print identically unless the difference is said, "
        + "so this is not reported as a clean week.",
    };
  }
  if (args.window === null || !args.windowUsable) {
    return {
      code: "no-window",
      headline: "UNDETERMINED (no window)",
      reason:
        "No readable measurement window in .story/config.json. Open one with `storybloq "
        + "review-stats --open-window`. A `contractMeasurement` that is present reads as absent "
        + "when it cannot be parsed, which includes a closed window carrying no close-time "
        + "divergence observations.",
    };
  }
  if (args.window.closedAt === null) {
    return {
      code: "window-open",
      headline: "UNDETERMINED (window open)",
      reason:
        "The window is still open. A population that grows every time the command runs cannot "
        + "support a threshold verdict about itself. Close it with `storybloq review-stats "
        + "--close-window`, no earlier than seven days after it opened.",
    };
  }
  if (args.scanState === "PARTIAL" || args.scanState === "UNAVAILABLE"
    || args.windowRootsNotScanned.length > 0) {
    return {
      code: "scan-incomplete",
      headline: "UNDETERMINED (scan incomplete)",
      reason: args.windowRootsNotScanned.length > 0
        ? `A root inside the window was never scanned: ${args.windowRootsNotScanned.join(", ")}. `
          + "Its rounds are members of this week and none of them was read."
        : `The measurement scan is ${args.scanState}. A threshold verdict over a population whose `
          + "size is unknown describes the part that happened to be readable.",
    };
  }
  if (args.undated > 0) {
    return {
      code: "indeterminate-membership",
      headline: "UNDETERMINED (indeterminate membership)",
      reason:
        `${args.undated} artifact(s) carry no usable timestamp and cannot be placed relative to `
        + "the window. A completely readable scan could otherwise report a verdict while silently "
        + "dropping rounds that may have been in window.",
    };
  }
  if (args.inWindow < MIN_POPULATION) {
    return {
      code: "insufficient-population",
      headline: "UNDETERMINED (insufficient population)",
      reason:
        `${args.inWindow} in-window accepted round(s); the floor is ${MIN_POPULATION}. The `
        + "window stays open until the floor is met.",
    };
  }
  return {
    code: "no-blocking-condition",
    headline: "No blocking condition. The three lines below are the verdict.",
    reason:
      "Deliberately not a single word. A single verdict is what let a week certify a capping "
      + "decision while delivery was unknown, so the three lines each carry their own threshold "
      + "and each is printed every time.",
  };
}
