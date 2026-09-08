/**
 * T-495 READER: `computeP3`, D0's join and window, D6's metrics and verdict.
 *
 * The item's failure class is an absence reading as a zero, and every test here
 * refuses one specific shape of it. The measurement's whole point is that a
 * reviewer who READ the principle list and named nothing produces the same
 * finding as one who NEVER RECEIVED it; without the delivery split those two
 * are one number that reads as evidence about reviewers when half of it may be
 * evidence about plumbing.
 */
import { describe, it, expect } from "vitest";

import {
  computeP3,
  type P3Input,
  type P3Result,
  type ThresholdRow,
} from "../../src/core/review-stats-p3.js";
import type { Metric } from "../../src/core/review-stats-types.js";
import type { PolicyRecord } from "../../src/autonomous/principle-policy-report.js";
import {
  BASELINE,
  CLOSED_AT,
  OPENED_AT,
  OTHER_CONTRACT,
  ROOT,
  artifactFor,
  assertRowsConsistent,
  buildFromRows,
  canonicalInput,
  canonicalRows,
  cleanScan,
  closedWindow,
  recordFor,
  type Row,
} from "./t495-p3-rows.js";

// ── helpers ──────────────────────────────────────────────────────

/**
 * Defer the call to collection-safe LAZY, so a throw fails the NAMED test.
 *
 * A `computeP3` call in a describe body throws during COLLECTION, and vitest
 * then reports a failed SUITE with "no tests" rather than a failed assertion.
 * That is not a named RED (L-101), and it is the same shape as the M11 mutant
 * from the writer commit which read as SURVIVED for exactly this reason.
 */
function lazy<T>(fn: () => T): () => T {
  let value: T | undefined;
  let done = false;
  return () => {
    if (!done) { value = fn(); done = true; }
    return value as T;
  };
}

function byId(metrics: readonly Metric[], id: string): Metric {
  const m = metrics.find((x) => x.id === id);
  if (m === undefined) throw new Error(`no metric ${id}; have ${metrics.map((x) => x.id).join(", ")}`);
  return m;
}

function row(over: Partial<Row> & Pick<Row, "leg" | "state">): Row {
  return {
    binding: null, dHash: null, dIncl: false, eHash: null, findings: 0,
    cappedNone: 0, cappedUndecl: 0, promDecl: 0, promImpl: 0, floor: 0,
    cmChanged: false, ucChanged: false,
    ...over,
  };
}

/** A verified packet round with `n` findings, `capped` of them capped. */
function verified(n: number, capped = 0): Row {
  return row({
    leg: "packet", state: "measured", binding: "exact", dHash: BASELINE, dIncl: true,
    eHash: BASELINE, findings: n, cappedNone: capped,
  });
}

function inputFrom(rows: readonly Row[], over: Partial<P3Input> = {}): P3Input {
  const built = buildFromRows(rows);
  return {
    records: built.records,
    artifacts: built.artifacts,
    window: closedWindow(),
    scan: cleanScan(),
    nowMs: Date.parse("2026-09-17T12:00:00.000Z"),
    contractAtScan: { status: "active", principleCount: 6, invalidCount: 0 },
    ...over,
  };
}

function rowFamily(r: P3Result, family: ThresholdRow["family"]): ThresholdRow[] {
  return r.verdict.rows.filter((x) => x.family === family);
}

// ── T43, T44, T45: the delivery split ────────────────────────────

describe("T43: the headline counts ONLY delivery-verified rounds", () => {
  // Refuses one number over both populations, which conflates a reviewer who
  // read the contract and named nothing with one who never received it.
  const result = lazy(() => computeP3(canonicalInput()));

  it("the headline denominator is the 60 findings on the 12 verified rounds", () => {
    expect(result().population.verifiedRounds).toBe(12);
    expect(result().headlineFindings).toBe(60);
    for (const m of result().headline) expect(m.denominator).toBe(60);
  });

  it("counts 8 of 60 capped for naming no principle, 13.3%", () => {
    const m = byId(result().headline, "p3-capped-names-none");
    expect(m.numerator).toBe(8);
    expect(m.value).toBeCloseTo(8 / 60, 10);
  });

  it("the unverified rounds are on their own line and never added in", () => {
    expect(result().population.unverifiedRounds).toBe(8);
    expect(result().unverifiedFindings).toBe(32);
    const m = byId(result().unverified, "p3-capped-names-none-unverified");
    expect(m.numerator).toBe(10);
    expect(m.denominator).toBe(32);
  });

  it("the other three headline outcomes are counted over the verified rounds too", () => {
    expect(byId(result().headline, "p3-capped-names-undeclared").numerator).toBe(3);
    expect(byId(result().headline, "p3-promoted-declared").numerator).toBe(3);
    expect(byId(result().headline, "p3-promoted-implicit").numerator).toBe(2);
    expect(byId(result().headline, "p3-floor-suppressed-minors").numerator).toBe(6);
  });
});

describe("T44: pooling the two capping lines is arithmetic on RAW COUNTS", () => {
  const result = lazy(() => computeP3(canonicalInput()));

  it("pools to 18 of 92, 19.6%, which is the pre-split number", () => {
    const v = byId(result().headline, "p3-capped-names-none");
    const u = byId(result().unverified, "p3-capped-names-none-unverified");
    const pooledN = (v.numerator ?? 0) + (u.numerator ?? 0);
    const pooledD = (v.denominator ?? 0) + (u.denominator ?? 0);
    expect([pooledN, pooledD]).toEqual([18, 92]);
    expect(pooledN / pooledD).toBeCloseTo(0.1956, 3);
  });

  it("adding the two PERCENTAGES is not a quantity, and the two differ", () => {
    // 13.3% and 31.2% are rates over different denominators. Their sum is not a
    // rate of anything, and a test that added them would pass while asserting
    // nothing. What IS assertable is that they disagree, which is the selection
    // effect the split exists to expose.
    const v = byId(result().headline, "p3-capped-names-none").value ?? 0;
    const u = byId(result().unverified, "p3-capped-names-none-unverified").value ?? 0;
    expect(u).toBeGreaterThan(v * 2);
  });

  it("no metric anywhere carries the pooled numerator or denominator", () => {
    const all = [
      ...result().headline, ...result().unverified,
      ...result().projection, ...result().deliveryDetail,
    ];
    expect(all.some((m) => m.denominator === 92)).toBe(false);
    expect(all.some((m) => m.numerator === 18 && m.denominator === 92)).toBe(false);
  });
});

describe("T45: the headline is LABELLED conditional on verified delivery", () => {
  const result = lazy(() => computeP3(canonicalInput()));

  it("every headline metric carries the conditional label in its note", () => {
    for (const m of result().headline) {
      expect(m.note ?? "").toMatch(/verified delivery/i);
    }
  });

  it("the finding counts by backend on the unverified rounds are reported", () => {
    expect(result().unverifiedFindingsByLeg).toEqual({ packet: 8, lens: 24 });
  });
});

// ── T47 family: delivery ─────────────────────────────────────────

