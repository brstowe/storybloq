import { describe, it, expect } from "vitest";
import {
  classifyHeading,
  splitFenceAwareSections,
  parseHandoverMarkdown,
  selectBoundedRecords,
  selectContinuationCandidates,
  buildTrajectory,
  type SectionRecord,
} from "../../src/core/markdown-sections.js";

describe("classifyHeading", () => {
  const positive: Array<[string, string]> = [
    ["Next step", "continuation"],
    ["Next, in order", "continuation"],
    ["Open loops, ranked", "continuation"],
    ["Next for whoever resumes", "continuation"],
    ["Remaining before T-400 unblocks", "continuation"],
    ["Queue architecture", "continuation"],
    ["Next step--for review", "continuation"],
    ["Blocked", "blocked"],
    ["Owner-open", "owner-gated"],
    ["Owner rulings", "owner-gated"],
    ["Decisions pending", "owner-gated"],
    ["Shipped", "shipped"],
    ["Done", "shipped"],
    ["Completed", "shipped"],
    ["Landed", "shipped"],
    ["Carried forward", "carried"],
    ["Todo", "continuation"],
    ["Open", "continuation"],
    ["Worker state", "continuation"],
    ["Exact next step", "continuation"],
    ["Next step: implementation details", "continuation"],
  ];

  for (const [heading, expected] of positive) {
    it(`classifies "${heading}" as ${expected}`, () => {
      expect(classifyHeading(heading)).toBe(expected);
    });
  }

  const negative: string[] = [
    "Open source licensing",
    "Next.js migration",
    "Reopened",
    "Unblocked",
    "Blocked out early today",
    "Next !!!",
  ];

  for (const heading of negative) {
    it(`does not classify "${heading}"`, () => {
      expect(classifyHeading(heading)).toBeNull();
    });
  }

  it("rejects a hyphenated word absorbing the -- delimiter", () => {
    // "step--for" must not be read as one hyphen-joined word that would
    // count as a second content word after "next".
    expect(classifyHeading("Next step--for extra words here")).toBe(
      "continuation",
    );
  });

  it("classifies case-insensitively and with NFKC normalization", () => {
    expect(classifyHeading("NEXT STEP")).toBe("continuation");
    expect(classifyHeading("Ｎｅｘｔ")).toBe("continuation"); // fullwidth "Next"
  });
});

describe("splitFenceAwareSections", () => {
  it("does not treat a heading-like line inside a fence as a boundary", () => {
    const md = [
      "# Title",
      "",
      "## Next",
      "",
      "- T-1: do the thing",
      "",
      "```",
      "## Not a real heading",
      "```",
      "",
      "- T-2: another thing",
    ].join("\n");

    const sections = splitFenceAwareSections(md);
    const headings = sections.map((s) => s.heading);
    expect(headings).toContain("Next");
    expect(headings).not.toContain("Not a real heading");
  });

  it("assigns bullets to the nearest enclosing heading only, no inheritance", () => {
    const md = [
      "# Title",
      "",
      "## Next",
      "- T-1: item A",
      "",
      "### Owner rulings",
      "- T-2: item B",
      "- T-3: item C",
      "",
      "## Todo",
      "- T-4: item D",
    ].join("\n");

    const parsed = parseHandoverMarkdown(md, "h.md");
    const byId = new Map(parsed.records.map((r) => [r.id, r]));
    expect(byId.get("T-1")?.disposition).toBe("continuation");
    expect(byId.get("T-2")?.disposition).toBe("owner-gated");
    expect(byId.get("T-3")?.disposition).toBe("owner-gated");
    expect(byId.get("T-4")?.disposition).toBe("continuation");
  });

  it("excludes bullets under a heading that does not classify from every category", () => {
    const md = [
      "# Title",
      "",
      "## Reopened",
      "- T-9: should not appear anywhere",
      "",
      "## Next",
      "- T-10: should appear",
    ].join("\n");

    const parsed = parseHandoverMarkdown(md, "h.md");
    const ids = parsed.records.map((r) => r.id);
    expect(ids).not.toContain("T-9");
    expect(ids).toContain("T-10");
  });

  it("does not mistake a top-level indented code sample's backtick line for a fence opener", () => {
    // The nested-fence indent allowance (up to 11 columns, for fences
    // nested under a list item) must NOT apply at the top document level,
    // where there is no enclosing list item and CommonMark's plain 3-space
    // fence-open rule holds. Widening it there let a 4-space-indented
    // literal "```" line swallow every heading after it, including its
    // records, until end of document (Codex review finding:
    // fence-awareness -- a regression from the fence-indent fix itself).
    const md = [
      "# Title",
      "",
      "    ```",
      "",
      "## Next",
      "- T-1: continue",
    ].join("\n");
    const sections = splitFenceAwareSections(md);
    expect(sections.map((s) => s.heading)).toContain("Next");

    const parsed = parseHandoverMarkdown(md, "h.md");
    expect(parsed.records.map((r) => r.id)).toContain("T-1");
  });

  it("does not mistake a TAB-indented top-level code sample's backtick line for a fence opener", () => {
    // A tab in the leading run must not bypass maxColumns entirely -- it
    // must expand to a real column and be judged like any other
    // indentation (Codex review finding: fence-awareness, round 3 -- an
    // earlier version's "any tab bypasses" rule reintroduced the exact
    // swallowed-heading bug via a tab instead of spaces).
    const md = ["# Title", "", "\t```", "", "## Next", "- T-1: continue"].join(
      "\n",
    );
    const sections = splitFenceAwareSections(md);
    expect(sections.map((s) => s.heading)).toContain("Next");

    const parsed = parseHandoverMarkdown(md, "h.md");
    expect(parsed.records.map((r) => r.id)).toContain("T-1");
  });

  it("does not mistake an indented code sample BETWEEN bullets (not nested under either) for a fence opener", () => {
    // The nested-fence tolerance must be scoped to a specific bullet's own
    // nested lines, not to the whole section body. The zero-indent prose
    // line ends T-1's nested region (a blank line alone would not -- blank
    // lines always continue a bullet's nested scope), so the fenced sample
    // that follows sits outside any bullet's nested walk entirely and must
    // stay governed by the strict top-level tolerance (Codex review
    // finding: fence-awareness, round 3).
    const md = [
      "# Title",
      "",
      "## Next",
      "- T-1: first",
      "",
      "Some prose paragraph, ending T-1's nested region.",
      "",
      "    ```",
      "    stray sample, not nested under T-1 or T-2",
      "    ```",
      "",
      "- T-2: second",
    ].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    expect(parsed.records.map((r) => r.id)).toEqual(["T-1", "T-2"]);
  });

  it("does not let a nested fence's closing delimiter be mistaken for a new top-level fence-open, dropping the next sibling bullet", () => {
    // T-1's nested fence opens at 4 spaces (valid CommonMark container
    // indent for a dash item) and closes at 2 spaces (still inside that
    // same container, and a valid closer for the opener). A strict
    // top-level scan computed independently over the whole section body
    // sees only the 2-space closer -- 2 <= 3 -- and misreads it as a
    // fresh fence-open, which then marks T-2's marker line as fenced and
    // drops it (Codex review finding: fence-awareness, round 4).
    const md = [
      "# Title",
      "",
      "## Next",
      "- T-1: first",
      "    ```",
      "    example",
      "  ```",
      "- T-2: second",
    ].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    expect(parsed.records.map((r) => r.id)).toEqual(["T-1", "T-2"]);
  });
});

