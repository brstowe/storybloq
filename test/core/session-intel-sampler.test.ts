import { describe, it, expect } from "vitest";
import { computeSample, handoverSuppresses, jumpAllowanceFor, p90, usageAdvisoryFrom } from "../../src/core/session-intel/sampler.js";
import { resolveSessionIntelConfig, type SessionIntelConfig } from "../../src/core/session-intel/config.js";
import { emptySessionIntel, type SessionIntelPresence } from "../../src/presence/session-intel-fields.js";
import type { CeilingResolution, ScanResult, UsageAdvisoryInput } from "../../src/core/session-intel/types.js";
import { resolveCeiling } from "../../src/core/session-intel/ceiling-resolver.js";
import type { LedgerEntry } from "../../src/core/session-intel/boundary-ledger.js";

const cfg = resolveSessionIntelConfig(null);
const NOW = "2026-09-09T12:30:00.000Z";

function ceiling(over: Partial<CeilingResolution> = {}): CeilingResolution {
  return { ceiling: 417_737, source: "measured-session", confidence: "high", sampleCount: 5, independentSessions: 1, effectiveSampleWindow: 5, basis: "test", conflict: null, autoCompactWindowAtStart: 450_000, captureKind: "startup", nativeWindow: null, highWaterMark: null, ...over };
}

function scan(contextTokens: number | null, deltas: number[] = []): ScanResult {
  return {
    observation: { era: "1:2", incarnation: "1:1", sizeAtOpen: 10, consumedOffset: 10, anchor: { offset: 10, sha256: "a".repeat(64) }, authoritative: true, revisionSeen: 0, lastRecordTimestamp: NOW, epoch: { kind: "unobserved" } },
    coverage: "tail", scannedBytes: 10, truncationReason: null, contextTokens, lastAssistantAt: NOW, lastAssistantModel: "claude-opus-5", oneMillionFlag: null, modelEvidence: "none",
    boundaries: [], deltas, highWaterMark: contextTokens,
    session: { startedAt: null, version: null, entrypoint: null, cwd: null, gitBranch: null, permissionMode: null, aiTitle: null, slug: null, bridgeSessionId: null, effort: null, models: [], turns: null, compactions: { autoObserved: 0, manualObserved: 0, unknownObserved: 0, last: null } },
  };
}

const NO_USAGE: UsageAdvisoryInput = { window: null, source: null, provenance: "none" };

const sample = (tokens: number | null, over: { deltas?: number[]; record?: SessionIntelPresence | null; ceiling?: CeilingResolution; usage?: UsageAdvisoryInput; sampledAt?: string; cfg?: SessionIntelConfig } = {}) =>
  computeSample({ scan: scan(tokens, over.deltas ?? []), ceiling: over.ceiling ?? ceiling(), cfg: over.cfg ?? cfg, sampledBy: "query", sampledAt: over.sampledAt ?? NOW, record: over.record ?? null, usage: over.usage ?? NO_USAGE });

