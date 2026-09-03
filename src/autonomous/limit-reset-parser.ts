/**
 * T-424: Parse usage-limit banner text into an absolute epoch-ms reset time.
 *
 * Ported from unsnooze (https://github.com/saaranshM/unsnooze, MIT) with
 * storybloq-specific clamping. DST-safe: resolves "resets 3pm (UTC)" via
 * iterative wall-clock correction in the stated timezone rather than naive
 * offset math. The banner format is not part of any documented contract, so
 * every parse is best-effort and unparseable input falls back to now +
 * fallbackMs (default 5h, the session-limit window).
 */

/** Bumped when the regex set changes -- recorded on ledger records so field drift is diagnosable. */
export const LIMIT_PARSER_VERSION = 1;

/** Parsed resets clamped to [now + CLAMP_MIN_MS, now + CLAMP_MAX_MS]; outside means we misread the banner. */
export const CLAMP_MIN_MS = 60_000;
export const CLAMP_MAX_MS = 8 * 86_400_000;

export const DEFAULT_FALLBACK_MS = 5 * 3_600_000;
export const DEFAULT_MARGIN_MS = 60_000;

export type ResetSource = "absolute" | "relative" | "fallback";

export type ParsedReset =
  | { absolute: true; atMs: number }
  | { relative: true; waitMs: number }
  | {
      hour: number;
      minute: number;
      timezone: string | null;
      ambiguous: boolean;
      day: number | null;
      month?: number;
      dayOfMonth?: number;
      /** Explicit 4-digit year from the banner (month-date form only). Absent = yearless (resolve within the weekly window). */
      year?: number;
    };

// Optional weekday between "resets" and the time covers weekly banners
// ("resets Tuesday 9am (UTC)").
const RESET_TIME_REGEX =
  /resets?\s+(?:at\s+)?(?:on\s+)?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;
const RELATIVE_TIME_REGEX =
  /(?:try again|wait|resets?\s+in)[:\s]\s*(?:for\s+)?(?:in\s+)?(\d+)\s*(hours?|minutes?|mins?|h|m)\b/i;