describe("parseHandoverMarkdown: record extraction", () => {
  it("extracts the first id token in a bullet, keeping others in text", () => {
    const md = [
      "# Title",
      "",
      "## Next",
      "- T-1: fix the thing, related to ISS-2 as well",
    ].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    expect(parsed.records[0].id).toBe("T-1");
    expect(parsed.records[0].label).toContain("fix the thing");
  });

  it("uses a single labelSource for both delimiter and no-delimiter cases", () => {
    const md = [
      "# Title",
      "",
      "## Next",
      "- T-1: short label: extra rationale text here",
      "- T-2 no colon or double dash at all just prose",
    ].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    const r1 = parsed.records.find((r) => r.id === "T-1")!;
    const r2 = parsed.records.find((r) => r.id === "T-2")!;
    expect(r1.label).toBe("short label");
    expect(r1.rationale).toBe("extra rationale text here");
    expect(r2.label).toBe("no colon or double dash at all just prose");
  });

  it("excludes fenced nested content from label and rationale extraction", () => {
    const md = [
      "# Title",
      "",
      "## Next",
      "- T-1: has a fence below",
      "  ```",
      "  this should never leak into rationale",
      "  ```",
    ].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    const r1 = parsed.records.find((r) => r.id === "T-1")!;
    expect(r1.rationale).toBe("unknown");
  });

  it("falls back to nested non-fence content for rationale when no delimiter exists", () => {
    const md = [
      "# Title",
      "",
      "## Next",
      "- T-1 no delimiter here at all in the first line whatsoever",
      "  the real rationale lives here on a nested line",
    ].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    const r1 = parsed.records.find((r) => r.id === "T-1")!;
    expect(r1.rationale).toBe("the real rationale lives here on a nested line");
  });

  const cueTokens = [
    "decided",
    "ruled",
    "deferred",
    "abandoned",
    "instead",
    "because",
    "owner",
    "do not",
    "never",
    "superseded",
  ];

  for (const token of cueTokens) {
    it(`classifies an id-less bullet containing "${token}" as a decision`, () => {
      const md = ["# Title", "", "## Next", `- We ${token} to do this`].join(
        "\n",
      );
      const parsed = parseHandoverMarkdown(md, "h.md");
      expect(parsed.records[0].kind).toBe("decision");
      expect(parsed.records[0].id).toBeNull();
    });
  }

  it("classifies an id-bearing bullet as item even with a cue token", () => {
    const md = ["# Title", "", "## Next", "- T-1: we decided to ship this"].join(
      "\n",
    );
    const parsed = parseHandoverMarkdown(md, "h.md");
    expect(parsed.records[0].kind).toBe("item");
  });

  it("falls back to unclassified when no heading classifies anywhere", () => {
    const md = [
      "# Session Handover",
      "",
      "This is the first paragraph describing what happened this session.",
      "",
      "## Reopened",
      "- T-1: nope",
    ].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    expect(parsed.unclassifiedFallback).toBe(true);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].disposition).toBe("unclassified");
    expect(parsed.records[0].label).toContain(
      "This is the first paragraph",
    );
  });

  it("treats a tab-indented nested line as nested content, not the end of the bullet", () => {
    const md = [
      "# Title",
      "",
      "## Next",
      "- T-1 no delimiter here at all in the first line whatsoever",
      "\tthe real rationale lives here on a tab-indented nested line",
    ].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    const r1 = parsed.records.find((r) => r.id === "T-1")!;
    expect(r1.rationale).toBe("the real rationale lives here on a tab-indented nested line");
  });

  it("preserves document order across sections in orderedIdOccurrences, including shipped", () => {
    const md = [
      "# Title",
      "",
      "## Shipped",
      "- T-1: done",
      "",
      "## Next",
      "- T-1: still open somehow",
    ].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    expect(parsed.orderedIdOccurrences).toEqual([
      { id: "T-1", disposition: "shipped" },
      { id: "T-1", disposition: "continuation" },
    ]);
  });

  it("extracts a numbered-list item ('1. ') as a bullet", () => {
    const md = ["# Title", "", "## Next", "1. T-1: numbered form"].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].id).toBe("T-1");
  });

  it("extracts a numbered-list item using the paren form ('1) ') as a bullet", () => {
    const md = ["# Title", "", "## Next", "1) T-1: paren form"].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].id).toBe("T-1");
  });

  it("extracts a three-digit numbered-list item ('123. ') as a bullet", () => {
    const md = ["# Title", "", "## Next", "123. T-1: three-digit form"].join(
      "\n",
    );
    const parsed = parseHandoverMarkdown(md, "h.md");
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].id).toBe("T-1");
  });

  it("does not treat a mid-line decimal or a four-digit year as a numbered-list marker", () => {
    // "1.5 ratio": the single digit before "." must be followed directly by
    // whitespace to be a marker, and "5" is not whitespace, so this is
    // ordinary prose, not a list item.
    const decimalMd = ["# Title", "", "## Next", "1.5 ratio holds"].join(
      "\n",
    );
    const decimalParsed = parseHandoverMarkdown(decimalMd, "h.md");
    expect(decimalParsed.records).toHaveLength(0);

    // "2026. " is a real 4-digit year: no 1-3 digit prefix of "2026" is
    // immediately followed by "." or ")", so this never matches the marker
    // grammar either -- accepted, intentional boundary, not a gap.
    const yearMd = ["# Title", "", "## Next", "2026. T-1: a year, not a marker"].join(
      "\n",
    );
    const yearParsed = parseHandoverMarkdown(yearMd, "h.md");
    expect(yearParsed.records).toHaveLength(0);
  });

  it("excludes a fence nested under a numbered marker even though its content indent exceeds the old 3-space fence-open cap", () => {
    // "10. " puts the fence at 4-space content indent; the fence-open check
    // must reach that (up to 11 columns) or "decided" inside the fence body
    // leaks into rationale and the record misclassifies (pen ruling, T-320
    // commit 1 fence-indent fix).
    const md = [
      "# Title",
      "",
      "## Next",
      "10. no delimiter here at all whatsoever",
      "    ```ts",
      "    // decided this should never leak",
      "    ```",
    ].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]?.rationale).toBe("unknown");
    expect(parsed.records[0]?.kind).toBe("item");
  });

  it("excludes a fence nested under a dash marker at 4-space content indent, same as the numbered case", () => {
    const md = [
      "# Title",
      "",
      "## Next",
      "- no delimiter here either for this dash item",
      "    ```ts",
      "    // decided this should never leak",
      "    ```",
    ].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]?.rationale).toBe("unknown");
    expect(parsed.records[0]?.kind).toBe("item");
  });

  it("treats a one-space-then-tab nested line as deeper than a 3-space marker indent, not the end of the bullet", () => {
    // nestedLineIndent must expand the WHOLE leading whitespace run via tab
    // stops, not just check whether the line starts with a tab -- a single
    // leading space before the tab must not make this look shallower than
    // the marker's own 3-space indent (Codex review finding: indentation).
    const md = [
      "# Title",
      "",
      "## Next",
      "   - T-1 no delimiter here at all in the first line whatsoever",
      " \tthe real rationale lives here after one space then a tab",
    ].join("\n");
    const parsed = parseHandoverMarkdown(md, "h.md");
    const r1 = parsed.records.find((r) => r.id === "T-1")!;
    expect(r1.rationale).toBe(
      "the real rationale lives here after one space then a tab",
    );
  });
});

