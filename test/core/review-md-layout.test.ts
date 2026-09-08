/**
 * T-487: a review contract must keep every declared principle inside the lens
 * window, COMPLETE.
 *
 * `context-packager.ts` hands REVIEW.md to a lens HEAD-TRUNCATED at
 * `REVIEW_BUDGET`. A principle past that offset is one a lens reviewer is asked
 * to name while never being shown it, and nothing about that failure is
 * visible: the file parses, the contract is active, the review runs, and the
 * finding just never names a principle. That is the absence-reading-as-a-zero
 * shape this ticket exists to close.
 *
 * Three things this deliberately does NOT do, each because it would let the
 * gate pass while the defect was present:
 *
 * 1. It does not check the heading offset alone. A `## Quality` heading landing
 *    at budget minus one satisfies "the heading is inside" while the definition
 *    and the `Blocking:` line it governs are cut off. The unit that has to fit
 *    is the section THROUGH its declaration, so that is what is measured.
 * 2. It does not hardcode 3000. A copied constant keeps passing after someone
 *    changes the real one, which is this same defect wearing a test's clothes.
 * 3. It does not measure the FIRST of a repeated heading. `projectDecision`
 *    keys principles into a Map by name, so a second `## Quality` section
 *    overwrites the first: the class the evaluator uses would come from a
 *    section a reviewer may never have received, while a first-match
 *    measurement reported the early, innocent copy.
 *
 * The declaration search is also BOUNDED to its own section, so a section with
 * no declaration cannot borrow the next one's. That bound is defence in depth
 * and is currently unreachable through the parser, which drops a principle
 * whose declaration is missing rather than letting it inherit; the test at the
 * bottom pins that parser behaviour rather than pretending to exercise the
 * bound.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadReviewContract } from "../../src/autonomous/review-contract.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workspaceRoot = resolve(pkgRoot, "..");
const templatePath = join(pkgRoot, "src", "skill", "review-contract-template.md");

/**
 * `storybloq/` is projected to a public repository on its own, without the
 * workspace around it, so the workspace REVIEW.md is legitimately absent there.
 * Absent WITH the workspace around it is not legitimate, and the two are told
 * apart by the ledger rather than by the missing file itself -- otherwise
 * deleting REVIEW.md would silently turn this gate off. The shipped template
 * lives inside this package, so it carries no such condition.
 */
const inWorkspace = existsSync(join(workspaceRoot, ".story"));

/** The declaration line the contract grammar reads, as it appears in a file. */
function declarationRegex(): RegExp {
  return /^Blocking:\s*\S+[^\n]*$/gm;
}

/** Any section heading, used to stop one principle's search entering the next. */
function anyHeadingRegex(): RegExp {
  return /^## .*$/gm;
}

function headingOccurrences(raw: string, name: string): number[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^## ${escaped}[ \\t]*$`, "gm");
  const found: number[] = [];
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    found.push(m.index);
  }
  return found;
}

function reviewBudget(): number {
  const source = readFileSync(
    join(pkgRoot, "src", "autonomous", "lens-harness", "context-packager.ts"),
    "utf-8",
  );
  const m = /^const REVIEW_BUDGET = (\d+);$/m.exec(source);
  if (m === null) {
    throw new Error(
      "REVIEW_BUDGET was not found in context-packager.ts. It was renamed or reshaped; " +
        "update this test to read the new form rather than letting the gate lapse.",
    );
  }
  return Number(m[1]);
}

/**
 * `loadReviewContract` is addressed by project root and always reads
 * `REVIEW.md`, so the shipped template -- which is not named that and does not
 * sit at a project root -- is staged into a throwaway root and parsed by the
 * same code path a real contract goes through. Parsing it by a second, private
 * route would prove only that it fits a grammar nothing uses.
 */
function stageAsContract(text: string): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "storybloq-contract-"));
  writeFileSync(join(root, "REVIEW.md"), text, "utf-8");
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

