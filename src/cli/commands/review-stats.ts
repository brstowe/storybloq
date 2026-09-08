/**
 * T-432: `storybloq review-stats`.
 *
 * RENDERING READS. It does not compute, sum, or derive. Every number printed
 * here already exists as a field on a `Metric`, which is what lets the honesty
 * properties be tested on the structured result: a renderer that computed its
 * own totals could print a disclosure beside a number the disclosure does not
 * describe.
 */
import {
  computeMonthly,
  computeP1,
  computeP2,
  SINGLE_BACKENDS,
  type MonthlyRollup,
  type P1Result,
  type P2Result,
} from "../../core/review-stats.js";
import {
  classifyLandingReason,
  discoverFleetRoots,
  scanRoots,
  type ScanResult,
  type SessionOverlap,
} from "../../core/review-stats-scan.js";
import type { Metric, ScanReport, ScanState } from "../../core/review-stats-types.js";
import { computeP3, type P3Result } from "../../core/review-stats-p3.js";
import { loadReviewContract } from "../../autonomous/review-contract.js";
import {
  closeContractWindow,
  openContractWindow,
  readContractWindow,
  type CloseObservations,
  type ContractWindow,
} from "../../core/review-stats-window.js";
import { gitLogTouchingPath, gitPathDirty } from "../../autonomous/git-inspector.js";
import type { CommandContext, CommandResult } from "../types.js";

export interface ReviewStatsOptions {
  /** Scan every `.story/` root under this directory instead of just the project. */
  readonly fleet?: string;
  /**
   * T-495: open the review-contract measurement window. Writes
   * `contractMeasurement` to `.story/config.json` and prints nothing else; it
   * refuses when a window is already recorded.
   */
  readonly openWindow?: boolean;
  /**
   * T-495: close the measurement window, recording the three divergence
   * observations. Refuses before day seven, refuses to re-close, and refuses
   * below the population floor.
   */
  readonly closeWindow?: boolean;
  /** T-495: print the review-contract population (P3) and its verdict. */
  readonly contract?: boolean;
}

/**
 * Render one number.
 *
 * A ZERO DENOMINATOR RENDERS "-", NEVER "0%". That is the whole deliverable in
 * one function: a 0% re-raise rate over no labelled findings would read as
 * evidence that this backend never re-raises, when it is evidence of nothing.
 *
 * AND A MEAN IS NEVER RENDERED AS A PERCENTAGE. Rounds per segment came out of
 * the first live run as `126.5%`, a share above 100%, which tells a reader the
 * tool is broken; `1.27 per segment` tells them what happened. `kind` is on the
 * metric because rendering cannot infer this and guessing it produces an
 * impossible number rather than a merely mislabelled one.
 */
export function renderValue(m: Metric): string {
  if (m.value === null) return "-";
  return m.kind === "proportion"
    ? `${(m.value * 100).toFixed(1)}%`
    : `${m.value.toFixed(2)} per ${m.unit}`;
}

export function renderCoverage(m: Metric): string {
  // NULL TOTAL MEANS NO PERCENTAGE. A percentage of an unknown total overclaims,
  // so an incomplete scan prints the readable count and stops there.
  if (m.records.total === null) return `${m.records.readable} readable / total unknown`;
  if (m.records.total === 0) return "0 records";
  return `${m.records.readable} of ${m.records.total}`;
}

export function metricRows(metrics: readonly Metric[]): string[] {
  return metrics.map((m) => {
    const num = m.numerator === null ? "-" : String(m.numerator);
    const den = m.denominator === null ? "-" : String(m.denominator);
    const flags = [
      m.provenance,
      m.scanState !== "COMPLETE" ? m.scanState : null,
      m.conditional ? "conditional" : null,
    ].filter((x): x is string => x !== null).join(", ");
    return `| ${m.label} | ${m.unit} | ${num} / ${den} | ${renderValue(m)} | ${renderCoverage(m)} | ${flags} |`;
  });
}

