/**
 * ISS-950 harness half, acceptance 1 and 5: the coverage basis synthesize
 * builds, and the cross-call relabel it is the only side able to see.
 *
 * The package decides whether a skip was honest (`coreLensApplicability` over
 * the union of the caller-declared files and every path the diff touches). The
 * harness supplies that basis, applies the downgrade-only rule across calls,
 * and flags the flip the server cannot: a lens that skipped in an EARLIER
 * synthesize for the same reviewId and comes back `ok` with zero findings is
 * renaming its old answer, and the two calls are separate review calls the
 * server never sees together.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSynthesize, skipBasisForLens } from "../../../src/autonomous/lens-harness/synthesize.js";

const CORE = ["security", "error-handling", "clean-code", "concurrency"] as const;

/** A docs-only change: nothing in any core lens's domain. */
const DOCS_DIFF = [
  "diff --git a/docs/guide.md b/docs/guide.md",
  "index 0000000..1111111 100644",
  "--- a/docs/guide.md",
  "+++ b/docs/guide.md",
  "@@ -1,2 +1,3 @@",
  " intro",
  "+a new sentence",
  " outro",
  "",
].join("\n");

/** A plain TypeScript change with no concurrency tokens on any changed line. */
const CODE_DIFF = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 0000000..1111111 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,3 +1,4 @@",
  " export function greet(name: string): string {",
  '+  console.log("debug");',
  '   return "hello " + name;',
  " }",
  "",
].join("\n");

/**
 * The caller declares docs only while the same diff DELETES a source file. A
 * deletion names its file on `--- a/path` and `diff --git` and nowhere else, so
 * a union read off `+++` alone would miss it and excuse every core lens over
 * unreviewed auth code.
 */
const DECLARED_DOCS_DELETES_CODE = [
  "diff --git a/docs/guide.md b/docs/guide.md",
  "--- a/docs/guide.md",
  "+++ b/docs/guide.md",
  "@@ -1,2 +1,3 @@",
  " intro",
  "+a new sentence",
  " outro",
  "diff --git a/src/auth.ts b/src/auth.ts",
  "deleted file mode 100644",
  "--- a/src/auth.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-export const token = process.env.TOKEN;",
  "-export default token;",
  "",
].join("\n");

function okOutput(findings: unknown[] = []) {
  return { status: "ok", findings, error: null, notes: null };
}

function skippedOutput(notes = "nothing in my domain") {
  return { status: "skipped", findings: [], error: null, notes };
}

const SKIPPED_LENSES = [
  "performance",
  "api-design",
  "test-quality",
  "accessibility",
  "data-safety",
];

let root: string;
let sessionDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lens-coverage-basis-"));
  sessionDir = join(root, ".story", "sessions", "sess-1");
  mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function synthesize(args: {
  outputs: Record<string, unknown>;
  diff: string;
  changedFiles: readonly string[];
  reviewId?: string;
  reviewRound?: number;
  omit?: readonly string[];
}) {
  const omit = new Set(args.omit ?? []);
  return handleSynthesize({
    stage: "CODE_REVIEW",
    lensResults: CORE.filter((l) => !omit.has(l)).map((lens) => ({
      lens,
      output: args.outputs[lens] ?? okOutput(),
    })),
    metadata: {
      activeLenses: [...CORE],
      skippedLenses: SKIPPED_LENSES,
      reviewRound: args.reviewRound ?? 1,
      reviewId: args.reviewId ?? "lens-cov-1",
    },
    projectRoot: root,
    sessionDir,
    sessionId: "sess-1",
    diff: args.diff,
    changedFiles: args.changedFiles,
  });
}

function entry(out: ReturnType<typeof handleSynthesize>, lensId: string) {
  const found = out.reviewVerdict.lensCoverage.find((e) => e.lensId === lensId);
  if (!found) throw new Error(`no coverage entry for ${lensId}`);
  return found;
}

