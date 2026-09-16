/**
 * T-499: the presence-side half of session intel.
 *
 * What the slim hook must guarantee for a subtree it never computes: parse it
 * with the writer's caps, carry it through every event except SessionEnd,
 * and keep the whole record under the reader's bound with the intel present.
 */
import { describe, it, expect } from "vitest";

import {
  MAX_ERA_BYTES,
  MAX_INCARNATION_BYTES,
  MAX_SESSION_INTEL_BYTES,
  MAX_TRANSCRIPT_PATH_BYTES,
  SESSION_INTEL_SHED_STEPS,
  emptySessionIntel,
  fitSessionIntel,
  parseSessionIntel,
  sessionIntelBytes,
  type SessionIntelPresence,
  type SessionIntelSample,
} from "../../src/presence/session-intel-fields.js";
import { applyPresenceEvent, parsePresenceRecord, serializePresence, type PresenceEventContext } from "../../src/presence/record.js";
import {
  MAX_AGENT_IDS,
  MAX_ARRANGEMENT_PRESENCE_ENTRIES,
  MAX_CLIENT_TASK_ID_BYTES,
  MAX_CLOSED_TOOL_IDS,
  MAX_GATE_NAME_BYTES,
  MAX_ID_BYTES,
  MAX_MILESTONE_KIND_BYTES,
  MAX_MILESTONE_NOTE_BYTES,
  MAX_RECORD_BYTES,
  MAX_TARGET_BYTES,
  MAX_TOOL_NAME_BYTES,
  type SessionPresence,
} from "../../src/presence/types.js";
import { ensureTelemetrySubdir } from "../../src/presence/io.js";
import { mkdtempSync, rmSync, lstatSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SESSION = "sess-intel";
const SHA = "f".repeat(64);

function sample(over: Partial<SessionIntelSample> = {}): SessionIntelSample {
  return {
    sampledAt: "2026-09-09T10:00:00.000Z",
    sampledBy: "stop-hook",
    state: "advisory",
    rawState: "imperative",
    pct: 0.71,
    contextTokens: 296_000,
    ceiling: 417_737,
    ceilingSource: "measured-session",
    ceilingConfidence: "high",
    observation: {
      era: "11442:1788000000",
      incarnation: "16777220:9001",
      sizeAtOpen: 5_000_000,
      consumedOffset: 4_999_990,
      anchor: { offset: 4_999_990, sha256: SHA },
      authoritative: true,
      revisionSeen: 3,
      lastRecordTimestamp: "2026-09-09T09:59:59.000Z",
      epoch: { kind: "observed", at: "2026-09-09T08:00:00.000Z" },
    },
    imperativeSince: "2026-09-09T09:50:00.000Z",
    suppressedBy: "handover",
    usageInput: { window: 1_000_000, source: "user", oneMillionFlag: true },
    ...over,
  };
}

function full(): SessionIntelPresence {
  return {
    era: "11442:1788000000",
    revision: 3,
    captureKind: "startup",
    autoCompactWindowAtStart: 450_000,
    autoCompactWindowSource: "user",
    capturedAt: "2026-09-09T07:00:00.000Z",
    transcriptPath: "/Users/u/.claude/projects/-Users-u-p/sess-intel.jsonl",
    epoch: { kind: "observed", at: "2026-09-09T08:00:00.000Z" },
    lastBoundaryAt: "2026-09-09T08:00:00.000Z",
    consumedOffset: 4_999_990,
    incarnation: "16777220:9001",
    baselineAnchor: { offset: 4_999_990, sha256: SHA },
    lastSample: sample(),
    handoverWrittenAt: "2026-09-09T09:55:00.000Z",
    tokensAtHandover: 290_000,
    handoverBoundaryAt: "2026-09-09T08:00:00.000Z",
    promptsSinceHandover: 4,
    lastImperativeAt: "2026-09-09T09:50:00.000Z",
    usageAdvisoryShownAt: "2026-09-09T09:00:00.000Z",
  };
}

function ctx(over: Partial<PresenceEventContext> & Pick<PresenceEventContext, "event">): PresenceEventContext {
  return { sessionId: SESSION, nowIso: "2026-09-09T10:00:00.000Z", source: null, toolId: null, toolName: null, target: null, agentId: null, suppressed: false, ...over };
}

describe("session intel fields (T-499)", () => {
  it("round-trips a full subtree through JSON and the parser", () => {
    const parsed = parseSessionIntel(JSON.parse(JSON.stringify(full())));
    expect(parsed).toEqual(full());
  });

  it("refuses anything that is not an object, and defaults every field it cannot read", () => {
    expect(parseSessionIntel(null)).toBeNull();
    expect(parseSessionIntel("x")).toBeNull();
    expect(parseSessionIntel([])).toBeNull();
    expect(parseSessionIntel({})).toEqual(emptySessionIntel());
    const junk = parseSessionIntel({
      era: 12, revision: -1, captureKind: "bogus", autoCompactWindowAtStart: 0, autoCompactWindowSource: "policy",
      capturedAt: "not a date", epoch: { kind: "observed" }, lastBoundaryAt: 5, consumedOffset: 1.5,
      baselineAnchor: { offset: 1, sha256: "zz" }, lastSample: { sampledAt: "2026-09-09T10:00:00.000Z" },
      tokensAtHandover: -3, handoverBoundaryAt: "",
    })!;
    expect(junk).toEqual(emptySessionIntel());
  });

  it("ISS-1197 commit 2: compact-needed round-trips as a state, and an unknown state string is still refused", () => {
    const intel = { ...full(), lastSample: sample({ state: "compact-needed", rawState: "compact-needed", suppressedBy: null }) };
    const parsed = parseSessionIntel(JSON.parse(JSON.stringify(intel)))!;
    expect(parsed.lastSample).toMatchObject({ state: "compact-needed", rawState: "compact-needed", suppressedBy: null });
    expect(parsed).toEqual(intel);
    // The set is still closed: an invented state drops the sample, and an
    // invented rawState falls back to the sample's own state.
    expect(parseSessionIntel({ ...full(), lastSample: { ...sample(), state: "compact_needed" } })!.lastSample).toBeNull();
    expect(parseSessionIntel({ ...full(), lastSample: { ...sample(), state: "compact-needed", rawState: "panic" } })!.lastSample).toMatchObject({ state: "compact-needed", rawState: "compact-needed" });
  });

  it("ISS-1197: a record written before the re-arm counters existed parses with 0 and null, keeping its handover fields", () => {
    const { promptsSinceHandover, lastImperativeAt, ...legacy } = full();
    expect(promptsSinceHandover).toBe(4);
    expect(lastImperativeAt).not.toBeNull();
    const parsed = parseSessionIntel(JSON.parse(JSON.stringify(legacy)))!;
    expect(parsed.promptsSinceHandover).toBe(0);
    expect(parsed.lastImperativeAt).toBeNull();
    expect(parsed.handoverWrittenAt).toBe(legacy.handoverWrittenAt);
    expect(parsed.tokensAtHandover).toBe(legacy.tokensAtHandover);
    // A hand-edited negative or fractional count reads as 0, never as itself.
    expect(parseSessionIntel({ ...full(), promptsSinceHandover: -1, lastImperativeAt: "nope" })!).toMatchObject({ promptsSinceHandover: 0, lastImperativeAt: null });
  });

  it("drops a malformed sample without dropping the capture", () => {
    const parsed = parseSessionIntel({ ...full(), lastSample: { ...sample(), observation: { incarnation: "x" } } })!;
    expect(parsed.lastSample).toBeNull();
    expect(parsed.captureKind).toBe("startup");
    expect(parsed.autoCompactWindowAtStart).toBe(450_000);
    // An unknown enum inside the sample is a refused sample, never a coerced one.
    expect(parseSessionIntel({ ...full(), lastSample: { ...sample(), state: "panic" } })!.lastSample).toBeNull();
    expect(parseSessionIntel({ ...full(), lastSample: { ...sample(), ceilingSource: "guess" } })!.lastSample).toBeNull();
  });

  it("caps display strings on read, and REFUSES oversized identities rather than truncating them", () => {
    const parsed = parseSessionIntel({ ...full(), transcriptPath: "/p/".repeat(1000) })!;
    expect(Buffer.byteLength(parsed.transcriptPath!, "utf-8")).toBeLessThanOrEqual(MAX_TRANSCRIPT_PATH_BYTES);
    // An era or incarnation is compared for exact equality downstream; a
    // truncated one would be a DIFFERENT, apparently valid provenance.
    const ids = parseSessionIntel({ ...full(), era: "e".repeat(65), incarnation: "i".repeat(65) })!;
    expect(ids.era).toBeNull();
    expect(ids.incarnation).toBeNull();
    expect(parseSessionIntel({ ...full(), era: "e".repeat(64) })!.era).toBe("e".repeat(64));
    // Inside a sample the incarnation is required, so an oversized one drops the sample.
    const obs = sample().observation;
    expect(parseSessionIntel({ ...full(), lastSample: sample({ observation: { ...obs, incarnation: "i".repeat(65) } }) })!.lastSample).toBeNull();
    expect(parseSessionIntel({ ...full(), lastSample: sample({ observation: { ...obs, era: "e".repeat(65) } }) })!.lastSample!.observation.era).toBeNull();
  });

  it("keeps a fractional ceiling through a presence round trip", () => {
    const intel = { ...full(), lastSample: sample({ ceiling: 417_737.5, pct: 0.6385 }) };
    const rec: SessionPresence = { ...applyPresenceEvent(null, ctx({ event: "SessionStart", source: "startup" })), sessionIntel: intel };
    const back = parsePresenceRecord(serializePresence(rec)!, SESSION)!.sessionIntel!.lastSample!;
    expect(back.ceiling).toBe(417_737.5);
    expect(back.pct).toBe(0.6385);
    expect(parseSessionIntel({ ...full(), lastSample: sample({ ceiling: 0 }) })!.lastSample!.ceiling).toBeNull();
    expect(parseSessionIntel({ ...full(), lastSample: sample({ ceiling: Number.POSITIVE_INFINITY }) })!.lastSample!.ceiling).toBeNull();
  });

  /**
   * The cap is on SERIALIZED bytes, escaping included: a path full of quotes
   * and backslashes costs twice its character count once JSON-encoded, and a
   * cap measured before encoding would let it through. The per-field caps keep
   * every LEGAL subtree under the real cap (pinned below), so the ladder is
   * exercised against a tighter cap, deterministically: one fixture needs
   * exactly one step, one needs both, one cannot fit.
   */
  it("sheds in order under a cap, measured on serialized bytes, and refuses what cannot fit", () => {
    const escapeHeavy = '"\\'.repeat(MAX_TRANSCRIPT_PATH_BYTES / 2); // 1024 chars, 2048 escaped bytes
    expect(Buffer.byteLength(JSON.stringify(escapeHeavy), "utf-8")).toBeGreaterThan(2 * MAX_TRANSCRIPT_PATH_BYTES);
    const subject: SessionIntelPresence = { ...full(), transcriptPath: escapeHeavy };
    const withoutSample = { ...subject, lastSample: null };
    const withoutBoth = { ...withoutSample, transcriptPath: null };
    const [all, noSample, noBoth] = [subject, withoutSample, withoutBoth].map(sessionIntelBytes) as [number, number, number];
    expect(all).toBeGreaterThan(noSample);
    expect(noSample).toBeGreaterThan(noBoth);

    // One step: a cap the sample-less subtree meets but the full one does not.
    const oneStep = fitSessionIntel(subject, noSample)!;
    expect(oneStep).toEqual(withoutSample);
    expect(sessionIntelBytes(oneStep)).toBeLessThanOrEqual(noSample);
    // Two steps: the path must go as well, and nothing else changes.
    const twoSteps = fitSessionIntel(subject, noBoth)!;
    expect(twoSteps).toEqual(withoutBoth);
    // Cannot fit: refused, never truncated further.
    expect(fitSessionIntel(subject, noBoth - 1)).toBeNull();
    // A subtree already under the cap is returned untouched.
    expect(fitSessionIntel(subject, all)).toEqual(subject);

    const [shedSample, shedPath] = SESSION_INTEL_SHED_STEPS;
    expect(SESSION_INTEL_SHED_STEPS).toHaveLength(2);
    expect(shedSample!(subject)).toEqual(withoutSample);
    expect(shedPath!(withoutSample)).toEqual(withoutBoth);
  });

  it("the worst LEGAL subtree stays under the real cap, so the ladder is last resort", () => {
    const worst: SessionIntelPresence = {
      ...full(),
      era: "\\".repeat(MAX_ERA_BYTES),
      incarnation: "\\".repeat(MAX_INCARNATION_BYTES),
      transcriptPath: '"\\'.repeat(MAX_TRANSCRIPT_PATH_BYTES / 2),
      lastSample: sample({
        pct: 0.123456789012345,
        ceiling: 1_234_567.123456789,
        observation: { ...sample().observation, era: "\\".repeat(MAX_ERA_BYTES), incarnation: "\\".repeat(MAX_INCARNATION_BYTES), sizeAtOpen: Number.MAX_SAFE_INTEGER, consumedOffset: Number.MAX_SAFE_INTEGER },
      }),
    };
    expect(parseSessionIntel(JSON.parse(JSON.stringify(worst)))).toEqual(worst); // legal: nothing shed on read
    expect(sessionIntelBytes(worst)).toBeLessThan(MAX_SESSION_INTEL_BYTES);
    expect(sessionIntelBytes(full())).toBeLessThan(MAX_SESSION_INTEL_BYTES * 0.5);
  });
});

describe("presence record carries session intel (T-499)", () => {
  const withIntel = (): SessionPresence => ({
    ...applyPresenceEvent(null, ctx({ event: "SessionStart", source: "startup" })),
    sessionIntel: full(),
  });

  it("preserves the subtree on every tool event, Stop, and every SessionStart source", () => {
    const rec = withIntel();
    const pre = applyPresenceEvent(rec, ctx({ event: "PreToolUse", toolId: "t1", toolName: "Read" }));
    expect(pre.sessionIntel).toEqual(full());
    const post = applyPresenceEvent(pre, ctx({ event: "PostToolUse", toolId: "t1", toolName: "Read" }));
    expect(post.sessionIntel).toEqual(full());
    const stop = applyPresenceEvent(post, ctx({ event: "Stop" }));
    expect(stop.sessionIntel).toEqual(full());
    for (const source of ["startup", "resume", "clear", "compact", "fork", null]) {
      const started = applyPresenceEvent(stop, ctx({ event: "SessionStart", source }));
      expect(started.sessionIntel, `SessionStart source=${source}`).toEqual(full());
    }
  });

  it("clears the subtree on SessionEnd, with the tombstone", () => {
    const ended = applyPresenceEvent(withIntel(), ctx({ event: "SessionEnd" }));
    expect(ended.endedAt).not.toBeNull();
    expect(ended.sessionIntel).toBeNull();
  });

  it("a fresh record starts with no intel, and a parsed record keeps what it had", () => {
    expect(applyPresenceEvent(null, ctx({ event: "SessionStart", source: "startup" })).sessionIntel).toBeNull();
    const text = serializePresence(withIntel())!;
    expect(parsePresenceRecord(text, SESSION)!.sessionIntel).toEqual(full());
    // An unreadable subtree parses as absent, never as a failed record.
    const broken = JSON.stringify({ ...JSON.parse(text), sessionIntel: "nope" });
    const parsed = parsePresenceRecord(broken, SESSION);
    expect(parsed).not.toBeNull();
    expect(parsed!.sessionIntel).toBeNull();
  });

  /**
   * The T-477 worst case, plus a session-intel subtree at its own cap, must
   * still fit the record bound. This re-baselines the record's headroom
   * rather than loosening the bound: intel is the one subtree that can reach
   * MAX_SESSION_INTEL_BYTES legitimately, so it is measured at that size.
   */
  it("the worst case with intel at its cap stays under the record bound", () => {
    const exact = (bytes: number, seed: string) => (seed + "z".repeat(bytes)).slice(0, bytes);
    let rec = applyPresenceEvent(null, ctx({ event: "SessionStart", source: "startup" }));
    for (let i = 0; i < MAX_AGENT_IDS; i++) {
      rec = applyPresenceEvent(rec, ctx({
        event: "PreToolUse", toolId: exact(MAX_ID_BYTES, `id${i}-`), toolName: exact(MAX_TOOL_NAME_BYTES, `tool${i}-`),
        target: exact(MAX_TARGET_BYTES, `d/${i}/`), agentId: exact(MAX_ID_BYTES, `agent${i}-`),
      }));
    }
    for (let i = 0; i < MAX_CLOSED_TOOL_IDS; i++) {
      rec = applyPresenceEvent(rec, ctx({ event: "PostToolUse", toolId: exact(MAX_ID_BYTES, `closed${i}-`), toolName: "Read" }));
    }
    // Pad the intel subtree up to (not over) its cap through the one field
    // that can legitimately be long.
    let intel: SessionIntelPresence = full();
    const room = MAX_SESSION_INTEL_BYTES - sessionIntelBytes({ ...intel, transcriptPath: "" });
    intel = { ...intel, transcriptPath: "p".repeat(Math.min(room, MAX_TRANSCRIPT_PATH_BYTES)) };
    expect(sessionIntelBytes(intel)).toBeLessThanOrEqual(MAX_SESSION_INTEL_BYTES);
    rec = {
      ...rec,
      arrangementPresence: Array.from({ length: MAX_ARRANGEMENT_PRESENCE_ENTRIES }, (_, i) => ({
        arrangementId: exact(MAX_ID_BYTES, `a${i}-`), role: i % 2 === 0 ? "pen" : "worker", lifecycle: "active", supervising: { workerActive: true },
      })),
      arrangementPresenceTruncated: true,
      milestone: { kind: exact(MAX_MILESTONE_KIND_BYTES, "k-"), at: "2026-08-20T12:00:00.000Z", gateName: exact(MAX_GATE_NAME_BYTES, "g-"), note: exact(MAX_MILESTONE_NOTE_BYTES, "n-") },
      ownerIdentity: { client: "codex", clientTaskId: exact(MAX_CLIENT_TASK_ID_BYTES, "t-") },
      sessionIntel: intel,
    };
    const text = serializePresence(rec)!;
    expect(text).not.toBeNull();
    const bytes = Buffer.byteLength(text, "utf-8");
    expect(bytes).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    // Nothing was shed to get there: the caps, not the ladder, are the bound.
    expect(parsePresenceRecord(text, SESSION)!.sessionIntel).toEqual(intel);
    // T-501 added two fields (`lastSample.usageInput` and
    // `usageAdvisoryShownAt`), so the worst case is about a hundred bytes
    // larger than the 5%-headroom form of this assertion allowed. Stated as
    // the margin it is actually about, in bytes.
    expect(MAX_RECORD_BYTES - bytes).toBeGreaterThan(512);
  });
});

describe("ensureTelemetrySubdir (T-499)", () => {
  it("creates the validated chain for a portable name and refuses anything else", () => {
    const root = mkdtempSync(join(tmpdir(), "intel-telemetry-"));
    try {
      const dir = ensureTelemetrySubdir(root, "session-intel")!;
      expect(dir).toBe(join(root, ".story", "telemetry", "session-intel"));
      expect(lstatSync(dir).isDirectory()).toBe(true);
      expect(ensureTelemetrySubdir(root, "session-intel")).toBe(dir); // idempotent
      for (const bad of ["", "..", "Presence", "a/b", "-x", "x".repeat(40)]) {
        expect(ensureTelemetrySubdir(root, bad), bad).toBeNull();
      }
      // A symlink squatting on the target level is refused, never written through.
      const elsewhere = mkdtempSync(join(tmpdir(), "intel-elsewhere-"));
      mkdirSync(join(root, ".story", "telemetry"), { recursive: true });
      symlinkSync(elsewhere, join(root, ".story", "telemetry", "eras"));
      expect(ensureTelemetrySubdir(root, "eras")).toBeNull();
      rmSync(elsewhere, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// T-501: the advisory's persisted INPUTS and its once-per-session stamp.
// ---------------------------------------------------------------------------

describe("usage advisory persistence (T-501)", () => {
  it("round-trips usageInput and the shown stamp", () => {
    const parsed = parseSessionIntel(JSON.parse(JSON.stringify(full())))!;
    expect(parsed.lastSample!.usageInput).toEqual({ window: 1_000_000, source: "user", oneMillionFlag: true });
    expect(parsed.usageAdvisoryShownAt).toBe("2026-09-09T09:00:00.000Z");
  });

  it("an older record without either field reads null for both, keeping the sample", () => {
    const { usageAdvisoryShownAt: _s, ...noStamp } = full();
    const { usageInput: _u, ...noInput } = full().lastSample!;
    const parsed = parseSessionIntel({ ...noStamp, lastSample: noInput })!;
    expect(parsed.usageAdvisoryShownAt).toBeNull();
    expect(parsed.lastSample).not.toBeNull();
    expect(parsed.lastSample!.usageInput).toBeNull();
  });

  it("a malformed usageInput reads null WITHOUT dropping the sample, and a malformed stamp reads null", () => {
    for (const bad of [42, "x", [], { window: "big", source: "user", oneMillionFlag: true }, { window: 1.5 }, { window: 600_000, source: "policy" }]) {
      const parsed = parseSessionIntel({ ...full(), lastSample: { ...full().lastSample!, usageInput: bad } })!;
      expect(parsed.lastSample, JSON.stringify(bad)).not.toBeNull();
      expect(parsed.lastSample!.usageInput, JSON.stringify(bad)).toBeNull();
    }
    expect(parseSessionIntel({ ...full(), usageAdvisoryShownAt: "not a date" })!.usageAdvisoryShownAt).toBeNull();
  });

  it("a partial usageInput keeps only what validates", () => {
    const parsed = parseSessionIntel({ ...full(), lastSample: { ...full().lastSample!, usageInput: { window: 600_000, source: null, oneMillionFlag: null } } })!;
    expect(parsed.lastSample!.usageInput).toEqual({ window: 600_000, source: null, oneMillionFlag: null });
  });

  it("shedding still drops the sample (and the input with it) first, and NEVER the stamp", () => {
    const shed = fitSessionIntel(full(), sessionIntelBytes(full()) - 1)!;
    expect(shed.lastSample).toBeNull();
    expect(shed.usageAdvisoryShownAt).toBe("2026-09-09T09:00:00.000Z");
    expect(shed.autoCompactWindowAtStart).toBe(450_000);
  });

  it("a full subtree carrying usageInput and the stamp still fits the real cap", () => {
    expect(sessionIntelBytes(full())).toBeLessThanOrEqual(MAX_SESSION_INTEL_BYTES);
  });
});