describe("computeSample states", () => {
  it("266,711 against 417,737 is 63.8%, ok", () => {
    const s = sample(266_711);
    expect(s.pct).toBeCloseTo(0.6385, 3);
    expect(s.state).toBe("ok");
    expect(s.headroom).toBe(417_737 - 266_711);
    expect(s.jumpAllowance).toBe(25_000);
    expect(s.jumpAllowanceBasis).toMatch(/floor 25000 \(0 deltas/);
  });

  it("advisory at 70%, imperative when tokens + jump allowance reach 90% (ISS-1249: 83% is still advisory)", () => {
    expect(sample(Math.ceil(0.7 * 417_737)).state).toBe("advisory");
    expect(sample(Math.ceil(0.7 * 417_737) - 1).state).toBe("ok");
    // ISS-1249: the owner's rule is no handover before 90%; 0.85 minus the
    // allowance fired "IMPERATIVE: 83%" and read as a bug.
    expect(sample(Math.ceil(0.83 * 417_737)).state).toBe("advisory");
    const imperativeAt = Math.ceil(0.9 * 417_737) - 25_000;
    expect(sample(imperativeAt).state).toBe("imperative");
    expect(sample(imperativeAt - 1).state).toBe("advisory");
    expect(sample(imperativeAt).reason).toMatch(/\+ jump allowance 25000 >= 0.9/);
  });

  it("jump allowance is p90 of deltas since the epoch, clamped, floor under 5 deltas", () => {
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
    expect(p90([])).toBeNull();
    expect(jumpAllowanceFor([1, 2, 3, 4], cfg)).toMatchObject({ value: 25_000 });
    expect(jumpAllowanceFor([30_000, 31_000, 32_000, 33_000, 34_000], cfg).value).toBe(34_000);
    expect(jumpAllowanceFor([1, 1, 1, 1, 1], cfg)).toMatchObject({ value: 25_000, basis: expect.stringMatching(/raised to floor/) });
    expect(jumpAllowanceFor([1e6, 1e6, 1e6, 1e6, 1e6], cfg)).toMatchObject({ value: 150_000, basis: expect.stringMatching(/capped/) });
    // A big p90 pulls imperative earlier.
    const tokens = Math.ceil(0.9 * 417_737) - 100_000;
    expect(sample(tokens).state).toBe("ok");
    expect(sample(tokens, { deltas: [90_000, 100_000, 100_000, 100_000, 100_000] }).state).toBe("imperative");
  });

  it("a ceiling conflict floors state at advisory even below 70%", () => {
    const s = sample(100_000, { ceiling: ceiling({ conflict: "high-water exceeds forecast" }) });
    expect(s.state).toBe("advisory");
    expect(s.reason).toMatch(/ceiling conflict/);
  });

  it("unknown when there is no usage record or no ceiling", () => {
    expect(sample(null)).toMatchObject({ state: "unknown", pct: null, reason: expect.stringMatching(/no assistant usage/) });
    expect(sample(100, { ceiling: ceiling({ ceiling: null, source: "unknown", confidence: null }) })).toMatchObject({ state: "unknown", reason: expect.stringMatching(/ceiling unknown/) });
  });
});

describe("handover suppression", () => {
  const imperativeTokens = Math.ceil(0.9 * 417_737) - 25_000;
  const withHandover = (over: Partial<SessionIntelPresence>): SessionIntelPresence => ({
    ...emptySessionIntel(),
    handoverWrittenAt: "2026-09-09T12:20:00.000Z",
    tokensAtHandover: imperativeTokens,
    handoverBoundaryAt: null,
    lastBoundaryAt: null,
    ...over,
  });

  it("suppresses imperative to advisory while the handover belongs to the current compaction and the context has not grown a step", () => {
    const s = sample(imperativeTokens, { record: withHandover({}) });
    expect(s).toMatchObject({ rawState: "imperative", state: "advisory", suppressedBy: "handover" });
    expect(s.reason).toMatch(/suppressed by a handover/);
  });

  // ISS-1197: three independent re-arm gates. The stamp sits at 86% of a
  // 400,000 ceiling, so the effective growth step is 20,000 tokens (0.05 x
  // 400,000, under the 25,000 cap) and the re-arm line is 91% of ceiling.
  const CEILING = 400_000;
  const C = ceiling({ ceiling: CEILING });
  const STAMP_AT = "2026-09-09T12:20:00.000Z";
  const STAMP_TOKENS = Math.round(0.86 * CEILING);
  const afterStamp = (minutes: number) => new Date(Date.parse(STAMP_AT) + minutes * 60_000).toISOString();
  const pctTokens = (pct: number) => Math.round(pct * CEILING);
  const rearm = (over: Partial<SessionIntelPresence> = {}): SessionIntelPresence => ({
    ...emptySessionIntel(),
    handoverWrittenAt: STAMP_AT,
    tokensAtHandover: STAMP_TOKENS,
    handoverBoundaryAt: null,
    lastBoundaryAt: null,
    ...over,
  });

  it("holds advisory while any re-arm gate is closed and re-fires once all three clear", () => {
    for (const [i, pct] of [0.87, 0.88, 0.89].entries()) {
      const s = sample(pctTokens(pct), { ceiling: C, record: rearm({ promptsSinceHandover: i }), sampledAt: afterStamp(2) });
      expect(s, `${pct} of ceiling`).toMatchObject({ rawState: "imperative", state: "advisory", suppressedBy: "handover" });
      expect(s.reason, `${pct} of ceiling`).toMatch(/step gate/);
    }
    const rearmed = sample(pctTokens(0.92), { ceiling: C, record: rearm({ promptsSinceHandover: 3 }), sampledAt: afterStamp(11) });
    expect(rearmed).toMatchObject({ rawState: "imperative", state: "imperative", suppressedBy: null });
  });

  it("mutant-step-dropped: the growth gate alone holds the advisory at 89% eleven minutes and three prompts on", () => {
    const s = sample(pctTokens(0.89), { ceiling: C, record: rearm({ promptsSinceHandover: 3 }), sampledAt: afterStamp(11) });
    expect(s).toMatchObject({ rawState: "imperative", state: "advisory", suppressedBy: "handover" });
    expect(s.reason).toMatch(/step gate/);
  });

  it("mutant-interval-dropped: the time latch alone holds the advisory at 92% two minutes and three prompts on", () => {
    const s = sample(pctTokens(0.92), { ceiling: C, record: rearm({ promptsSinceHandover: 3 }), sampledAt: afterStamp(2) });
    expect(s).toMatchObject({ rawState: "imperative", state: "advisory", suppressedBy: "handover" });
    expect(s.reason).toMatch(/interval gate/);
  });

  it("mutant-prompt-age-dropped: the prompt count alone holds the advisory at 92% eleven minutes and two prompts on", () => {
    const s = sample(pctTokens(0.92), { ceiling: C, record: rearm({ promptsSinceHandover: 2 }), sampledAt: afterStamp(11) });
    expect(s).toMatchObject({ rawState: "imperative", state: "advisory", suppressedBy: "handover" });
    expect(s.reason).toMatch(/prompts gate/);
  });

  it("mutant-prompts-gate-ignores-hook-off: the prompt gate is skipped when the prompt hook is off, since nothing would ever advance the count", () => {
    const record = rearm({ promptsSinceHandover: 0 });
    const noHook = resolveSessionIntelConfig({ promptHook: false });
    expect(sample(pctTokens(0.92), { ceiling: C, record, sampledAt: afterStamp(11), cfg: noHook })).toMatchObject({ rawState: "imperative", state: "imperative", suppressedBy: null });
    // The same record with the hook on is held by the prompt gate.
    const held = sample(pctTokens(0.92), { ceiling: C, record, sampledAt: afterStamp(11) });
    expect(held).toMatchObject({ state: "advisory", suppressedBy: "handover" });
    expect(held.reason).toMatch(/prompts gate/);
    // The other two gates still hold with the hook off.
    expect(sample(pctTokens(0.89), { ceiling: C, record, sampledAt: afterStamp(11), cfg: noHook })).toMatchObject({ state: "advisory", suppressedBy: "handover" });
    expect(sample(pctTokens(0.92), { ceiling: C, record, sampledAt: afterStamp(2), cfg: noHook })).toMatchObject({ state: "advisory", suppressedBy: "handover" });
  });

  it("the time latch runs from the later of the handover and the last imperative", () => {
    const record = rearm({ promptsSinceHandover: 3, lastImperativeAt: afterStamp(9) });
    expect(sample(pctTokens(0.92), { ceiling: C, record, sampledAt: afterStamp(11) })).toMatchObject({ state: "advisory", suppressedBy: "handover" });
    expect(sample(pctTokens(0.92), { ceiling: C, record, sampledAt: afterStamp(19) })).toMatchObject({ state: "imperative", suppressedBy: null });
  });

  it("the growth step is capped in tokens, so a larger ceiling does not widen the gate", () => {
    const big = ceiling({ ceiling: 1_000_000 });
    const record = rearm({ tokensAtHandover: 860_000, promptsSinceHandover: 3 });
    // 0.05 x 1,000,000 is 50,000, capped to 25,000: the line is 885,000.
    expect(sample(884_000, { ceiling: big, record, sampledAt: afterStamp(11) })).toMatchObject({ state: "advisory", suppressedBy: "handover" });
    expect(sample(885_000, { ceiling: big, record, sampledAt: afterStamp(11) })).toMatchObject({ state: "imperative", suppressedBy: null });
  });

  it("a handover from a previous compaction does not suppress; one migrated to the current boundary does", () => {
    const stale = withHandover({ lastBoundaryAt: "2026-09-09T12:25:00.000Z", handoverBoundaryAt: null });
    expect(sample(imperativeTokens, { record: stale }).state).toBe("imperative");
    const migrated = withHandover({ lastBoundaryAt: "2026-09-09T12:25:00.000Z", handoverBoundaryAt: "2026-09-09T12:25:00.000Z" });
    expect(sample(imperativeTokens, { record: migrated }).state).toBe("advisory");
    expect(handoverSuppresses(null, 1, 1, cfg, NOW)).toBeNull();
    expect(handoverSuppresses(withHandover({ tokensAtHandover: null }), 1, 1, cfg, NOW)).toBeNull();
  });

  it("imperativeSince is carried from the record's last sample and cleared when not imperative; it never affects suppression", () => {
    const prior = withHandover({ lastSample: { ...sample(imperativeTokens), sampledAt: "2026-09-09T12:10:00.000Z", imperativeSince: "2026-09-09T12:10:00.000Z", observation: scan(1).observation, ceiling: 417_737, ceilingSource: "measured-session", ceilingConfidence: "high", state: "imperative", rawState: "imperative", pct: 0.8, contextTokens: imperativeTokens, suppressedBy: null } });
    const s = sample(imperativeTokens, { record: prior });
    expect(s.imperativeSince).toBe("2026-09-09T12:10:00.000Z");
    expect(s.state).toBe("advisory");
    expect(sample(imperativeTokens).imperativeSince).toBe(NOW);
    expect(sample(1000).imperativeSince).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ISS-1197 commit 2: compact-needed, the state past which a handover no longer
// helps and only the user's /compact does.
// ---------------------------------------------------------------------------

describe("compact-needed", () => {
  const CEILING = 400_000;
  const C = ceiling({ ceiling: CEILING });
  /** The first token count at or past the default compactNeededPct of 0.95. */
  const COMPACT_TOKENS = Math.ceil(0.95 * CEILING);
  const STAMP_AT = "2026-09-09T12:29:00.000Z";
  /** A handover written one minute ago with every re-arm gate still closed. */
  const freshHandover = (tokens: number): SessionIntelPresence => ({
    ...emptySessionIntel(),
    handoverWrittenAt: STAMP_AT,
    tokensAtHandover: tokens,
    handoverBoundaryAt: null,
    lastBoundaryAt: null,
    promptsSinceHandover: 0,
  });

  it("past compactNeededPct the state is compact-needed and a fresh handover stamp does not suppress it", () => {
    const s = sample(COMPACT_TOKENS, { ceiling: C });
    expect(s).toMatchObject({ state: "compact-needed", rawState: "compact-needed", suppressedBy: null });
    expect(s.reason).toMatch(/>= 0\.95 x 400000/);
    // One token lower is still the ordinary imperative: the threshold is a
    // boundary, not a mood.
    expect(sample(COMPACT_TOKENS - 1, { ceiling: C })).toMatchObject({ state: "imperative", rawState: "imperative" });

    // The gate that holds an imperative cannot hold this: a handover written a
    // minute ago, no growth, no prompts, every re-arm gate closed.
    const record = freshHandover(COMPACT_TOKENS);
    const held = sample(COMPACT_TOKENS, { ceiling: C, record, sampledAt: NOW });
    expect(held).toMatchObject({ state: "compact-needed", rawState: "compact-needed", suppressedBy: null });
    // Proof the same record really is suppressing: one token lower it does.
    expect(sample(COMPACT_TOKENS - 1, { ceiling: C, record: freshHandover(COMPACT_TOKENS - 1), sampledAt: NOW }))
      .toMatchObject({ rawState: "imperative", state: "advisory", suppressedBy: "handover" });
  });

  it("the threshold is checked before the jump allowance, so a large allowance cannot promote imperative past it", () => {
    // Deltas big enough that tokens + allowance clears the imperative line by a
    // mile; the state below the compact line is still imperative, not compact-needed.
    const deltas = [140_000, 150_000, 150_000, 150_000, 150_000];
    expect(sample(COMPACT_TOKENS - 1, { ceiling: C, deltas })).toMatchObject({ state: "imperative", rawState: "imperative" });
    expect(sample(COMPACT_TOKENS, { ceiling: C, deltas })).toMatchObject({ state: "compact-needed" });
  });

  it("imperativeSince continues across the crossing from imperative into compact-needed, rather than restarting or clearing", () => {
    const EARLIER = "2026-09-09T12:05:00.000Z";
    const IMPERATIVE_BEFORE = Math.round(0.9 * CEILING);
    const priorImperative: SessionIntelPresence = {
      ...emptySessionIntel(),
      lastSample: {
        ...sample(IMPERATIVE_BEFORE, { ceiling: C }),
        sampledAt: EARLIER,
        imperativeSince: EARLIER,
        state: "imperative",
        rawState: "imperative",
        ceiling: CEILING,
        ceilingSource: "measured-session",
        ceilingConfidence: "high",
      },
    };
    // Sanity: the record it is built from really was imperative.
    expect(priorImperative.lastSample?.state).toBe("imperative");
    const crossed = sample(COMPACT_TOKENS, { ceiling: C, record: priorImperative, sampledAt: NOW });
    expect(crossed.state).toBe("compact-needed");
    expect(crossed.imperativeSince).toBe(EARLIER);
    // With no prior sample it starts at this sample's own time, never null:
    // the tokens alone already clear the lower imperative line.
    expect(sample(COMPACT_TOKENS, { ceiling: C, sampledAt: NOW }).imperativeSince).toBe(NOW);
  });

  it("ISS-1197 commit 3: the next sample's pct is measured against the RAISED ceiling, so a passed boundary stops reading as 97 percent", () => {
    // The field shape: a 416,250 forecast and an auto boundary at 416,642 from
    // a previous era, with the context sitting at the boundary.
    const ledger: LedgerEntry[] = [{
      sessionId: "me", era: "9:9", captureKind: "startup", timestamp: "2026-09-09T12:01:00.000Z",
      trigger: "auto", preTokens: 416_642, postTokens: 30_000, autoCompactWindowAtStart: 450_000,
    }];
    const raised = resolveCeiling({
      sessionId: "me",
      target: { era: "1:2", capture: { captureKind: "startup", autoCompactWindowAtStart: 450_000, capturedAt: "2026-09-09T11:50:00.000Z" } },
      ledger, liveSetting: null, lastAssistantModel: "claude-opus-5", oneMillionFlag: null,
      modelEvidence: "none", highWaterMark: null, cfg,
    });
    expect(raised.ceiling).toBe(416_642);
    const s = sample(416_642, { ceiling: raised });
    expect(s.pct).toBe(1);
    // Against the unraised 416,250 forecast the same context read 100.1% of a
    // point already passed; the whole defect was reading BELOW 100 there.
    const unraised = resolveCeiling({
      sessionId: "me",
      target: { era: "1:2", capture: { captureKind: "startup", autoCompactWindowAtStart: 450_000, capturedAt: "2026-09-09T11:50:00.000Z" } },
      ledger: [], liveSetting: null, lastAssistantModel: "claude-opus-5", oneMillionFlag: null,
      modelEvidence: "none", highWaterMark: null, cfg,
    });
    expect(sample(403_000, { ceiling: unraised }).pct).toBeGreaterThan(sample(403_000, { ceiling: raised }).pct!);
  });

  it("a configured compactNeededPct moves the line", () => {
    const high = resolveSessionIntelConfig({ compactNeededPct: 0.99 });
    expect(high.compactNeededPct).toBe(0.99);
    expect(sample(COMPACT_TOKENS, { ceiling: C, cfg: high })).toMatchObject({ state: "imperative" });
    expect(sample(Math.ceil(0.99 * CEILING), { ceiling: C, cfg: high })).toMatchObject({ state: "compact-needed" });
  });
});

// ---------------------------------------------------------------------------
// T-501: the usage-cost advisory, decided from the resolved inputs alone.
// ---------------------------------------------------------------------------

describe("usageAdvisoryFrom", () => {
  const input = (window: number | null, source: UsageAdvisoryInput["source"] = null): UsageAdvisoryInput =>
    ({ window, source, provenance: window === null ? "none" : "capture" });

  it("a window above the recommended max gives kind window with the observed value and its source", () => {
    expect(usageAdvisoryFrom(input(1_000_000, "user"), null, cfg)).toEqual({ kind: "window", observed: 1_000_000, source: "user", recommendedMax: 450_000 });
  });

  it("a window at the recommended max gives nothing", () => {
    expect(usageAdvisoryFrom(input(450_000, "user"), null, cfg)).toBeNull();
    expect(usageAdvisoryFrom(input(450_001, "user"), null, cfg)).toEqual({ kind: "window", observed: 450_001, source: "user", recommendedMax: 450_000 });
  });

  it("no observed window plus a 1M model gives kind model", () => {
    expect(usageAdvisoryFrom(input(null), true, cfg)).toEqual({ kind: "model", nativeWindow: 1_000_000, recommendedMax: 450_000 });
  });

  it("a 1M model with a window at or under the max gives nothing (the window bounds it)", () => {
    expect(usageAdvisoryFrom(input(450_000, "user"), true, cfg)).toBeNull();
  });

  it("no observed window and no 1M evidence gives nothing", () => {
    expect(usageAdvisoryFrom(input(null), null, cfg)).toBeNull();
    expect(usageAdvisoryFrom(input(null), false, cfg)).toBeNull();
  });

  it("recommendedWindowMax 0 disables BOTH kinds", () => {
    const off = resolveSessionIntelConfig({ recommendedWindowMax: 0 });
    expect(off.recommendedWindowMax).toBe(0);
    expect(usageAdvisoryFrom(input(1_000_000, "user"), true, off)).toBeNull();
    expect(usageAdvisoryFrom(input(null), true, off)).toBeNull();
  });

  it("the max is a threshold, never a sentinel by magnitude: 2,000,000 against a max of 1,000,000 still fires", () => {
    const high = resolveSessionIntelConfig({ recommendedWindowMax: 1_000_000 });
    expect(usageAdvisoryFrom(input(2_000_000, "local"), null, high)).toEqual({ kind: "window", observed: 2_000_000, source: "local", recommendedMax: 1_000_000 });
  });

  it("a window with no known source keeps the advisory and reports source null", () => {
    expect(usageAdvisoryFrom(input(600_000), null, cfg)).toEqual({ kind: "window", observed: 600_000, source: null, recommendedMax: 450_000 });
  });
});

describe("computeSample carries the advisory on every path", () => {
  it("an ok sample still carries the advisory", () => {
    const s = sample(10, { usage: { window: 1_000_000, source: "user", provenance: "capture" } });
    expect(s.state).toBe("ok");
    expect(s.usageAdvisory).toEqual({ kind: "window", observed: 1_000_000, source: "user", recommendedMax: 450_000 });
    expect(s.usageInput).toEqual({ window: 1_000_000, source: "user", provenance: "capture" });
  });

  it("an unknown sample (no context tokens) still carries the advisory and the input", () => {
    const s = sample(null, { usage: { window: 600_000, source: "project", provenance: "live" } });
    expect(s.state).toBe("unknown");
    expect(s.usageAdvisory).toEqual({ kind: "window", observed: 600_000, source: "project", recommendedMax: 450_000 });
  });

  it("an unknown-ceiling sample still carries the advisory", () => {
    const s = sample(100, { ceiling: ceiling({ ceiling: null }), usage: { window: 600_000, source: "user", provenance: "capture" } });
    expect(s.usageAdvisory).not.toBeNull();
  });

  it("the model kind reads oneMillionFlag from the scan", () => {
    const withFlag = computeSample({ scan: { ...scan(10), oneMillionFlag: true }, ceiling: ceiling(), cfg, sampledBy: "query", sampledAt: NOW, record: null, usage: NO_USAGE });
    expect(withFlag.usageAdvisory).toEqual({ kind: "model", nativeWindow: 1_000_000, recommendedMax: 450_000 });
  });
});
