/**
 * T-495 T47d: the canonical fixture, as ROWS.
 *
 * PORTED FROM `.story/duet-plans/t495-fixture.py`, which is the plan's own
 * source and prints every number in the plan's fixture printout. Three
 * consecutive fixtures were internally inconsistent and each read healthier
 * than it was, so nothing here is a typed total: the rows are the fixture and
 * every number the tests assert is computed from them.
 *
 * `assertRowsConsistent` THROWS. That is the point of it: a fixture that cannot
 * describe itself must fail loudly rather than quietly supply a denominator, and
 * the R6 review round found exactly that defect in this very fixture (a round
 * with 6 floor-suppressed findings out of 5).
 */
import type {
  DeliveryBinding,
  MeasuredPolicyRecord,
  PolicyFindingRecord,
  PolicyOutcome,
  PolicyRecord,
  PolicyRecordIdentity,
} from "../../src/autonomous/principle-policy-report.js";
import type { P3Record } from "../../src/core/review-stats-scan.js";
import type { P1Artifact, ScanReport } from "../../src/core/review-stats-types.js";
import type { ContractWindow } from "../../src/core/review-stats-window.js";
import type { P3Input } from "../../src/core/review-stats-p3.js";

export const BASELINE = "hash-A";
export const OTHER_CONTRACT = "hash-B";
export const ROOT = "/fixture/root";
export const OPENED_AT = "2026-09-10T00:00:00.000Z";
export const CLOSED_AT = "2026-09-17T00:00:00.000Z";
/** Inside the window, comfortably clear of both edges. */
const IN_WINDOW = "2026-09-12T00:00:00.000Z";

export interface Row {
  readonly leg: "packet" | "lens";
  readonly state: "measured" | "degraded" | "absent";
  readonly binding: DeliveryBinding | null;
  /** The hash the delivery line carried. Null when no line bound. */
  readonly dHash: string | null;
  /** Whether the contract was actually INCLUDED in what the reviewer got. */
  readonly dIncl: boolean;
  readonly eHash: string | null;
  readonly findings: number;
  readonly cappedNone: number;
  readonly cappedUndecl: number;
  readonly promDecl: number;
  readonly promImpl: number;
  readonly floor: number;
  readonly cmChanged: boolean;
  readonly ucChanged: boolean;
}

const OUTCOME_KEYS = ["cappedNone", "cappedUndecl", "promDecl", "promImpl", "floor"] as const;

function base(over: Partial<Row> & Pick<Row, "leg" | "state">): Row {
  return {
    binding: null, dHash: null, dIncl: false, eHash: null, findings: 0,
    cappedNone: 0, cappedUndecl: 0, promDecl: 0, promImpl: 0, floor: 0,
    cmChanged: false, ucChanged: false,
    ...over,
  };
}

/** The canonical 24-round fixture. Identical rows to the plan's script. */
export function canonicalRows(): Row[] {
  const rows: Row[] = [];
  const add = (n: number, over: Partial<Row> & Pick<Row, "leg" | "state">): void => {
    for (let i = 0; i < n; i++) rows.push(base(over));
  };
  add(12, {
    leg: "packet", state: "measured", binding: "exact", dHash: BASELINE, dIncl: true,
    eHash: BASELINE, findings: 5, cappedNone: 1,
  });
  const set = (i: number, over: Partial<Row>): void => { rows[i] = { ...rows[i]!, ...over }; };
  set(0, { cappedUndecl: 3, cappedNone: 0 });
  set(1, { promDecl: 3, cappedNone: 0 });
  set(2, { promImpl: 2, cappedNone: 0 });
  set(3, { floor: 4, cappedNone: 0 });
  set(6, { floor: 2 });
  // One round where ONLY critical-or-major moves and one where ONLY
  // unresolved-critical moves, so the union can separate from either component.
  set(4, { cmChanged: true });
  set(5, { ucChanged: true });

  // EXACT binding, evaluated hash equals the baseline, DELIVERED contract was a
  // different one. The round the delivered-versus-evaluated metric exists to
  // reveal, and one a selector keyed on verification could never contain.
  add(1, {
    leg: "packet", state: "measured", binding: "exact", dHash: OTHER_CONTRACT, dIncl: true,
    eHash: BASELINE, findings: 4, cappedNone: 2,
  });
  // Dropped by the budget fit. Its hash is PRESENT because the packet builder
  // read and hashed REVIEW.md before the fit dropped the section, so a selector
  // testing only hash presence would admit a round where nothing was delivered.
  add(1, {
    leg: "packet", state: "measured", binding: "omitted-by-fit", dHash: BASELINE, dIncl: false,
    eHash: BASELINE, findings: 4, cappedNone: 2,
  });
  // Lens leg: weak by construction, so never verified. Zero BY DISCLOSURE.
  add(6, {
    leg: "lens", state: "measured", binding: "weak", eHash: BASELINE, findings: 4, cappedNone: 1,
  });
  add(2, { leg: "packet", state: "degraded" });
  add(2, { leg: "packet", state: "absent" });
  return rows;
}