function renderScan(scan: ScanReport): string[] {
  const lines: string[] = ["", "## Scan", ""];
  lines.push(`Started ${scan.startedAt}, finished ${scan.finishedAt}. NOT ATOMIC: sessions may be written while the scan runs, so every count is as-of-scan.`);
  lines.push("");
  lines.push(`Roots scanned: ${scan.roots.length}`);
  for (const [key, state] of Object.entries(scan.state)) {
    if (state !== "COMPLETE") lines.push(`- ${key}: ${state}`);
  }
  if (scan.failures.length === 0) {
    lines.push("- no read failures");
    return lines;
  }
  lines.push("", `Read failures: ${scan.readFailures}, by SCOPE (how far the uncertainty reaches, not which call failed):`);
  const byScope = new Map<string, number>();
  for (const f of scan.failures) byScope.set(f.scope, (byScope.get(f.scope) ?? 0) + 1);
  for (const [scope, n] of byScope) lines.push(`- ${scope}: ${n}`);
  for (const f of scan.failures.slice(0, 10)) {
    lines.push(`  - [${f.scope}] ${f.path}: ${f.reason}`);
  }
  if (scan.failures.length > 10) lines.push(`  - ... ${scan.failures.length - 10} more`);
  return lines;
}

export function renderOverlaps(overlaps: readonly SessionOverlap[], rootCount: number): string[] {
  if (rootCount < 2) return [];
  const lines = ["", "## Session ids under more than one root", ""];
  if (overlaps.length === 0) {
    lines.push("None observed.");
    return lines;
  }
  lines.push(
    "Reported, never silently deduplicated inside an aggregate. `matching-stored-hashes`",
    "is a MATCHING CLAIM, not a confirmed copy: a stale or hand-edited record keeps its",
    "old hash, so equal stored hashes are weaker evidence than identical content.",
    "",
  );
  for (const o of overlaps) {
    // The unread count is on the LINE, not folded into the label. `unknown`
    // says the comparison did not settle; only this says a whole copy's
    // filenames were never enumerated, so `sharedFiles` is a lower bound.
    const unread = o.holdersWithUnreadListing > 0
      ? `, ${o.holdersWithUnreadListing} of them with an unread artifact listing`
      : "";
    lines.push(`- ${o.sessionId}: ${o.agreement} across ${o.roots.length} roots${unread}`);
  }
  return lines;
}

function renderMonthly(monthly: MonthlyRollup): string[] {
  if (monthly.rows.length === 0) return [];
  const lines = [
    "",
    "## By month",
    "",
    "| Month | Rounds | Zero-critical | Criticals unknown | Segments | Rounds/segment p50 | p90 | Last verdict not approve | Verdict unknown |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of monthly.rows) {
    // A `-` here is a WITHHELD percentile on a month below the minimum, not a
    // zero. The count beside it is what that month actually supports.
    const dash = (v: number | null) => (v === null ? "-" : String(v));
    lines.push(
      // `Criticals unknown` sits beside `Zero-critical` so the denominator is
      // readable off the row: zero-critical is out of `Rounds` MINUS this
      // column, not out of `Rounds`. Without it a reader subtracts and lands on
      // "rounds that had criticals", which counts every unreadable count as a
      // round that had them.
      `| ${r.month} | ${r.rounds} | ${r.zeroCriticalRounds} | ${r.criticalsUnknown} | ${r.segments} | `
      + `${dash(r.roundsPerSegmentP50)} | ${dash(r.roundsPerSegmentP90)} | `
      // Same reason as `Criticals unknown`: without it, subtracting the
      // not-approve count from `Segments` reads as established approvals, and
      // silently counts every unreadable verdict among them.
      + `${dash(r.lastVerdictNotApprove)} | ${r.lastVerdictUnknown} |`,
    );
  }
  lines.push(
    "",
    `Minimum eligible segments for percentiles: ${monthly.minEligible}. `
    + `Rounds with no usable timestamp: ${monthly.unassignableRounds}. `
    + `Groups excluded for indeterminate chronology: ${monthly.excludedGroups}. `
    + `Sessions suppressed for an unread artifact: ${monthly.suppressedSessions}. `
    // READ the structured field. Saying UNKNOWN on a complete scan with nothing
    // excluded is manufactured uncertainty: there, the hidden count is known,
    // and it is zero.
    + (monthly.segmentsHiddenByExclusion === null
      ? "Segments hidden by those: UNKNOWN."
      : `Segments hidden by those: ${monthly.segmentsHiddenByExclusion}.`),
    "",
    monthly.rules,
  );
  return lines;
}

