import { describe, it, expect } from "vitest";
import {
  parseResetTime,
  resetAtMs,
  resolveResetAt,
  CLAMP_MAX_MS,
  DEFAULT_FALLBACK_MS,
  type ParsedReset,
} from "../../src/autonomous/limit-reset-parser.js";

const MARGIN = 60_000;
const H = 3_600_000;

function wallClock(p: ParsedReset | null): { hour: number; minute: number; timezone: string | null; ambiguous: boolean; day: number | null } {
  if (!p || "relative" in p || "absolute" in p) throw new Error("expected wall-clock parse");
  return p;
}

describe("parseResetTime", () => {
  it("parses absolute 'resets 3pm (UTC)'", () => {
    const p = wallClock(parseResetTime("· resets 3pm (UTC)"));
    expect({ hour: p.hour, minute: p.minute, timezone: p.timezone }).toEqual({ hour: 15, minute: 0, timezone: "UTC" });
    expect(p.ambiguous).toBe(false);
  });

  it("parses 'resets at 3:30 PM'", () => {
    const p = wallClock(parseResetTime("resets at 3:30 PM"));
    expect(p.hour).toBe(15);
    expect(p.minute).toBe(30);
  });

  it("handles 12am/12pm edge cases", () => {
    expect(wallClock(parseResetTime("resets 12am")).hour).toBe(0);
    expect(wallClock(parseResetTime("resets 12pm")).hour).toBe(12);
  });

  it("parses relative 'try again in 5 minutes'", () => {
    const p = parseResetTime("try again in 5 minutes");
    expect(p).toEqual({ relative: true, waitMs: 5 * 60_000 });
  });

  it("parses 'resets in: 3 hours'", () => {
    const p = parseResetTime("resets in: 3 hours");
    expect(p).toEqual({ relative: true, waitMs: 3 * H });
  });

  it("parses multi-unit relative 'Try again in 4 days 20 hours 9 minutes.'", () => {
    const p = parseResetTime("Try again in 4 days 20 hours 9 minutes.");
    expect(p).toEqual({ relative: true, waitMs: ((4 * 24 + 20) * 60 + 9) * 60_000 });
  });

  it("parses month-date weekly form 'resets Jul 4 at 12:30am (Asia/Calcutta)'", () => {
    const p = parseResetTime("You've hit your weekly limit · resets Jul 4 at 12:30am (Asia/Calcutta)");
    expect(p).toMatchObject({ month: 6, dayOfMonth: 4, hour: 0, minute: 30, timezone: "Asia/Calcutta", ambiguous: false });
  });

  it("parses day-only weekly banner 'resets Tuesday'", () => {
    const p = wallClock(parseResetTime("weekly limit reached · resets Tuesday"));
    expect(p.day).toBe(2);
    expect(p.hour).toBe(0);
  });

  it("rejects an out-of-range clock ('resets 99:99') instead of letting Date normalize it", () => {
    expect(parseResetTime("resets 99:99 (UTC)")).toBeNull();
    const now = new Date("2026-07-05T12:00:00Z");
    const { source } = resolveResetAt("resets 99:99 (UTC)", { now, fallbackMs: 5 * H, marginMs: MARGIN });
    expect(source).toBe("fallback");
  });

  it("invalid clock in the absolute form still falls through to a relative phrase", () => {
    const p = parseResetTime("resets 99:99, try again in 2 hours");
    expect(p).toEqual({ relative: true, waitMs: 2 * H });
  });

  it("rejects an impossible calendar date ('Feb 31') via the round-trip guard", () => {
    expect(parseResetTime("try again at Feb 31, 2027 9:01 PM.")).toBeNull();
    const now = new Date("2026-07-05T12:00:00Z");
    const { source } = resolveResetAt("try again at Feb 31, 2027 9:01 PM.", { now, fallbackMs: 5 * H, marginMs: MARGIN });
    expect(source).toBe("fallback");
  });

  it("returns null for unparseable text", () => {
    expect(parseResetTime("garbage text")).toBeNull();
    expect(parseResetTime("")).toBeNull();
    expect(parseResetTime(null)).toBeNull();
  });
});