describe("T47: every lens round is unverified and the reason is carried", () => {
  const result = lazy(() => computeP3(canonicalInput()));

  it("the lens leg prints zero of six, and not as a measurement", () => {
    const lens = result().deliveryCoverage.find((c) => c.leg === "lens");
    expect(lens).toEqual({ leg: "lens", verified: 0, rounds: 6, rate: 0 });
  });

  it("the coverage denominator is ALL in-window rounds of the leg, not the measured ones", () => {
    // 18 packet rounds: 14 measured plus the 2 degraded and 2 record-less ones.
    // A denominator of measured rounds alone flatters the rate by dropping
    // exactly the rounds whose delivery is least known.
    const packet = result().deliveryCoverage.find((c) => c.leg === "packet");
    expect(packet).toEqual({ leg: "packet", verified: 12, rounds: 18, rate: 12 / 18 });
  });

  it("the lens exclusion is weak-binding, which is structural, not observed", () => {
    const weak = result().deliveryExclusions.byClass.find((c) => c.cls === "weak-binding");
    expect(weak).toMatchObject({ count: 6, lens: 6, packet: 0 });
  });

  it("the verdict row for the lens leg says the zero is a disclosure", () => {
    const lensRow = rowFamily(result(), "delivery-coverage").find((r) => r.label.includes("lens"));
    expect(lensRow?.pass).toBe(false);
    expect(JSON.stringify(result().verdict)).toMatch(/ISS-1148|not measured/i);
  });
});

describe("T47b: delivered-versus-evaluated selects on PRESENCE, not on verification", () => {
  // Refuses selecting on `deliveryVerified`, under which the numerator is
  // unreachable by construction: verification already requires the delivered
  // hash to EQUAL the baseline, so the mismatch could never appear.
  const result = lazy(() => computeP3(canonicalInput()));

  it("selects 13 rounds and finds the one mismatch", () => {
    const m = byId(result().deliveryDetail, "p3-delivered-differs-from-evaluated");
    expect([m.numerator, m.denominator]).toEqual([1, 13]);
  });

  it("the mismatching round is NOT delivery-verified, so a verified selector loses it", () => {
    const rows = canonicalRows();
    const mismatch = rows.filter((r) => r.dHash !== null && r.dIncl && r.dHash !== r.eHash);
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.dHash).toBe(OTHER_CONTRACT);
    // The proof that the rev 5 selector was unreachable: intersecting it with
    // verified delivery empties the numerator.
    const underVerifiedSelector = mismatch.filter((r) => r.dHash === BASELINE);
    expect(underVerifiedSelector).toHaveLength(0);
  });

  it("a round whose hash is present but whose contract was NOT included is excluded", () => {
    // The omitted-by-fit round carries the baseline hash, because the packet
    // builder hashed REVIEW.md before the fit dropped the section. Admitting it
    // reports "delivered and evaluated agree" for a round where nothing was
    // delivered, which is the false zero from the other direction.
    const m = byId(result().deliveryDetail, "p3-delivered-differs-from-evaluated");
    expect(m.denominator).toBe(13);
    const omitted = canonicalRows().filter((r) => r.dHash !== null && !r.dIncl);
    expect(omitted).toHaveLength(1);
  });
});

describe("T47c: a delivered mismatch triggers no VOID", () => {
  it("the evaluated hash still equals the baseline, and they are different fields", () => {
    const result = lazy(() => computeP3(canonicalInput()));
    expect(result().verdict.status.code).not.toBe("void-contract-changed");
    expect(byId(result().deliveryDetail, "p3-delivered-differs-from-evaluated").numerator).toBe(1);
  });
});

describe("T47d: the fixture builder refuses rows that cannot describe themselves", () => {
  it("refuses a round whose outcome counts exceed its own finding count", () => {
    // The exact defect the R6 review round found in this fixture: 6
    // floor-suppressed findings on a 5-finding round.
    const bad = [verified(5), { ...verified(5), floor: 6 }];
    expect(() => assertRowsConsistent(bad)).toThrow(/exceed its 5 findings/);
  });

  it("refuses a fixture whose delivered-versus-evaluated metric cannot contain a mismatch", () => {
    const bad = canonicalRows().map((r) =>
      (r.dHash === OTHER_CONTRACT ? { ...r, dHash: BASELINE } : r));
    expect(() => assertRowsConsistent(bad)).toThrow(/CONTAIN a mismatch/);
  });

  it("refuses a fixture with no round carrying an undelivered hash", () => {
    const bad = canonicalRows().map((r) =>
      (r.dHash !== null && !r.dIncl ? { ...r, dHash: null } : r));
    expect(() => assertRowsConsistent(bad)).toThrow(/not delivered/);
  });

  it("refuses a fixture where every changed round moves BOTH blocker booleans", () => {
    // Under such a fixture the union equals each component, so an
    // implementation comparing only one boolean produces the same number and
    // the union test cannot tell them apart.
    const bad = canonicalRows().map((r) =>
      (r.cmChanged || r.ucChanged ? { ...r, cmChanged: true, ucChanged: true } : r));
    expect(() => assertRowsConsistent(bad)).toThrow(/separate from BOTH components/);
  });

  it("accepts the canonical rows", () => {
    expect(() => assertRowsConsistent(canonicalRows())).not.toThrow();
  });
});

// ── T48: the verified definition is READ, never widened ──────────

describe("T48: the reader reads `deliveryVerified` and never re-derives it", () => {
  it("a record claiming verified with a non-baseline delivered hash still counts as the record says", () => {
    // The definition lives at the WRITE site (two conjuncts, exact binding AND
    // delivered hash equal to baseline). A reader that recomputed it could
    // quietly widen or narrow it, and the week would then be measured against
    // a definition nobody wrote down.
    const r = verified(4, 1);
    const built = buildFromRows([r]);
    const rec = built.records[0]!.record as Extract<PolicyRecord, { kind: "measured" }>;
    const tampered: PolicyRecord = { ...rec, deliveryVerified: false, deliveryVerifiedBy: null };
    const result = lazy(() => computeP3(inputFrom([r], {
      records: [{ root: ROOT, record: tampered }],
      artifacts: built.artifacts,
    })));
    expect(result().population.verifiedRounds).toBe(0);
    expect(result().population.unverifiedRounds).toBe(1);
  });

  it("a record claiming VERIFIED with a differing delivered hash is counted verified", () => {
    // The opposite direction, and it is the one that catches NARROWING. The
    // test above only refuses an implementation that widens verification; an
    // implementation that additionally required hash equality here would pass
    // it while silently overriding the decision the write site recorded.
    const r = verified(4, 1);
    const built = buildFromRows([r]);
    const rec = built.records[0]!.record as Extract<PolicyRecord, { kind: "measured" }>;
    const tampered: PolicyRecord = {
      ...rec,
      delivered: { ...rec.delivered!, contentHash: OTHER_CONTRACT },
      deliveryVerified: true,
      deliveryVerifiedBy: "key-binding",
    };
    const result = computeP3(inputFrom([r], {
      records: [{ root: ROOT, record: tampered }],
      artifacts: built.artifacts,
    }));
    expect(result.population.verifiedRounds).toBe(1);
    expect(result.population.unverifiedRounds).toBe(0);
  });
});

// ── T51, T52: what the split does and does not apply to ──────────

