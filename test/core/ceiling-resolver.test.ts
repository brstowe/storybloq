import { describe, it, expect } from "vitest";
import { resolveCeiling, type ResolveCeilingInput } from "../../src/core/session-intel/ceiling-resolver.js";
import { resolveSessionIntelConfig } from "../../src/core/session-intel/config.js";
import type { LedgerEntry } from "../../src/core/session-intel/boundary-ledger.js";

const cfg = resolveSessionIntelConfig(null);
const T0 = Date.parse("2026-09-09T12:00:00Z");
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();
const ME = "me";

function entry(sessionId: string, minute: number, pre: number, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return { sessionId, era: "1:2", captureKind: "startup", timestamp: at(minute), trigger: "auto", preTokens: pre, postTokens: 30_000, autoCompactWindowAtStart: 450_000, ...over };
}

function input(over: Partial<ResolveCeilingInput> = {}): ResolveCeilingInput {
  return {
    sessionId: ME,
    target: { era: "1:2", capture: { captureKind: "startup", autoCompactWindowAtStart: 450_000, capturedAt: at(-10) } },
    ledger: [],
    liveSetting: null,
    lastAssistantModel: "claude-opus-5",
    oneMillionFlag: null,
    modelEvidence: "none",
    highWaterMark: null,
    cfg,
    ...over,
  };
}