function render(
  p1: P1Result,
  p2: P2Result,
  monthly: MonthlyRollup,
  scan: ScanResult,
  fleet: boolean,
): string {
  const lines: string[] = ["# Review stats", ""];

  if (fleet) {
    lines.push(
      "ROOT-LEVEL RESULTS ARE AUTHORITATIVE. Each root is labelled by PATH, never by",
      "\"project\": one repository can be checked out several times and some roots carry",
      "no git origin at all, so the cross-root figure below is a SUM OF ROOT",
      "OBSERVATIONS that may include duplicates. It is not a count of unique fleet",
      "activity.",
      "",
    );
  }

  lines.push(
    "| Metric | Unit | n / d | Value | Records | Provenance / flags |",
    "|---|---|---|---|---|---|",
    ...metricRows(p1.metrics),
    ...metricRows(p2.metrics),
    "",
  );

  lines.push("## Segment-denominated metrics", "");
  for (const m of [...p1.metrics, ...p2.metrics]) {
    if (m.segments === undefined) continue;
    const total = m.segments.segmentTotal === null ? "unknown" : String(m.segments.segmentTotal);
    lines.push(
      `- ${m.label}: ${m.segments.eligibleSegments} eligible segments, `
      + `${m.segments.excludedGroups} excluded groups, `
      + `${m.segments.suppressedSessions} suppressed sessions `
      + `(${m.segments.suppressedArtifacts} readable artifacts inside them), `
      + `segment total ${total}`,
    );
  }
  lines.push(
    "",
    "An excluded group's segment count is unknown BY CONSTRUCTION, so the segment",
    "total is absent whenever anything was excluded. This can happen on a completely",
    "readable scan: unreadability and indeterminate chronology are different defects",
    "and only the first is a scan problem.",
    "",
    "A SUPPRESSED SESSION is one where a P1 read failed. Its readable records still",
    "count for the order-independent metrics; they are kept out of every",
    "reconstruction because the missing record's unknown round and timestamp can",
    "move the boundaries around it and change which verdict is last. That is a",
    "defect in the reconstruction, not a reduction in its coverage.",
    "",
    "## Reconstruction rule",
    "",
    p1.reconstructionRule,
    "",
    "## Backends",
    "",
  );

  const totalRounds = Object.values(p1.backends).reduce((a, b) => a + b, 0);
  for (const b of SINGLE_BACKENDS) {
    const n = p1.backends[b] ?? 0;
    if (n > 0) lines.push(`- ${b}: ${n}`);
  }
  const composite = p1.backends.composite ?? 0;
  lines.push(
    `- composite: ${composite}`,
    "",
    "`composite` is more than one backend named in ONE round's reviewer field, so the",
    "round cannot enter any single backend's denominator without an arbitrary",
    "assignment. It is never folded in. `other` is the different case of one backend",
    `we have no bucket for. Rounds counted: ${totalRounds}.`,
  );

  for (const m of [...p1.metrics, ...p2.metrics]) {
    if (m.note) lines.push("", `> ${m.label}: ${m.note}`);
  }

  lines.push(...renderMonthly(monthly));
  lines.push(...renderOverlaps(scan.overlaps, scan.report.roots.length));
  lines.push(...renderScan(scan.report));
  return lines.join("\n");
}


/**
 * T-495: the review-contract printout.
 *
 * READS THE STRUCTURED RESULT. Every number, every PASS and the verdict itself
 * are fields on `P3Result`; nothing here sums, derives or decides. That is what
 * lets the honesty properties be tested on the result rather than on text,
 * which can carry a disclosure while the claim behind it is unjustified.
 */
