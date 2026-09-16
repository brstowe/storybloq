/**
 * ISS-823 deterministic judge (pen ruling R2/R3).
 *
 * The judge is a pure three-value mapping over the package ReviewVerdict
 * plus convergence history. No LLM hop:
 *   - pipeline reject  -> reject
 *   - pipeline revise  -> revise
 *   - pipeline approve carrying majors or partial coverage
 *                      -> approve + recommendFixRound (the WF2 third value)
 *   - else             -> approve
 * Convergence history damps repeated fix-round recommendations using the
 * fork's documented stop rule (blocking = 0 for two consecutive rounds and
 * major counts stable or decreasing), applied deterministically.
 */

import { describe, it, expect } from "vitest";
import type { MergedFinding, ReviewVerdict } from "@storybloq/lenses";
import { handleJudge } from "../../../src/autonomous/lens-harness/judge.js";

function finding(overrides: Partial<MergedFinding> = {}): MergedFinding {
  return {
    id: "f-1",
    severity: "major",
    category: "unchecked-error",
    file: "src/a.ts",
    line: 3,
    description: "example",
    suggestion: "fix",
    confidence: 0.9,
    contributingLenses: ["error-handling"],
    ...overrides,
  };
}

function verdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  const findings = overrides.findings ?? [];
  return {
    verdict: "approve",
    findings,
    tensions: [],
    blocking: findings.filter((f) => f.severity === "blocking").length,
    major: findings.filter((f) => f.severity === "major").length,
    minor: findings.filter((f) => f.severity === "minor").length,
    suggestion: findings.filter((f) => f.severity === "suggestion").length,
    sessionId: "s-judge",
    parseErrors: [],
    deferred: [],
    suppressedFindingCount: 0,
    hadAnyFindings: findings.length > 0,
    nextActions: [],
    lensCoverage: [],
    coverage: "full",
    errorCodes: [],
    reviewComplete: true,
    anchorRealignedCount: 0,
    evidenceUnverifiedCount: 0,
    reviewIntegrity: [],
    anchorUnindexedFiles: [],
    ...overrides,
  };
}

describe("handleJudge (deterministic three-value mapping)", () => {
  it("maps pipeline reject to reject without a fix-round flag", () => {
    // recommendFixRound is the approve-only third value; a reject verdict is
    // already the fix signal, so the flag stays false (pen ruling R2).
    const v = verdict({
      verdict: "reject",
      findings: [finding({ severity: "blocking", category: "hardcoded-secrets" })],
    });
    const out = handleJudge({ reviewVerdict: v });
    expect(out.verdict).toBe("reject");
    expect(out.recommendFixRound).toBe(false);
    expect(out.blocking).toBe(1);
  });

  it("maps pipeline revise to revise without a fix-round flag", () => {
    const v = verdict({ verdict: "revise", findings: [finding()] });
    const out = handleJudge({ reviewVerdict: v });
    expect(out.verdict).toBe("revise");
    expect(out.recommendFixRound).toBe(false);
  });

  it("recommendFixRound is only ever true on an approve verdict", () => {
    // reject carrying majors + partial coverage still keeps the flag false.
    const rej = verdict({
      verdict: "reject",
      coverage: "partial",
      lensCoverage: [
        { lensId: "performance", status: "error", attempts: 1, contributedFindings: 0 },
      ],
      findings: [
        finding({ severity: "blocking", category: "hardcoded-secrets" }),
        finding({ id: "f-2", severity: "major" }),
      ],
    });
    expect(handleJudge({ reviewVerdict: rej }).recommendFixRound).toBe(false);
  });

  it("clean approve carries no fix-round recommendation", () => {
    const out = handleJudge({ reviewVerdict: verdict() });
    expect(out.verdict).toBe("approve");
    expect(out.recommendFixRound).toBe(false);
    expect(out.isPartial).toBe(false);
  });

  it("approve with partial coverage from a non-core lens recommends a fix round", () => {
    const v = verdict({
      coverage: "partial",
      lensCoverage: [
        { lensId: "performance", status: "error", attempts: 1, contributedFindings: 0 },
      ],
    });
    const out = handleJudge({ reviewVerdict: v });
    expect(out.verdict).toBe("approve");
    expect(out.recommendFixRound).toBe(true);
    expect(out.isPartial).toBe(true);
  });

  it("convergence history suppresses a majors-only recommendation once stable", () => {
    const v = verdict({
      verdict: "approve",
      findings: [finding({ severity: "major" })],
    });
    const history = [
      { round: 1, verdict: "approve", blocking: 0, important: 2, newCode: "no" },
      { round: 2, verdict: "approve", blocking: 0, important: 1, newCode: "no" },
    ];
    const damped = handleJudge({ reviewVerdict: v, convergenceHistory: history });
    expect(damped.verdict).toBe("approve");
    expect(damped.recommendFixRound).toBe(false);

    // Without history the same verdict recommends another round.
    const fresh = handleJudge({ reviewVerdict: v });
    expect(fresh.recommendFixRound).toBe(true);

    // A blocking round in recent history disables the damping.
    const blocked = handleJudge({
      reviewVerdict: v,
      convergenceHistory: [
        { round: 1, verdict: "reject", blocking: 1, important: 2, newCode: "no" },
        { round: 2, verdict: "approve", blocking: 0, important: 1, newCode: "no" },
      ],
    });
    expect(blocked.recommendFixRound).toBe(true);
  });

  it("convergence history never suppresses a coverage-gap recommendation", () => {
    const v = verdict({
      coverage: "partial",
      lensCoverage: [
        { lensId: "performance", status: "error", attempts: 1, contributedFindings: 0 },
      ],
    });
    const out = handleJudge({
      reviewVerdict: v,
      convergenceHistory: [
        { round: 1, verdict: "approve", blocking: 0, important: 0, newCode: "no" },
        { round: 2, verdict: "approve", blocking: 0, important: 0, newCode: "no" },
      ],
    });
    expect(out.recommendFixRound).toBe(true);
  });

  it("rejects a malformed reviewVerdict payload", () => {
    expect(() => handleJudge({ reviewVerdict: { verdict: "approve" } })).toThrow(
      /reviewVerdict/,
    );
    // Internally inconsistent payload (blocking finding under approve) is
    // rejected by the schema's superRefine, not silently accepted.
    const bad = verdict({ findings: [finding({ severity: "blocking" })] });
    expect(() => handleJudge({ reviewVerdict: bad })).toThrow(/reviewVerdict/);
  });
});