describe("resetAtMs", () => {
  it("month-date reset resolves to that date in the stated timezone", () => {
    const now = new Date("2026-07-01T12:00:00Z");
    const { at, source } = resetAtMs(parseResetTime("resets Jul 4 at 12:30am (Asia/Calcutta)"), { now, marginMs: MARGIN });
    expect(source).toBe("absolute");
    // 00:30 IST on Jul 4 == 19:00 UTC on Jul 3
    expect(at).toBe(new Date("2026-07-03T19:00:00Z").getTime() + MARGIN);
  });

  it("month-date day-walk across a DST fall-back stays on the named date", () => {
    // America/New_York falls back on 2026-11-01; the walk from Oct 30 to Nov 3
    // crosses it. Raw 24h steps would drift the wall clock and land on Nov 4.
    const now = new Date("2026-10-30T12:00:00-04:00");
    const { at, source } = resetAtMs(parseResetTime("resets Nov 3 at 12:30am (America/New_York)"), { now, marginMs: 0 });
    expect(source).toBe("absolute");
    expect(at).toBe(new Date("2026-11-03T05:30:00Z").getTime()); // 00:30 EST
  });

  it("month-date already past falls back, never waits toward next year", () => {
    const now = new Date("2026-07-10T12:00:00Z");
    const { at, source } = resetAtMs(parseResetTime("resets Jul 4 at 12:30am (Asia/Calcutta)"), { now, fallbackMs: 5 * H, marginMs: MARGIN });
    expect(source).toBe("fallback");
    expect(at).toBe(now.getTime() + 5 * H + MARGIN);
  });

  it("year rollover: late-December yearless month-date resolves into early January", () => {
    const now = new Date("2026-12-29T12:00:00Z");
    const { at, source } = resetAtMs(parseResetTime("resets Jan 2 at 9:00am (UTC)"), { now, marginMs: 0 });
    expect(source).toBe("absolute");
    expect(at).toBe(new Date("2027-01-02T09:00:00Z").getTime());
  });

  it("preserves an EXPLICIT year in a full-date banner (resets form)", () => {
    // The banner names the year outright -- resolve to THAT year, never the
    // current one. Group indices must not silently drop the year.
    const parsed = parseResetTime("resets Jan 2, 2027 at 9:00am (UTC)");
    expect(parsed && "year" in parsed ? parsed.year : undefined).toBe(2027);
    const now = new Date("2026-07-05T12:00:00Z");
    const { at, source } = resetAtMs(parsed, { now, marginMs: 0 });
    expect(source).toBe("absolute");
    expect(at).toBe(new Date("2027-01-02T09:00:00Z").getTime());
  });

  it("preserves an EXPLICIT year in a 'try again at' full-date banner", () => {
    const now = new Date("2026-07-05T12:00:00Z");
    // resolveResetAt clamps to the 8-day horizon, so use resetAtMs directly to
    // assert the raw resolved year; the local-time Date mirrors the parser.
    const { at, source } = resetAtMs(parseResetTime("try again at Jan 2, 2027 9:00 AM."), { now, marginMs: 0 });
    expect(source).toBe("absolute");
    expect(at).toBe(new Date(2027, 0, 2, 9, 0).getTime());
  });

  it("a stale explicit year (already past) falls back rather than firing immediately", () => {
    const now = new Date("2026-07-05T12:00:00Z");
    const { source } = resetAtMs(parseResetTime("try again at Jan 2, 2020 9:00 AM."), { now, fallbackMs: 5 * H, marginMs: MARGIN });
    expect(source).toBe("fallback");
  });

  it("daily rollover across spring-forward keeps the requested local wall clock", () => {
    // 2026-03-08 America/New_York springs forward (EST->EDT). "resets 6am" asked
    // the evening BEFORE must land at 6:00am EDT the next morning, not 5 or 7.
    const now = new Date("2026-03-07T23:00:00Z"); // 6pm EST on Mar 7
    const { at, source } = resetAtMs(parseResetTime("resets 6am (America/New_York)"), { now, marginMs: 0 });
    expect(source).toBe("absolute");
    // 6:00am EDT on Mar 8 = 10:00 UTC (EDT is UTC-4).
    expect(at).toBe(new Date("2026-03-08T10:00:00Z").getTime());
  });

  it("daily rollover across fall-back keeps the requested local wall clock", () => {
    // 2026-11-01 America/New_York falls back (EDT->EST). "resets 6am" asked the
    // evening before must land at 6:00am EST, not 5 or 7.
    const now = new Date("2026-10-31T22:00:00Z"); // 6pm EDT on Oct 31
    const { at, source } = resetAtMs(parseResetTime("resets 6am (America/New_York)"), { now, marginMs: 0 });
    expect(source).toBe("absolute");
    // 6:00am EST on Nov 1 = 11:00 UTC (EST is UTC-5).
    expect(at).toBe(new Date("2026-11-01T11:00:00Z").getTime());
  });

  it("null parse falls back to now + fallbackMs", () => {
    const now = new Date("2026-07-05T12:00:00Z");
    const { at, source } = resetAtMs(null, { now, fallbackMs: 5 * H, marginMs: MARGIN });
    expect(at).toBe(now.getTime() + 5 * H + MARGIN);
    expect(source).toBe("fallback");
  });

  it("absolute UTC time in the future today", () => {
    const now = new Date("2026-07-05T12:00:00Z");
    const { at } = resetAtMs(parseResetTime("resets 3pm (UTC)"), { now, marginMs: MARGIN });
    expect(at).toBe(new Date("2026-07-05T15:00:00Z").getTime() + MARGIN);
  });

  it("absolute UTC time already past rolls to tomorrow", () => {
    const now = new Date("2026-07-05T18:00:00Z");
    const { at } = resetAtMs(parseResetTime("resets 3pm (UTC)"), { now, marginMs: MARGIN });
    expect(at).toBe(new Date("2026-07-06T15:00:00Z").getTime() + MARGIN);
  });

  it("ambiguous hour picks nearest future occurrence", () => {
    const now = new Date("2026-07-05T12:00:00Z");
    // "resets 3" (no am/pm) in UTC: 3am tomorrow (15h away) vs 3pm today (3h away) -> 3pm today
    const p = parseResetTime("resets 3 (UTC)");
    expect(wallClock(p).ambiguous).toBe(true);
    const { at } = resetAtMs(p, { now, marginMs: MARGIN });
    expect(at).toBe(new Date("2026-07-05T15:00:00Z").getTime() + MARGIN);
  });

  it("DST boundary: America/New_York spring forward", () => {
    // 2026-03-08 02:00 EST -> EDT. Ask for "resets 3pm" the day of.
    const now = new Date("2026-03-08T13:00:00Z"); // 8am EST->EDT morning
    const { at } = resetAtMs(parseResetTime("resets 3pm (America/New_York)"), { now, marginMs: 0 });
    // 3pm EDT = 19:00 UTC
    expect(at).toBe(new Date("2026-03-08T19:00:00Z").getTime());
  });

  it("DST spring-forward: a reset inside the nonexistent hour resolves bounded (no oscillation hang)", () => {
    // 2026-03-08 America/New_York: 2:00-3:00am local does not exist. The
    // wall-clock correction cannot converge on 2:30am; the bounded iteration
    // must land on a deterministic future instant instead of hanging or NaN.
    const now = new Date("2026-03-08T06:00:00Z"); // 1:00am EST, before the jump
    const { at, source } = resetAtMs(parseResetTime("resets 2:30am (America/New_York)"), { now, marginMs: 0 });
    expect(source).toBe("absolute");
    expect(Number.isFinite(at)).toBe(true);
    expect(at).toBeGreaterThan(now.getTime());
    expect(at).toBeLessThan(now.getTime() + 86_400_000);
    // The bounded correction settles in the post-jump hour: 3:30am EDT.
    expect(at).toBe(new Date("2026-03-08T07:30:00Z").getTime());
  });

  it("weekly: 'resets Tuesday 9am (UTC)' rolls to next Tuesday", () => {
    const now = new Date("2026-07-05T12:00:00Z"); // a Sunday
    const p = parseResetTime("· resets Tuesday 9am (UTC)");
    expect(wallClock(p).day).toBe(2);
    const { at } = resetAtMs(p, { now, marginMs: 0 });
    expect(at).toBe(new Date("2026-07-07T09:00:00Z").getTime());
  });

  it("invalid timezone falls back", () => {
    const now = new Date("2026-07-05T12:00:00Z");
    const { at, source } = resetAtMs(
      { hour: 15, minute: 0, timezone: "Not/AZone", ambiguous: false, day: null },
      { now, fallbackMs: 5 * H, marginMs: MARGIN },
    );
    expect(source).toBe("fallback");
    expect(at).toBe(now.getTime() + 5 * H + MARGIN);
  });

  it("pre-resolved epoch in the past falls back (stale full-date banner)", () => {
    const now = new Date("2026-07-05T12:00:00Z");
    const { source } = resetAtMs({ absolute: true, atMs: now.getTime() - 1000 }, { now, fallbackMs: 5 * H, marginMs: MARGIN });
    expect(source).toBe("fallback");
  });
});