function makeRecord(overrides: Partial<SectionRecord>): SectionRecord {
  return {
    id: null,
    label: "label",
    disposition: "continuation",
    rationale: "unknown",
    kind: "item",
    file: "h.md",
    ...overrides,
  };
}

describe("selectBoundedRecords: byte budget", () => {
  it("stays within the 1,600-byte / 12-record cap", () => {
    const candidates: SectionRecord[] = Array.from({ length: 30 }, (_, i) =>
      makeRecord({
        id: `T-${i}`,
        label: "x".repeat(100),
        rationale: "y".repeat(200),
      }),
    );
    const { records, index } = selectBoundedRecords(candidates, "h.md");
    expect(records.length).toBeLessThanOrEqual(12);
    const totalBytes = records.reduce(
      (sum, r) => sum + Buffer.byteLength(JSON.stringify(r), "utf-8"),
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(1600);
    if (index) {
      expect(index.omittedCount).toBeGreaterThan(0);
    }
  });

  it("reserve pass makes the drop-reserve mutant provably wrong on a decisions-last fixture", () => {
    // Several item records first (large enough to fill the budget), then
    // decision records last, sized so a pure document-order walk would
    // exhaust the cap before reaching them.
    const items: SectionRecord[] = Array.from({ length: 10 }, (_, i) =>
      makeRecord({
        id: `T-${i}`,
        kind: "item",
        label: "z".repeat(110),
        rationale: "w".repeat(110),
      }),
    );
    const decisions: SectionRecord[] = Array.from({ length: 3 }, (_, i) =>
      makeRecord({
        id: null,
        kind: "decision",
        label: `decision ${i} we ruled on this`,
        rationale: "unknown",
      }),
    );
    const candidates = [...items, ...decisions];

    const withReserve = selectBoundedRecords(candidates, "h.md");
    const withoutReserve = selectBoundedRecordsNoReserveMutant(
      candidates,
      "h.md",
    );

    const reserveHasDecision = withReserve.records.some(
      (r) => r.kind === "decision",
    );
    const mutantHasDecision = withoutReserve.records.some(
      (r) => r.kind === "decision",
    );
    expect(reserveHasDecision).toBe(true);
    expect(mutantHasDecision).toBe(false);
  });

  it("honors the reserve floor under a many-decisions/few-bytes shape", () => {
    const decisions: SectionRecord[] = Array.from({ length: 6 }, (_, i) =>
      makeRecord({ id: null, kind: "decision", label: `d${i}`, rationale: "unknown" }),
    );
    const { records } = selectBoundedRecords(decisions, "h.md");
    const decisionCount = records.filter((r) => r.kind === "decision").length;
    expect(decisionCount).toBeGreaterThanOrEqual(4);
  });

  it("honors the reserve floor under a few-decisions/many-bytes shape", () => {
    const decisions: SectionRecord[] = Array.from({ length: 2 }, (_, i) =>
      makeRecord({
        id: null,
        kind: "decision",
        label: "big".repeat(30),
        rationale: "rationale".repeat(20),
      }),
    );
    const { records } = selectBoundedRecords(decisions, "h.md");
    const decisionCount = records.filter((r) => r.kind === "decision").length;
    expect(decisionCount).toBe(2);
  });

  it("index self-shortens the non-file part when 20 ids would exceed 160 bytes", () => {
    const candidates: SectionRecord[] = Array.from({ length: 60 }, (_, i) =>
      makeRecord({
        id: `T-${1000 + i}`,
        label: "x".repeat(115),
        rationale: "y".repeat(230),
      }),
    );
    const { index } = selectBoundedRecords(candidates, "h.md");
    expect(index).not.toBeNull();
    const nonFileBytes = Buffer.byteLength(
      JSON.stringify({ omittedCount: index!.omittedCount, ids: index!.ids }),
      "utf-8",
    );
    expect(nonFileBytes).toBeLessThanOrEqual(160);
    expect(index!.omittedCount).toBeGreaterThan(index!.ids.length);
  });

  it("round-trips an exact adversarial filename through the index unmodified", () => {
    const adversarial = "a".repeat(120) + "\"\\".repeat(20) + ".md";
    const candidates: SectionRecord[] = Array.from({ length: 60 }, (_, i) =>
      makeRecord({ id: `T-${2000 + i}`, label: "x".repeat(115) }),
    );
    const { index } = selectBoundedRecords(candidates, adversarial);
    expect(index).not.toBeNull();
    expect(index!.file).toBe(adversarial);
    const nonFileBytes = Buffer.byteLength(
      JSON.stringify({ omittedCount: index!.omittedCount, ids: index!.ids }),
      "utf-8",
    );
    expect(nonFileBytes).toBeLessThanOrEqual(160);
  });

  it("longest real generated filename round-trips and fits the non-file cap", () => {
    const slug = "a".repeat(60);
    const generated = `2026-09-10-153045-a1b2c3d4-${slug}.md`;
    const candidates: SectionRecord[] = Array.from({ length: 60 }, (_, i) =>
      makeRecord({ id: `T-${3000 + i}`, label: "x".repeat(115) }),
    );
    const { index } = selectBoundedRecords(candidates, generated);
    expect(index).not.toBeNull();
    expect(index!.file).toBe(generated);
    const nonFileBytes = Buffer.byteLength(
      JSON.stringify({ omittedCount: index!.omittedCount, ids: index!.ids }),
      "utf-8",
    );
    expect(nonFileBytes).toBeLessThanOrEqual(160);
  });

  it("evicts fill-pass records before reserve-pass decisions to fit the index", () => {
    const items: SectionRecord[] = Array.from({ length: 11 }, (_, i) =>
      makeRecord({ id: `T-${i}`, kind: "item", label: "i".repeat(90) }),
    );
    const decisions: SectionRecord[] = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ id: null, kind: "decision", label: `dec-${i}`.repeat(3) }),
    );
    const { records, index } = selectBoundedRecords(
      [...items, ...decisions],
      "h.md",
    );

    // Pinned exact outcome (Codex review finding: test-coverage -- the
    // prior version only checked that SOME index existed and the record
    // count stayed under 12, which a reversed eviction priority could also
    // satisfy). All 4 reserved decisions survive intact; the fill pass
    // initially admits T-0..T-5 (6 items) alongside them, then the index's
    // own weight forces one eviction, which removes T-5 -- the LAST
    // fill-pass record added, not a reserve-pass decision -- leaving
    // T-0..T-4 and pushing T-5 into the index behind the already-omitted
    // T-6..T-10.
    expect(records.map((r) => r.id)).toEqual([
      null,
      null,
      null,
      null,
      "T-0",
      "T-1",
      "T-2",
      "T-3",
      "T-4",
    ]);
    expect(records.filter((r) => r.kind === "decision")).toHaveLength(4);
    expect(index).toEqual({
      omittedCount: 7,
      ids: ["T-6", "T-7", "T-8", "T-9", "T-10", "T-5"],
      file: "h.md",
    });
    expect(records.length + 1).toBeLessThanOrEqual(12);
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify({ records, index }),
      "utf-8",
    );
    expect(envelopeBytes).toBeLessThanOrEqual(1600);
  });

  it("fills id-bearing records before id-less ones when only one more fits, regardless of document order", () => {
    // Filler consumes budget so exactly one of the two remaining candidates
    // fits. The id-less bullet comes FIRST in document order; the plan
    // requires id-bearing records to be filled before remaining id-less
    // bullets, so the id-bearing one must win even though it is later in
    // the document.
    const filler = makeRecord({ id: "T-0", kind: "item", label: "f".repeat(1250), rationale: "unknown" });
    const idLessFirst = makeRecord({ id: null, kind: "item", label: "x".repeat(20), rationale: "unknown" });
    const idBearingSecond = makeRecord({ id: "T-1", kind: "item", label: "y".repeat(20), rationale: "unknown" });

    const { records, index } = selectBoundedRecords([filler, idLessFirst, idBearingSecond], "h.md");

    expect(records.some((r) => r.id === "T-1")).toBe(true);
    expect(records).toHaveLength(2);
    expect(index?.omittedCount).toBe(1);
  });

  it("keeps the FULL serialized envelope (records + index together) within the cap, not just summed record sizes", () => {
    const candidates: SectionRecord[] = Array.from({ length: 12 }, (_, i) =>
      makeRecord({ id: `T-${i}`, label: "x".repeat(118), rationale: "unknown" }),
    );
    const { records, index } = selectBoundedRecords(candidates, "h.md");
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify({ records, index }),
      "utf-8",
    );
    expect(envelopeBytes).toBeLessThanOrEqual(1600);
  });

  it("shortens the label (after the rationale) when rationale-dropping alone still does not fit", () => {
    const bigLabelRecord = makeRecord({
      id: "T-1",
      kind: "item",
      label: "L".repeat(3000),
      rationale: "R".repeat(500),
    });
    const { records } = selectBoundedRecords([bigLabelRecord], "h.md");
    expect(records).toHaveLength(1);
    const record = records[0] as SectionRecord;
    expect(record.rationale).toBe("unknown");
    expect(record.label.length).toBeLessThan(bigLabelRecord.label.length);
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify({ records, index: null }),
      "utf-8",
    );
    expect(envelopeBytes).toBeLessThanOrEqual(1600);
  });

  it("finds a label shorter than a fixed 40-byte shrink target when the remaining budget requires it", () => {
    // Filler sized so a 40-byte label does not fit the remainder, but a
    // 10-byte label does -- proves the shrink is a real search against the
    // available budget, not a fixed truncation target that would have
    // rejected this record outright.
    const filler = makeRecord({
      id: "T-0",
      kind: "item",
      label: "f".repeat(1350),
      rationale: "unknown",
    });
    const tight = makeRecord({
      id: "T-1",
      kind: "item",
      label: "L".repeat(3000),
      rationale: "R".repeat(500),
    });
    const { records } = selectBoundedRecords([filler, tight], "h.md");
    const t1 = records.find((r) => r.id === "T-1");
    expect(t1).toBeDefined();
    expect(Buffer.byteLength(t1!.label, "utf-8")).toBeLessThan(40);
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify({ records, index: null }),
      "utf-8",
    );
    expect(envelopeBytes).toBeLessThanOrEqual(1600);
  });

  it("admits two distinct id-less candidates sharing every other identity field, distinguished only by label", () => {
    // Two id-less continuation items in the same file share disposition,
    // kind, id (null), and file -- every field a naive accounting check
    // might use as an identity key. Only the label tells them apart, so
    // selectBoundedRecords must retain both, not silently collapse to one
    // (Codex review finding: test-coverage, round 3 -- a prior corpus-test
    // invariant used exactly that tuple as an identity key).
    const first = makeRecord({ id: null, label: "first id-less item", rationale: "unknown" });
    const second = makeRecord({ id: null, label: "second id-less item", rationale: "unknown" });
    const { records, index } = selectBoundedRecords([first, second], "h.md");
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.label)).toEqual(["first id-less item", "second id-less item"]);
    expect(index).toBeNull();
  });

  it("admits two distinct candidates that share the same id -- id is not a uniqueness key", () => {
    // Two separate bullets can legitimately carry the same ticket id (e.g.
    // two handovers both naming T-1). selectBoundedRecords must not treat
    // id as an identity and silently dedupe one away (Codex review finding:
    // test-coverage -- a prior invariant check wrongly assumed ids were
    // unique across candidates).
    const first = makeRecord({ id: "T-1", label: "first mention", rationale: "unknown" });
    const second = makeRecord({ id: "T-1", label: "second mention", rationale: "unknown" });
    const { records, index } = selectBoundedRecords([first, second], "h.md");
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.label)).toEqual(["first mention", "second mention"]);
    expect(index).toBeNull();
  });

  it("does not double-count a shrunk-but-retained record as omitted", () => {
    const needsShortening = makeRecord({
      id: "T-1",
      kind: "item",
      label: "a".repeat(50),
      rationale: "b".repeat(300),
    });
    const filler: SectionRecord[] = Array.from({ length: 20 }, (_, i) =>
      makeRecord({
        id: `T-${i + 2}`,
        kind: "item",
        label: "z".repeat(115),
        rationale: "w".repeat(115),
      }),
    );
    const candidates = [needsShortening, ...filler];
    const { records, index } = selectBoundedRecords(candidates, "h.md");

    const t1 = records.find((r) => r.id === "T-1");
    expect(t1).toBeDefined();
    if (index) {
      expect(index.ids).not.toContain("T-1");
    }
    const includedIds = new Set(records.map((r) => r.id));
    expect(index?.omittedCount ?? 0).toBe(candidates.length - includedIds.size);
  });
});