/**
 * Refuse a fixture that cannot describe itself.
 *
 * Every assertion here failed on some real draft of this fixture. The outcome
 * partition one is the R6 finding: `outcome` is ONE enum per finding, so the
 * five counts partition a round and the remainder is `unchanged`.
 */
export function assertRowsConsistent(rows: readonly Row[]): void {
  const measured = rows.filter((r) => r.state === "measured");
  const excluded = rows.filter((r) => r.state !== "measured");
  if (measured.length + excluded.length !== rows.length) {
    throw new Error("measured plus excluded does not equal the total");
  }
  for (const [i, r] of rows.entries()) {
    const sum = OUTCOME_KEYS.reduce((a, k) => a + r[k], 0);
    if (sum > r.findings) {
      throw new Error(
        `row ${i}: outcome counts ${sum} exceed its ${r.findings} findings. `
        + "`outcome` is ONE enum per finding, so the counts partition the round and the "
        + "remainder is `unchanged`.",
      );
    }
  }
  if (!measured.some((r) => r.leg === "lens")) throw new Error("no lens round to disclose");
  if (measured.some((r) => r.leg === "lens" && verifiedRow(r))) {
    throw new Error("a lens round can never be verified delivery");
  }
  const selected = measured.filter((r) => r.dHash !== null && r.dIncl);
  if (!selected.some((r) => r.dHash !== r.eHash)) {
    throw new Error("the delivered-versus-evaluated metric must be able to CONTAIN a mismatch");
  }
  if (!measured.some((r) => r.dHash !== null && !r.dIncl)) {
    throw new Error(
      "the fixture must CONTAIN a round carrying a hash for a contract that was not delivered",
    );
  }
  const cm = measured.filter((r) => r.cmChanged).length;
  const uc = measured.filter((r) => r.ucChanged).length;
  const union = measured.filter((r) => r.cmChanged || r.ucChanged).length;
  // `union > cm && union > uc` is the condition that does the work. An earlier
  // form wrote `union >= cm + uc + 1`, which a union can never satisfy: it is
  // bounded above by the sum of its components. A guard that cannot fail is
  // this ticket's own failure class inside the assertion meant to prevent it,
  // and it accepted a fixture where every changed round moved BOTH booleans,
  // under which the union equals each component and an implementation checking
  // only one of them passes. Codex found it.
  if (cm < 1 || uc < 1 || union <= cm || union <= uc) {
    throw new Error(
      `the union must be able to separate from BOTH components (union ${union}, `
      + `critical-or-major ${cm}, unresolved-critical ${uc})`,
    );
  }
}

/** The ruled definition, applied to a row. Two conjuncts, never three. */
export function verifiedRow(r: Row): boolean {
  return r.state === "measured" && r.leg === "packet"
    && r.binding === "exact" && r.dHash === BASELINE;
}

function findingsOf(r: Row, seed: string): PolicyFindingRecord[] {
  const out: PolicyFindingRecord[] = [];
  const push = (n: number, outcome: PolicyOutcome, floorSuppressed: boolean): void => {
    for (let i = 0; i < n; i++) {
      out.push({
        index: out.length,
        principle: outcome === "capped-names-none" ? null : `${seed}-principle`,
        coverage: "inside",
        actualSeverity: "minor",
        projectedSeverity: "minor",
        policyBlock: "baseline",
        floorSuppressed,
        outcome,
        reason: `${outcome} in ${seed}`,
        undeclaredName: outcome === "capped-names-undeclared" ? "not-declared" : null,
        baseline: { severity: "minor", blocking: false },
      });
    }
  };
  push(r.cappedNone, "capped-names-none", false);
  push(r.cappedUndecl, "capped-names-undeclared", false);
  push(r.promDecl, "promoted-declared", false);
  push(r.promImpl, "promoted-implicit", false);
  push(r.floor, "floor-suppressed", true);
  push(r.findings - out.length, "unchanged", false);
  return out;
}

export interface BuiltFixture {
  readonly artifacts: P1Artifact[];
  readonly records: P3Record[];
  readonly rows: readonly Row[];
}

/**
 * Build artifacts and records from rows.
 *
 * Every in-window row produces ONE artifact. A `measured` or `degraded` row
 * also produces a record joined to it; an `absent` row produces none, which is
 * `measurement-absent` and is a different thing from a degraded record.
 */
export function buildFromRows(rows: readonly Row[], opts: {
  readonly root?: string;
  readonly timestamp?: string;
} = {}): BuiltFixture {
  const root = opts.root ?? ROOT;
  const timestamp = opts.timestamp ?? IN_WINDOW;
  const artifacts: P1Artifact[] = [];
  const records: P3Record[] = [];
  rows.forEach((r, i) => {
    const attempt = `ra-${i}`;
    artifacts.push(artifactFor(root, attempt, timestamp, `art-${i}`));
    if (r.state === "absent") return;
    records.push({ root, record: recordFor(r, attempt, i, `art-${i}`) });
  });
  return { artifacts, records, rows };
}