describe("T51: the blocker-check metric keeps every measured round", () => {
  // Refuses applying the delivery split to a metric about the PROJECTION.
  const result = lazy(() => computeP3(canonicalInput()));

  it("its denominator is all 20 measured rounds, not the 12 verified ones", () => {
    const m = byId(result().projection, "p3-blocker-check-changed");
    expect(m.denominator).toBe(20);
    expect(m.numerator).toBe(2);
  });
});

describe("T33: the blocker-check numerator is the UNION, counted once", () => {
  // Refuses comparing only `hasCriticalOrMajor`, which misses a critical capped
  // to a policy-blocking major; and refuses double counting a round that moved
  // both booleans.
  const rows = [
    { ...verified(1), cmChanged: true },
    { ...verified(1), ucChanged: true },
    { ...verified(1), cmChanged: true, ucChanged: true },
    verified(1),
  ];
  const result = lazy(() => computeP3(inputFrom(rows)));

  it("counts three rounds of four, not four and not two", () => {
    const m = byId(result().projection, "p3-blocker-check-changed");
    expect([m.numerator, m.denominator]).toEqual([3, 4]);
  });

  it("prints both components as their own metrics, since the union cannot say which moved", () => {
    expect(byId(result().projection, "p3-critical-or-major-changed").numerator).toBe(2);
    expect(byId(result().projection, "p3-unresolved-critical-changed").numerator).toBe(2);
  });
});

describe("T52: delivery-only and TOTAL delivery ineligibility both print", () => {
  const result = lazy(() => computeP3(canonicalInput()));

  it("reports 8 delivery-only and 12 total, which are different questions", () => {
    expect(result().deliveryExclusions.excluded).toBe(8);
    expect(result().totalDeliveryIneligible).toBe(12);
    expect(result().outcomeExclusions.excluded).toBe(4);
  });
});

// ── T35, T36, T38: the two exclusion families ────────────────────

describe("T35: only the OUTCOME family carries the threshold", () => {
  const result = lazy(() => computeP3(canonicalInput()));

  it("the outcome rate is 4 of 24 and passes 20%", () => {
    expect(result().outcomeExclusions.excluded).toBe(4);
    expect(result().outcomeExclusions.of).toBe(24);
    expect(rowFamily(result(), "outcome")[0]?.pass).toBe(true);
  });

  it("the delivery rate carries no threshold row of its own in the outcome family", () => {
    expect(rowFamily(result(), "outcome")).toHaveLength(1);
  });

  it("the pooled union counts an overlapping round ONCE", () => {
    // The 4 outcome-excluded rounds are delivery-ineligible too, so a pooled
    // figure that added the families would report 12 + 4. The union is 12.
    expect(result().pooled.excluded).toBe(12);
    expect(result().pooled.of).toBe(24);
  });

  it("a lens-heavy project is not INVALID by construction", () => {
    // Under one pooled threshold, any project whose lens rounds exceed 20%
    // fails forever on plumbing alone. 24 lens rounds and nothing else:
    // delivery coverage fails, the outcome family is clean.
    const rows = Array.from({ length: 24 }, () =>
      row({ leg: "lens", state: "measured", binding: "weak", eHash: BASELINE, findings: 2 }));
    const lensOnly = computeP3(inputFrom(rows));
    expect(lensOnly.outcomeExclusions.excluded).toBe(0);
    expect(rowFamily(lensOnly, "outcome")[0]?.pass).toBe(true);
    expect(rowFamily(lensOnly, "delivery-coverage").every((r) => r.pass === false)).toBe(true);
  });
});

describe("T36: the pooled rate is printed and LABELLED informational", () => {
  it("prints 12 of 24 at 50% and says it is not a threshold", () => {
    const result = lazy(() => computeP3(canonicalInput()));
    expect(result().pooled.rate).toBeCloseTo(0.5, 10);
    expect(result().verdict.rows.some((r) => r.label.toLowerCase().includes("pooled"))).toBe(false);
  });
});

describe("T38: a hash mismatch is an exclusion AND sets VOID", () => {
  // Refuses either clause alone, both of which under-report a week that
  // measured two different contracts.
  const rows = [...Array.from({ length: 23 }, () => verified(2)), {
    ...verified(2), eHash: OTHER_CONTRACT,
  }];
  const result = lazy(() => computeP3(inputFrom(rows)));

  it("counts the round as an outcome exclusion", () => {
    const hm = result().outcomeExclusions.byClass.find((c) => c.cls === "hash-mismatch");
    expect(hm?.count).toBe(1);
  });

  it("sets VOID whatever the rate", () => {
    expect(result().verdict.status.code).toBe("void-contract-changed");
    expect(result().verdict.status.headline).toMatch(/^VOID/);
    // 1 of 24 is 4.2%, comfortably under 20%, so the rate alone would pass.
    expect(rowFamily(result(), "outcome")[0]?.pass).toBe(true);
  });
});

// ── T5: the evaluated hash is READ, never recomputed ─────────────

describe("T5: the evaluated hash comes from the record", () => {
  it("a record hashing `aaa` against baseline `aaa` is clean whatever the file says now", () => {
    // Refuses recomputing at the reader, which reports a mismatch for a
    // contract that has since changed and would VOID every closed week whose
    // REVIEW.md was later edited.
    const rows = Array.from({ length: 20 }, () => verified(2));
    const result = lazy(() => computeP3(inputFrom(rows)));
    expect(result().verdict.status.code).not.toBe("void-contract-changed");
    const hm = result().outcomeExclusions.byClass.find((c) => c.cls === "hash-mismatch");
    expect(hm?.count).toBe(0);
  });
});

// ── T10 to T13, T17: population and the join ─────────────────────

describe("T10: finding metrics and delivery metrics have different denominators", () => {
  it("keeps all 20 measured rounds for the projection and 12 for the headline", () => {
    const result = lazy(() => computeP3(canonicalInput()));
    expect(byId(result().projection, "p3-blocker-check-changed").denominator).toBe(20);
    expect(byId(result().headline, "p3-capped-names-none").denominator).toBe(60);
    expect(result().population.measuredRounds).toBe(20);
  });
});

describe("T11: orphans, out-of-window and undated are outside every denominator", () => {
  const undated = artifactFor(ROOT, "ra-undated", null, "art-undated");
  const rows = canonicalRows();
  const built = buildFromRows(rows);
  const result = lazy(() => computeP3(canonicalInput({
    artifacts: [
      ...built.artifacts,
      ...[0, 1, 2].map((i) => artifactFor(ROOT, `pre-${i}`, "2026-09-01T00:00:00.000Z", `p${i}`)),
      undated,
    ],
  })));

  it("reports each outside count on its own", () => {
    expect(result().population.inWindow).toBe(24);
    expect(result().population.outOfWindowPast).toBe(3);
    expect(result().population.undated).toBe(1);
    expect(result().population.orphanRecords).toBe(2);
  });

  it("no denominator exceeds the in-window count, so no rate can pass 100%", () => {
    for (const m of [...result().projection, ...result().deliveryDetail]) {
      expect(m.denominator ?? 0).toBeLessThanOrEqual(24);
      expect(m.value === null || m.value <= 1).toBe(true);
    }
  });
});

