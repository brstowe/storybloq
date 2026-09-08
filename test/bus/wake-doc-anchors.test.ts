/**
 * T-489 skill-doc anchors.
 *
 * A shared anchor constant does not by itself prevent a VACUOUS PASS: if the
 * section extractor returns an empty slice, every absence anchor passes over
 * nothing and every presence anchor fails for the wrong reason. So the extractor
 * is itself under test here, and each region is asserted NON-EMPTY before any
 * anchor runs.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(here, "..", "..", "src", "skill", "bus-mode.md");

const WAKE_HEADING = "### The wake tier";

/**
 * Anchors scoped to the wake PROSE section.
 *
 * Presence anchors are behaviours a reader must be told. Absence anchors are the
 * pre-T-489 claims that would now be false.
 */
const WAKE_SECTION_ANCHORS = {
  presence: [
    "clientSessionName",
    "arming `bus poll --wait` at every idle boundary is a setup requirement",
    "the Stop hook path stays the only delivery during an active turn",
    "skipped:surface-unreachable",
  ],
  absence: [
    "no equivalent exists for Codex",
    "not shipped",
    // ISS-1132's absence anchor "written later, by the delivery layer" is RETIRED
    // by ISS-1153, deliberately and not by accident. It guarded a claim that was
    // FALSE when it was written: the doc promised a writer that did not exist.
    // The poll path writes `poll_observed` now, so the claim is true, and keeping
    // an absence anchor against it would forbid this file's own subject from
    // saying what the code does. An anchor earns its place by being wrong to
    // violate; this one stopped being that.
  ],
} as const;

/**
 * ISS-1132 anchors: the opted-out-not-broken paragraph.
 *
 * Kept as a separate constant from the T-489 set so a future edit can tell which
 * change each anchor belongs to, and so deleting one set cannot quietly take the
 * other with it.
 *
 * ISS-1132 also anchored "not yet written" and "ISS-1153" here, pinning the GAP:
 * the doc had to say `poll_observed` was unwritten and name the issue that owned
 * it. ISS-1153 closed the gap, so both are retired rather than left to fail. The
 * anchors that replace them are in WAKE_ISS1153_ANCHORS below, and they pin the
 * behaviour instead of its absence.
 */
const WAKE_ISS1132_ANCHORS = {
  presence: [
    // The paragraph: pre-1.14.0 endpoints are opted out, not broken.
    "defaulted to `never` and remain opted out",
  ],
} as const;

/**
 * ISS-1153 anchors: what the reader must be told about `poll_observed`.
 *
 * Every one of these is a claim a reader would get WRONG without the sentence it
 * anchors. A rate with no lower-bound caveat reads as a measurement; a
 * `poll_observed` with no causal caveat reads as proof the wake worked; a
 * cumulative condition read as an in-invocation one makes an empty poll look like
 * a bug; and a reader who does not know skips never reach the thread will go
 * looking for them there and conclude the tier is broken.
 */
const WAKE_ISS1153_ANCHORS = {
  presence: [
    "poll_observed",
    "storybloq bus status",
    "That condition is cumulative",
    "an observation and never a cause",
    "a lower bound",
    "Skips never reach the thread",
  ],
} as const;

/**
 * ISS-1153 anchors scoped to the two PARAGRAPHS that carry the load, not to the
 * section.
 *
 * Section scope is too weak here and the weakness is specific: `poll_observed`
 * appears in several sentences, so a section-scoped anchor survives deleting the
 * one clause that says WHO writes it and when; and `a lower bound` survives
 * deleting every sentence that explains what is missing from the count, leaving a
 * reader with a caveat and no way to act on it. Each anchor below names a clause
 * whose removal would leave the doc confidently incomplete.
 */
const OBSERVATION_MARKER = "The evidence that mail actually reached someone";
const OBSERVATION_ANCHORS = [
  "the poll path appends",
  "polled mailbox cursor stands at or past",
  "That condition is cumulative",
  "an observation and never a cause",
  "storybloq bus status",
] as const;

const BOUNDARY_MARKER = "What that section reports is a lower bound";
const BOUNDARY_ANCHORS = [
  "DISCOVER the `requested` entry",
  "hold a cursor at or past",
  "append the observation successfully",
  "waits on a later poll folding that thread again",
  "reclaims the thread's mailbox pointer",
  "written after the poll that would have carried it",
  "the observation's own append fails",
] as const;

/**
 * Anchors scoped to the OPTING-IN PARAGRAPH, not to the whole section.
 *
 * `bus endpoint list` is named twice in this section: once by the corrected
 * telemetry sentence and once by the opting-in paragraph. A section-scoped
 * anchor is therefore satisfied by the telemetry sentence alone, so deleting the
 * opting-in paragraph's instruction to CHECK the current policy would pass
 * unnoticed. Same cross-location weakness that let a mutant through the
 * endpoint-list assertions; scoped here so it cannot.
 */
