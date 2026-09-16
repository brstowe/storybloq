/**
 * ISS-823 contract tests for the @storybloq/lenses dependency.
 *
 * The autonomous lens backend consumes the package's stable 0.3.0 library
 * surface (lenses T-033). These tests pin the exact exports the consumer
 * harness relies on, so a package upgrade that breaks the contract fails
 * here first with a named symbol rather than deep inside the harness.
 */

import { describe, it, expect } from "vitest";
import {
  LENSES,
  SURFACE_RULES,
  activate,
  buildLensPrompt,
  runMergerPipeline,
  LensOutputSchema,
  LensFindingSchema,
  ReviewVerdictSchema,
  MergerConfigSchema,
  PreambleConfigSchema,
  DEFAULT_ALWAYS_BLOCK,
  COVERED_STATUSES,
  changeFileUnion,
  coreLensApplicability,
  diffTouchedPaths,
  isCoveredEntry,
} from "@storybloq/lenses";

describe("@storybloq/lenses stable library surface (ISS-823)", () => {
  it("exports the 9-lens frozen registry projection", () => {
    const ids = Object.keys(LENSES).sort();
    expect(ids).toEqual([
      "accessibility",
      "api-design",
      "clean-code",
      "concurrency",
      "data-safety",
      "error-handling",
      "performance",
      "security",
      "test-quality",
    ]);
    // Mutability boundary: registry projections are frozen.
    expect(Object.isFrozen(LENSES)).toBe(true);
    expect(Object.isFrozen(SURFACE_RULES)).toBe(true);
    // Every lens carries a version used in consumer cache keys.
    for (const id of ids) {
      expect(LENSES[id as keyof typeof LENSES].version).toBeTruthy();
    }
  });

  it("activate() fires all four core lenses for a plain TS code review", () => {
    const activations = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/example.ts"],
    });
    const active = activations.map((a) => a.lensId);
    for (const core of ["security", "error-handling", "clean-code", "concurrency"]) {
      expect(active).toContain(core);
    }
  });

  it("buildLensPrompt() produces a self-contained prompt embedding the artifact", () => {
    const [first] = activate({
      stage: "CODE_REVIEW",
      changedFiles: ["src/example.ts"],
    });
    const prompt = buildLensPrompt({
      activation: first!,
      startParams: {
        stage: "CODE_REVIEW",
        changedFiles: ["src/example.ts"],
        artifact: "diff --git a/src/example.ts b/src/example.ts\n+const x = 1;",
        ticketDescription: "contract test",
        reviewRound: 1,
        priorDeferrals: [],
      },
      preambleConfig: PreambleConfigSchema.parse({}),
    });
    expect(prompt.lensId).toBe(first!.lensId);
    expect(prompt.prompt).toContain("const x = 1;");
    expect(prompt.prompt).toContain("## Output rules");
  });

  it("runMergerPipeline() returns a schema-valid ReviewVerdict", () => {
    const finding = {
      id: "f-1",
      severity: "major" as const,
      category: "unchecked-error",
      file: "src/example.ts",
      line: 1,
      description: "example finding",
      suggestion: "fix it",
      confidence: 0.9,
    };
    const verdict = runMergerPipeline({
      reviewId: "r-contract",
      sessionId: "s-contract",
      perLens: [
        {
          lensId: "error-handling",
          output: { status: "ok", findings: [finding], error: null, notes: null },
        },
      ],
      lensCoverage: [
        { lensId: "error-handling", status: "ok", attempts: 1, contributedFindings: 1 },
      ],
      reviewComplete: true,
    });
    const parsed = ReviewVerdictSchema.parse(verdict);
    expect(parsed.verdict).toBe("revise");
    expect(parsed.major).toBe(1);
    expect(parsed.coverage).toBe("full");
  });

  it("blocking severity forces reject and hardcoded-secrets is alwaysBlock", () => {
    expect(DEFAULT_ALWAYS_BLOCK).toContain("hardcoded-secrets");
    expect(COVERED_STATUSES.has("ok")).toBe(true);
    expect(COVERED_STATUSES.has("cached")).toBe(true);
    const verdict = runMergerPipeline({
      reviewId: "r-blocking",
      sessionId: "s-blocking",
      perLens: [
        {
          lensId: "security",
          output: {
            status: "ok",
            findings: [
              {
                id: "sec-1",
                severity: "blocking",
                category: "hardcoded-secrets",
                file: null,
                line: null,
                description: "secret detected",
                suggestion: "remove it",
                confidence: 0.9,
              },
            ],
            error: null,
            notes: null,
          },
        },
      ],
      reviewComplete: true,
    });
    expect(verdict.verdict).toBe("reject");
    expect(verdict.blocking).toBe(1);
  });

  it("LensOutputSchema and LensFindingSchema enforce the wire contract", () => {
    expect(
      LensOutputSchema.safeParse({
        status: "ok",
        findings: [],
        error: null,
        notes: null,
      }).success,
    ).toBe(true);
    // Fork-shaped finding (evidence[], suggestedFix, critical severity) must
    // NOT parse: the fork schema survives nowhere (pen ruling R1).
    expect(
      LensFindingSchema.safeParse({
        lens: "security",
        lensVersion: "v1",
        severity: "critical",
        recommendedImpact: "blocker",
        category: "x",
        description: "y",
        file: null,
        line: null,
        evidence: [{ file: "a.ts", startLine: 1, endLine: 1, code: "z" }],
        suggestedFix: null,
        confidence: 0.9,
        assumptions: null,
        requiresMoreContext: false,
      }).success,
    ).toBe(false);
    expect(MergerConfigSchema.parse(undefined).confidenceFloor).toBe(0.6);
  });
});