interface Analysis {
  readonly ends: { name: string; end: number }[];
  readonly missing: string[];
  readonly duplicates: string[];
  readonly principles: number;
  readonly status: string;
  readonly invalid: readonly unknown[];
}

function analyze(raw: string, contractRoot: string): Analysis {
  const contract = loadReviewContract(contractRoot);
  const ends: { name: string; end: number }[] = [];
  const missing: string[] = [];
  const duplicates: string[] = [];

  for (const p of contract.principles) {
    const heading = `## ${p.name}`;
    const occurrences = headingOccurrences(raw, p.name);
    if (occurrences.length === 0) {
      missing.push(`${heading} (heading absent)`);
      continue;
    }
    if (occurrences.length > 1) {
      duplicates.push(`${heading} x${occurrences.length} @ ${occurrences.join(", ")}`);
      continue;
    }

    const start = occurrences[0]!;
    const nextHeading = anyHeadingRegex();
    nextHeading.lastIndex = start + heading.length;
    const next = nextHeading.exec(raw);
    const limit = next === null ? raw.length : next.index;

    const declaration = declarationRegex();
    declaration.lastIndex = start;
    const decl = declaration.exec(raw);
    if (decl === null || decl.index >= limit) {
      missing.push(`${heading} (no Blocking: declaration inside its own section)`);
      continue;
    }
    ends.push({ name: heading, end: decl.index + decl[0].length });
  }

  return {
    ends,
    missing,
    duplicates,
    principles: contract.principles.length,
    status: contract.status,
    invalid: contract.invalid,
  };
}

function analyzed(raw: string): Analysis {
  const staged = stageAsContract(raw);
  try {
    return analyze(raw, staged.root);
  } finally {
    staged.dispose();
  }
}

function assertFits(sourcePath: string, budget: number): void {
  const raw = readFileSync(sourcePath, "utf-8");
  const filename = sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
  const { ends, missing, duplicates, principles, status, invalid } = analyzed(raw);

  // Guards every assertion below against passing over a contract the evaluator
  // would refuse, an empty one, or a principle whose section is not locatable.
  //
  // Status and invalid are checked HERE rather than beside them, because a
  // single bad declaration anywhere makes the whole file `unparseable` while
  // leaving the six good principles in place -- measured: appending a section
  // declaring `Blocking: nit` yields status "unparseable" with all six still
  // returned. Counting principles alone passes over exactly that file.
  expect(status, `${filename} does not parse as an active contract`).toBe("active");
  expect(invalid, `${filename} carries invalid declarations: ${JSON.stringify(invalid)}`).toEqual([]);
  expect(principles, `${filename} declares no principles`).toBeGreaterThanOrEqual(6);
  expect(missing, `${filename}: sections not locatable: ${missing.join(", ")}`).toEqual([]);
  expect(
    duplicates,
    `${filename}: duplicate principle sections; the evaluator would use the LAST one, which is ` +
      `not the one measured here: ${duplicates.join("; ")}`,
  ).toEqual([]);
  expect(ends.length).toBe(principles);

  const cut = ends.filter((e) => e.end > budget).map((e) => `${e.name} ends @ ${e.end}`);
  expect(
    cut,
    `${filename}: these principles are cut by the ${budget}-character lens window, so a lens is ` +
      `asked to name a principle it does not fully receive: ${cut.join("; ")}`,
  ).toEqual([]);
}

describe("a review contract fits the lens window, complete (T-487)", () => {
  it("reads the real budget out of the packager rather than assuming one", () => {
    expect(reviewBudget()).toBeGreaterThan(0);
  });

  it("the shipped template's principles all fit, through their declarations", () => {
    assertFits(templatePath, reviewBudget());
  });

  it.runIf(inWorkspace)("this repository's principles all fit, through their declarations", () => {
    assertFits(join(workspaceRoot, "REVIEW.md"), reviewBudget());
  });
});