describe("T12: an accepted artifact with no readable record is measurement-absent", () => {
  const result = lazy(() => computeP3(canonicalInput()));

  it("counts the 2 record-less artifacts apart from the 2 degraded ones", () => {
    expect(result().population.artifactsWithNoRecord).toBe(2);
    expect(result().population.degradedRounds).toBe(2);
    const absent = result().outcomeExclusions.byClass.find((c) => c.cls === "measurement-absent");
    expect(absent?.count).toBe(2);
  });

  it("says the CAUSE IS UNKNOWN and never attributes it to an append failure", () => {
    // A crash before `reportRound`, a missed call site, a deleted log and a
    // failed append all look identical from the join.
    const printed = JSON.stringify(result());
    expect(printed).toMatch(/cause unknown/i);
    expect(printed).not.toMatch(/append failure/i);
  });
});

describe("T13: pre-window artifacts do not enter the denominator", () => {
  it("130 historical artifacts do not become 130 exclusions", () => {
    // The live-run defect: without a window every artifact this repository
    // already holds precedes the feature and the first run is INVALID before
    // it starts.
    const rows = Array.from({ length: 20 }, () => verified(2));
    const built = buildFromRows(rows);
    const old = Array.from({ length: 130 }, (_, i) =>
      artifactFor(ROOT, `old-${i}`, "2026-08-01T00:00:00.000Z", `old-${i}`));
    const result = lazy(() => computeP3(inputFrom(rows, {
      artifacts: [...built.artifacts, ...old],
      records: built.records,
    })));
    expect(result().population.inWindow).toBe(20);
    expect(result().population.outOfWindowPast).toBe(130);
    expect(result().outcomeExclusions.excluded).toBe(0);
  });
});

describe("T17: the join is on reviewAttemptId, and a hash disagreement is join-mismatch", () => {
  it("does not join two rounds sharing target, stage and round across generations", () => {
    // Refuses a numeric-tuple join, which collides across generations exactly
    // as rev 1's delivery key collided across items.
    const rows = [verified(2), verified(2)];
    const built = buildFromRows(rows);
    // Both artifacts carry the same target/stage/round; only the attempt id
    // differs. A tuple join would attach both records to one artifact and
    // leave the other with none.
    const result = lazy(() => computeP3(inputFrom(rows, {
      artifacts: built.artifacts,
      records: built.records,
    })));
    expect(result().population.measuredRounds).toBe(2);
    expect(result().population.artifactsWithNoRecord).toBe(0);
  });

  it("rejects a record whose stored artifact hash disagrees with the artifact", () => {
    const rows = [verified(2)];
    const built = buildFromRows(rows);
    const rec = built.records[0]!.record as Extract<PolicyRecord, { kind: "measured" }>;
    const result = lazy(() => computeP3(inputFrom(rows, {
      artifacts: built.artifacts,
      records: [{ root: ROOT, record: { ...rec, artifactContentHash: "a-different-hash" } }],
    })));
    const jm = result().outcomeExclusions.byClass.find((c) => c.cls === "join-mismatch");
    expect(jm?.count).toBe(1);
    expect(result().population.measuredRounds).toBe(0);
  });
});

describe("T27 reader half: policy changed BETWEEN rounds is disclosed, not a conflict", () => {
  it("reports two distinct effective policies and no conflicting-evaluation", () => {
    const rows = [verified(2), verified(2)];
    const built = buildFromRows(rows);
    const second = built.records[1]!.record as Extract<PolicyRecord, { kind: "measured" }>;
    const result = lazy(() => computeP3(inputFrom(rows, {
      artifacts: built.artifacts,
      records: [
        built.records[0]!,
        {
          root: ROOT,
          record: { ...second, effectivePolicy: { alwaysBlock: ["critical", "major"], neverBlock: [] } },
        },
      ],
    })));
    const conflict = result().outcomeExclusions.byClass.find((c) => c.cls === "conflicting-evaluation");
    expect(conflict?.count).toBe(0);
    expect(result().policyForms).toHaveLength(2);
    expect(result().policyForms.map((f) => f.rounds).sort()).toEqual([1, 1]);
  });

  it("two non-equivalent records for ONE attempt are conflicting-evaluation", () => {
    const rows = [verified(2)];
    const built = buildFromRows(rows);
    const rec = built.records[0]!.record as Extract<PolicyRecord, { kind: "measured" }>;
    const result = lazy(() => computeP3(inputFrom(rows, {
      artifacts: built.artifacts,
      records: [
        built.records[0]!,
        {
          root: ROOT,
          record: { ...rec, effectivePolicy: { alwaysBlock: [], neverBlock: ["style"] } },
        },
      ],
    })));
    const conflict = result().outcomeExclusions.byClass.find((c) => c.cls === "conflicting-evaluation");
    expect(conflict?.count).toBe(1);
  });

  it("two IDENTICAL records for one attempt collapse to one measurement", () => {
    const rows = [verified(2)];
    const built = buildFromRows(rows);
    const rec = built.records[0]!.record as Extract<PolicyRecord, { kind: "measured" }>;
    const result = lazy(() => computeP3(inputFrom(rows, {
      artifacts: built.artifacts,
      records: [
        built.records[0]!,
        // A different timestamp only. `timestamp` is outside canonical
        // equivalence; comparing whole records means no duplicate ever
        // collapses and every re-entry reads as a conflict.
        { root: ROOT, record: { ...rec, timestamp: "2026-09-12T09:09:09.000Z" } },
      ],
    })));
    expect(result().population.measuredRounds).toBe(1);
  });
});

// ── T22, T23, T28 to T32, T37, T39, T42: window and verdict ──────

describe("T22: zero in-window rounds prints `-`, never 0%", () => {
  const result = lazy(() => computeP3(inputFrom([], { artifacts: [], records: [] })));

  it("every rate is null rather than zero", () => {
    for (const m of [...result().headline, ...result().projection, ...result().deliveryDetail]) {
      expect(m.value).toBeNull();
    }
    expect(result().outcomeExclusions.rate).toBeNull();
  });

  it("the outcome threshold cannot be evaluated and does not default to PASS", () => {
    expect(rowFamily(result(), "outcome")[0]?.pass).toBeNull();
  });
});

describe("T23: a partial scan and an absent window each yield UNDETERMINED", () => {
  it("a PARTIAL scan is UNDETERMINED (scan incomplete)", () => {
    const rows = Array.from({ length: 24 }, () => verified(2));
    const result = lazy(() => computeP3(inputFrom(rows, {
      scan: cleanScan({
        state: { [`p3:${ROOT}`]: "PARTIAL" },
        failures: [{
          root: ROOT, scope: "record", path: `${ROOT}/x`, reason: "EACCES", affects: ["p3"],
        }],
        readFailures: 1,
      }),
    })));
    expect(result().verdict.status.code).toBe("scan-incomplete");
  });

  it("an absent window is UNDETERMINED (no window) and names the command", () => {
    const rows = Array.from({ length: 24 }, () => verified(2));
    const result = lazy(() => computeP3(inputFrom(rows, { window: null })));
    expect(result().verdict.status.code).toBe("no-window");
    expect(result().verdict.status.reason).toContain("--open-window");
  });
});

describe("T28: any undated artifact yields UNDETERMINED on an otherwise clean scan", () => {
  it("does not exclude it quietly and still report a threshold verdict", () => {
    const rows = Array.from({ length: 24 }, () => verified(2));
    const built = buildFromRows(rows);
    const result = lazy(() => computeP3(inputFrom(rows, {
      artifacts: [...built.artifacts, artifactFor(ROOT, "ra-x", null, "art-x")],
      records: built.records,
    })));
    expect(result().population.undated).toBe(1);
    expect(result().verdict.status.code).toBe("indeterminate-membership");
  });
});