export function artifactFor(
  root: string,
  reviewAttemptId: string | null,
  timestamp: string | null,
  contentHash: string | null,
): P1Artifact {
  return {
    root,
    sessionId: "s1",
    fileName: `${reviewAttemptId ?? "legacy"}.json`,
    target: "T-1",
    stage: "code",
    round: 1,
    verdict: "approve",
    reviewerRaw: "codex",
    findingsCount: 0,
    criticalCount: 0,
    timestamp,
    epochMs: timestamp === null ? null : Date.parse(timestamp),
    contentHash,
    originClasses: [],
    diffLines: null,
    reviewAttemptId,
    itemAttemptId: "ia-1",
    generation: 1,
  };
}

export function recordFor(
  r: Row,
  reviewAttemptId: string,
  index: number,
  artifactContentHash: string,
): PolicyRecord {
  const identity = {
    sessionId: "s1",
    itemId: "T-1",
    target: "T-1",
    itemAttemptId: "ia-1",
    reviewAttemptId,
    artifactFileName: `${reviewAttemptId}.json`,
    artifactContentHash,
    stage: "code",
    round: 1,
    generation: 1,
    backend: r.leg === "lens" ? "lenses" : "codex",
    leg: r.leg,
  } as const;
  if (r.state === "degraded") {
    return {
      ...identity,
      kind: "degraded",
      failedAt: "project",
      error: "injected",
      timestamp: `2026-09-12T00:00:0${index % 10}.000Z`,
    };
  }
  const findings = findingsOf(r, `r${index}`);
  return measuredRecord({
    identity,
    row: r,
    findings,
    timestamp: `2026-09-12T00:00:0${index % 10}.000Z`,
  });
}

export function measuredRecord(args: {
  readonly identity: PolicyRecordIdentity;
  readonly row: Row;
  readonly findings: readonly PolicyFindingRecord[];
  readonly timestamp: string;
}): MeasuredPolicyRecord {
  const { identity, row, findings, timestamp } = args;
  const verified = verifiedRow(row);
  return {
    ...identity,
    kind: "measured",
    evaluatedContentHash: row.eHash,
    contractStatus: "active",
    contractActive: true,
    effectivePolicy: { alwaysBlock: ["critical"], neverBlock: [] },
    delivered: row.binding === "weak" || row.binding === "ambiguous" || row.binding === "absent"
      ? null
      : {
        contentHash: row.dHash,
        reviewMdIncluded: row.dIncl,
        truncated: false,
        truncatedAtChars: null,
        deliveredChars: row.dIncl ? 1000 : null,
      },
    deliveryBinding: row.binding ?? "absent",
    deliveryVerified: verified,
    deliveryVerifiedBy: verified ? "key-binding" : null,
    findings,
    gate: {
      hasCriticalOrMajor: row.cmChanged,
      hasUnresolvedCritical: row.ucChanged,
      baselineHasCriticalOrMajor: false,
      baselineHasUnresolvedCritical: false,
      policyBlockedIndices: [],
      forcedLandingAllowed: false,
    },
    stageNextAction: "IMPLEMENT",
    floorSuppressedMinorCount: row.floor,
    floorSuppressedTotal: row.floor,
    timestamp,
  };
}

export function closedWindow(over: Partial<ContractWindow> = {}): ContractWindow {
  return {
    openedAt: OPENED_AT,
    closedAt: CLOSED_AT,
    baselineHash: BASELINE,
    roots: [ROOT],
    closeObservations: {
      reReadHash: BASELINE,
      commitsTouchingReview: 0,
      reviewDirty: false,
      notes: [],
    },
    ...over,
  };
}

export function cleanScan(over: Partial<ScanReport> = {}): ScanReport {
  return {
    roots: [ROOT],
    startedAt: "2026-09-17T00:00:00.000Z",
    finishedAt: "2026-09-17T00:00:01.000Z",
    atomic: false,
    failures: [],
    readFailures: 0,
    state: { [`p1:${ROOT}`]: "COMPLETE", [`p2:${ROOT}`]: "COMPLETE", [`p3:${ROOT}`]: "COMPLETE" },
    ...over,
  };
}

/** The canonical input: 24 in-window rounds, 3 pre-window, 2 orphan records. */
export function canonicalInput(over: Partial<P3Input> = {}): P3Input {
  const rows = canonicalRows();
  assertRowsConsistent(rows);
  const built = buildFromRows(rows);
  const preWindow = [0, 1, 2].map((i) =>
    artifactFor(ROOT, `pre-${i}`, "2026-09-01T00:00:00.000Z", `pre-art-${i}`));
  const orphans: P3Record[] = [0, 1].map((i) => ({
    root: ROOT,
    record: recordFor(canonicalRows()[7]!, `orphan-${i}`, 100 + i, `orphan-art-${i}`),
  }));
  return {
    records: [...built.records, ...orphans],
    artifacts: [...built.artifacts, ...preWindow],
    window: closedWindow(),
    scan: cleanScan(),
    nowMs: Date.parse("2026-09-17T12:00:00.000Z"),
    contractAtScan: { status: "active", principleCount: 6, invalidCount: 0 },
    ...over,
  };
}
