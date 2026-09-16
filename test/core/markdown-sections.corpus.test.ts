import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseHandoverMarkdown,
  selectBoundedRecords,
  type SectionRecord,
} from "../../src/core/markdown-sections.js";

// Acceptance-oracle corpus, per the T-320 plan, split into two tiers (pen
// ruling, T-320 commit 1 follow-up):
//
// - PUBLIC acceptance (always runs, including in the projected public
//   repo): the LobbyKit and ORACLE fixtures from ISS-1154, checked in under
//   test/core/fixtures/, plus the synthetic cases in
//   markdown-sections.test.ts.
// - PRIVATE workspace oracle (below, this repo's real last ten handovers as
//   of 2026-09-10, pinned by exact filename -- a frozen point-in-time
//   oracle, not "whatever is newest" at test-run time): these read directly
//   from `.story/handovers/`, which is workspace-internal session
//   narrative and is deliberately NOT copied into fixtures or projected to
//   the public repo. The describe block is skipped when that directory is
//   absent (e.g. in the public `storybloq/` projection), so this tier is a
//   workspace-only bonus check, never a hard requirement for the public
//   build.
//
// Every expectation below was derived BY READING the raw markdown and
// applying the grammar directly, before ever running the parser against it
// -- not by running the code and copying its output. Byte-truncation
// MECHANICS (exact truncated-string content) are already covered by the
// synthetic unit tests in markdown-sections.test.ts; this file focuses on
// the two things only real content can surface: whether the STRUCTURE
// (which headings classify, which bullets get picked up, what id/kind each
// carries) matches a human reading of the source, and whether the
// byte-budget invariants (envelope <= 1,600 bytes, every candidate
// accounted for as either selected or counted in the index) hold in
// practice.

const __dirname = dirname(fileURLToPath(import.meta.url));
const HANDOVERS_DIR = join(__dirname, "../../../.story/handovers");
const FIXTURES_DIR = join(__dirname, "fixtures");

function readHandover(filename: string): string {
  return readFileSync(join(HANDOVERS_DIR, filename), "utf-8");
}

function readFixture(filename: string): string {
  return readFileSync(join(FIXTURES_DIR, filename), "utf-8");
}

// A candidate's id, disposition, kind, and file are never altered by
// selectBoundedRecords' shrinking -- only label and rationale can be
// truncated (rationale can also be dropped to the literal string
// "unknown"). This checks that `selected` could actually have come FROM
// `candidate`: the unchanged fields match exactly, and each of label and
// rationale is either byte-identical or a valid truncated-with-"..."
// prefix of the candidate's version (Codex review finding: test-coverage,
// round 3 -- an (id, disposition, kind, file) TUPLE-COUNT check is blind
// to two distinct candidates that share every one of those fields, e.g.
// two id-less continuation items in the same file: returning one of them
// twice while dropping the other preserves every tuple count).
function derivesFrom(selected: SectionRecord, candidate: SectionRecord): boolean {
  if (selected.id !== candidate.id) return false;
  if (selected.disposition !== candidate.disposition) return false;
  if (selected.kind !== candidate.kind) return false;
  if (selected.file !== candidate.file) return false;

  const rationaleOk =
    selected.rationale === candidate.rationale ||
    selected.rationale === "unknown" ||
    (selected.rationale.endsWith("...") &&
      candidate.rationale.startsWith(selected.rationale.slice(0, -3)));
  if (!rationaleOk) return false;

  return (
    selected.label === candidate.label ||
    (selected.label.endsWith("...") &&
      candidate.label.startsWith(selected.label.slice(0, -3)))
  );
}