describe("T29: the verdict is UNDETERMINED (window open) until closedAt exists", () => {
  it("refuses a threshold verdict over a population that still grows", () => {
    const rows = Array.from({ length: 24 }, () => verified(2));
    const result = lazy(() => computeP3(inputFrom(rows, {
      window: { ...closedWindow(), closedAt: null, closeObservations: null },
    })));
    expect(result().verdict.status.code).toBe("window-open");
  });
});

describe("T30: a root not in `roots` is reported out-of-scope and changes no denominator", () => {
  it("names the root and its artifact count", () => {
    const rows = Array.from({ length: 24 }, () => verified(2));
    const built = buildFromRows(rows);
    const other = Array.from({ length: 5 }, (_, i) =>
      artifactFor("/other/root", `o-${i}`, "2026-09-12T00:00:00.000Z", `o-${i}`));
    const result = lazy(() => computeP3(inputFrom(rows, {
      artifacts: [...built.artifacts, ...other],
      records: built.records,
      scan: cleanScan({ roots: [ROOT, "/other/root"] }),
    })));
    expect(result().population.inWindow).toBe(24);
    expect(result().population.outOfScopeRoots).toEqual([{ root: "/other/root", artifacts: 5 }]);
  });

  it("a window root that was never scanned is UNDETERMINED (scan incomplete)", () => {
    const rows = Array.from({ length: 24 }, () => verified(2));
    const result = lazy(() => computeP3(inputFrom(rows, {
      window: closedWindow({ roots: [ROOT, "/never/scanned"] }),
    })));
    expect(result().population.windowRootsNotScanned).toEqual(["/never/scanned"]);
    expect(result().verdict.status.code).toBe("scan-incomplete");
  });
});

describe("T31: membership is by ARTIFACT timestamp, not session start", () => {
  it("an in-window artifact from a session opened before the window is a member", () => {
    const rows = [verified(2)];
    const built = buildFromRows(rows, { timestamp: "2026-09-12T00:00:00.000Z" });
    const result = lazy(() => computeP3(inputFrom(rows, {
      artifacts: built.artifacts,
      records: built.records,
    })));
    expect(result().population.inWindow).toBe(1);
  });
});

describe("T32 and T42: artifacts after close or beyond the skew allowance", () => {
  it("an artifact after closedAt is out-of-window-future, and closedAt itself is IN", () => {
    // `nowMs` is deliberately two days AFTER the late artifact, so the
    // five-minute skew allowance cannot be what excludes it. With the earlier
    // fixture the artifact was both after `closedAt` and beyond the skew, and
    // deleting the `closedAt` check left the test passing: it did not establish
    // that closing fixes the upper bound at all. Codex found it.
    const rows = [verified(2)];
    const built = buildFromRows(rows);
    const result = lazy(() => computeP3(inputFrom(rows, {
      artifacts: [
        ...built.artifacts,
        artifactFor(ROOT, "ra-late", "2026-09-18T00:00:00.000Z", "late"),
        // Exactly ON the boundary: a member, because the window is closed AT
        // that instant rather than before it.
        artifactFor(ROOT, "ra-edge", CLOSED_AT, "edge"),
      ],
      records: built.records,
      nowMs: Date.parse("2026-09-20T00:00:00.000Z"),
    })));
    expect(result().population.outOfWindowFuture).toBe(1);
    expect(result().population.inWindow).toBe(2);
  });

  it("an artifact more than five minutes ahead of the scan clock is out-of-window-future", () => {
    // Refuses admitting clock skew silently. The window here is still open, so
    // `closedAt` cannot be doing the work.
    const rows = [verified(2)];
    const built = buildFromRows(rows);
    const nowMs = Date.parse("2026-09-12T00:00:00.000Z");
    const skewed = artifactFor(
      ROOT, "ra-skew", new Date(nowMs + 6 * 60 * 1000).toISOString(), "skew");
    const withinSkew = artifactFor(
      ROOT, "ra-ok", new Date(nowMs + 4 * 60 * 1000).toISOString(), "ok");
    const result = lazy(() => computeP3(inputFrom(rows, {
      artifacts: [...built.artifacts, skewed, withinSkew],
      records: built.records,
      window: { ...closedWindow(), closedAt: null, closeObservations: null },
      nowMs,
    })));
    expect(result().population.outOfWindowFuture).toBe(1);
    expect(result().population.inWindow).toBe(2);
  });
});

describe("T37: the blocking conditions are ORDERED", () => {
  // Proven by fixtures that trip TWO at once. One fixture per rung passes after
  // any reordering, because each trips exactly one condition.
  it("VOID beats window-open and scan-incomplete", () => {
    const rows = [...Array.from({ length: 23 }, () => verified(2)), {
      ...verified(2), eHash: OTHER_CONTRACT,
    }];
    const result = lazy(() => computeP3(inputFrom(rows, {
      window: { ...closedWindow(), closedAt: null, closeObservations: null },
      scan: cleanScan({
        state: { [`p3:${ROOT}`]: "PARTIAL" },
        failures: [{
          root: ROOT, scope: "record", path: `${ROOT}/x`, reason: "EACCES", affects: ["p3"],
        }],
        readFailures: 1,
      }),
    })));
    expect(result().verdict.status.code).toBe("void-contract-changed");
  });

  it("window-open beats scan-incomplete and indeterminate membership", () => {
    const rows = Array.from({ length: 24 }, () => verified(2));
    const built = buildFromRows(rows);
    const result = lazy(() => computeP3(inputFrom(rows, {
      artifacts: [...built.artifacts, artifactFor(ROOT, "ra-x", null, "art-x")],
      records: built.records,
      window: { ...closedWindow(), closedAt: null, closeObservations: null },
      scan: cleanScan({
        state: { [`p3:${ROOT}`]: "PARTIAL" },
        failures: [{
          root: ROOT, scope: "record", path: `${ROOT}/x`, reason: "EACCES", affects: ["p3"],
        }],
        readFailures: 1,
      }),
    })));
    expect(result().verdict.status.code).toBe("window-open");
  });

  it("scan-incomplete beats indeterminate membership", () => {
    const rows = Array.from({ length: 24 }, () => verified(2));
    const built = buildFromRows(rows);
    const result = lazy(() => computeP3(inputFrom(rows, {
      artifacts: [...built.artifacts, artifactFor(ROOT, "ra-x", null, "art-x")],
      records: built.records,
      scan: cleanScan({
        state: { [`p3:${ROOT}`]: "PARTIAL" },
        failures: [{
          root: ROOT, scope: "record", path: `${ROOT}/x`, reason: "EACCES", affects: ["p3"],
        }],
        readFailures: 1,
      }),
    })));
    expect(result().verdict.status.code).toBe("scan-incomplete");
  });

  it("indeterminate membership beats insufficient population", () => {
    const rows = Array.from({ length: 5 }, () => verified(2));
    const built = buildFromRows(rows);
    const result = lazy(() => computeP3(inputFrom(rows, {
      artifacts: [...built.artifacts, artifactFor(ROOT, "ra-x", null, "art-x")],
      records: built.records,
    })));
    expect(result().verdict.status.code).toBe("indeterminate-membership");
  });
});