// "resets Tuesday 3pm" / "resets on Mon" -- weekly limits carry a day name.
const DAY_REGEX = /resets?\s+(?:on\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*/i;
const DAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
// Month-date weekly form (transcript/API error text):
//   "resets Jul 4 at 12:30am (Asia/Calcutta)"
const RESET_DATE_REGEX =
  /resets?\s+(?:on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;

// Codex-style forms kept from the port ("try again at ...", local time):
//   same day:  "or try again at 3:51 PM."
//   cross-day: "or try again at Feb 23rd, 2026 9:01 PM."
//   older:     "Try again in 4 days 20 hours 9 minutes."
const TRY_AT_TIME_REGEX = /try again at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
const TRY_AT_DATE_REGEX =
  /try again at\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)/i;
const MULTI_RELATIVE_REGEX = /try again in\s+(?:(\d+)\s*days?\s*)?(?:(\d+)\s*hours?\s*)?(?:(\d+)\s*min(?:ute)?s?)?/i;
const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function to24h(hour: number, ampm: string | null): number {
  let h = hour;
  if (ampm === "pm" && h !== 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return h;
}

/**
 * Range-validate parsed clock/date fields BEFORE they reach Date math: JS Date
 * silently normalizes "99:99" or "Feb 31" into a different valid instant, and
 * the iterative wall-clock correction turns a NaN seed into a stuck record.
 * Out-of-range means we misread the banner -- callers fall back.
 */
function validClock(hour: number, minute: number, ampm: string | null): boolean {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false;
  if (minute < 0 || minute > 59) return false;
  return ampm ? hour >= 1 && hour <= 12 : hour >= 0 && hour <= 23;
}

function validDayOfMonth(day: number): boolean {
  return Number.isInteger(day) && day >= 1 && day <= 31;
}

export function parseResetTime(text: string | null | undefined): ParsedReset | null {
  if (!text) return null;

  // Full-date form first -- its trailing "9:01 PM" would otherwise be eaten by
  // the same-day "try again at" regex.
  const dateMatch = text.match(TRY_AT_DATE_REGEX);
  if (dateMatch) {
    const mon = dateMatch[1]!;
    const day = parseInt(dateMatch[2]!, 10);
    const year = parseInt(dateMatch[3]!, 10);
    const hour = parseInt(dateMatch[4]!, 10);
    const minute = parseInt(dateMatch[5]!, 10);
    const ampm = dateMatch[6]!.toLowerCase();
    if (!validClock(hour, minute, ampm) || !validDayOfMonth(day)) return null;
    const month = MONTH_INDEX[mon.toLowerCase()]!;
    const d = new Date(year, month, day, to24h(hour, ampm), minute);
    // Round-trip guard: Date normalizes impossible dates (Feb 31 -> Mar 3).
    if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return null;
    return { absolute: true, atMs: d.getTime() };
  }

  const tryAtMatch = text.match(TRY_AT_TIME_REGEX);
  if (tryAtMatch) {
    const hour = parseInt(tryAtMatch[1]!, 10);
    const minute = tryAtMatch[2] ? parseInt(tryAtMatch[2], 10) : 0;
    const ampm = tryAtMatch[3]!.toLowerCase();
    if (!validClock(hour, minute, ampm)) return null;
    return {
      hour: to24h(hour, ampm),
      minute,
      timezone: null, ambiguous: false, day: null,
    };
  }

  const resetDateMatch = text.match(RESET_DATE_REGEX);
  if (resetDateMatch) {
    const mon = resetDateMatch[1]!;
    const dayOfMonth = parseInt(resetDateMatch[2]!, 10);
    const year = resetDateMatch[3] ? parseInt(resetDateMatch[3], 10) : undefined;
    const hourRaw = parseInt(resetDateMatch[4]!, 10);
    const minute = resetDateMatch[5] ? parseInt(resetDateMatch[5], 10) : 0;
    const ampm = resetDateMatch[6]?.toLowerCase() ?? null;
    const timezone = resetDateMatch[7] ?? null;
    if (!validClock(hourRaw, minute, ampm) || !validDayOfMonth(dayOfMonth)) return null;
    const month = MONTH_INDEX[mon.toLowerCase()]!;
    // An explicit year makes the date fully determined: validate the calendar
    // date up front (Feb 31 with a year is a misread) via a Date round-trip in
    // UTC (the tz only shifts the instant, never which calendar day this is).
    if (year !== undefined) {
      const probe = new Date(Date.UTC(year, month, dayOfMonth));
      if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month || probe.getUTCDate() !== dayOfMonth) {
        return null;
      }
    }
    let hour = hourRaw;
    if (ampm === "pm" && hour !== 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    return {
      month,
      dayOfMonth,
      year,
      hour,
      minute,
      timezone,
      ambiguous: !ampm && hour >= 1 && hour <= 12,
      day: null,
    };
  }

  const dayMatch = text.match(DAY_REGEX);
  const absMatch = text.match(RESET_TIME_REGEX);
  if (absMatch) {
    const hourRaw = parseInt(absMatch[1]!, 10);
    const minute = absMatch[2] ? parseInt(absMatch[2], 10) : 0;
    const ampm = absMatch[3]?.toLowerCase() ?? null;
    const timezone = absMatch[4] ?? null;
    if (validClock(hourRaw, minute, ampm)) {
      let hour = hourRaw;
      if (ampm === "pm" && hour !== 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;

      const ambiguous = !ampm && hour >= 1 && hour <= 12;
      return {
        hour, minute, timezone, ambiguous,
        day: dayMatch ? DAY_INDEX[dayMatch[1]!.toLowerCase()]! : null,
      };
    }
    // Invalid clock in the absolute form: fall through to the relative forms
    // (the same banner may still carry a parseable "resets in ..." phrase).
  }

  const relMatch = text.match(RELATIVE_TIME_REGEX);
  if (relMatch) {
    const amount = parseInt(relMatch[1]!, 10);
    const unit = relMatch[2]!.toLowerCase();
    const isMinutes = unit.startsWith("m");
    return { relative: true, waitMs: amount * (isMinutes ? 60_000 : 3_600_000) };
  }

  // Multi-unit relative ("in 4 days 20 hours 9 minutes") -- checked after the
  // single-unit form, which already covers "in 2 hours" / "in 5 minutes".
  const multiMatch = text.match(MULTI_RELATIVE_REGEX);
  if (multiMatch && (multiMatch[1] || multiMatch[2] || multiMatch[3])) {
    const days = parseInt(multiMatch[1] ?? "0", 10);
    const hours = parseInt(multiMatch[2] ?? "0", 10);
    const minutes = parseInt(multiMatch[3] ?? "0", 10);
    return { relative: true, waitMs: ((days * 24 + hours) * 60 + minutes) * 60_000 };
  }

  // Day-only weekly banner ("resets Tuesday") with no time -- midnight target,
  // resolved by resetAtMs via hour 0.
  if (dayMatch) {
    return { hour: 0, minute: 0, timezone: null, ambiguous: false, day: DAY_INDEX[dayMatch[1]!.toLowerCase()]! };
  }

  return null;
}

export interface ResetAtOptions {
  marginMs?: number;
  fallbackMs?: number;
  now?: Date;
}

/**
 * Convert parsed reset info into an absolute epoch ms (includes margin).
 * Unparseable input falls back to now + fallbackMs.
 */
export function resetAtMs(
  parsed: ParsedReset | null,
  { marginMs = DEFAULT_MARGIN_MS, fallbackMs = DEFAULT_FALLBACK_MS, now = new Date() }: ResetAtOptions = {},
): { at: number; source: ResetSource } {
  if (!parsed) return { at: now.getTime() + fallbackMs + marginMs, source: "fallback" };
  if ("relative" in parsed) return { at: now.getTime() + parsed.waitMs + marginMs, source: "relative" };
  const source: ResetSource = "absolute";
  // Pre-resolved epoch (full-date banner, local time). A stale past date means
  // we misread the banner -- fall back rather than firing immediately.
  if ("absolute" in parsed) {
    if (parsed.atMs <= now.getTime()) return { at: now.getTime() + fallbackMs + marginMs, source: "fallback" };
    return { at: parsed.atMs + marginMs, source };
  }

  let tz: string;
  try {
    tz = parsed.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return { at: now.getTime() + fallbackMs + marginMs, source: "fallback" };
  }

  // DST-safe: build today's date in the target tz, then iteratively correct the
  // UTC guess until it formats as the desired local h:m. Correction normalized
  // to [-720, +720] minutes to take the minimum-magnitude step (avoids the
  // off-by-a-day bug in high-offset timezones).
  function correctWallClock(candidate: number, h: number, m: number): number {
    for (let i = 0; i < 3; i++) {
      const fp = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour: "numeric", minute: "numeric", hour12: false,
      }).formatToParts(new Date(candidate));
      const ch = parseInt(fp.find((p) => p.type === "hour")!.value, 10) % 24;
      const cm = parseInt(fp.find((p) => p.type === "minute")!.value, 10);
      let diffMin = (h - ch) * 60 + (m - cm);
      diffMin = ((diffMin % 1440) + 1440) % 1440;
      if (diffMin > 720) diffMin -= 1440;
      if (diffMin === 0) break;
      candidate += diffMin * 60_000;
    }
    return candidate;
  }

  function targetTimestamp(h: number, m: number): number {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour12: false,
    }).formatToParts(now);
    const y = parseInt(parts.find((p) => p.type === "year")!.value, 10);
    const mo = parseInt(parts.find((p) => p.type === "month")!.value, 10);
    const d = parseInt(parts.find((p) => p.type === "day")!.value, 10);

    const targetStr = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
    return correctWallClock(new Date(targetStr + "Z").getTime(), h, m);
  }

  function nextOccurrence(h: number, m: number, day: number | null): number {
    let t = targetTimestamp(h, m);
    // Every day roll re-corrects the wall clock: a raw +24h jump across a DST
    // transition drifts the local time by an hour, so the resolved instant
    // would land an hour off the requested h:m in the target tz.
    if (t <= now.getTime()) t = correctWallClock(t + 86_400_000, h, m);
    if (day != null) {
      // Roll forward to the named weekday (in the target tz), re-correcting on
      // each step for the same DST reason.
      for (let i = 0; i < 7; i++) {
        const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" })
          .format(new Date(t)).toLowerCase().slice(0, 3);
        if (DAY_INDEX[wd] === day) break;
        t = correctWallClock(t + 86_400_000, h, m);
      }
    }
    return t;
  }

  // Month-date form ("resets Jul 4 at 12:30am (tz)"): roll forward from today
  // in the target tz to the named month/day, re-correct the wall-clock (the
  // walk may cross DST). An already-past date means we misread stale text --
  // fall back rather than waiting toward next year.
  if (parsed.month != null) {
    // Explicit-year form ("try again at Jan 2, 2027 9:00 AM"): the date is
    // fully determined -- resolve it directly in the target tz (no weekly-window
    // walk, no next-year inference). Clamping to the reset horizon happens in
    // resolveResetAt, so a stale past year still falls back there.
    if (parsed.year !== undefined) {
      const targetStr =
        `${parsed.year}-${String(parsed.month + 1).padStart(2, "0")}-${String(parsed.dayOfMonth).padStart(2, "0")}` +
        `T${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}:00`;
      const at = correctWallClock(new Date(targetStr + "Z").getTime(), parsed.hour, parsed.minute);
      // Match the pre-resolved "absolute" branch: an explicit year already in
      // the past falls back directly, so a direct resetAtMs caller (not just
      // resolveResetAt's later clamp) never receives a stale timestamp.
      if (!Number.isFinite(at) || at + marginMs <= now.getTime()) {
        return { at: now.getTime() + fallbackMs + marginMs, source: "fallback" };
      }
      return { at: at + marginMs, source };
    }
    const monthDayAt = (t: number): [number, number] => {
      const fp = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "numeric", day: "numeric" })
        .formatToParts(new Date(t));
      return [
        parseInt(fp.find((p) => p.type === "month")!.value, 10) - 1,
        parseInt(fp.find((p) => p.type === "day")!.value, 10),
      ];
    };
    const resolve = (h: number, m: number): number | null => {
      // Re-correct the wall clock on EVERY day step: a raw 24h jump across a
      // DST transition drifts the local time, and a drifted probe can match
      // the named date at the wrong instant (landing a day late after the
      // final correction). The walk is capped just past the 10-day acceptance
      // window below -- longer walks are discarded anyway.
      let t = targetTimestamp(h, m);
      for (let i = 0; i <= 12; i++) {
        const [mo, d] = monthDayAt(t);
        if (mo === parsed.month && d === parsed.dayOfMonth) return t;
        t = correctWallClock(t + 86_400_000, h, m);
      }
      return null; // beyond the weekly window (or an impossible date)
    };
    const candidates = parsed.ambiguous
      ? [resolve(parsed.hour, parsed.minute), resolve((parsed.hour + 12) % 24, parsed.minute)]
      : [resolve(parsed.hour, parsed.minute)];
    // The yearless form only ever names a date within the weekly window; a
    // resolution further out means the date already passed and the walk landed
    // on NEXT year's occurrence -- that's a misread, not an 11-month wait.
    const maxAhead = now.getTime() + 10 * 86_400_000;
    const future = candidates.filter((t): t is number => t != null && t > now.getTime() && t <= maxAhead);
    if (future.length === 0) return { at: now.getTime() + fallbackMs + marginMs, source: "fallback" };
    return { at: Math.min(...future) + marginMs, source };
  }

  let at: number;
  if (parsed.ambiguous) {
    const t1 = nextOccurrence(parsed.hour, parsed.minute, parsed.day);
    const t2 = nextOccurrence((parsed.hour + 12) % 24, parsed.minute, parsed.day);
    at = Math.min(t1, t2);
  } else {
    at = nextOccurrence(parsed.hour, parsed.minute, parsed.day);
  }
  return { at: at + marginMs, source };
}