export function renderContract(p3: P3Result, scan: ScanReport): string {
  const w = p3.window;
  const lines: string[] = ["## Review contract (report-only, P3)", ""];
  if (w === null) {
    lines.push("No measurement window recorded.", "");
  } else {
    lines.push(
      `Window opened ${w.openedAt}, ${w.closedAt === null ? "STILL OPEN" : `closed ${w.closedAt}`}`,
      `Baseline ${w.baselineHash}`,
      `Roots: ${w.roots.length} (${w.roots.join(", ")})`,
    );
    const c = p3.contractAtScan;
    if (c !== null) {
      lines.push(`Contract at scan: ${c.status}, ${c.principleCount} principles, invalid ${c.invalidCount}`);
    }
    const obs = w.closeObservations;
    if (obs === null) {
      lines.push("Close-time observations: NONE RECORDED (the window is open, or was not closed by this build).");
    } else {
      lines.push(
        `Close-time contract re-read: ${obs.reReadHash === null
          ? "NOT OBSERVED"
          : obs.reReadHash === w.baselineHash ? "matches baseline" : "DIFFERS from baseline"}`,
        `Commits touching REVIEW.md in window: ${obs.commitsTouchingReview ?? "NOT OBSERVED"}. `
        + `Working tree at close: ${obs.reviewDirty === null
          ? "NOT OBSERVED" : obs.reviewDirty ? "DIRTY" : "clean"}.`,
      );
      for (const n of obs.notes) lines.push(`  - observation note: ${n}`);
    }
    lines.push(`Scan: ${p3.scanState}`, "");
  }

  const table = (metrics: readonly Metric[]): string[] => [
    "| Metric | Unit | N / D | Value | Coverage | Flags |",
    "|---|---|---|---|---|---|",
    ...metricRows(metrics),
  ];

  lines.push(
    `### Headline, over the ${p3.population.verifiedRounds} rounds whose delivery is VERIFIED, `
    + `${p3.headlineFindings} findings`,
    "",
    "CONDITIONAL ON VERIFIED DELIVERY. These rates describe the rounds where the contract",
    `provably reached the reviewer. Round coverage is NOT representativeness: the `
    + `${p3.population.unverifiedRounds} unverified rounds below hold ${p3.unverifiedFindings} `
    + "findings, and nothing here establishes that they would have behaved the same way.",
    "",
    ...table(p3.headline),
    "",
    "### Delivery unverified, NOT part of the numbers above",
    "",
    ...table(p3.unverified),
    "",
    `Findings by backend on these rounds: packet ${p3.unverifiedFindingsByLeg.packet}, `
    + `lens ${p3.unverifiedFindingsByLeg.lens}.`,
    "",
    "A reviewer who read the contract and named nothing, and a reviewer who never received it,",
    "produce the same finding, and only the first is evidence about capping. Adding the line",
    "above to the headline restores exactly that conflation.",
    "",
    `### Projection, over all ${p3.population.measuredRounds} measured rounds`,
    "",
    ...table(p3.projection),
    "",
    "The blocker check is a property of the projection, not of what reached the reviewer, so it",
    "keeps every measured round, verified or not.",
    "",
    "### Delivery detail, selected on PRESENCE of a delivered contract",
    "",
    ...table(p3.deliveryDetail),
    "",
  );
  for (const m of [...p3.headline, ...p3.unverified, ...p3.projection, ...p3.deliveryDetail]) {
    if (m.note) lines.push(`> ${m.label}: ${m.note}`, "");
  }

  const p = p3.population;
  lines.push(
    "### Population",
    "",
    p.membershipDefined
      ? `In-window identified accepted rounds: ${p.inWindow}. Floor 20: `
        + `${p.inWindow >= 20 ? "met" : "NOT met"}.`
      // NOT a zero and NOT "NOT met". With no usable window nothing was
      // selected, so a measured-looking zero here would contradict the verdict
      // below, which already says the floor cannot be evaluated.
      : "Membership is undefined: no usable measurement window selects a population, so the "
        + "population floor cannot be evaluated and the counts below are unselected rather "
        + "than measured.",
    `Out of window, before it opened: ${p.outOfWindowPast} artifacts. Not members.`,
    `Out of window, after close or beyond the five-minute skew allowance: ${p.outOfWindowFuture}.`,
    `Out-of-scope roots: ${p.outOfScopeRoots.length}`
    + (p.outOfScopeRoots.length === 0
      ? "."
      : ` (${p.outOfScopeRoots.map((r) => `${r.root}: ${r.artifacts}`).join(", ")}).`),
    `Window roots never scanned: ${p.windowRootsNotScanned.length}`
    + (p.windowRootsNotScanned.length === 0 ? "." : ` (${p.windowRootsNotScanned.join(", ")}).`),
    `Undated artifacts: ${p.undated}.`,
    `Orphan records joining no artifact: ${p.orphanRecords}. Not members.`,
    `Records joining an artifact outside the window: ${p.recordsOutsideWindow}. Not members, and `
    + "not orphans either: they joined something, just not a member.",
    `Records rejected for a disagreeing artifact hash: ${p.joinMismatchRecords}. The other `
    + "records of their round joined a member artifact and are counted as joined, so every "
    + "record is in exactly one bucket, assuming member artifacts have unique join keys. "
    + "Two member artifacts sharing one key are each classified against the same records, "
    + "so a record can be counted twice; nothing enforces that uniqueness.",
    `Reconciliation: ${p.inWindow} in-window accepted artifacts, ${p.joinedRecords} records joined, `
    + `${p.measuredRounds} of them usable measurements and ${p.degradedRounds} degraded, `
    + `${p.artifactsWithNoRecord} artifacts with no record at all `
    + `(${p.unjoinableArtifacts} of them carrying no reviewAttemptId, so they could never be `
    + `joined), and ${p.orphanRecords} orphan records.`,
    "A degraded record JOINS its artifact and supplies no projection, so it is not an",
    "artifact-with-no-record: collapsing the two loses the distinction between a reporter that",
    "ran and failed, which names its `failedAt`, and one that left nothing behind.",
    "",
    "### Exclusions",
    "",
    `OUTCOME exclusions, which carry the 20 percent: ${p3.outcomeExclusions.excluded} of `
    + `${p3.outcomeExclusions.of}, ${p3.outcomeExclusions.rate === null
      ? "-" : `${(p3.outcomeExclusions.rate * 100).toFixed(1)}%`}`,
    p3.outcomeExclusions.byClass
      .map((c) => `${c.cls} ${c.count} (packet ${c.packet}, lens ${c.lens})`).join("; "),
    "",
    `DELIVERY-ONLY exclusions: ${p3.deliveryExclusions.excluded} of ${p3.deliveryExclusions.of}, `
    + `${p3.deliveryExclusions.rate === null
      ? "-" : `${(p3.deliveryExclusions.rate * 100).toFixed(1)}%`}`,
    p3.deliveryExclusions.byClass
      .map((c) => `${c.cls} ${c.count} (packet ${c.packet}, lens ${c.lens})`).join("; "),
    "",
    `Total delivery ineligibility: ${p3.totalDeliveryIneligible} of ${p3.pooled.of}. The `
    + `${p3.outcomeExclusions.excluded} outcome-excluded rounds carry no usable delivery evidence `
    + "either, so both print: they answer different questions.",
    "",
    `Pooled: ${p3.pooled.excluded} of ${p3.pooled.of}, ${p3.pooled.rate === null
      ? "-" : `${(p3.pooled.rate * 100).toFixed(1)}%`}. INFORMATIONAL ONLY. Not a threshold.`,
    "",
  );
  for (const c of [...p3.outcomeExclusions.byClass, ...p3.deliveryExclusions.byClass]) {
    if (c.note) lines.push(`> ${c.cls}: ${c.note}`, "");
  }

  lines.push(
    "### Verdict",
    "",
    p3.verdict.status.headline,
    p3.verdict.status.reason,
    "",
  );
  for (const r of p3.verdict.rows) {
    const verdictWord = r.pass === null ? "CANNOT BE EVALUATED" : r.pass ? "PASS" : "FAIL";
    lines.push(`${r.label.padEnd(26)} ${r.measured}   against ${r.against}   ${verdictWord}`);
  }
  lines.push(
    "",
    p3.verdict.notAnAuthorisation,
    "",
    p3.verdict.observationalLimit,
  );
  if (p3.policyForms.length > 1) {
    lines.push(
      "",
      `Effective policy was not constant across the window: ${p3.policyForms.length} distinct `
      + "forms were observed. A change BETWEEN rounds is not a conflicting evaluation, which is "
      + "scoped to one attempt, so it is disclosed here instead.",
      ...p3.policyForms.map((f) =>
        `  - alwaysBlock ${JSON.stringify(f.alwaysBlock)}, neverBlock `
        + `${JSON.stringify(f.neverBlock)}: ${f.rounds} round(s)`),
    );
  }
  lines.push(...renderScan(scan));
  return lines.join("\n");
}