/**
 * The false-pass shapes the assertions above exist to refuse. Both are built
 * from the shipped template, so what they exercise is the real grammar.
 */
describe("the shapes a first-match measurement would have passed (T-487)", () => {
  const template = (): string => readFileSync(templatePath, "utf-8");

  it("refuses a duplicate principle section instead of measuring the first one", () => {
    const doubled =
      `${template()}\n\n${"z".repeat(4000)}\n\n## Quality\n\nA second, later Quality section.\n\nBlocking: blocking\n`;

    expect(analyzed(template()).duplicates).toEqual([]);

    // The parser emits BOTH sections as principles -- measured, not assumed:
    // ["... Quality:major", "Quality:blocking"] -- and `projectDecision` keys
    // them into a Map by name, so the class it uses comes from the late
    // section, 4000-odd characters past anything a lens receives.
    const staged = stageAsContract(doubled);
    try {
      const parsed = loadReviewContract(staged.root);
      const quality = parsed.principles.filter((x) => x.name === "Quality");
      expect(quality.length).toBe(2);
      expect(quality.map((x) => x.blockingClass)).toEqual(["major", "blocking"]);
      expect(new Map(parsed.principles.map((x) => [x.name, x])).get("Quality")?.blockingClass)
        .toBe("blocking");
    } finally {
      staged.dispose();
    }

    const dirty = analyzed(doubled);
    // One entry per parsed Quality principle, both naming the same two offsets.
    expect(dirty.duplicates.length).toBeGreaterThanOrEqual(1);
    expect(dirty.duplicates.every((d) => d.includes("## Quality x2"))).toBe(true);
    // The early copy fits the budget, so a first-match measurement would have
    // called this document clean while the evaluator used the late section.
    expect(dirty.ends.some((e) => e.name === "## Quality")).toBe(false);
  });

  it("refuses a file the evaluator would not use, even with all six principles intact", () => {
    // One bad declaration anywhere makes the WHOLE file unparseable while the
    // six good principles are still returned, so a principle count alone reads
    // this file as healthy. Measured, not assumed.
    const withNit = `${template()}\n\n## Housekeeping\n\nA section with a class the grammar does not know.\n\nBlocking: nit\n`;

    const parts = analyzed(withNit);
    expect(parts.principles).toBe(6);
    expect(parts.ends.length).toBe(6);
    expect(parts.missing).toEqual([]);
    expect(parts.duplicates).toEqual([]);
    // Everything a count-and-offset check looks at is clean. These are not:
    expect(parts.status).toBe("unparseable");
    expect(parts.invalid).toEqual([
      { section: "Housekeeping", reason: "unrecognised-class", word: "nit" },
    ]);
  });

  it("a section with no declaration is not a principle at all, which is why the bound cannot fire", () => {
    // The `limit` bound in analyze() stops one principle's declaration search
    // entering the next section. It is defence in depth and it is currently
    // UNREACHABLE through the parser, for the reason pinned here: strip a
    // section's declaration and the parser drops the principle entirely rather
    // than letting it inherit the next one. Saying so is the point -- an
    // unreachable guard with no note reads as dead code to the next editor,
    // and a test claiming to exercise it would be asserting a scenario that
    // cannot occur.
    const stripped = template().replace(/^Blocking: major$/m, "(declaration removed)");
    expect(stripped).not.toBe(template());

    const staged = stageAsContract(stripped);
    try {
      const parsed = loadReviewContract(staged.root);
      expect(parsed.principles.map((x) => x.name)).not.toContain("Coherence");
      expect(parsed.principles.length).toBe(5);
      // And nothing reports it as invalid, so the drop is silent.
      expect(parsed.invalid).toEqual([]);
    } finally {
      staged.dispose();
    }

    // analyze() therefore never sees Coherence, and reports no missing section.
    expect(analyzed(stripped).missing).toEqual([]);
  });
});