describe("resolveCeiling precedence", () => {
  it("measured-session: median of this session's auto boundaries in the target era; auto-only differs from all", () => {
    const ledger = [entry(ME, 1, 410_000), entry(ME, 2, 420_000), entry(ME, 3, 430_000), entry(ME, 4, 331_000, { trigger: "manual" }), entry(ME, 5, 100, { trigger: "unknown" })];
    const r = resolveCeiling(input({ ledger }));
    expect(r).toMatchObject({ source: "measured-session", ceiling: 420_000, confidence: "high", sampleCount: 3, effectiveSampleWindow: 3, conflict: null });
    expect(r.basis).toMatch(/window 3 of 20 configured/);
    expect(resolveCeiling(input({ ledger: ledger.slice(0, 2) }))).toMatchObject({ confidence: "medium", ceiling: 415_000 });
  });

  it("era-keyed: a 368,739 boundary from the 400k era never pools with the 450k-era capture; unclassified never pools; a new era ignores prior measurements", () => {
    const ledger = [entry(ME, 1, 368_739, { era: "1:1", autoCompactWindowAtStart: 400_000 }), entry(ME, 2, 368_739, { era: null })];
    const r = resolveCeiling(input({ ledger }));
    expect(r.source).toBe("setting");
    expect(r.ceiling).toBeCloseTo(0.925 * 450_000);
    // Same ledger, target era null: measured-session is impossible.
    expect(resolveCeiling(input({ ledger: [entry(ME, 1, 417_000)], target: { era: null, capture: input().target.capture } })).source).toBe("setting");
  });

  it("measured-project requires >= 2 sessions and >= 5 startup-captured, era-stamped boundaries with the SAME window; late entries are excluded", () => {
    const others = [entry("a", 1, 415_000), entry("a", 2, 416_000), entry("a", 3, 417_000), entry("b", 4, 418_000), entry("b", 5, 419_000)];
    expect(resolveCeiling(input({ ledger: others }))).toMatchObject({ source: "measured-project", ceiling: 417_000, confidence: "medium", independentSessions: 2, sampleCount: 5 });
    expect(resolveCeiling(input({ ledger: [...others, entry("c", 6, 420_000)] })).confidence).toBe("high");
    expect(resolveCeiling(input({ ledger: others.slice(0, 4) })).source).toBe("setting");
    expect(resolveCeiling(input({ ledger: others.map((e) => ({ ...e, sessionId: "a" })) })).source).toBe("setting");
    expect(resolveCeiling(input({ ledger: others.map((e) => ({ ...e, captureKind: "late" as const })) })).source).toBe("setting");
    expect(resolveCeiling(input({ ledger: others.map((e) => ({ ...e, autoCompactWindowAtStart: 400_000 })) })).source).toBe("setting");
    expect(resolveCeiling(input({ ledger: others.map((e) => ({ ...e, era: null })) })).source).toBe("setting");
    // Diversity is judged on the SELECTED window: one session supplying every
    // newest boundary, with two other sessions only in older entries, does not qualify.
    const small = resolveSessionIntelConfig({ boundarySampleCount: 5 });
    const skewed = [entry("x", 1, 400_000), entry("y", 2, 401_000), ...Array.from({ length: 5 }, (_, i) => entry("a", 10 + i, 417_000))];
    expect(resolveCeiling(input({ ledger: skewed, cfg: small })).source).toBe("setting");
    // Unknown-trigger boundaries never pool.
    expect(resolveCeiling(input({ ledger: others.map((e) => ({ ...e, trigger: "unknown" as const })) })).source).toBe("setting");
    // Absent capture: project path skipped entirely.
    expect(resolveCeiling(input({ ledger: others, target: { era: "1:2", capture: null } })).source).toBe("model");
  });

  it("setting: startup high, late medium, live read medium with its basis", () => {
    expect(resolveCeiling(input())).toMatchObject({ source: "setting", confidence: "high", autoCompactWindowAtStart: 450_000, captureKind: "startup" });
    expect(resolveCeiling(input({ target: { era: "1:2", capture: { captureKind: "late", autoCompactWindowAtStart: 450_000, capturedAt: at(0) } } }))).toMatchObject({ confidence: "medium" });
    const live = resolveCeiling(input({ target: { era: null, capture: null }, liveSetting: { value: 400_000, basis: "live read, no capture" } }));
    expect(live).toMatchObject({ source: "setting", confidence: "medium", ceiling: 0.925 * 400_000 });
    expect(live.basis).toMatch(/live read, no capture/);
  });

  it("model: 1M flag only from evidence; full medium, tail low, none computes for 200k with a conflict", () => {
    const noCapture = { era: null, capture: null };
    expect(resolveCeiling(input({ target: noCapture, oneMillionFlag: true, modelEvidence: "full" }))).toMatchObject({ source: "model", nativeWindow: 1_000_000, confidence: "medium", conflict: null });
    expect(resolveCeiling(input({ target: noCapture, oneMillionFlag: false, modelEvidence: "tail" }))).toMatchObject({ nativeWindow: 200_000, confidence: "low" });
    expect(resolveCeiling(input({ target: noCapture, modelEvidence: "none" }))).toMatchObject({ nativeWindow: 200_000, confidence: "low", conflict: "no model-window evidence", ceiling: 185_000 });
  });

  it("a model change with a window set leaves the ceiling unchanged", () => {
    const a = resolveCeiling(input({ lastAssistantModel: "claude-opus-5" }));
    const b = resolveCeiling(input({ lastAssistantModel: "claude-sonnet-5", oneMillionFlag: true, modelEvidence: "full" }));
    expect(b.ceiling).toBe(a.ceiling);
    expect(b.source).toBe("setting");
  });

  it("overshoot never promotes: HWM above the forecast keeps the ceiling and raises the conflict, never a 1M jump", () => {
    const r = resolveCeiling(input({ highWaterMark: 460_000 }));
    expect(r.ceiling).toBeCloseTo(416_250);
    expect(r.conflict).toBe("high-water exceeds forecast");
    expect(r.nativeWindow).toBeNull();
    const model = resolveCeiling(input({ target: { era: null, capture: null }, modelEvidence: "none", highWaterMark: 250_000 }));
    expect(model.conflict).toBe("no model-window evidence; high-water exceeds forecast");
    expect(model.ceiling).toBe(185_000);
  });

  it("ISS-1197 commit 3: a HWM above the forecast raises only the conflict, and never the basis note", () => {
    const r = resolveCeiling(input({ highWaterMark: 460_000 }));
    expect(r.ceiling).toBeCloseTo(416_250);
    expect(r.basis).not.toMatch(/raised to observed boundary/);
  });

  it("nothing at all is unknown", () => {
    const r = resolveCeiling(input({ target: { era: null, capture: null }, lastAssistantModel: null }));
    expect(r).toMatchObject({ source: "unknown", ceiling: null, confidence: null });
  });

  it("config fallbacks are surfaced in basis", () => {
    const bad = resolveSessionIntelConfig({ advisoryPct: 0.9, imperativePct: 0.8 });
    expect(resolveCeiling(input({ cfg: bad })).basis).toMatch(/config: sessionIntel.imperativePct/);
  });
});