/**
 * The three divergence observations, made AT CLOSE.
 *
 * Each is independently nullable and a null is NOT a clean result. The reader
 * refuses to certify a week where one of them did not run, because a check that
 * did not happen and a check that found nothing print identically otherwise.
 */
export async function observeDivergence(
  projectRoot: string,
  window: ContractWindow,
  closedAtMs: number,
): Promise<CloseObservations> {
  const notes: string[] = [];
  const contract = loadReviewContract(projectRoot);
  const reReadHash = contract.contentHash;
  if (reReadHash === null) notes.push("REVIEW.md could not be read at close, so it was not re-hashed");

  // The window filter is applied HERE and not by `--since`/`--until`. Those
  // walk history with a heuristic that can stop early, and the dates would
  // reach a git argv from a config file.
  let commits: number | null = null;
  const log = await gitLogTouchingPath(projectRoot, "REVIEW.md");
  if (!log.ok) notes.push(`commits touching REVIEW.md not observed: ${log.message}`);
  else {
    const openedMs = Date.parse(window.openedAt);
    if (Number.isNaN(openedMs)) notes.push("openedAt is not a readable instant, so no commit range could be built");
    else {
      commits = log.data.filter((c) => {
        const t = Date.parse(c.committedAt);
        return !Number.isNaN(t) && t >= openedMs && t <= closedAtMs;
      }).length;
      const undatedCommits = log.data.filter((c) => Number.isNaN(Date.parse(c.committedAt))).length;
      if (undatedCommits > 0) {
        // A commit whose date will not parse cannot be placed in or out of the
        // window, so the COUNT is not a complete answer and says so.
        commits = null;
        notes.push(`${undatedCommits} commit(s) touching REVIEW.md carry an unreadable date, so the in-window count is not determinable`);
      }
    }
  }

  let reviewDirty: boolean | null = null;
  const dirty = await gitPathDirty(projectRoot, "REVIEW.md");
  if (!dirty.ok) notes.push(`dirty-tree check not observed: ${dirty.message}`);
  else reviewDirty = dirty.data;

  return { reReadHash, commitsTouchingReview: commits, reviewDirty, notes };
}