describe("T39: fewer than 20 in-window rounds is UNDETERMINED even at a 0% outcome rate", () => {
  // The ruling's own worked example: at 12 rounds a week cannot reach a
  // threshold verdict however clean it is.
  const rows = Array.from({ length: 12 }, () => verified(2));
  const result = lazy(() => computeP3(inputFrom(rows)));

  it("names insufficient population", () => {
    expect(result().verdict.status.code).toBe("insufficient-population");
    expect(result().outcomeExclusions.excluded).toBe(0);
  });

  it("the population row still prints, and FAILS against 20", () => {
    const pop = rowFamily(result(), "population")[0];
    expect(pop?.pass).toBe(false);
    expect(pop?.against).toContain("20");
  });
});

describe("T49: the verdict prints three families every time", () => {
  // Refuses a single verdict, which is what let a week certify capping while
  // delivery was unknown.
  for (const [name, input] of [
    ["the canonical week", canonicalInput()],
    ["an empty week", inputFrom([], { artifacts: [], records: [] })],
    ["a VOID week", inputFrom(
      [...Array.from({ length: 23 }, () => verified(2)), { ...verified(2), eHash: OTHER_CONTRACT }],
    )],
    ["a window-open week", inputFrom(Array.from({ length: 24 }, () => verified(2)), {
      window: { ...closedWindow(), closedAt: null, closeObservations: null },
    })],
  ] as const) {
    it(`prints outcome, delivery coverage and population for ${name}`, () => {
      const result = lazy(() => computeP3(input));
      expect(rowFamily(result(), "outcome").length).toBe(1);
      expect(rowFamily(result(), "delivery-coverage").length).toBeGreaterThanOrEqual(1);
      expect(rowFamily(result(), "population").length).toBe(1);
      for (const r of result().verdict.rows) {
        expect(r.against.length).toBeGreaterThan(0);
        expect(["boolean", "object"]).toContain(typeof r.pass);
      }
    });
  }
});

describe("T50: the reader never emits anything that reads like permission", () => {
  for (const [name, input] of [
    ["the canonical week", canonicalInput()],
    ["a clean week", inputFrom(Array.from({ length: 24 }, () => verified(2)))],
    ["an empty week", inputFrom([], { artifacts: [], records: [] })],
  ] as const) {
    it(`says it is not an authorisation for ${name}`, () => {
      const result = lazy(() => computeP3(input));
      const printed = JSON.stringify(result()).toLowerCase();
      expect(printed).not.toMatch(/flip authorised|flip authorized|authorised: yes/);
      expect(result().verdict.notAnAuthorisation).toMatch(/not an authorisation/i);
    });
  }

  it("a fully clean week still refuses to certify a flip", () => {
    const result = lazy(() => computeP3(inputFrom(Array.from({ length: 24 }, () => verified(2)))));
    expect(rowFamily(result(), "outcome")[0]?.pass).toBe(true);
    expect(rowFamily(result(), "population")[0]?.pass).toBe(true);
    expect(result().verdict.status.code).toBe("no-blocking-condition");
    expect(result().verdict.notAnAuthorisation).toMatch(/pen ruling/i);
  });
});

describe("T34: the truncation metric's unreachability is PRINTED", () => {
  it("prints no numerator and a note, never a clean 0.0%", () => {
    const result = lazy(() => computeP3(canonicalInput()));
    const m = byId(result().deliveryDetail, "p3-delivery-truncated");
    expect(m.numerator).toBeNull();
    expect(m.value).toBeNull();
    expect(m.note ?? "").toMatch(/unreachable/i);
  });
});

describe("T54: the printout discloses the unobservable case", () => {
  it("says an edit made and reverted between rounds is undetectable", () => {
    const result = lazy(() => computeP3(inputFrom(Array.from({ length: 24 }, () => verified(2)))));
    expect(result().verdict.observationalLimit).toMatch(/reverted/i);
  });
});

describe("VOID from the close-time observations", () => {
  // The three divergence checks D0 puts on `--close-window`. Recorded-hash
  // divergence alone misses an edit made after the last round of the week.
  const rows = Array.from({ length: 24 }, () => verified(2));

  it("a close-time re-read that differs from the baseline is VOID", () => {
    const result = lazy(() => computeP3(inputFrom(rows, {
      window: closedWindow({
        closeObservations: {
          reReadHash: OTHER_CONTRACT, commitsTouchingReview: 0, reviewDirty: false, notes: [],
        },
      }),
    })));
    expect(result().verdict.status.code).toBe("void-contract-changed");
  });

  it("a commit touching REVIEW.md inside the window is VOID", () => {
    const result = lazy(() => computeP3(inputFrom(rows, {
      window: closedWindow({
        closeObservations: {
          reReadHash: BASELINE, commitsTouchingReview: 1, reviewDirty: false, notes: [],
        },
      }),
    })));
    expect(result().verdict.status.code).toBe("void-contract-changed");
  });

  it("a dirty REVIEW.md at close is VOID", () => {
    const result = lazy(() => computeP3(inputFrom(rows, {
      window: closedWindow({
        closeObservations: {
          reReadHash: BASELINE, commitsTouchingReview: 0, reviewDirty: true, notes: [],
        },
      }),
    })));
    expect(result().verdict.status.code).toBe("void-contract-changed");
  });

  it("an UNOBSERVED check is not a clean one", () => {
    // The item's own failure class aimed at its divergence checks: a check that
    // did not run and a check that found nothing print identically unless the
    // difference is carried.
    const result = lazy(() => computeP3(inputFrom(rows, {
      window: closedWindow({
        closeObservations: {
          reReadHash: BASELINE,
          commitsTouchingReview: null,
          reviewDirty: false,
          notes: ["git log failed: not a repository"],
        },
      }),
    })));
    expect(result().verdict.status.code).toBe("divergence-unobserved");
    expect(result().verdict.status.reason).toMatch(/not a repository|commits/i);
  });

  it("detected divergence beats an unobserved check", () => {
    const result = lazy(() => computeP3(inputFrom(rows, {
      window: closedWindow({
        closeObservations: {
          reReadHash: OTHER_CONTRACT, commitsTouchingReview: null, reviewDirty: null, notes: ["x"],
        },
      }),
    })));
    expect(result().verdict.status.code).toBe("void-contract-changed");
  });
});

describe("contract divergence is observed independently of the exclusion class", () => {
  // Two records for one attempt evaluating two DIFFERENT contracts are the most
  // explicit evidence of a mid-window change there is. They classify as
  // `conflicting-evaluation`, which returns before any hash comparison, so a
  // VOID derived from the `hash-mismatch` class alone missed them entirely.
  const rows = [...Array.from({ length: 23 }, () => verified(2)), verified(2)];
  const built = buildFromRows(rows);
  const last = built.records[23]!.record as Extract<PolicyRecord, { kind: "measured" }>;
  const result = lazy(() => computeP3(inputFrom(rows, {
    artifacts: built.artifacts,
    records: [
      ...built.records,
      { root: ROOT, record: { ...last, evaluatedContentHash: OTHER_CONTRACT } },
    ],
  })));

  it("classifies the round as conflicting-evaluation", () => {
    const conflict = result().outcomeExclusions.byClass
      .find((c) => c.cls === "conflicting-evaluation");
    expect(conflict?.count).toBe(1);
  });

  it("and STILL sets VOID, because a contract other than the baseline was evaluated", () => {
    expect(result().verdict.status.code).toBe("void-contract-changed");
  });
});