/**
 * ISS-1197 commit 3 (acceptance c): an auto boundary is a MEASUREMENT of where
 * compaction actually fired. A forecast below one this session has already
 * passed is not a forecast in conflict with the evidence, it is a forecast the
 * evidence has replaced, and leaving it made a session read "97%" of a point it
 * was already past. The boundary is era-agnostic on purpose: when it belongs to
 * a previous era, measured-session cannot use it and the resolver falls through
 * to the forecast, which is exactly the case that went wrong in the field.
 */
describe("ISS-1197 commit 3: an observed auto boundary raises the forecast it disproves", () => {
  const FORECAST = 0.925 * 450_000; // 416,250, the `setting` source
  /** Attributed to a DIFFERENT era, so measured-session cannot consume it. */
  const priorEra = (pre: number, over: Partial<LedgerEntry> = {}) => entry(ME, 1, pre, { era: "9:9", ...over });

  it("raises the ceiling to the boundary, names it in basis, and drops the exceeds-forecast conflict", () => {
    // Above the 416,250 forecast and inside the 450,000 window that bounds
    // the raise: a boundary above the window itself is refused, not raised.
    const pre = 445_000;
    const r = resolveCeiling(input({ ledger: [priorEra(pre)], highWaterMark: pre }));
    expect(r.source).toBe("setting");
    expect(r.ceiling).toBe(pre);
    expect(r.basis).toMatch(new RegExp(`raised to observed boundary ${pre}`));
    // The high-water mark is judged against the RAISED ceiling, so the
    // "exceeds forecast" conflict the old code raised here is gone.
    expect(r.conflict).toBeNull();
    // A high-water mark still above the raised ceiling keeps conflicting.
    expect(resolveCeiling(input({ ledger: [priorEra(pre)], highWaterMark: pre + 1 })).conflict).toBe("high-water exceeds forecast");
  });

  it("the field case: an auto boundary at 416,642 against the 416,250 forecast lands at 416,642", () => {
    const r = resolveCeiling(input({ ledger: [priorEra(416_642)] }));
    expect(FORECAST).toBe(416_250);
    expect(r.ceiling).toBe(416_642);
    expect(r.basis).toMatch(/raised to observed boundary 416642/);
    expect(r.confidence).toBe("high"); // unchanged by the raise
    expect(r.source).toBe("setting");
  });

  it("a MANUAL boundary above the forecast never raises: a user compacting early measures nothing about the fire point", () => {
    const r = resolveCeiling(input({ ledger: [priorEra(500_000, { trigger: "manual" })] }));
    expect(r.ceiling).toBeCloseTo(FORECAST);
    expect(r.basis).not.toMatch(/raised to observed boundary/);
    // Same for an unclassified trigger.
    expect(resolveCeiling(input({ ledger: [priorEra(500_000, { trigger: "unknown" })] })).ceiling).toBeCloseTo(FORECAST);
  });

  it("only THIS session's boundaries raise, and only when they exceed the resolved ceiling", () => {
    expect(resolveCeiling(input({ ledger: [entry("other", 1, 500_000, { era: "9:9" })] })).ceiling).toBeCloseTo(FORECAST);
    // At or below the forecast there is nothing to replace.
    expect(resolveCeiling(input({ ledger: [priorEra(416_250)] })).basis).not.toMatch(/raised to observed boundary/);
    expect(resolveCeiling(input({ ledger: [priorEra(400_000)] })).ceiling).toBeCloseTo(FORECAST);
  });

  it("measured-session keeps its median: the raise replaces a FORECAST, never this session's own measurement", () => {
    // 410k/420k/430k in the target era: the median is the deliberate robust
    // estimator of where the NEXT compaction fires, and the 430k observation
    // is one of the samples it already weighed. Re-maxing it would turn the
    // median into a max on nearly every real ledger.
    const ledger = [entry(ME, 1, 410_000), entry(ME, 2, 420_000), entry(ME, 3, 430_000)];
    const r = resolveCeiling(input({ ledger }));
    expect(r).toMatchObject({ source: "measured-session", ceiling: 420_000 });
    expect(r.basis).not.toMatch(/raised to observed boundary/);
  });

  it("measured-project IS raised: other sessions' median says nothing about what this session has passed", () => {
    const others = [entry("a", 1, 415_000), entry("a", 2, 416_000), entry("a", 3, 417_000), entry("b", 4, 418_000), entry("b", 5, 419_000)];
    const r = resolveCeiling(input({ ledger: [...others, priorEra(440_000)] }));
    expect(r.source).toBe("measured-project");
    expect(r.ceiling).toBe(440_000);
    expect(r.basis).toMatch(/raised to observed boundary 440000/);
  });

  it("the floor is the MAX of this session's boundaries, not the first one seen", () => {
    // Lower boundary first, so a first-wins reduction lands on 430,000.
    const r = resolveCeiling(input({ ledger: [priorEra(430_000), entry(ME, 2, 445_000, { era: "9:9" })] }));
    expect(r.ceiling).toBe(445_000);
    expect(r.basis).toMatch(/raised to observed boundary 445000/);
  });
});