describe("ISS-950 acceptance 1: a not-applicable core skip is coverage", () => {
  it("four core lenses skipping a docs-only diff yields approve with no cap", () => {
    const out = synthesize({
      outputs: Object.fromEntries(CORE.map((l) => [l, skippedOutput()])),
      diff: DOCS_DIFF,
      changedFiles: ["docs/guide.md"],
    });

    for (const lens of CORE) {
      expect(entry(out, lens).status).toBe("skipped");
      expect(entry(out, lens).basis).toBe("not-applicable");
    }
    expect(out.reviewVerdict.capReasons).toEqual([]);
    expect(out.reviewVerdict.coverage).toBe("full");
    expect(out.reviewVerdict.verdict).toBe("approve");
  });

  it("a skip on an APPLICABLE change stays self-reported and still caps", () => {
    // `error-handling` has surface on any code file, so a code diff is
    // applicable to it whatever it contains. `concurrency` on the same diff is
    // genuinely excused (no token on any changed line), which is the whole
    // point of the per-lens narrowing.
    const out = synthesize({
      outputs: { "error-handling": skippedOutput(), concurrency: skippedOutput() },
      diff: CODE_DIFF,
      changedFiles: ["src/example.ts"],
    });

    expect(entry(out, "error-handling").basis).toBe("self-reported");
    expect(entry(out, "concurrency").basis).toBe("not-applicable");
    expect(entry(out, "security").basis).toBeUndefined();
    expect(out.reviewVerdict.capReasons).toEqual([
      "core lens 'error-handling' uncovered (skipped, self-reported)",
    ]);
    expect(out.reviewVerdict.verdict).toBe("revise");
  });

  it("M-UNION-DECLARED-ONLY: the union reads the diff, not the caller's declaration", () => {
    // Declared docs-only, but the diff deletes src/auth.ts. Every core lens is
    // applicable, so no skip is excused.
    const out = synthesize({
      outputs: Object.fromEntries(CORE.map((l) => [l, skippedOutput()])),
      diff: DECLARED_DOCS_DELETES_CODE,
      changedFiles: ["docs/guide.md"],
    });

    for (const lens of CORE) {
      expect(entry(out, lens).basis).toBe("self-reported");
    }
    expect(out.reviewVerdict.verdict).toBe("revise");
    expect(out.reviewVerdict.capReasons).toHaveLength(4);
  });

  it("a lens that never submitted is no-submission, and never coverage", () => {
    const out = synthesize({
      outputs: {},
      diff: DOCS_DIFF,
      changedFiles: ["docs/guide.md"],
      omit: ["clean-code"],
    });

    expect(entry(out, "clean-code").basis).toBe("no-submission");
    expect(entry(out, "clean-code").status).toBe("error");
    expect(out.reviewVerdict.capReasons).toEqual([
      "core lens 'clean-code' uncovered (error, no-submission)",
    ]);
  });
});