/**
 * T-495: `review-stats --open-window`.
 *
 * The baseline is the hash the CONTRACT PARSER computed, from the same read
 * that produced its text. Hashing the file again here would give this command
 * its own answer about a file that can change between two reads, and every
 * later comparison would be against a contract nobody was handed.
 */
async function openWindow(ctx: CommandContext): Promise<CommandResult> {
  const opened = await openContractWindow(ctx.root, {
    roots: [ctx.root],
    // READ AND VALIDATED UNDER THE LOCK, not before it. See the callback's
    // docblock in `review-stats-window.ts` for why the ordering is the whole
    // point: a baseline captured before the wait can already be stale by the
    // time the immutable record is written.
    baseline: () => {
      const contract = loadReviewContract(ctx.root);
      // The baseline must be a contract the evaluator would actually USE. An
      // empty or unparseable REVIEW.md is readable and hashable, so an earlier
      // draft opened an immutable week against a file declaring no usable
      // principle at all, and every delivered hash matching it would then read
      // as VERIFIED delivery of a contract that decides nothing.
      if (contract.status !== "active" || contract.invalid.length > 0) {
        return {
          ok: false,
          reason: [
            `REVIEW.md at ${contract.path} is ${contract.status}`
            + `${contract.invalid.length > 0
              ? ` with ${contract.invalid.length} invalid declaration(s): `
                + `${JSON.stringify(contract.invalid)}`
              : ""}.`,
            "",
            "The week's baseline has to be a contract the evaluator would apply. Opening against",
            "one it would refuse makes every matching delivery read as verified delivery of a",
            "contract that decides nothing, and the window cannot be re-based once opened.",
          ].join("\n"),
        };
      }
      if (contract.contentHash === null) {
        return {
          ok: false,
          reason:
            "No readable REVIEW.md to baseline against. A window opened on a null baseline makes "
            + "every delivered contract unequal to it, so every round reports delivery-unverified "
            + "for a reason about the window rather than about the round.",
        };
      }
      return { ok: true, hash: contract.contentHash };
    },
  });
  if (!opened.ok) {
    return { output: `Refused to open the measurement window.\n\n${opened.reason}`, exitCode: 1 };
  }
  const w = opened.window;
  return {
    output: [
      "Review-contract measurement window OPENED.",
      "",
      `  opened at    ${w.openedAt}`,
      `  baseline     ${w.baselineHash}`,
      `  roots        ${w.roots.join(", ")}`,
      "",
      "The window is immutable: it cannot be re-opened or re-based. Close it with",
      "`storybloq review-stats --close-window`, no earlier than seven days from now.",
    ].join("\n"),
  };
}