/**
 * ISS-1197 commit 3 gate (byte-review MAJOR): the floor is a measurement of a
 * SPECIFIC window. Carrying it across a window change inflates the ceiling of
 * the new one, and a ceiling above the real fire point is worse than no
 * learning at all: it suppresses advisory, imperative and compact-needed right
 * through the compaction it was meant to predict.
 */
describe("ISS-1197 commit 3: the raise is scoped to the window it was measured under", () => {
  /** The user lowered autoCompactWindow to 200,000 and resumed. */
  const shrunk = (over: Partial<ResolveCeilingInput> = {}) =>
    input({ target: { era: "2:2", capture: { captureKind: "startup", autoCompactWindowAtStart: 200_000, capturedAt: at(-10) } }, ...over });
  /** No capture and no live setting: the resolver falls to the model path. */
  const modelPath = (over: Partial<ResolveCeilingInput> = {}) =>
    input({ target: { era: null, capture: null }, oneMillionFlag: false, modelEvidence: "full", ...over });

  it("a 450k-window boundary never raises a session that restarted at 200k", () => {
    const r = resolveCeiling(shrunk({ ledger: [entry(ME, 1, 416_642, { era: "9:9", autoCompactWindowAtStart: 450_000 })] }));
    expect(r.source).toBe("setting");
    expect(r.ceiling).toBeCloseTo(0.925 * 200_000); // 185,000, the honest forecast
    expect(r.basis).not.toMatch(/raised to observed boundary/);
  });

  it("the grow direction is unaffected: a 200k-window boundary leaves the 450k forecast alone", () => {
    const r = resolveCeiling(input({ ledger: [entry(ME, 1, 185_000, { era: "9:9", autoCompactWindowAtStart: 200_000 })] }));
    expect(r.ceiling).toBeCloseTo(0.925 * 450_000);
    expect(r.basis).not.toMatch(/raised to observed boundary/);
  });

  it("a null window on either side still counts (the gate skips only a known mismatch)", () => {
    expect(resolveCeiling(input({ ledger: [entry(ME, 1, 445_000, { era: "9:9", autoCompactWindowAtStart: null })] })).ceiling).toBe(445_000);
    // Target side null: the model path has no window at all.
    expect(resolveCeiling(modelPath({ ledger: [entry(ME, 1, 190_000, { era: "9:9" })] })).ceiling).toBe(190_000);
  });

  it("a null-window entry is bounded by the TARGET window, not waved through", () => {
    // query.ts stamps every boundary outside the live era with era null and
    // autoCompactWindowAtStart null, and capture.ts does the same when the
    // window read fails, so this is the common shape, not a corner. Unbounded
    // it would hold a 200,000-window session's ceiling at 416,642 while
    // compaction fires at 185,000.
    const shrunkTarget = { era: "2:2", capture: { captureKind: "startup" as const, autoCompactWindowAtStart: 200_000, capturedAt: at(-10) } };
    const orphan = (pre: number) => entry(ME, 1, pre, { era: null, autoCompactWindowAtStart: null });
    const refused = resolveCeiling(input({ target: shrunkTarget, ledger: [orphan(416_642)] }));
    expect(refused.ceiling).toBeCloseTo(185_000);
    expect(refused.basis).not.toMatch(/raised to observed boundary/);
    // At or below the target window it is still a usable measurement.
    expect(resolveCeiling(input({ target: shrunkTarget, ledger: [orphan(190_000)] })).ceiling).toBe(190_000);
  });

  it("measured-project is bounded the same way", () => {
    const pool = [180_000, 181_000, 182_000, 183_000, 184_000].map((p, i) =>
      entry(i < 3 ? "a" : "b", i + 1, p, { autoCompactWindowAtStart: 200_000 }),
    );
    const target = { era: "2:2", capture: { captureKind: "startup" as const, autoCompactWindowAtStart: 200_000, capturedAt: at(-10) } };
    const orphan = (pre: number) => entry(ME, 9, pre, { era: null, autoCompactWindowAtStart: null });
    const refused = resolveCeiling(input({ target, ledger: [...pool, orphan(416_642)] }));
    expect(refused.source).toBe("measured-project");
    expect(refused.ceiling).toBe(182_000);
    expect(refused.basis).not.toMatch(/raised to observed boundary/);
    expect(resolveCeiling(input({ target, ledger: [...pool, orphan(190_000)] })).ceiling).toBe(190_000);
  });

  it("the live-setting path is scoped to the live setting's own window", () => {
    const r = resolveCeiling(
      input({
        target: { era: null, capture: null },
        liveSetting: { value: 200_000, basis: "live read, unbound" },
        ledger: [entry(ME, 1, 416_642, { era: "9:9", autoCompactWindowAtStart: 450_000 })],
      }),
    );
    expect(r.source).toBe("setting");
    expect(r.ceiling).toBeCloseTo(185_000);
    expect(r.basis).not.toMatch(/raised to observed boundary/);
    // null-window orphan: bounded by the live setting. The entry-side gate
    // cannot help here (its window is unknown), so only the bound refuses it.
    expect(
      resolveCeiling(
        input({
          target: { era: null, capture: null },
          liveSetting: { value: 200_000, basis: "live read, unbound" },
          ledger: [entry(ME, 1, 416_642, { era: null, autoCompactWindowAtStart: null })],
        }),
      ).ceiling,
    ).toBeCloseTo(185_000);
  });

  it("the bound is inclusive: a boundary exactly at the native window raises", () => {
    const r = resolveCeiling(modelPath({ ledger: [entry(ME, 1, 200_000, { era: "9:9", autoCompactWindowAtStart: null })] }));
    expect(r.ceiling).toBe(200_000);
    expect(r.basis).toMatch(/raised to observed boundary 200000/);
  });

  it("the model path REFUSES a boundary above the native window rather than clamping to it", () => {
    // The 1M-flag era compacted at 830,000; this process resumed without the
    // flag, so 200,000 is the whole context. That boundary is evidence about a
    // different window state, not about this one, so it has no bearing here:
    // the forecast stands, unraised and unannotated. Clamping to 200,000 would
    // report a number no evidence supports.
    const r = resolveCeiling(modelPath({ ledger: [entry(ME, 1, 830_000, { era: "9:9", autoCompactWindowAtStart: 1_000_000 })] }));
    expect(r.source).toBe("model");
    expect(r.ceiling).toBe(185_000); // 0.925 x 200,000, untouched
    expect(r.basis).not.toMatch(/raised to observed boundary/);
    expect(r.basis).not.toMatch(/clamped to native window/);
  });
});