describe("ISS-950: the downgrade-only basis rule across calls", () => {
  it("M-UPGRADE-BASIS: a self-reported skip is never raised to not-applicable later", () => {
    // Round 1: a real code change. The error-handling skip is self-reported.
    const first = synthesize({
      outputs: { "error-handling": skippedOutput() },
      diff: CODE_DIFF,
      changedFiles: ["src/example.ts"],
      reviewId: "lens-cov-downgrade",
    });
    expect(entry(first, "error-handling").basis).toBe("self-reported");

    // Round 2 on the SAME reviewId, now presented with a docs-only diff. The
    // applicability check alone would say not-applicable. The recorded skip
    // cannot be raised by re-presenting the change.
    const second = synthesize({
      outputs: { "error-handling": skippedOutput() },
      diff: DOCS_DIFF,
      changedFiles: ["docs/guide.md"],
      reviewId: "lens-cov-downgrade",
      reviewRound: 2,
    });
    expect(entry(second, "error-handling").basis).toBe("self-reported");
    expect(second.reviewVerdict.verdict).toBe("revise");
  });

  it("the memory is scoped per reviewId, so a different review starts clean", () => {
    synthesize({
      outputs: { "error-handling": skippedOutput() },
      diff: CODE_DIFF,
      changedFiles: ["src/example.ts"],
      reviewId: "lens-cov-a",
    });
    const other = synthesize({
      outputs: { "error-handling": skippedOutput() },
      diff: DOCS_DIFF,
      changedFiles: ["docs/guide.md"],
      reviewId: "lens-cov-b",
    });
    expect(entry(other, "error-handling").basis).toBe("not-applicable");
  });

  it("the memory is persisted in the session telemetry directory, not in process memory", () => {
    synthesize({
      outputs: { "error-handling": skippedOutput() },
      diff: CODE_DIFF,
      changedFiles: ["src/example.ts"],
      reviewId: "lens-cov-persist",
    });
    const file = join(sessionDir, "telemetry", "lens-coverage-memory.json");
    expect(existsSync(file)).toBe(true);
    const memory = JSON.parse(readFileSync(file, "utf-8"));
    expect(memory["lens-cov-persist"]["error-handling"]).toEqual({
      everSkipped: true,
      basis: "self-reported",
    });
  });
});

describe("ISS-950 acceptance 5: cross-call relabel detection", () => {
  it("M-NO-RELABEL: skipped then ok with zero findings on the same reviewId is a relabel", () => {
    const first = synthesize({
      outputs: { "error-handling": skippedOutput() },
      diff: CODE_DIFF,
      changedFiles: ["src/example.ts"],
      reviewId: "lens-cov-relabel",
    });
    expect(first.reviewVerdict.verdict).toBe("revise");

    // The field harm, reproduced: the same analysis resubmitted under a
    // different label. It must not buy the approve.
    const second = synthesize({
      outputs: { "error-handling": okOutput([]) },
      diff: CODE_DIFF,
      changedFiles: ["src/example.ts"],
      reviewId: "lens-cov-relabel",
      reviewRound: 2,
    });
    expect(entry(second, "error-handling").relabeled).toBe(true);
    expect(second.reviewVerdict.capReasons).toEqual([
      "core lens 'error-handling' relabeled",
    ]);
    expect(second.reviewVerdict.verdict).toBe("revise");
  });

  it("an ok that carries real findings is never a relabel", () => {
    synthesize({
      outputs: { "error-handling": skippedOutput() },
      diff: CODE_DIFF,
      changedFiles: ["src/example.ts"],
      reviewId: "lens-cov-realwork",
    });
    const second = synthesize({
      outputs: {
        "error-handling": okOutput([
          {
            id: "conc-1",
            severity: "major",
            category: "race-condition",
            file: "src/example.ts",
            line: 2,
            snippet: { quote: 'console.log("debug");', startLine: 2 },
            description: "unsynchronized write",
            suggestion: "guard it",
            confidence: 0.9,
          },
        ]),
      },
      diff: CODE_DIFF,
      changedFiles: ["src/example.ts"],
      reviewId: "lens-cov-realwork",
      reviewRound: 2,
    });
    expect(entry(second, "error-handling").relabeled).toBeUndefined();
    expect(second.reviewVerdict.capReasons).toEqual([]);
  });

  it("a lens that never skipped is never flagged, however empty its ok", () => {
    const out = synthesize({
      outputs: {},
      diff: CODE_DIFF,
      changedFiles: ["src/example.ts"],
      reviewId: "lens-cov-clean",
    });
    for (const lens of CORE) {
      expect(entry(out, lens).relabeled).toBeUndefined();
    }
    expect(out.reviewVerdict.capReasons).toEqual([]);
  });
});

