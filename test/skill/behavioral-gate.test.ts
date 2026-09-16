/**
 * T-498 Commit 4: the 5c behavioural gate runner + fixtures.
 *
 * These tests exercise the real, in-process MCP path (McpServer +
 * registerAllTools, real `.story/` fixtures) that `runRedProof` and
 * `captureInvocationBundle` themselves use -- `gitLogMode: "fixture"`
 * means no real git process is touched, so no child-process isolation is
 * needed the way priming-cost.test.ts's CLI-level determinism tests
 * require it. The four fixture roots are hand-authored and ground-truthed
 * directly against `storybloq_recommend` / `storybloq_handover_latest`
 * (see each fixture's own handovers); the values pinned below are exactly
 * what that ground-truthing produced, not assumed.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  FIXTURES,
  captureInvocationBundle,
  renderPromptForBundle,
  scoreTranscript,
  runRedProof,
  UNAUTHORIZED_DISPATCHER,
  runOneSession,
  type FixtureSpec,
  type InvocationBundle,
} from "../../scripts/behavioral-gate.js";

const SKILL_PATH = resolve(__dirname, "../../src/skill/SKILL.md");

describe("FIXTURES catalog", () => {
  it("names the four shapes required by plan-t498.md rev 7", () => {
    expect(FIXTURES.map((f) => f.name)).toEqual([
      "deferred-item",
      "idless-decision",
      "abandoned-no-reversal",
      "abandoned-intermediate-reversal",
    ]);
  });

  it("only fixtures 2/3 declare reconciliation evidence (a decisive handover); 1/4 declare a line-one expectation", () => {
    const byName = Object.fromEntries(FIXTURES.map((f) => [f.name, f]));
    expect(byName["deferred-item"]?.evidence).toEqual({
      kind: "line-one",
      expectedId: "T-3002",
      expectedLabelIncludes: "CSV export",
    });
    expect(byName["idless-decision"]?.evidence).toEqual({
      kind: "line-one",
      expectedId: null,
      expectedLabelIncludes: "backfill",
    });
    expect(byName["abandoned-no-reversal"]?.evidence).toEqual({
      kind: "reconciliation",
      decisiveHandoverFilename: "2026-08-05-day5.md",
    });
    expect(byName["abandoned-intermediate-reversal"]?.evidence).toEqual({
      kind: "reconciliation",
      decisiveHandoverFilename: "2026-08-08-day8.md",
    });
  });
});

describe("runRedProof: deterministic RED proof, ground-truthed per fixture", () => {
  it("deferred-item: naive ranking picks the wrong ticket; the two-call shape resolves the deferred item directly", async () => {
    const fixture = FIXTURES.find((f) => f.name === "deferred-item")!;
    const result = await runRedProof(fixture, SKILL_PATH);
    expect(result.rankingTopId).toBe("T-3001");
    expect(result.rankingTopId).not.toBe(fixture.correctAnswer);
    expect(result.oldShapeReachesDecisiveHandover).toBeNull();
    expect(result.newShapeSurfacesEvidence).toBe(true);
    expect(result.newShapeDetail).toContain("T-3002");
  });

  it("idless-decision: naive ranking names a ticket id, but the correct answer is an id-less decision the two-call shape still resolves", async () => {
    const fixture = FIXTURES.find((f) => f.name === "idless-decision")!;
    const result = await runRedProof(fixture, SKILL_PATH);
    expect(result.rankingTopId).toBe("T-4001");
    expect(result.oldShapeReachesDecisiveHandover).toBeNull();
    expect(result.newShapeSurfacesEvidence).toBe(true);
    expect(result.newShapeDetail).toContain("id-less decision");
    expect(result.newShapeDetail).toContain("backfill");
  });

  it("abandoned-no-reversal: the pre-T-498 count:3 shape never reaches day5's abandonment; reconciliation recovery does", async () => {
    const fixture = FIXTURES.find((f) => f.name === "abandoned-no-reversal")!;
    const result = await runRedProof(fixture, SKILL_PATH);
    expect(result.rankingTopId).toBe("T-5001");
    expect(result.rankingTopId).not.toBe(fixture.correctAnswer);
    expect(result.oldShapeFilenames).toEqual(["2026-08-10-day10.md", "2026-08-09-day9.md", "2026-08-08-day8.md"]);
    expect(result.oldShapeReachesDecisiveHandover).toBe(false);
    expect(result.newShapeSurfacesEvidence).toBe(true);
    expect(result.newShapeDetail).toContain("2026-08-05-day5.md");
  });

  it("abandoned-intermediate-reversal: naive ranking coincides with the correct ticket, but the old shape's 3-window happens to reach the reversal too -- only reconciliation recovery proves it was actually surfaced, not merely lucky", async () => {
    const fixture = FIXTURES.find((f) => f.name === "abandoned-intermediate-reversal")!;
    const result = await runRedProof(fixture, SKILL_PATH);
    expect(result.rankingTopId).toBe("T-5001");
    expect(result.rankingTopId).toBe(fixture.correctAnswer);
    expect(result.oldShapeFilenames).toEqual(["2026-08-10-day10.md", "2026-08-09-day9.md", "2026-08-08-day8.md"]);
    expect(result.oldShapeReachesDecisiveHandover).toBe(true);
    expect(result.newShapeSurfacesEvidence).toBe(true);
    expect(result.newShapeDetail).toContain("2026-08-08-day8.md");
  });

  it("Codex round 1 finding: newShapeSurfacesEvidence validates the SPECIFIC expected candidate, not just that something resolved", async () => {
    const realFixture = FIXTURES.find((f) => f.name === "deferred-item")!;
    // Line one genuinely resolves T-3002 on this fixture -- a mismatched
    // expectation must report false, proving the check discriminates
    // rather than passing on any non-null resolution.
    const wrongIdFixture: FixtureSpec = {
      ...realFixture,
      evidence: { kind: "line-one", expectedId: "T-9999", expectedLabelIncludes: "CSV export" },
    };
    const wrongLabelFixture: FixtureSpec = {
      ...realFixture,
      evidence: { kind: "line-one", expectedId: "T-3002", expectedLabelIncludes: "something unrelated" },
    };
    const wrongIdResult = await runRedProof(wrongIdFixture, SKILL_PATH);
    const wrongLabelResult = await runRedProof(wrongLabelFixture, SKILL_PATH);
    expect(wrongIdResult.newShapeSurfacesEvidence).toBe(false);
    expect(wrongLabelResult.newShapeSurfacesEvidence).toBe(false);
  });
});

describe("captureInvocationBundle: oracle vs brief arm shape", () => {
  const fixture = FIXTURES.find((f) => f.name === "abandoned-no-reversal")!;

  it("oracle arm captures every handover's full raw body, filename-keyed", async () => {
    const bundle = await captureInvocationBundle(fixture, "oracle", SKILL_PATH);
    expect(bundle.arm).toBe("oracle");
    expect(bundle.fullBodies).toBeDefined();
    const filenames = bundle.briefHandovers.map((h) => h.filename);
    expect(Object.keys(bundle.fullBodies!).sort()).toEqual([...filenames].sort());
    expect(bundle.fullBodies!["2026-08-05-day5.md"]).toContain("Zephyr templating library");
  });

  it("brief arm never carries fullBodies", async () => {
    const bundle = await captureInvocationBundle(fixture, "brief", SKILL_PATH);
    expect(bundle.arm).toBe("brief");
    expect(bundle.fullBodies).toBeUndefined();
  });

  it("both arms get the same skill text and recommend/handover data (only body availability differs)", async () => {
    const oracle = await captureInvocationBundle(fixture, "oracle", SKILL_PATH);
    const brief = await captureInvocationBundle(fixture, "brief", SKILL_PATH);
    expect(oracle.skillText).toBe(brief.skillText);
    expect(oracle.recommendRows).toEqual(brief.recommendRows);
    expect(oracle.briefHandovers).toEqual(brief.briefHandovers);
    expect(oracle.primingBody).toEqual(brief.primingBody);
    expect(oracle.unreadableHandoverCount).toEqual(brief.unreadableHandoverCount);
    expect(oracle.trajectory).toEqual(brief.trajectory);
  });

  it("Codex round 1 finding: trajectory is captured (not dropped) on the real fixture", async () => {
    const bundle = await captureInvocationBundle(fixture, "brief", SKILL_PATH);
    expect(Array.isArray(bundle.trajectory)).toBe(true);
    expect(bundle.trajectory.some((t) => t.id === "T-5001")).toBe(true);
  });
});

describe("renderPromptForBundle", () => {
  const baseBundle: InvocationBundle = {
    fixture: "test-fixture",
    arm: "brief",
    skillText: "SKILL TEXT HERE",
    recommendRows: [{ id: "T-1", kind: "ticket", title: "Do the thing", reason: "quick win" }],
    excludedRows: [],
    unreadableHandoverCount: 2,
    primingBody: "priming body text",
    briefHandovers: [{ filename: "2026-08-10-day10.md", form: "raw", body: "raw body text" }],
    trajectory: [{ id: "T-1", occurrenceCount: 3, firstSeenInWindow: "2026-08-08-day8.md", latest: "2026-08-10-day10.md", latestDisposition: "continuation" }],
  };

  it("renders skill text, recommend result, and both handover_latest calls, in order", () => {
    const prompt = renderPromptForBundle(baseBundle);
    const skillIdx = prompt.indexOf("SKILL TEXT HERE");
    const recommendIdx = prompt.indexOf("storybloq_recommend result");
    const primingIdx = prompt.indexOf("count: 1, priming: true");
    const briefIdx = prompt.indexOf("count: 10, brief: true");
    const taskIdx = prompt.indexOf("# Task");
    expect(skillIdx).toBeGreaterThanOrEqual(0);
    expect(skillIdx).toBeLessThan(recommendIdx);
    expect(recommendIdx).toBeLessThan(primingIdx);
    expect(primingIdx).toBeLessThan(briefIdx);
    expect(briefIdx).toBeLessThan(taskIdx);
    expect(prompt).toContain("Do the thing");
    expect(prompt).toContain("priming body text");
  });

  it("Codex round 1 finding: the recommend block carries unreadableHandoverCount and the brief block carries trajectory (both were dropped by the earlier reconstruction)", () => {
    const prompt = renderPromptForBundle(baseBundle);
    const recommendBlock = prompt.slice(
      prompt.indexOf("storybloq_recommend result"),
      prompt.indexOf("storybloq_handover_latest result (count: 1"),
    );
    expect(recommendBlock).toContain('"unreadableHandoverCount": 2');
    const briefBlock = prompt.slice(prompt.indexOf("storybloq_handover_latest result (count: 10"));
    expect(briefBlock).toContain('"trajectory"');
    expect(briefBlock).toContain('"occurrenceCount": 3');
  });

  it("omits the oracle-only extra-material block for the brief arm", () => {
    const prompt = renderPromptForBundle(baseBundle);
    expect(prompt).not.toContain("Extra material (oracle arm only)");
  });

  it("includes every full raw body, after the two tool-result blocks, for the oracle arm", () => {
    const oracleBundle: InvocationBundle = {
      ...baseBundle,
      arm: "oracle",
      fullBodies: { "2026-08-10-day10.md": "the full raw handover body" },
    };
    const prompt = renderPromptForBundle(oracleBundle);
    expect(prompt).toContain("Extra material (oracle arm only)");
    expect(prompt).toContain("the full raw handover body");
    const briefIdx = prompt.indexOf("count: 10, brief: true");
    const extraIdx = prompt.indexOf("Extra material (oracle arm only)");
    expect(briefIdx).toBeLessThan(extraIdx);
  });
});

describe("scoreTranscript", () => {
  const noHandoverFixture: FixtureSpec = {
    name: "deferred-item",
    root: "/mock-root",
    correctAnswer: "T-3002",
    evidence: { kind: "line-one", expectedId: "T-3002", expectedLabelIncludes: "CSV export" },
  };
  const withHandoverFixture: FixtureSpec = {
    name: "abandoned-no-reversal",
    root: "/mock-root",
    correctAnswer: "T-5002",
    evidence: { kind: "reconciliation", decisiveHandoverFilename: "2026-08-05-day5.md" },
  };

  it("passes when the transcript names the correct answer and no handover citation is required", () => {
    const result = scoreTranscript("I'll work on T-3002 next, the CSV export quick action.", noHandoverFixture);
    expect(result.pass).toBe(true);
    expect(result.namedCorrectAlternative).toBe(true);
    expect(result.citedDecisiveHandover).toBe(true);
  });

  it("fails when the transcript never names the correct answer", () => {
    const result = scoreTranscript("I'll work on T-3001 next.", noHandoverFixture);
    expect(result.pass).toBe(false);
    expect(result.namedCorrectAlternative).toBe(false);
    expect(result.reason).toContain("T-3002");
  });

  it("matching is case-insensitive", () => {
    const result = scoreTranscript("i'll work on t-3002 next.", noHandoverFixture);
    expect(result.namedCorrectAlternative).toBe(true);
  });

  it("fails when the correct alternative is named but the decisive handover is not cited", () => {
    const result = scoreTranscript("T-5002 is the right next step, since T-5001 was dropped.", withHandoverFixture);
    expect(result.namedCorrectAlternative).toBe(true);
    expect(result.citedDecisiveHandover).toBe(false);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("2026-08-05-day5.md");
  });

  it("passes only when both the correct alternative and the decisive handover are present", () => {
    const result = scoreTranscript(
      "T-5002 is next; 2026-08-05-day5.md recorded T-5001 as abandoned.",
      withHandoverFixture,
    );
    expect(result.pass).toBe(true);
    expect(result.namedCorrectAlternative).toBe(true);
    expect(result.citedDecisiveHandover).toBe(true);
  });

  // Widened after the real 5c run (2026-09-13): every "did not cite" failure
  // in that run correctly named the alternative, stated the full abandonment
  // reasoning, and attributed it to the decisive handover by date or day
  // label -- just never spelled out the literal filename. The rubric is
  // "names the correct alternative AND attributes it to the specific older
  // handover"; date/day-label/filename-without-extension are all valid
  // attribution, not just the exact filename string.
  it("accepts the decisive handover's filename without the .md extension", () => {
    const result = scoreTranscript("T-5002 is next; 2026-08-05-day5 recorded the abandonment.", withHandoverFixture);
    expect(result.citedDecisiveHandover).toBe(true);
    expect(result.pass).toBe(true);
  });

  it("accepts the decisive handover's ISO date alone", () => {
    const result = scoreTranscript("T-5002 is next; the 2026-08-05 handover recorded the abandonment.", withHandoverFixture);
    expect(result.citedDecisiveHandover).toBe(true);
    expect(result.pass).toBe(true);
  });

  it("accepts the decisive handover's day-label with no space (day5)", () => {
    const result = scoreTranscript("T-5002 is next; day5 recorded the abandonment.", withHandoverFixture);
    expect(result.citedDecisiveHandover).toBe(true);
    expect(result.pass).toBe(true);
  });

  it("accepts the decisive handover's day-label with a space (day 5), case-insensitively", () => {
    const result = scoreTranscript("T-5002 is next; Day 5 recorded the abandonment.", withHandoverFixture);
    expect(result.citedDecisiveHandover).toBe(true);
    expect(result.pass).toBe(true);
  });

  it("still rejects a quote of the abandonment reasoning with no date, day label, or filename attribution", () => {
    const result = scoreTranscript(
      "T-5002 is next. The report templates work was abandoned in favor of hand-writing the templates instead, because legal confirmed the license terms are incompatible with how we ship.",
      withHandoverFixture,
    );
    expect(result.namedCorrectAlternative).toBe(true);
    expect(result.citedDecisiveHandover).toBe(false);
    expect(result.pass).toBe(false);
  });

  it("rejects a DIFFERENT handover's date even though it is inside the same fixture's date window (kills an 'any date in window' mutant)", () => {
    const result = scoreTranscript(
      "T-5002 is next. The 2026-08-06 handover confirms the Zephyr dependency was already removed from the lockfile.",
      withHandoverFixture,
    );
    expect(result.namedCorrectAlternative).toBe(true);
    expect(result.citedDecisiveHandover).toBe(false);
    expect(result.pass).toBe(false);
  });

  // Codex round 4 finding: a plain substring check on the short forms
  // accepts an adjacent-digit false positive ("day5" inside "day50").
  it("rejects 'day50' as a citation of 'day5' (adjacent-digit false positive)", () => {
    const result = scoreTranscript("T-5002 is next; day50 recorded the abandonment.", withHandoverFixture);
    expect(result.namedCorrectAlternative).toBe(true);
    expect(result.citedDecisiveHandover).toBe(false);
    expect(result.pass).toBe(false);
  });

  it("rejects 'day 50' as a citation of 'day 5' (adjacent-digit false positive, spaced form)", () => {
    const result = scoreTranscript("T-5002 is next; day 50 recorded the abandonment.", withHandoverFixture);
    expect(result.namedCorrectAlternative).toBe(true);
    expect(result.citedDecisiveHandover).toBe(false);
    expect(result.pass).toBe(false);
  });

  it("rejects 'weekday5' as a citation of 'day5' (adjacent-letter false positive)", () => {
    const result = scoreTranscript("T-5002 is next; weekday5 recorded the abandonment.", withHandoverFixture);
    expect(result.namedCorrectAlternative).toBe(true);
    expect(result.citedDecisiveHandover).toBe(false);
    expect(result.pass).toBe(false);
  });

  it("still accepts 'day5' immediately followed by punctuation, not just whitespace", () => {
    const result = scoreTranscript("T-5002 is next; (day5) recorded the abandonment.", withHandoverFixture);
    expect(result.citedDecisiveHandover).toBe(true);
    expect(result.pass).toBe(true);
  });
});

describe("UNAUTHORIZED_DISPATCHER / runOneSession", () => {
  it("throws rather than launching any live session, per the pen ruling on T-498", async () => {
    await expect(UNAUTHORIZED_DISPATCHER("any prompt", "any-model")).rejects.toThrow(
      /requires explicit owner authorization/,
    );
  });

  it("runOneSession propagates the dispatcher's refusal without capturing any transcript", async () => {
    const fixture = FIXTURES.find((f) => f.name === "deferred-item")!;
    await expect(runOneSession(fixture, "brief", SKILL_PATH, "any-model", UNAUTHORIZED_DISPATCHER)).rejects.toThrow(
      /requires explicit owner authorization/,
    );
  });
});