describe("resolveResetAt (parse + clamp)", () => {
  it("passes through an in-bounds absolute reset", () => {
    const now = new Date("2026-07-05T12:00:00Z");
    const { at, source } = resolveResetAt("resets 3pm (UTC)", { now, marginMs: MARGIN });
    expect(source).toBe("absolute");
    expect(at).toBe(new Date("2026-07-05T15:00:00Z").getTime() + MARGIN);
  });

  it("clamps a reset beyond 8 days to fallback", () => {
    const now = new Date("2026-07-05T12:00:00Z");
    // 9 days out via multi-unit relative -- past CLAMP_MAX_MS
    const { at, source } = resolveResetAt("Try again in 9 days 1 hours 0 minutes.", { now, marginMs: MARGIN });
    expect(source).toBe("fallback");
    expect(at).toBe(now.getTime() + DEFAULT_FALLBACK_MS + MARGIN);
    expect(at).toBeLessThan(now.getTime() + CLAMP_MAX_MS);
  });

  it("clamps a reset in under a minute to fallback", () => {
    const now = new Date("2026-07-05T12:00:00Z");
    const { source } = resolveResetAt("try again in 0 minutes", { now, marginMs: 0 });
    expect(source).toBe("fallback");
  });

  it("falls back on empty banner", () => {
    const now = new Date("2026-07-05T12:00:00Z");
    const { at, source } = resolveResetAt(null, { now, marginMs: MARGIN, fallbackMs: 5 * H });
    expect(source).toBe("fallback");
    expect(at).toBe(now.getTime() + 5 * H + MARGIN);
  });
});