function fitsEnvelopeForMutant(records: SectionRecord[]): boolean {
  return Buffer.byteLength(JSON.stringify({ records, index: null }), "utf-8") <= 1600;
}

function truncateUtf8ForMutant(s: string, maxBytes: number): string {
  const ellipsis = "...";
  if (Buffer.byteLength(s, "utf-8") <= maxBytes) return s;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, "utf-8"));
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const chBytes = Buffer.byteLength(ch, "utf-8");
    if (bytes + chBytes > budget) break;
    out += ch;
    bytes += chBytes;
  }
  return out + ellipsis;
}

// Mirrors selectBoundedRecords' admission logic (envelope check via the
// full serialized form, rationale-drop then label-shrink fallback, same
// CAP_RECORDS=12 ceiling) for its two fill passes, but skips the reserve
// pass entirely -- straight from an empty selection into the id-bearing
// fill pass, then the id-less fill pass. It does NOT mirror production's
// trailing fitIndex step (index-driven eviction of already-selected
// records): the assertion below only checks whether ANY decision survives
// initial selection in a decisions-last fixture sized so the fill passes
// alone exhaust the budget, which fitIndex's eviction (which always removes
// fill-pass records before reserve-pass ones, per the test above) would not
// change either way here -- so the missing step does not affect what this
// specific comparison verifies, but it IS a real difference from
// production and this helper is not a general substitute for it (Codex
// review finding: mutation-testing -- an earlier version of this comment
// overclaimed full isolation).
function admitForMutant(
  selected: SectionRecord[],
  candidate: SectionRecord,
): SectionRecord | null {
  if (selected.length + 1 > 12) return null;
  if (fitsEnvelopeForMutant([...selected, candidate])) return candidate;
  const rationaleDropped =
    candidate.rationale === "unknown" ? candidate : { ...candidate, rationale: "unknown" };
  if (fitsEnvelopeForMutant([...selected, rationaleDropped])) return rationaleDropped;

  let lo = 0;
  let hi = Buffer.byteLength(rationaleDropped.label, "utf-8");
  let best: string | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const label = truncateUtf8ForMutant(rationaleDropped.label, mid);
    if (fitsEnvelopeForMutant([...selected, { ...rationaleDropped, label }])) {
      best = label;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best === null ? null : { ...rationaleDropped, label: best };
}

function selectBoundedRecordsNoReserveMutant(
  candidates: SectionRecord[],
  file: string,
): { records: SectionRecord[]; index: { omittedCount: number; ids: string[]; file: string } | null } {
  const selected: SectionRecord[] = [];
  const admitted = new Set<number>();

  for (let i = 0; i < candidates.length; i++) {
    if ((candidates[i] as SectionRecord).id === null) continue;
    const result = admitForMutant(selected, candidates[i] as SectionRecord);
    if (result === null) continue;
    selected.push(result);
    admitted.add(i);
  }
  for (let i = 0; i < candidates.length; i++) {
    if (admitted.has(i)) continue;
    if ((candidates[i] as SectionRecord).id !== null) continue;
    const result = admitForMutant(selected, candidates[i] as SectionRecord);
    if (result === null) continue;
    selected.push(result);
    admitted.add(i);
  }

  const omittedCount = candidates.length - admitted.size;
  const ids = candidates
    .map((c, i) => ({ c, i }))
    .filter(({ i }) => !admitted.has(i))
    .map(({ c }) => c.id)
    .filter((x): x is string => x !== null);
  const index = omittedCount > 0 ? { omittedCount, ids, file } : null;
  return { records: selected, index };
}

describe("buildTrajectory", () => {
  it("counts occurrence per handover, not per bullet", () => {
    const handovers = [
      {
        filename: "b.md",
        orderedIdOccurrences: [
          { id: "T-1", disposition: "continuation" as const },
          { id: "T-1", disposition: "continuation" as const },
        ],
      },
      {
        filename: "a.md",
        orderedIdOccurrences: [{ id: "T-1", disposition: "blocked" as const }],
      },
    ];
    const trajectory = buildTrajectory(handovers);
    const entry = trajectory.find((t) => t.id === "T-1")!;
    expect(entry.occurrenceCount).toBe(2);
  });

  it("reports shipped as latestDisposition when it is the newest mention", () => {
    const handovers = [
      {
        filename: "newest.md",
        orderedIdOccurrences: [{ id: "T-1", disposition: "shipped" as const }],
      },
      {
        filename: "older.md",
        orderedIdOccurrences: [{ id: "T-1", disposition: "continuation" as const }],
      },
    ];
    const trajectory = buildTrajectory(handovers);
    const entry = trajectory.find((t) => t.id === "T-1")!;
    expect(entry.latestDisposition).toBe("shipped");
    expect(entry.latest).toBe("newest.md");
    expect(entry.firstSeenInWindow).toBe("older.md");
  });

  it("still includes an id that was dropped from its newest handover's rendered records by budgeting", () => {
    // buildTrajectory operates on the FULL parsed record set, so this is
    // really just confirming it does not depend on selectBoundedRecords
    // having been applied first.
    const handovers = [
      {
        filename: "newest.md",
        orderedIdOccurrences: [{ id: "T-1", disposition: "continuation" as const }],
      },
    ];
    const trajectory = buildTrajectory(handovers);
    expect(trajectory.find((t) => t.id === "T-1")).toBeDefined();
  });

  it("resolves a same-handover tie by whichever occurrence is textually first: shipped before continuation", () => {
    const handovers = [
      {
        filename: "h.md",
        orderedIdOccurrences: [
          { id: "T-1", disposition: "shipped" as const },
          { id: "T-1", disposition: "continuation" as const },
        ],
      },
    ];
    const trajectory = buildTrajectory(handovers);
    const entry = trajectory.find((t) => t.id === "T-1")!;
    expect(entry.latestDisposition).toBe("shipped");
  });

  it("resolves a same-handover tie by whichever occurrence is textually first: continuation before shipped", () => {
    const handovers = [
      {
        filename: "h.md",
        orderedIdOccurrences: [
          { id: "T-1", disposition: "continuation" as const },
          { id: "T-1", disposition: "shipped" as const },
        ],
      },
    ];
    const trajectory = buildTrajectory(handovers);
    const entry = trajectory.find((t) => t.id === "T-1")!;
    expect(entry.latestDisposition).toBe("continuation");
  });

  it("a shipped-only mention across the window gives occurrenceCount 0 with latestDisposition shipped", () => {
    const handovers = [
      {
        filename: "h.md",
        orderedIdOccurrences: [{ id: "T-1", disposition: "shipped" as const }],
      },
    ];
    const trajectory = buildTrajectory(handovers);
    const entry = trajectory.find((t) => t.id === "T-1")!;
    expect(entry.occurrenceCount).toBe(0);
    expect(entry.latestDisposition).toBe("shipped");
  });

  it("shipped in the newest handover plus continuation in an older one gives occurrenceCount 1 with latest shipped", () => {
    const handovers = [
      {
        filename: "newest.md",
        orderedIdOccurrences: [{ id: "T-1", disposition: "shipped" as const }],
      },
      {
        filename: "older.md",
        orderedIdOccurrences: [{ id: "T-1", disposition: "continuation" as const }],
      },
    ];
    const trajectory = buildTrajectory(handovers);
    const entry = trajectory.find((t) => t.id === "T-1")!;
    expect(entry.occurrenceCount).toBe(1);
    expect(entry.latestDisposition).toBe("shipped");
    expect(entry.latest).toBe("newest.md");
  });
});

describe("selectContinuationCandidates (T-498 commit 2)", () => {
  it("filters to continuation-disposition records only, in document order", () => {
    const records: SectionRecord[] = [
      makeRecord({ id: "T-1", disposition: "blocked", label: "blocked one" }),
      makeRecord({ id: "T-2", disposition: "continuation", label: "second" }),
      makeRecord({ id: "T-3", disposition: "owner-gated", label: "gated one" }),
      makeRecord({ id: "T-4", disposition: "continuation", label: "fourth" }),
    ];
    const result = selectContinuationCandidates(records, "h.md");
    expect(result.candidates.map((c) => c.id)).toEqual(["T-2", "T-4"]);
    expect(result.omittedContinuationCount).toBe(0);
    expect(result.omittedContinuationIds).toEqual([]);
  });

  it("preserves document order even when a decision record appears after an item record", () => {
    const records: SectionRecord[] = [
      makeRecord({ id: null, kind: "decision", disposition: "continuation", label: "decided to defer" }),
      makeRecord({ id: "T-5", kind: "item", disposition: "continuation", label: "keep going on T-5" }),
    ];
    const result = selectContinuationCandidates(records, "h.md");
    expect(result.candidates.map((c) => c.label)).toEqual([
      "decided to defer",
      "keep going on T-5",
    ]);
  });

  it("does not run a reserve pass -- an item is never reordered ahead of an earlier decision", () => {
    // Unlike selectBoundedRecords, there is no reserve-first pass here: an
    // actionable item record must not jump ahead of an earlier decision
    // record just because it carries an id.
    const records: SectionRecord[] = [
      makeRecord({ id: null, kind: "decision", disposition: "continuation", label: "first, a decision" }),
      makeRecord({ id: "T-9", kind: "item", disposition: "continuation", label: "second, an item" }),
    ];
    const result = selectContinuationCandidates(records, "h.md");
    expect(result.candidates[0]!.kind).toBe("decision");
    expect(result.candidates[1]!.kind).toBe("item");
  });

  it("stays within the 800-byte cap and discloses omissions when the cap binds", () => {
    const records: SectionRecord[] = Array.from({ length: 20 }, (_, i) =>
      makeRecord({
        id: `T-${i}`,
        kind: "item",
        disposition: "continuation",
        label: "x".repeat(100),
        rationale: "y".repeat(200),
      }),
    );
    const result = selectContinuationCandidates(records, "h.md");
    const totalBytes = Buffer.byteLength(
      JSON.stringify({
        candidates: result.candidates,
        omittedContinuationCount: result.omittedContinuationCount,
        omittedContinuationIds: result.omittedContinuationIds,
      }),
      "utf-8",
    );
    expect(totalBytes).toBeLessThanOrEqual(800);
    expect(result.omittedContinuationCount).toBeGreaterThan(0);
    expect(result.omittedContinuationIds.length).toBeGreaterThan(0);
  });

  it("shrinks the disclosed omitted-ids list itself when a single parser-accepted id alone would exceed the 800-byte envelope (Codex round 1 finding: eviction loop stalled once candidates were already empty)", () => {
    // ID_TOKEN_REGEX (`T|ISS|N|L`-`\d+`) has no length ceiling, so a
    // pathologically long numeric suffix is a real, parser-accepted id, not
    // a contrived one. A single omitted record with this id, on its own,
    // exceeds 800 bytes -- so even after every candidate is evicted (working
    // is empty), the envelope still must not fit unless the ids list itself
    // is trimmed rather than left at its INDEX_MAX_IDS-capped length.
    const hugeId = `T-${"9".repeat(900)}`;
    const records: SectionRecord[] = [makeRecord({ id: hugeId, kind: "item", disposition: "continuation", label: "x" })];
    const result = selectContinuationCandidates(records, "h.md");
    const totalBytes = Buffer.byteLength(
      JSON.stringify({
        candidates: result.candidates,
        omittedContinuationCount: result.omittedContinuationCount,
        omittedContinuationIds: result.omittedContinuationIds,
      }),
      "utf-8",
    );
    expect(totalBytes).toBeLessThanOrEqual(800);
    expect(result.candidates).toEqual([]);
    expect(result.omittedContinuationCount).toBe(1);
    expect(result.omittedContinuationIds).toEqual([]);
  });

  it("an id-less omitted decision contributes to the count but never to omittedContinuationIds", () => {
    const items: SectionRecord[] = Array.from({ length: 15 }, (_, i) =>
      makeRecord({
        id: `T-${i}`,
        kind: "item",
        disposition: "continuation",
        label: "x".repeat(100),
        rationale: "y".repeat(200),
      }),
    );
    const trailingDecision = makeRecord({
      id: null,
      kind: "decision",
      disposition: "continuation",
      label: "z".repeat(100),
      rationale: "w".repeat(200),
    });
    const records = [...items, trailingDecision];
    const result = selectContinuationCandidates(records, "h.md");
    expect(result.omittedContinuationCount).toBeGreaterThan(result.omittedContinuationIds.length);
  });

  it("an actionable item is not dropped by any reserve pass, unlike the display primitive", () => {
    // A shape where selectBoundedRecords's reserve pass would prioritize
    // decision records; selectContinuationCandidates has no such pass, so a
    // single early actionable item candidate must survive intact.
    const records: SectionRecord[] = [
      makeRecord({ id: "T-1", kind: "item", disposition: "continuation", label: "the actionable one" }),
      ...Array.from({ length: 5 }, (_, i) =>
        makeRecord({ id: null, kind: "decision", disposition: "continuation", label: `decision ${i}` }),
      ),
    ];
    const result = selectContinuationCandidates(records, "h.md");
    expect(result.candidates[0]!.id).toBe("T-1");
  });

  it("returns empty candidates and no omissions when there are no continuation-disposition records", () => {
    const records: SectionRecord[] = [
      makeRecord({ id: "T-1", disposition: "blocked" }),
      makeRecord({ id: "T-2", disposition: "carried" }),
    ];
    const result = selectContinuationCandidates(records, "h.md");
    expect(result.candidates).toEqual([]);
    expect(result.omittedContinuationCount).toBe(0);
    expect(result.omittedContinuationIds).toEqual([]);
  });
});