/**
 * T-495: `review-stats --close-window`.
 *
 * The population is counted INSIDE the lock, against the window being closed,
 * because the floor is a property of that window and a count taken before the
 * wait describes a different moment. `--contract` is the reader; this command
 * only fixes the upper bound and records what the divergence checks saw.
 */
async function closeWindow(ctx: CommandContext): Promise<CommandResult> {
  const nowMs = Date.now();
  const closed = await closeContractWindow(ctx.root, {
    nowMs,
    observe: (window) => observeDivergence(ctx.root, window, nowMs),
    population: async (window) => {
      const scan = await scanRoots(window.roots.length > 0 ? window.roots : [ctx.root]);
      return computeP3({
        records: scan.p3,
        artifacts: scan.p1,
        // COUNTED AGAINST THE WINDOW THAT WILL BE PERSISTED, not the open one.
        // An open window admits artifacts up to `nowMs` plus the five-minute
        // skew allowance; the closed window excludes everything after
        // `closedAt`, which is `nowMs`. So 19 rounds plus one timestamped a
        // minute ahead passed the floor while the closed week held 19, and a
        // window cannot be re-opened. Codex found it.
        window: { ...window, closedAt: new Date(nowMs).toISOString() },
        scan: scan.report,
        nowMs,
      }).population.inWindow;
    },
  });
  if (!closed.ok) {
    return { output: `Refused to close the measurement window.\n\n${closed.reason}`, exitCode: 1 };
  }
  const w = closed.window;
  const obs = w.closeObservations;
  return {
    output: [
      "Review-contract measurement window CLOSED.",
      "",
      `  opened at    ${w.openedAt}`,
      `  closed at    ${w.closedAt}`,
      `  baseline     ${w.baselineHash}`,
      "",
      "Close-time divergence observations, recorded with the close:",
      `  re-read      ${obs?.reReadHash === null || obs === null
        ? "NOT OBSERVED"
        : obs.reReadHash === w.baselineHash ? "matches baseline" : "DIFFERS from baseline"}`,
      `  commits      ${obs?.commitsTouchingReview ?? "NOT OBSERVED"} touching REVIEW.md in window`,
      `  working tree ${obs?.reviewDirty === null || obs === undefined || obs === null
        ? "NOT OBSERVED" : obs.reviewDirty ? "DIRTY" : "clean"}`,
      ...(obs === null || obs.notes.length === 0
        ? []
        : ["", "  notes:", ...obs.notes.map((n) => `    - ${n}`)]),
      "",
      "Read the week with `storybloq review-stats --contract`.",
    ].join("\n"),
  };
}