const OPTING_IN_MARKER = "Opting in.";
const OPTING_IN_ANCHORS = ["bus endpoint list", "bus setup --wake idle", "codex_desktop"] as const;

/** The single blank-line-delimited paragraph containing `marker`. */
export function extractParagraph(section: string, marker: string): string {
  const paragraphs = section.split(/\n\s*\n/);
  const hits = paragraphs.filter((p) => p.includes(marker));
  return hits.length === 1 ? hits[0]! : "";
}

/**
 * Anchors scoped to the delivery TIER TABLE.
 *
 * Split out deliberately rather than asserted at file scope. The default-policy
 * statement belongs in the table (it is a property of the tier, alongside the
 * other tiers) and it genuinely lives there, so scoping it to the table keeps the
 * no-vacuous-pass guarantee that file-scope matching would give up.
 */
const WAKE_TABLE_ANCHORS = {
  presence: ["wakePolicy defaults to `never`", "wake (idle)"],
} as const;

/**
 * Slice a markdown section: from `heading` to the next heading of EQUAL OR HIGHER
 * level, so a parent heading closing the section cannot swallow unrelated content.
 */
export function extractSection(
  markdown: string,
  heading: string,
): { found: "one" | "none" | "many"; section: string } {
  const lines = markdown.split("\n");
  const level = /^(#{1,6})\s/.exec(heading)?.[1].length ?? 0;
  const indices = lines
    .map((line, i) => (line.trim() === heading ? i : -1))
    .filter((i) => i >= 0);
  if (indices.length === 0) return { found: "none", section: "" };
  if (indices.length > 1) return { found: "many", section: "" };

  const start = indices[0]!;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const match = /^(#{1,6})\s/.exec(lines[i]!);
    if (match && match[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return { found: "one", section: lines.slice(start, end).join("\n") };
}

/** The contiguous markdown table block containing `marker`. */
export function extractTableBlock(markdown: string, marker: string): string {
  const lines = markdown.split("\n");
  const hit = lines.findIndex((line) => line.startsWith("|") && line.includes(marker));
  if (hit < 0) return "";
  let start = hit;
  while (start > 0 && lines[start - 1]!.startsWith("|")) start--;
  let end = hit;
  while (end + 1 < lines.length && lines[end + 1]!.startsWith("|")) end++;
  return lines.slice(start, end + 1).join("\n");
}

async function skill(): Promise<string> {
  return await readFile(SKILL_PATH, "utf-8");
}

describe("T-489 skill doc: the extractor itself", () => {
  it("reports a missing heading rather than returning an empty slice that passes", () => {
    const out = extractSection("# Title\n\nbody\n", "### Nope");
    expect(out.found).toBe("none");
    expect(out.section).toBe("");
  });

  it("reports a DUPLICATED heading instead of silently taking the first", () => {
    const md = "### A\nfirst\n\n### A\nsecond\n";
    expect(extractSection(md, "### A").found).toBe("many");
  });

  it("ends the section at the next heading of EQUAL level", () => {
    const md = "### A\nkeep\n### B\ndrop\n";
    const { section } = extractSection(md, "### A");
    expect(section).toContain("keep");
    expect(section).not.toContain("drop");
  });

  it("ends the section at a HIGHER-level heading too, so a parent cannot swallow it", () => {
    const md = "### A\nkeep\n## Parent\ndrop\n";
    const { section } = extractSection(md, "### A");
    expect(section).toContain("keep");
    expect(section).not.toContain("drop");
  });

  it("does NOT end the section at a deeper heading", () => {
    const md = "### A\nkeep\n#### Child\nalso keep\n## Parent\ndrop\n";
    const { section } = extractSection(md, "### A");
    expect(section).toContain("also keep");
    expect(section).not.toContain("drop");
  });

  it("handles a heading that is last in the file", () => {
    const md = "## Intro\nx\n### A\nfinal content\n";
    const { found, section } = extractSection(md, "### A");
    expect(found).toBe("one");
    expect(section).toContain("final content");
  });

  it("PASSES when forbidden text exists OUTSIDE the section", () => {
    // Scoping is the whole point: prose elsewhere in the file must not fail a
    // section-scoped absence anchor.
    const md = "### A\nclean\n## Elsewhere\nnot shipped\n";
    const { section } = extractSection(md, "### A");
    expect(section).not.toContain("not shipped");
  });

  it("returns an empty block for a table marker that is absent", () => {
    expect(extractTableBlock("no tables here", "wake (idle)")).toBe("");
  });
});

describe("T-489 skill doc: anchor sets are not empty", () => {
  it("has anchors to check, so an emptied constant fails loudly", () => {
    // Without this, deleting the anchors would make every assertion below vacuous.
    expect(WAKE_SECTION_ANCHORS.presence.length).toBeGreaterThan(0);
    expect(WAKE_SECTION_ANCHORS.absence.length).toBeGreaterThan(0);
    expect(WAKE_TABLE_ANCHORS.presence.length).toBeGreaterThan(0);
    expect(WAKE_ISS1132_ANCHORS.presence.length).toBeGreaterThan(0);
    expect(WAKE_ISS1153_ANCHORS.presence.length).toBeGreaterThan(0);
    expect(OBSERVATION_ANCHORS.length).toBeGreaterThan(0);
    expect(BOUNDARY_ANCHORS.length).toBeGreaterThan(0);
    expect(OPTING_IN_ANCHORS.length).toBeGreaterThan(0);
  });
});

describe("T-489 skill doc: bus-mode.md documents the wake tier", () => {
  it("contains EXACTLY ONE wake heading", async () => {
    expect(extractSection(await skill(), WAKE_HEADING).found).toBe("one");
  });

  it("extracts a NON-EMPTY wake section before any anchor is checked", async () => {
    const { section } = extractSection(await skill(), WAKE_HEADING);
    expect(section.trim().length).toBeGreaterThan(0);
    expect(section.split("\n").length).toBeGreaterThan(1);
  });

  it("carries every presence anchor INSIDE the wake section", async () => {
    const { section } = extractSection(await skill(), WAKE_HEADING);
    expect(section.length).toBeGreaterThan(0);
    for (const anchor of WAKE_SECTION_ANCHORS.presence) {
      expect(section).toContain(anchor);
    }
  });

  it("carries NO absence anchor inside the wake section", async () => {
    const { section } = extractSection(await skill(), WAKE_HEADING);
    expect(section.length).toBeGreaterThan(0);
    for (const anchor of WAKE_SECTION_ANCHORS.absence) {
      expect(section).not.toContain(anchor);
    }
  });

  it("extracts a NON-EMPTY tier table and documents the wake row and its default", async () => {
    const table = extractTableBlock(await skill(), "wake (idle)");
    expect(table.trim().length).toBeGreaterThan(0);
    for (const anchor of WAKE_TABLE_ANCHORS.presence) {
      expect(table).toContain(anchor);
    }
  });

  it("ISS-1132: says pre-1.14.0 endpoints are opted out and where to check", async () => {
    const { section } = extractSection(await skill(), WAKE_HEADING);
    expect(section.length).toBeGreaterThan(0);
    for (const anchor of WAKE_ISS1132_ANCHORS.presence) {
      expect(section, `missing ISS-1132 anchor: ${anchor}`).toContain(anchor);
    }
  });

  it("ISS-1153: says who writes poll_observed, and every caveat the number needs", async () => {
    const { section } = extractSection(await skill(), WAKE_HEADING);
    expect(section.length).toBeGreaterThan(0);
    for (const anchor of WAKE_ISS1153_ANCHORS.presence) {
      expect(section, `missing ISS-1153 anchor: ${anchor}`).toContain(anchor);
    }
  });

  it("ISS-1153: the observation paragraph names the WRITER and both caveats", async () => {
    const { section } = extractSection(await skill(), WAKE_HEADING);
    const paragraph = extractParagraph(section, OBSERVATION_MARKER);
    // Non-empty FIRST: an empty slice makes every anchor below vacuous.
    expect(paragraph.trim().length).toBeGreaterThan(0);
    for (const anchor of OBSERVATION_ANCHORS) {
      expect(paragraph, `observation paragraph missing: ${anchor}`).toContain(anchor);
    }
  });

  it("ISS-1153: the boundary paragraph names all three requirements and all three ways to miss", async () => {
    const { section } = extractSection(await skill(), WAKE_HEADING);
    const paragraph = extractParagraph(section, BOUNDARY_MARKER);
    expect(paragraph.trim().length).toBeGreaterThan(0);
    for (const anchor of BOUNDARY_ANCHORS) {
      expect(paragraph, `boundary paragraph missing: ${anchor}`).toContain(anchor);
    }
  });

  it("ISS-1132: the opting-in paragraph itself says where to check and what is refused", async () => {
    const { section } = extractSection(await skill(), WAKE_HEADING);
    const paragraph = extractParagraph(section, OPTING_IN_MARKER);
    // Non-empty FIRST: an empty slice would make every anchor below vacuous,
    // which is the failure this whole file exists to prevent.
    expect(paragraph.trim().length).toBeGreaterThan(0);
    for (const anchor of OPTING_IN_ANCHORS) {
      expect(paragraph, `opting-in paragraph missing: ${anchor}`).toContain(anchor);
    }
  });

  it("states the tier is opt-in per endpoint via the documented flag", async () => {
    const table = extractTableBlock(await skill(), "wake (idle)");
    expect(table).toContain("bus setup --wake idle");
  });
});