/**
 * ISS-950: the 0.6.0 coverage surface the harness half is built on.
 *
 * Pinned here rather than inside the harness tests because these are the
 * package's promises, not the harness's: the signatures, the basis vocabulary,
 * the single coverage predicate, and the `capReasons` default. A 0.5.x package
 * fails every assertion in this block at the import, which is exactly the
 * coordinated-release fence the CHANGELOG describes.
 */
describe("@storybloq/lenses 0.6.0 coverage surface (ISS-950)", () => {
  const DOCS_DIFF = [
    "diff --git a/docs/guide.md b/docs/guide.md",
    "--- a/docs/guide.md",
    "+++ b/docs/guide.md",
    "@@ -1,2 +1,3 @@",
    " intro",
    "+a new sentence",
    " outro",
    "",
  ].join("\n");

  const CODE_DIFF = [
    "diff --git a/src/pool.ts b/src/pool.ts",
    "--- a/src/pool.ts",
    "+++ b/src/pool.ts",
    "@@ -1,2 +1,3 @@",
    " export const pool = 1;",
    "+export const extra = 2;",
    " export default pool;",
    "",
  ].join("\n");

  it("coreLensApplicability takes (lensId, changedFiles, diff) and rules a docs-only change not applicable", () => {
    expect(typeof coreLensApplicability).toBe("function");
    for (const core of ["security", "error-handling", "clean-code", "concurrency"]) {
      expect(coreLensApplicability(core, ["docs/guide.md"], DOCS_DIFF)).toBe("not-applicable");
    }
  });

  it("coreLensApplicability rules a code change applicable, and an empty union applicable", () => {
    expect(coreLensApplicability("error-handling", ["src/pool.ts"], CODE_DIFF)).toBe("applicable");
    // Nothing there proves the lens had no surface, so the uncertain case is
    // applicable. A PLAN_REVIEW with no diff lands here.
    expect(coreLensApplicability("error-handling", [], "")).toBe("applicable");
  });

  it("the declared file list is a claim: the diff-touched union overrides it", () => {
    // The caller declares docs only while the diff deletes a source file. The
    // union is what the check ranges over, so no core lens is excused.
    const deletion = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "deleted file mode 100644",
      "--- a/src/auth.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-export const token = process.env.TOKEN;",
      "-export default token;",
      "",
    ].join("\n");
    const union = changeFileUnion(["docs/guide.md"], deletion);
    expect(union).toContain("src/auth.ts");
    expect(coreLensApplicability("security", ["docs/guide.md"], deletion)).toBe("applicable");
  });

  it("changeFileUnion and diffTouchedPaths take the raw diff string", () => {
    expect(diffTouchedPaths(CODE_DIFF)).toEqual(["src/pool.ts"]);
    expect(changeFileUnion([], CODE_DIFF)).toEqual(["src/pool.ts"]);
    expect(changeFileUnion(["docs/guide.md"], "").sort()).toEqual(["docs/guide.md"]);
  });

  it("isCoveredEntry is the single coverage rule: only a not-applicable skip is covered", () => {
    const base = { lensId: "concurrency", attempts: 1, contributedFindings: 0 } as const;
    expect(isCoveredEntry({ ...base, status: "ok" })).toBe(true);
    expect(isCoveredEntry({ ...base, status: "cached" })).toBe(true);
    expect(isCoveredEntry({ ...base, status: "skipped", basis: "not-applicable" })).toBe(true);
    expect(isCoveredEntry({ ...base, status: "skipped", basis: "self-reported" })).toBe(false);
    expect(isCoveredEntry({ ...base, status: "error", basis: "no-submission" })).toBe(false);
    // A relabel is never coverage, whatever the status says.
    expect(
      isCoveredEntry({ ...base, status: "ok", relabeled: true }),
    ).toBe(false);
  });

  it("ReviewVerdict carries capReasons, defaulted to empty", () => {
    const verdict = runMergerPipeline({
      stage: "CODE_REVIEW",
      perLens: [
        { lensId: "security", output: { status: "ok", findings: [], error: null, notes: null } },
      ],
      reviewComplete: true,
    });
    expect(verdict.capReasons).toEqual([]);
  });

  it("a self-reported core skip caps the verdict and names itself in capReasons", () => {
    const coverage = (
      lensId: string,
      extra: Record<string, unknown>,
    ) => ({ lensId, attempts: 1, contributedFindings: 0, ...extra });
    const verdict = runMergerPipeline({
      stage: "CODE_REVIEW",
      perLens: [
        { lensId: "security", output: { status: "ok", findings: [], error: null, notes: null } },
      ],
      lensCoverage: [
        coverage("security", { status: "ok" }),
        coverage("error-handling", { status: "ok" }),
        coverage("clean-code", { status: "ok" }),
        coverage("concurrency", { status: "skipped", basis: "self-reported" }),
      ] as never,
      reviewComplete: true,
    });
    expect(verdict.verdict).toBe("revise");
    expect(verdict.capReasons).toEqual([
      "core lens 'concurrency' uncovered (skipped, self-reported)",
    ]);
  });

  it("a not-applicable core skip does not cap, but only when anchoring lets the server confirm it", () => {
    const coverage = (
      lensId: string,
      extra: Record<string, unknown>,
    ) => ({ lensId, attempts: 1, contributedFindings: 0, ...extra });
    const lensCoverage = [
      coverage("security", { status: "skipped", basis: "not-applicable" }),
      coverage("error-handling", { status: "skipped", basis: "not-applicable" }),
      coverage("clean-code", { status: "skipped", basis: "not-applicable" }),
      coverage("concurrency", { status: "skipped", basis: "not-applicable" }),
    ] as never;
    const perLens = [
      { lensId: "security" as const, output: { status: "skipped" as const, findings: [], error: null, notes: null } },
    ];

    // TRUSTED DOWNWARD ONLY. With no anchoring the server has no diff to check
    // the claim against, so a supplied `not-applicable` is DEMOTED to
    // `self-reported` and still caps. This is the contract the harness has to
    // satisfy: a basis it computes itself does not survive on its own word.
    const unconfirmed = runMergerPipeline({
      stage: "CODE_REVIEW",
      perLens,
      lensCoverage,
      reviewComplete: true,
    });
    expect(unconfirmed.verdict).toBe("revise");
    expect(unconfirmed.capReasons).toEqual([
      "core lens 'security' uncovered (skipped, self-reported)",
      "core lens 'error-handling' uncovered (skipped, self-reported)",
      "core lens 'clean-code' uncovered (skipped, self-reported)",
      "core lens 'concurrency' uncovered (skipped, self-reported)",
    ]);

    // With the artifact the lenses actually saw, the server confirms it.
    const confirmed = runMergerPipeline({
      stage: "CODE_REVIEW",
      perLens,
      lensCoverage,
      reviewComplete: true,
      anchoring: {
        stage: "CODE_REVIEW",
        artifact: DOCS_DIFF,
        changedFiles: ["docs/guide.md"],
      },
    });
    expect(confirmed.verdict).toBe("approve");
    expect(confirmed.capReasons).toEqual([]);
    expect(confirmed.coverage).toBe("full");
  });
});