/**
 * One-call resolution for the detection handler: parse the banner, convert to
 * an absolute reset time, and clamp to [now + CLAMP_MIN_MS, now + CLAMP_MAX_MS].
 * Out-of-bounds resolutions mean the banner was misread -- fall back instead of
 * firing immediately or scheduling months out.
 */
export function resolveResetAt(
  bannerText: string | null | undefined,
  opts: ResetAtOptions = {},
): { at: number; source: ResetSource } {
  const now = opts.now ?? new Date();
  const marginMs = opts.marginMs ?? DEFAULT_MARGIN_MS;
  const fallbackMs = opts.fallbackMs ?? DEFAULT_FALLBACK_MS;
  const resolved = resetAtMs(parseResetTime(bannerText), { ...opts, now, marginMs, fallbackMs });
  if (resolved.source === "fallback") return resolved;
  const lo = now.getTime() + CLAMP_MIN_MS;
  const hi = now.getTime() + CLAMP_MAX_MS;
  // NaN fails BOTH range comparisons, so check finiteness explicitly: a NaN
  // nextAttemptAt would leave the record permanently not-due.
  if (!Number.isFinite(resolved.at) || resolved.at < lo || resolved.at > hi) {
    return { at: now.getTime() + fallbackMs + marginMs, source: "fallback" };
  }
  return resolved;
}