/**
 * ISS-950 acceptance 4: the judge separates the two reasons a verdict can sit
 * below approve.
 *
 * A revise with zero blocking and zero major findings whose every cap reason
 * names an uncovered core lens is a COVERAGE cap: nothing was found, a lens
 * simply did not cover its domain. The remedy is that lens running again, not
 * the implementer changing code. A revise carrying findings is a FINDINGS cap
 * whatever its coverage looks like, and the two must never be conflated: one
 * routes to a lens re-run, the other to IMPLEMENT.
 */
describe("handleJudge coverage-only cap (ISS-950)", () => {
  const coverageEntry = (
    lensId: string,
    extra: Record<string, unknown> = {},
  ) => ({ lensId, status: "skipped" as const, attempts: 1, contributedFindings: 0, ...extra });

  it("M-CAP-CONFLATED: a findings-free revise capped by coverage is a coverage cap", () => {
    const v = verdict({
      verdict: "revise",
      coverage: "partial",
      lensCoverage: [
        coverageEntry("security", { status: "ok" }),
        coverageEntry("concurrency", { basis: "self-reported" }),
      ],
      capReasons: ["core lens 'concurrency' uncovered (skipped, self-reported)"],
    });
    const out = handleJudge({ reviewVerdict: v });
    expect(out.verdict).toBe("revise");
    expect(out.coverageOnlyCap).toBe(true);
    expect(out.uncoveredCoreLenses).toEqual(["concurrency"]);
    expect(out.capReasons).toEqual([
      "core lens 'concurrency' uncovered (skipped, self-reported)",
    ]);
    expect(out.verdictReason).toContain("coverage");
    expect(out.verdictReason).not.toContain("1 major");
  });

  it("M-CAP-CONFLATED: a revise carrying majors is a findings cap even with a coverage gap", () => {
    const v = verdict({
      verdict: "revise",
      findings: [finding()],
      coverage: "partial",
      lensCoverage: [coverageEntry("concurrency", { basis: "self-reported" })],
      capReasons: ["core lens 'concurrency' uncovered (skipped, self-reported)"],
    });
    const out = handleJudge({ reviewVerdict: v });
    expect(out.verdict).toBe("revise");
    expect(out.coverageOnlyCap).toBe(false);
    // The lens is still named: a findings cap does not make the gap disappear.
    expect(out.uncoveredCoreLenses).toEqual(["concurrency"]);
  });

  it("a relabelled core lens is a coverage cap and names the lens", () => {
    const v = verdict({
      verdict: "revise",
      coverage: "partial",
      lensCoverage: [
        coverageEntry("concurrency", { status: "ok", relabeled: true }),
      ],
      capReasons: ["core lens 'concurrency' relabeled"],
    });
    const out = handleJudge({ reviewVerdict: v });
    expect(out.coverageOnlyCap).toBe(true);
    expect(out.uncoveredCoreLenses).toEqual(["concurrency"]);
  });

  it("a non-coverage cap reason disqualifies the coverage-only route", () => {
    // `retry pending` and `review incomplete` also cap an approve, and neither
    // is answered by re-running a named lens.
    const v = verdict({
      verdict: "revise",
      coverage: "partial",
      lensCoverage: [coverageEntry("concurrency", { basis: "self-reported" })],
      capReasons: [
        "core lens 'concurrency' uncovered (skipped, self-reported)",
        "retry pending",
      ],
    });
    const out = handleJudge({ reviewVerdict: v });
    expect(out.coverageOnlyCap).toBe(false);
  });

  it("a reject is never a coverage cap", () => {
    const v = verdict({
      verdict: "reject",
      findings: [finding({ severity: "blocking", category: "hardcoded-secrets" })],
      coverage: "partial",
      lensCoverage: [coverageEntry("concurrency", { basis: "self-reported" })],
      capReasons: ["core lens 'concurrency' uncovered (skipped, self-reported)"],
    });
    const out = handleJudge({ reviewVerdict: v });
    expect(out.verdict).toBe("reject");
    expect(out.coverageOnlyCap).toBe(false);
  });

  it("an uncapped approve reports no cap at all", () => {
    const out = handleJudge({ reviewVerdict: verdict({ capReasons: [] }) });
    expect(out.coverageOnlyCap).toBe(false);
    expect(out.capReasons).toEqual([]);
    expect(out.uncoveredCoreLenses).toEqual([]);
  });
});