/** T-495: `review-stats --contract`. The reader. */
async function contractReport(
  options: ReviewStatsOptions,
  ctx: CommandContext,
): Promise<CommandResult> {
  const window = readContractWindow(ctx.root);
  // Every root the WINDOW names is scanned, whether or not it is this project:
  // a window root that was never scanned is a hole in the population, and the
  // reader reports it as an incomplete scan rather than as a smaller week.
  const discovery = options.fleet === undefined
    ? { roots: [...new Set([ctx.root, ...(window?.roots ?? [])])], failures: [] }
    : await discoverFleetRoots(options.fleet);
  const scan = await scanRoots(discovery.roots);
  const discoveryState: Record<string, ScanState> = {};
  for (const f of discovery.failures) {
    for (const population of f.affects) discoveryState[`${population}:${f.root}`] = "UNAVAILABLE";
  }
  const report: ScanReport = {
    ...scan.report,
    failures: [...discovery.failures, ...scan.report.failures],
    readFailures: discovery.failures.length + scan.report.readFailures,
    state: { ...discoveryState, ...scan.report.state },
  };
  const contract = loadReviewContract(ctx.root);
  const p3 = computeP3({
    records: scan.p3,
    artifacts: scan.p1,
    window,
    scan: report,
    nowMs: Date.now(),
    contractAtScan: {
      status: contract.status,
      principleCount: contract.principles.length,
      invalidCount: contract.invalid.length,
    },
  });
  if (ctx.format === "json") {
    return {
      output: JSON.stringify({ p3, scan: report }, null, 2),
      ...(report.readFailures > 0 && {
        warnings: [`${report.readFailures} read failure(s); see scan.failures`],
      }),
    };
  }
  return {
    output: renderContract(p3, report),
    ...(report.readFailures > 0 && {
      warnings: [`${report.readFailures} read failure(s); see the Scan section`],
    }),
  };
}

export async function handleReviewStats(
  options: ReviewStatsOptions,
  ctx: CommandContext,
): Promise<CommandResult> {
  // T-495. Handled FIRST and returned from: opening a window is a write, it
  // reads no artifacts, and running the whole scan to reach it would report a
  // population the window does not yet select.
  if (options.openWindow === true) return openWindow(ctx);
  if (options.closeWindow === true) return closeWindow(ctx);
  // The reader runs its own scan and its own root selection, so it returns from
  // here rather than sharing P1's: the window names the roots, not the flags.
  if (options.contract === true) return contractReport(options, ctx);

  const discovery = options.fleet === undefined
    ? { roots: [ctx.root], failures: [] }
    : await discoverFleetRoots(options.fleet);

  const scan = await scanRoots(discovery.roots);
  // A FAILED DISCOVERY MUST NOT READ AS AN EMPTY ONE. With no roots there are
  // no per-root state entries, and an empty state reduces to EMPTY -- which is
  // "scanned, nothing there" and would let the command report a definitive
  // total of 0 over a directory it could not open. The failure is recorded as
  // UNAVAILABLE state for both populations so the total goes null instead.
  const discoveryState: Record<string, ScanState> = {};
  for (const f of discovery.failures) {
    for (const population of f.affects) discoveryState[`${population}:${f.root}`] = "UNAVAILABLE";
  }
  const report: ScanReport = {
    ...scan.report,
    failures: [...discovery.failures, ...scan.report.failures],
    readFailures: discovery.failures.length + scan.report.readFailures,
    state: { ...discoveryState, ...scan.report.state },
  };
  const p1 = computeP1({ artifacts: scan.p1, scan: report });
  const p2 = computeP2({ sessions: scan.p2, scan: report }, classifyLandingReason);
  const monthly = computeMonthly({ artifacts: scan.p1, scan: report });

  if (ctx.format === "json") {
    return {
      output: JSON.stringify(
        {
          p1: { metrics: p1.metrics, backends: p1.backends, segmentation: p1.segmentation },
          p2: { metrics: p2.metrics },
          monthly,
          reconstructionRule: p1.reconstructionRule,
          scan: report,
          overlaps: scan.overlaps,
          semantics: {
            rootsAreAuthoritative: true,
            crossRootFigureIs: "sumOfRootObservations",
            crossRootFigureIsNot: "unique fleet activity",
            nullRateMeans: "no eligible denominator; never zero",
            nullTotalMeans: "discovery incomplete; no coverage percentage is claimed",
          },
        },
        null,
        2,
      ),
      ...(report.readFailures > 0 && { warnings: [`${report.readFailures} read failure(s); see scan.failures`] }),
    };
  }

  return {
    output: render(p1, p2, monthly, { ...scan, report }, options.fleet !== undefined),
    ...(report.readFailures > 0 && { warnings: [`${report.readFailures} read failure(s); see the Scan section`] }),
  };
}