describe("a contradictory artifact hash disqualifies the round even when another agrees", () => {
  it("is a join-mismatch, not an apparently unique usable measurement", () => {
    // Filtering the disagreeing record out and using whatever agreed turned
    // contradictory evidence about one round into a clean measurement, and the
    // rejected record appeared in no count at all.
    const rows = [verified(2)];
    const built = buildFromRows(rows);
    const rec = built.records[0]!.record as Extract<PolicyRecord, { kind: "measured" }>;
    const result = computeP3(inputFrom(rows, {
      artifacts: built.artifacts,
      records: [
        built.records[0]!,
        { root: ROOT, record: { ...rec, artifactContentHash: "names-another-artifact" } },
      ],
    }));
    expect(result.population.measuredRounds).toBe(0);
    expect(result.outcomeExclusions.byClass.find((c) => c.cls === "join-mismatch")?.count).toBe(1);
    expect(result.population.joinMismatchRecords).toBe(1);
  });

  it("and the agreeing record is still accounted for, in joinedRecords", () => {
    // The early return counted only the DISAGREEING record. The agreeing one --
    // which the round-2 fix made load-bearing, because it is what supplies
    // divergence evidence -- landed in no bucket at all, so the reconciliation
    // silently lost a record in exactly the mixed case this block covers. An
    // accounting line that does not add up is an absence reading as a zero.
    // Codex found it in round 3.
    const rows = [verified(2)];
    const built = buildFromRows(rows);
    const rec = built.records[0]!.record as Extract<PolicyRecord, { kind: "measured" }>;
    const p = computeP3(inputFrom(rows, {
      artifacts: built.artifacts,
      records: [
        built.records[0]!,
        { root: ROOT, record: { ...rec, artifactContentHash: "names-another-artifact" } },
      ],
    })).population;
    expect(p.joinedRecords).toBe(1);
    expect(
      p.joinedRecords + p.joinMismatchRecords + p.recordsOutsideWindow + p.orphanRecords,
    ).toBe(2);
    // Counted as joined, and STILL not a measurement.
    expect(p.measuredRounds).toBe(0);
  });
});

describe("the four-bucket reconciliation holds only for UNIQUE artifact join keys", () => {
  // Codex round 4. The round-3 fix added a doc comment and a printed sentence
  // claiming every record is in exactly one of the four buckets. That is not
  // unconditionally true: the loop runs PER ARTIFACT and looks up the same
  // candidate list by `(root, sessionId, reviewAttemptId)`, so two member
  // artifacts sharing that key with different content hashes each classify the
  // SAME record, once as agreeing and once as disagreeing. Nothing in the
  // scanner enforces key uniqueness.
  //
  // The counting is defensible; the CLAIM about it was too strong, which is the
  // same defect the round-3 fix was addressing, one level up. These two tests
  // pin the real precondition rather than the wish.

  function dupKeyPopulation() {
    const ts = "2026-09-10T12:00:00.000Z";
    const row = canonicalRows()[0]!;
    return computeP3({
      artifacts: [
        artifactFor(ROOT, "ra-dup", ts, "hash-A"),
        artifactFor(ROOT, "ra-dup", ts, "hash-B"),
      ],
      records: [{ root: ROOT, record: recordFor(row, "ra-dup", 1, "hash-A") }],
      window: closedWindow(),
      scan: cleanScan(),
      nowMs: Date.parse("2026-09-17T12:00:00.000Z"),
      contractAtScan: { status: "active", principleCount: 6, invalidCount: 0 },
    }).population;
  }

  it("counts ONE record in TWO buckets when two member artifacts share a key", () => {
    const p = dupKeyPopulation();
    expect(p.inWindow).toBe(2);
    expect(p.joinedRecords).toBe(1);
    expect(p.joinMismatchRecords).toBe(1);
    // The sum EXCEEDS the one input record. Asserted, not tolerated: a reader
    // who trusts the unqualified claim would read this as two records.
    expect(
      p.joinedRecords + p.joinMismatchRecords + p.recordsOutsideWindow + p.orphanRecords,
    ).toBe(2);
  });

  it("and the same shape with a UNIQUE key reconciles exactly, which is the precondition", () => {
    // The control. Without it the case above reads as "reconciliation is
    // broken" rather than "reconciliation assumes unique keys".
    const rows = [canonicalRows()[0]!];
    const built = buildFromRows(rows);
    const p = computeP3(inputFrom(rows, {
      artifacts: built.artifacts,
      records: built.records,
    })).population;
    expect(p.inWindow).toBe(1);
    expect(
      p.joinedRecords + p.joinMismatchRecords + p.recordsOutsideWindow + p.orphanRecords,
    ).toBe(built.records.length);
  });
});

describe("a record joining an artifact outside the window has its own count", () => {
  it("is neither an orphan nor a joined record, and is reported", () => {
    // It joined something, so it is not an orphan; the artifact is not a
    // member, so it is not among the joined records. Without its own count the
    // reconciliation line claims to account for every record while one class
    // stays invisible.
    const rows = [verified(2)];
    const built = buildFromRows(rows);
    const preWindow = artifactFor(ROOT, "ra-old", "2026-09-01T00:00:00.000Z", "old-art");
    const oldRow = canonicalRows()[7]!;
    const result = computeP3(inputFrom(rows, {
      artifacts: [...built.artifacts, preWindow],
      records: [...built.records, { root: ROOT, record: recordFor(oldRow, "ra-old", 9, "old-art") }],
    }));
    expect(result.population.recordsOutsideWindow).toBe(1);
    expect(result.population.orphanRecords).toBe(0);
    expect(result.population.joinedRecords).toBe(1);
  });
});

describe("scan completeness covers the ARTIFACT population too", () => {
  it("an unreadable artifact makes the verdict scan-incomplete even with clean records", () => {
    // Membership comes from P1. The scanner classifies an unreadable artifact
    // as affecting `p1` only, so reading just the `p3` states let a week with
    // missing accepted rounds report a COMPLETE scan and no blocking condition.
    const rows = Array.from({ length: 24 }, () => verified(2));
    const result = computeP3(inputFrom(rows, {
      scan: cleanScan({
        state: { [`p1:${ROOT}`]: "PARTIAL", [`p3:${ROOT}`]: "COMPLETE" },
        failures: [{
          root: ROOT, scope: "record", path: `${ROOT}/a.json`, reason: "EACCES", affects: ["p1"],
        }],
        readFailures: 1,
      }),
    }));
    expect(result.scanState).toBe("PARTIAL");
    expect(result.verdict.status.code).toBe("scan-incomplete");
  });

  it("a scan problem in a root OUTSIDE the window scope does not spoil the week", () => {
    const rows = Array.from({ length: 24 }, () => verified(2));
    const result = computeP3(inputFrom(rows, {
      scan: cleanScan({
        roots: [ROOT, "/other/root"],
        state: {
          [`p1:${ROOT}`]: "COMPLETE", [`p3:${ROOT}`]: "COMPLETE",
          "p1:/other/root": "UNAVAILABLE",
        },
        failures: [{
          root: "/other/root", scope: "root-discovery", path: "/other", reason: "EACCES",
          affects: ["p1"],
        }],
        readFailures: 1,
      }),
    }));
    expect(result.scanState).toBe("COMPLETE");
    expect(result.verdict.status.code).toBe("no-blocking-condition");
  });
});