// Every SELECTED record must derive from a distinct, not-yet-claimed
// candidate (greedy one-to-one match) -- a selector that returns one
// candidate twice while silently dropping another one that could
// otherwise have derived the same selected record is rejected here, even
// when the two share every id/disposition/kind/file field. Every candidate
// the parser extracted is either claimed this way or counted in the
// omission index, and the index itself competes for one of the 12 record
// slots when present (Codex review finding: test-coverage -- the prior
// version only checked records.length and aggregate bytes, which cannot
// catch a selector that returns 12 records AND a non-null index).
function assertBudgetInvariants(candidates: SectionRecord[], file: string) {
  const { records, index } = selectBoundedRecords(candidates, file);
  const envelopeBytes = Buffer.byteLength(
    JSON.stringify({ records, index }),
    "utf-8",
  );
  expect(envelopeBytes).toBeLessThanOrEqual(1600);
  expect(records.length + (index ? 1 : 0)).toBeLessThanOrEqual(12);
  const selectedCount = records.length;
  const omittedCount = index?.omittedCount ?? 0;
  expect(selectedCount + omittedCount).toBe(candidates.length);

  const claimed = new Array<boolean>(candidates.length).fill(false);
  for (const r of records) {
    const idx = candidates.findIndex((c, i) => !claimed[i] && derivesFrom(r, c));
    expect(idx).toBeGreaterThanOrEqual(0);
    if (idx >= 0) claimed[idx] = true;
  }

  return { records, index };
}

describe("acceptance-oracle corpus: ISS-1154 field-shape fixtures", () => {
  it("ORACLE (broker): extracts both continuation items the field report said priming buried", () => {
    const md = readFixture("oracle-handover.md");
    const parsed = parseHandoverMarkdown(md, "oracle-handover.md");

    expect(parsed.unclassifiedFallback).toBe(false);
    expect(parsed.records).toHaveLength(2);

    expect(parsed.records[0]).toMatchObject({
      id: "ISS-439",
      label: "W2 experiment armed, first prediction outcomes due 2026-09-03.",
      disposition: "continuation",
      rationale: "unknown",
      kind: "item",
    });
    expect(parsed.records[1]).toMatchObject({
      id: "T-344",
      label: "coverage check outstanding before the experiment window closes.",
      disposition: "continuation",
      rationale: "unknown",
      kind: "item",
    });

    assertBudgetInvariants(parsed.records, "oracle-handover.md");
  });

  it("LobbyKit: extracts the T-159 U10a continuation the field report said the ranking table buried", () => {
    const md = readFixture("lobbykit-handover.md");
    const parsed = parseHandoverMarkdown(md, "lobbykit-handover.md");

    expect(parsed.unclassifiedFallback).toBe(false);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({
      id: "T-159",
      label: "continue U10a, the current unit of work.",
      disposition: "continuation",
      rationale: "unknown",
      kind: "item",
    });

    assertBudgetInvariants(parsed.records, "lobbykit-handover.md");
  });
});

// ISS-1204: the ten filenames below are pinned, point-in-time evidence --
// worker handovers that (as of this writing) have never been committed. The
// directory itself (`.story/handovers/`) is tracked and exists in every
// worktree, so checking only for its existence let this describe block run
// in a fresh worktree or clone and fail on ENOENT for whichever pinned files
// were never committed there, instead of skipping. Skip on ANY pinned file
// being absent, not just all of them: a partial corpus is not the frozen
// oracle this tier claims to run.
const PINNED_HANDOVER_FILENAMES = [
  "2026-09-10-084104-f16aec6c-cpm-89-t500-round21-approve-r12-dry-run.md",
  "2026-09-10-082124-0ddd4ddb-cpm-89-t500-round19-archive-publication.md",
  "2026-09-10-080339-07e76426-cpm-89-t500-subscription-auth-round17-request-changes.md",
  "2026-09-10-075954-6761f0ca-session.md",
  "2026-09-10-075335-7d08377a-session.md",
  "2026-09-10-074541-7e435477-session.md",
  "2026-09-10-072059-6d948ec0-t320-full-spec-read-exploring-codebase-next.md",
  "2026-09-10-072022-fbf748c9-t320-dispatched-reading-spec.md",
  "2026-09-10-072005-bbca959e-cpm-89-t500-ready-for-smoke-manifest-r10.md",
  "2026-09-10-071943-ace29e70-cpm-d1-handover-9-legc-closed-t320-dispatched.md",
] as const;

const missingPinnedHandovers = existsSync(HANDOVERS_DIR)
  ? PINNED_HANDOVER_FILENAMES.filter((f) => !existsSync(join(HANDOVERS_DIR, f)))
  : PINNED_HANDOVER_FILENAMES;