/**
 * ISS-950 gate round: the basis computation, tested at its own seam.
 *
 * `runMergerPipeline` recomputes a supplied `not-applicable` from the anchoring
 * artifact and demotes what it cannot confirm, which is the right contract and
 * makes the harness's own union reading UNOBSERVABLE at the verdict: whichever
 * way the harness reads the file set, the server's answer is what lands. That
 * is defense in depth, not a gap, but it means the union rule cannot be pinned
 * through `handleSynthesize`. It is pinned here instead, on the exported
 * function, so M-UNION-DECLARED-ONLY has a test of its own.
 */
describe("skipBasisForLens: the union is the declared files AND the diff", () => {
  it("M-UNION-DECLARED-ONLY: a declared docs-only change that DELETES source is applicable", () => {
    // Read from the declaration alone this is four excused core lenses over
    // unreviewed auth code. A deletion names its file on `--- a/path` and
    // `diff --git` and nowhere else.
    expect(
      skipBasisForLens({
        lensId: "error-handling",
        declaredFiles: ["docs/guide.md"],
        artifact: DECLARED_DOCS_DELETES_CODE,
      }),
    ).toBe("self-reported");
    expect(
      skipBasisForLens({
        lensId: "security",
        declaredFiles: ["docs/guide.md"],
        artifact: DECLARED_DOCS_DELETES_CODE,
      }),
    ).toBe("self-reported");
  });

  it("a genuinely docs-only change is not-applicable", () => {
    expect(
      skipBasisForLens({
        lensId: "error-handling",
        declaredFiles: ["docs/guide.md"],
        artifact: DOCS_DIFF,
      }),
    ).toBe("not-applicable");
  });

  it("an absent or empty artifact can never excuse a lens", () => {
    // Nothing there proves the lens had no surface. A PLAN_REVIEW and a review
    // whose retained artifact was lost both land here.
    expect(
      skipBasisForLens({ lensId: "error-handling", declaredFiles: [], artifact: undefined }),
    ).toBe("self-reported");
    expect(
      skipBasisForLens({ lensId: "error-handling", declaredFiles: [], artifact: "" }),
    ).toBe("self-reported");
  });

  it("a recorded self-reported basis pins the answer whatever the diff says", () => {
    expect(
      skipBasisForLens({
        lensId: "error-handling",
        declaredFiles: ["docs/guide.md"],
        artifact: DOCS_DIFF,
        priorBasis: "self-reported",
      }),
    ).toBe("self-reported");
  });
});

describe("ISS-950 gate round: self-reported is sticky across rounds", () => {
  it("M-STICKY-LOST: a no-submission round does not erase an earlier self-reported skip", () => {
    const reviewId = "lens-cov-sticky";

    // Round 1: the lens skips a change the server judges applicable.
    const first = synthesize({
      outputs: { "error-handling": skippedOutput() },
      diff: CODE_DIFF,
      changedFiles: ["src/example.ts"],
      reviewId,
    });
    expect(entry(first, "error-handling").basis).toBe("self-reported");

    // Round 2: the lens does not submit at all. Its entry carries
    // `no-submission`, which must not become the memory's answer -- overwriting
    // here is what let round 3 escape the restriction round 1 established.
    const second = synthesize({
      outputs: {},
      diff: CODE_DIFF,
      changedFiles: ["src/example.ts"],
      reviewId,
      reviewRound: 2,
      omit: ["error-handling"],
    });
    expect(entry(second, "error-handling").basis).toBe("no-submission");

    // Round 3: the same skip, now presented with a docs-only diff. Still
    // self-reported, because round 1 is still on the record.
    const third = synthesize({
      outputs: { "error-handling": skippedOutput() },
      diff: DOCS_DIFF,
      changedFiles: ["docs/guide.md"],
      reviewId,
      reviewRound: 3,
    });
    expect(entry(third, "error-handling").basis).toBe("self-reported");
    expect(third.reviewVerdict.verdict).toBe("revise");
  });
});