describe("a contradictory record cannot HIDE evidence that the contract changed", () => {
  it("sets VOID as well as join-mismatch", () => {
    // The two round-1 fixes interacted. Divergence was recorded after the
    // join-mismatch early return, so adding a record with a disagreeing
    // artifact hash suppressed a VOID that the OTHER record independently
    // established. An extra contradictory record must never remove evidence.
    const rows = [...Array.from({ length: 23 }, () => verified(2)), verified(2)];
    const built = buildFromRows(rows);
    const last = built.records[23]!.record as Extract<PolicyRecord, { kind: "measured" }>;
    const result = computeP3(inputFrom(rows, {
      artifacts: built.artifacts,
      records: [
        ...built.records.slice(0, 23),
        // Hash-MATCHING and contract-divergent: this is the VOID evidence.
        { root: ROOT, record: { ...last, evaluatedContentHash: OTHER_CONTRACT } },
        // Hash-DISAGREEING: this is what used to swallow it.
        { root: ROOT, record: { ...last, artifactContentHash: "names-another-artifact" } },
      ],
    }));
    expect(result.outcomeExclusions.byClass.find((c) => c.cls === "join-mismatch")?.count).toBe(1);
    expect(result.verdict.status.code).toBe("void-contract-changed");
  });

  it("counts a divergent round ONCE even with several divergent records", () => {
    const rows = [...Array.from({ length: 23 }, () => verified(2)), verified(2)];
    const built = buildFromRows(rows);
    const last = built.records[23]!.record as Extract<PolicyRecord, { kind: "measured" }>;
    const result = computeP3(inputFrom(rows, {
      artifacts: built.artifacts,
      records: [
        ...built.records.slice(0, 23),
        { root: ROOT, record: { ...last, evaluatedContentHash: OTHER_CONTRACT } },
        { root: ROOT, record: { ...last, evaluatedContentHash: "hash-C" } },
      ],
    }));
    expect(result.verdict.status.reason).toContain("1 in-window round(s)");
  });
});

describe("with no usable window the POPULATION row asserts nothing", () => {
  for (const [name, w] of [
    ["an absent window", null],
    ["an unparseable openedAt", { ...closedWindow(), openedAt: "banana" }],
    ["an unparseable closedAt", { ...closedWindow(), closedAt: "banana" }],
  ] as const) {
    it(`prints CANNOT BE EVALUATED rather than FAIL for ${name}`, () => {
      const result = computeP3(inputFrom(Array.from({ length: 24 }, () => verified(2)), {
        window: w,
      }));
      const pop = rowFamily(result, "population")[0];
      expect(pop?.pass).toBeNull();
      expect(pop?.measured).toMatch(/membership is undefined/);
      expect(result.verdict.status.code).toBe("no-window");
      // The POPULATION SECTION must agree with the row. A section printing a
      // measured-looking zero beside a row saying the floor cannot be
      // evaluated is two answers to one question.
      expect(result.population.membershipDefined).toBe(false);
    });
  }
});

describe("the window header material is carried through", () => {
  it("reports the window, the contract at scan and the close observations", () => {
    const result = lazy(() => computeP3(canonicalInput()));
    expect(result().window?.openedAt).toBe(OPENED_AT);
    expect(result().window?.closedAt).toBe(CLOSED_AT);
    expect(result().contractAtScan).toEqual({ status: "active", principleCount: 6, invalidCount: 0 });
  });
});

describe("a degraded record is never eligible for any metric", () => {
  it("has no findings key to count and is excluded from the projection too", () => {
    const rows = [verified(4, 2), row({ leg: "packet", state: "degraded" })];
    const built = buildFromRows(rows);
    const result = lazy(() => computeP3(inputFrom(rows, {
      artifacts: built.artifacts,
      records: built.records,
    })));
    expect(result().population.measuredRounds).toBe(1);
    expect(byId(result().projection, "p3-blocker-check-changed").denominator).toBe(1);
    expect(byId(result().headline, "p3-capped-names-none").denominator).toBe(4);
    const rec = built.records[1]!.record;
    expect("findings" in rec).toBe(false);
    expect("gate" in rec).toBe(false);
  });
});

describe("an artifact with no reviewAttemptId can never be joined, and says so", () => {
  it("counts it as unjoinable beside measurement-absent rather than matching by session", () => {
    const rows = [verified(2)];
    const built = buildFromRows(rows);
    const result = lazy(() => computeP3(inputFrom(rows, {
      artifacts: [...built.artifacts, artifactFor(ROOT, null, "2026-09-12T00:00:00.000Z", "legacy")],
      records: built.records,
    })));
    expect(result().population.unjoinableArtifacts).toBe(1);
    expect(result().population.measuredRounds).toBe(1);
    const absent = result().outcomeExclusions.byClass.find((c) => c.cls === "measurement-absent");
    expect(absent?.count).toBe(1);
  });
});

describe("record accounting is carried on every metric", () => {
  it("a partial scan makes the population total null rather than a confident count", () => {
    const rows = Array.from({ length: 24 }, () => verified(2));
    const result = lazy(() => computeP3(inputFrom(rows, {
      scan: cleanScan({
        state: { [`p3:${ROOT}`]: "PARTIAL" },
        failures: [{
          root: ROOT, scope: "record", path: `${ROOT}/x`, reason: "EACCES", affects: ["p3"],
        }],
        readFailures: 1,
      }),
    })));
    for (const m of [...result().headline, ...result().projection]) {
      expect(m.records.total).toBeNull();
      expect(m.conditional).toBe(true);
      expect(m.scanState).toBe("PARTIAL");
    }
  });

  it("a complete scan carries the in-window count as the total", () => {
    const result = lazy(() => computeP3(canonicalInput()));
    for (const m of [...result().headline, ...result().projection]) {
      expect(m.records.total).toBe(24);
      expect(m.conditional).toBe(false);
    }
  });
});

describe("every metric declares the p3 population and its own provenance", () => {
  it("never claims a P1 or P2 population", () => {
    const result = lazy(() => computeP3(canonicalInput()));
    const all = [
      ...result().headline, ...result().unverified,
      ...result().projection, ...result().deliveryDetail,
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) {
      expect(m.population).toBe("p3");
      expect(["observed", "derived", "reconstructed"]).toContain(m.provenance);
      expect(m.kind).toBe("proportion");
    }
  });
});

describe("the reconciliation line accounts for every artifact and record", () => {
  it("24 artifacts, 22 joined records, 20 measured, 2 degraded, 2 with none, 2 orphans", () => {
    const result = lazy(() => computeP3(canonicalInput()));
    const p = result().population;
    expect(p.joinedRecords).toBe(22);
    expect(p.measuredRounds + p.degradedRounds + p.artifactsWithNoRecord).toBe(p.inWindow);
    expect(p.orphanRecords).toBe(2);
  });
});