describe.skipIf(missingPinnedHandovers.length > 0)(
  "acceptance-oracle corpus: this repo's real last ten handovers (pinned 2026-09-10) -- private corpus: runs only in the workspace checkout",
  () => {
  // Five of the ten real handovers below have a "## Next" (or equivalent
  // classifying) heading whose body uses a NUMBERED list ("1.", "2.", ...);
  // the bullet grammar now recognizes `\d{1,3}[.)]` markers (pen ruling,
  // T-320 commit 1 follow-up: six-of-ten zero-record handovers is a real
  // corpus gap, fix in commit 1, not later), so these extract real records
  // below instead of zero. Two further handovers (T-320 v6, v4) have
  // genuinely prose "## Next step" bodies with no list markup of any kind
  // (dash or numbered) and correctly remain zero-record under the extended
  // grammar too -- verified by direct inspection, not just re-running the
  // parser. The T-320 v7 handover's seven dash sub-items, previously read
  // as seven independent top-level bullets (the numbered top-level items
  // that contained them weren't recognized as markers at all), are now
  // nested CONTENT of their five real numbered-item bullets instead --
  // updated below to match.

  it("round21-approve-r12-dry-run: '## Next' classifies, numbered list now yields four records", () => {
    const filename =
      "2026-09-10-084104-f16aec6c-cpm-89-t500-round21-approve-r12-dry-run.md";
    const md = readHandover(filename);
    const parsed = parseHandoverMarkdown(md, filename);
    expect(parsed.unclassifiedFallback).toBe(false);
    expect(parsed.records).toHaveLength(4);
    for (const record of parsed.records) {
      expect(record.disposition).toBe("continuation");
      expect(record.id).toBeNull();
      expect(record.kind).toBe("item");
    }
    expect(parsed.records[0]?.label).toBe(
      "Fixture fix for the minor, suite green, commit (`git add",
    );
    expect(parsed.records[0]?.rationale).toBe(
      "storybloq/bench/terminal-bench` then plain commit, no trailer, no push), append the round record to `.story/tickets/t-2x50maxy9eb089n8.json` and commit.",
    );
    expect(parsed.records[1]?.label).toBe("If the r12 dry runs pass");
    // Long remainder, no early sentence-end match within it -- truncated.
    expect(parsed.records[1]?.rationale.endsWith("...")).toBe(true);
    expect(
      Buffer.byteLength(parsed.records[1]?.rationale ?? "", "utf-8"),
    ).toBeLessThanOrEqual(240);
    expect(parsed.records[2]?.label).toBe("Tell cpm-d1 the launch shape");
    // A lone "." from a shell `. /path` source command, followed by a
    // space, matches the simple "[.!?] " sentence-end heuristic -- a real,
    // documented quirk of that heuristic, not a bug.
    expect(parsed.records[2]?.rationale).toBe("`set -a; .");
    expect(parsed.records[3]?.label).toBe(
      "Smoke on the .env signal; `build_report.py",
    );
    expect(parsed.records[3]?.rationale).toBe("smoke`; go/no-go.");

    assertBudgetInvariants(parsed.records, filename);
  });

  it("round19-archive-publication: '## Next' classifies, numbered list now yields three records", () => {
    const filename =
      "2026-09-10-082124-0ddd4ddb-cpm-89-t500-round19-archive-publication.md";
    const md = readHandover(filename);
    const parsed = parseHandoverMarkdown(md, filename);
    expect(parsed.unclassifiedFallback).toBe(false);
    expect(parsed.records).toHaveLength(3);
    for (const record of parsed.records) {
      expect(record.disposition).toBe("continuation");
      expect(record.id).toBeNull();
    }
    expect(parsed.records[0]?.label).toBe("Fix");
    // The remainder contains "instead" ("fails on EXDEV instead of
    // copying"), a genuine cue-token match on an id-less bullet.
    expect(parsed.records[0]?.kind).toBe("decision");
    expect(parsed.records[0]?.rationale.endsWith("...")).toBe(true);
    expect(
      Buffer.byteLength(parsed.records[0]?.rationale ?? "", "utf-8"),
    ).toBeLessThanOrEqual(240);
    // No ":" or "--" within the first 120 bytes -- label truncated, no
    // remainder, rationale falls through to "unknown".
    expect(parsed.records[1]?.kind).toBe("item");
    expect(parsed.records[1]?.label.endsWith("...")).toBe(true);
    expect(
      Buffer.byteLength(parsed.records[1]?.label ?? "", "utf-8"),
    ).toBeLessThanOrEqual(120);
    expect(parsed.records[1]?.rationale).toBe("unknown");
    expect(parsed.records[2]?.kind).toBe("item");
    expect(parsed.records[2]?.label).toBe(
      "Real smoke when cpm-d1 signals the .env; report with `",
    );
    expect(parsed.records[2]?.rationale).toBe("smoke`; go/no-go.");

    assertBudgetInvariants(parsed.records, filename);
  });

  it("subscription-auth-round17-request-changes: no classifying heading, falls back to unclassified with a decision cue ('owner')", () => {
    const filename =
      "2026-09-10-080339-07e76426-cpm-89-t500-subscription-auth-round17-request-changes.md";
    const md = readHandover(filename);
    const parsed = parseHandoverMarkdown(md, filename);

    expect(parsed.unclassifiedFallback).toBe(true);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({
      id: null,
      label: "Owner of this thread",
      disposition: "unclassified",
      rationale: "cpm-89 (Fable pen).",
      // The bullet's text contains "owner" as a substring ("owner is
      // preparing ..."), which the cue-token grammar matches regardless of
      // sense -- a known, spec-accepted false-positive shape for the
      // substring-based cue check, not a bug this corpus pass should fix.
      kind: "decision",
    });

    assertBudgetInvariants(parsed.records, filename);
  });

  it("T-320 v7 handover: '## Next step (mechanical...)' classifies via the '(' delimiter; five numbered top-level items, the first with seven dash sub-items as nested content", () => {
    const filename = "2026-09-10-075954-6761f0ca-session.md";
    const md = readHandover(filename);
    const parsed = parseHandoverMarkdown(md, filename);

    expect(parsed.unclassifiedFallback).toBe(false);
    // Under the dash-only grammar, the five numbered top-level items
    // weren't recognized as markers at all, so the seven dash sub-items
    // indented under item 1 were read as seven independent top-level
    // bullets. Now that numbered markers are recognized, item 1 itself is
    // the bullet and those seven dash lines are its NESTED content (only
    // the first feeds the rationale fallback) -- five records, not seven.
    expect(parsed.records).toHaveLength(5);
    for (const record of parsed.records) {
      expect(record.disposition).toBe("continuation");
      expect(record.id).toBeNull();
    }

    // Item 5 ("If revise: ... do not attempt a 7th solo round.") contains
    // the cue token "do not" -- a genuine match, not a false positive.
    const kinds = parsed.records.map((r) => r.kind);
    expect(kinds).toEqual(["item", "item", "item", "item", "decision"]);

    expect(parsed.records[0]?.label).toBe("Edit plan.md to v7");
    // No remainder after the label's ":" (nothing follows on item 1's own
    // line) -- rationale falls through to the first nested dash line's
    // trimmed text, INCLUDING its own "- " marker (computeRationale trims
    // whitespace only, not list markers), then truncates at 240 bytes.
    expect(parsed.records[0]?.rationale.startsWith("- Commit 1:")).toBe(true);
    expect(parsed.records[0]?.rationale.endsWith("...")).toBe(true);
    expect(
      Buffer.byteLength(parsed.records[0]?.rationale ?? "", "utf-8"),
    ).toBeLessThanOrEqual(240);

    expect(parsed.records[1]?.label).toBe(
      "Read full plan.md once to sanity-check arithmetic and internal consistency (established practice every round).",
    );
    expect(parsed.records[1]?.rationale).toBe("unknown");

    expect(parsed.records[2]?.label).toBe(
      "Submit to Codex `mcp__codex-bridge__review_plan` round 6, same session id `01a08a37-4fc3-7da0-8669-69f57fe9a4f4`, `cwd",
    );
    expect(parsed.records[2]?.rationale).toBe(
      "/Users/amirshayegh/Developer/CPM`.",
    );

    expect(parsed.records[3]?.label).toBe("If approve");
    expect(parsed.records[3]?.rationale).toBe(
      "start commit 1 (TDD, `src/core/markdown-sections.ts`) immediately, no further pen wait, per delegated authority stated across every round so far.",
    );

    expect(parsed.records[4]?.label).toBe("If revise");
    expect(parsed.records[4]?.rationale).toBe(
      "send findings to pen via SendMessage to `cpm-d1`, do not attempt a 7th solo round.",
    );

    assertBudgetInvariants(parsed.records, filename);
  });

  it("T-320 v6 handover: '## Next step' classifies, genuinely prose body (no list markup at all) still yields zero records", () => {
    const filename = "2026-09-10-075335-7d08377a-session.md";
    const md = readHandover(filename);
    const parsed = parseHandoverMarkdown(md, filename);
    expect(parsed.unclassifiedFallback).toBe(false);
    expect(parsed.records).toHaveLength(0);
  });

  it("T-320 v4 handover: '## Open questions...' correctly rejected (two content words), '## Next step' classifies with genuinely prose body, zero records", () => {
    const filename = "2026-09-10-074541-7e435477-session.md";
    const md = readHandover(filename);
    const parsed = parseHandoverMarkdown(md, filename);
    expect(parsed.unclassifiedFallback).toBe(false);
    expect(parsed.records).toHaveLength(0);
  });

  it("T-320 full-spec-read handover: '## Next step (not yet started)' classifies via '(' delimiter, numbered list now yields four records", () => {
    const filename =
      "2026-09-10-072059-6d948ec0-t320-full-spec-read-exploring-codebase-next.md";
    const md = readHandover(filename);
    const parsed = parseHandoverMarkdown(md, filename);
    expect(parsed.unclassifiedFallback).toBe(false);
    expect(parsed.records).toHaveLength(4);
    for (const record of parsed.records) {
      expect(record.disposition).toBe("continuation");
      expect(record.kind).toBe("item");
    }
    expect(parsed.records[0]?.id).toBe("T-497");
    expect(parsed.records[0]?.label).toBe(
      "harness BASELINE now (before touching anything)",
    );
    expect(parsed.records[0]?.rationale.endsWith("...")).toBe(true);
    expect(
      Buffer.byteLength(parsed.records[0]?.rationale ?? "", "utf-8"),
    ).toBeLessThanOrEqual(240);

    expect(parsed.records[1]?.id).toBe("ISS-1179");
    expect(parsed.records[1]?.label.endsWith("...")).toBe(true);
    expect(
      Buffer.byteLength(parsed.records[1]?.label ?? "", "utf-8"),
    ).toBeLessThanOrEqual(120);
    expect(parsed.records[1]?.rationale).toBe("unknown");

    expect(parsed.records[2]?.id).toBeNull();
    expect(parsed.records[2]?.label.endsWith("...")).toBe(true);
    expect(parsed.records[2]?.rationale).toBe("unknown");

    expect(parsed.records[3]?.id).toBeNull();
    expect(parsed.records[3]?.label.endsWith("...")).toBe(true);
    expect(parsed.records[3]?.rationale).toBe("unknown");

    assertBudgetInvariants(parsed.records, filename);
  });

  it("T-320 dispatched handover: '## Next step' classifies, numbered list now yields five records", () => {
    const filename = "2026-09-10-072022-fbf748c9-t320-dispatched-reading-spec.md";
    const md = readHandover(filename);
    const parsed = parseHandoverMarkdown(md, filename);
    expect(parsed.unclassifiedFallback).toBe(false);
    expect(parsed.records).toHaveLength(5);
    for (const record of parsed.records) {
      expect(record.disposition).toBe("continuation");
      expect(record.kind).toBe("item");
    }
    expect(parsed.records[0]?.id).toBe("ISS-1179");
    expect(parsed.records[0]?.label).toBe(
      "(`storybloq issue get ISS-1179`) for umbrella context.",
    );
    expect(parsed.records[0]?.rationale).toBe("unknown");

    expect(parsed.records[1]?.id).toBeNull();
    expect(parsed.records[1]?.label.endsWith("...")).toBe(true);
    expect(parsed.records[1]?.rationale).toBe("unknown");

    expect(parsed.records[2]?.id).toBeNull();
    expect(parsed.records[2]?.label.endsWith("...")).toBe(true);
    expect(parsed.records[2]?.rationale).toBe("unknown");

    expect(parsed.records[3]?.id).toBeNull();
    expect(parsed.records[3]?.label.endsWith("...")).toBe(true);
    expect(parsed.records[3]?.rationale).toBe("unknown");

    expect(parsed.records[4]?.id).toBe("T-497");
    expect(parsed.records[4]?.label).toBe(
      "BEFORE any edit and include those numbers in the plan sent to the pen.",
    );
    expect(parsed.records[4]?.rationale).toBe("unknown");

    assertBudgetInvariants(parsed.records, filename);
  });

  it("T-500 ready-for-smoke handover: '## Next, in order (...)' classifies via ',' delimiter, numbered list now yields four records", () => {
    const filename =
      "2026-09-10-072005-bbca959e-cpm-89-t500-ready-for-smoke-manifest-r10.md";
    const md = readHandover(filename);
    const parsed = parseHandoverMarkdown(md, filename);
    expect(parsed.unclassifiedFallback).toBe(false);
    expect(parsed.records).toHaveLength(4);
    for (const record of parsed.records) {
      expect(record.disposition).toBe("continuation");
    }

    // Contains "never" ("never print the values"), a genuine cue-token
    // match on an id-less bullet.
    expect(parsed.records[0]?.id).toBeNull();
    expect(parsed.records[0]?.kind).toBe("decision");
    expect(parsed.records[0]?.label).toBe("In the launch shell only");
    // Same shell-dot-command quirk as round21's item 2 above.
    expect(parsed.records[0]?.rationale).toBe("`set -a; .");

    expect(parsed.records[1]?.id).toBeNull();
    expect(parsed.records[1]?.kind).toBe("item");
    expect(parsed.records[1]?.label).toBe(
      "Smoke on `tasks-smoke` (regex-log) with `",
    );
    expect(parsed.records[1]?.rationale.endsWith("...")).toBe(true);
    expect(
      Buffer.byteLength(parsed.records[1]?.rationale ?? "", "utf-8"),
    ).toBeLessThanOrEqual(240);

    expect(parsed.records[2]?.id).toBeNull();
    expect(parsed.records[2]?.kind).toBe("item");
    expect(parsed.records[2]?.label).toBe("`report/build_report.py");
    expect(parsed.records[2]?.rationale).toBe("smoke --job A0=...");

    // The id ("T-500") sits right before the line's trailing period, so
    // after the id is stripped only that period remains; the leading-
    // punctuation strip in computeLabelSource consumes it, leaving an
    // empty label -- a real, structurally valid edge case.
    expect(parsed.records[3]?.id).toBe("T-500");
    expect(parsed.records[3]?.kind).toBe("item");
    expect(parsed.records[3]?.label).toBe("");
    expect(parsed.records[3]?.rationale).toBe("unknown");

    assertBudgetInvariants(parsed.records, filename);
  });

  it("cpm-d1 handover 9: no H2 sections at all (H1 only, does not classify), falls back to unclassified", () => {
    const filename =
      "2026-09-10-071943-ace29e70-cpm-d1-handover-9-legc-closed-t320-dispatched.md";
    const md = readHandover(filename);
    const parsed = parseHandoverMarkdown(md, filename);

    expect(parsed.unclassifiedFallback).toBe(true);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({
      id: null,
      label: "Delta from handover 8 (2026-09-10-071145-43f9e719).",
      disposition: "unclassified",
      rationale: "unknown",
      kind: "item",
    });

    assertBudgetInvariants(parsed.records, filename);
  });
});

// A skipped `describe` can render as collapsed or absent depending on
// reporter verbosity, which would leave "this gate silently did not run"
// invisible. This standalone skipped `it` always renders as its own line
// (ISS-1204 acceptance: "a visible skip... with a one-line disclosure naming
// how many pinned files are missing"), independent of how the describe
// block above is displayed.
if (missingPinnedHandovers.length > 0) {
  it.skip(
    `SKIPPED: acceptance-oracle corpus not run -- ${missingPinnedHandovers.length}/${PINNED_HANDOVER_FILENAMES.length} pinned handover files are absent from .story/handovers/ (private workspace-only oracle)`,
    () => {},
  );
}
