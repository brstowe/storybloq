import { describe, it, expect } from "vitest";
import {
  ProcessEraResolver,
  REVALIDATION_MEMO_MS,
  checkEra,
  eraIdFor,
  parseClaudePid,
  parseEraId,
  parseLstart,
  probeStarts,
  type PsRunner,
} from "../../src/core/session-intel/process-era.js";

/** `ps -o lstart=` under LC_ALL=C TZ=UTC for 2026-09-09T12:15:15Z. */
const LSTART = "Wed Sep  9 12:15:15 2026";
const LSTART_SECONDS = Math.floor(Date.parse("2026-09-09T12:15:15Z") / 1000);

function fakePs(table: Record<number, string | "gone">, opts: { fail?: boolean } = {}): PsRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = ((args: readonly string[]) => {
    calls.push([...args]);
    if (opts.fail) return null;
    const pids = args[1]!.split(",").map(Number);
    const batched = args[3] === "pid=,lstart=";
    const lines: string[] = [];
    for (const pid of pids) {
      const row = table[pid];
      if (row === undefined || row === "gone") continue;
      lines.push(batched ? `${String(pid).padStart(5)} ${row}` : row);
    }
    return lines.length ? lines.join("\n") + "\n" : "";
  }) as PsRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

describe("parseLstart / ids", () => {
  it("parses the C-locale form as UTC regardless of this process's zone", () => {
    expect(parseLstart(LSTART)).toBe(LSTART_SECONDS);
    expect(parseLstart(`  ${LSTART}\n`)).toBe(LSTART_SECONDS);
  });

  it("rejects empty, garbage, and oversize text", () => {
    expect(parseLstart("")).toBeNull();
    expect(parseLstart("not a date")).toBeNull();
    expect(parseLstart("x".repeat(41))).toBeNull();
  });

  it("CLAUDE_PID must be a positive decimal integer string", () => {
    expect(parseClaudePid("11442")).toBe(11442);
    for (const bad of [undefined, "", "0", "-1", "12.5", "1e3", " 12", "abc", 12]) expect(parseClaudePid(bad)).toBeNull();
  });

  it("era ids round-trip and malformed ones are rejected", () => {
    const id = eraIdFor(11442, LSTART_SECONDS);
    expect(id).toBe(`11442:${LSTART_SECONDS}`);
    expect(parseEraId(id)).toEqual({ pid: 11442, startedSeconds: LSTART_SECONDS });
    for (const bad of ["", "11442", ":1", "0:1", "1:0", "a:b", "1:2:3", "11442:1 "]) expect(parseEraId(bad)).toBeNull();
  });
});

describe("ProcessEraResolver.current", () => {
  it("is pid + UTC epoch, cached per process, one ps call", () => {
    const ps = fakePs({ 11442: LSTART });
    const r = new ProcessEraResolver({ CLAUDE_PID: "11442" }, ps);
    expect(r.current()).toEqual({ pid: 11442, startedAt: "2026-09-09T12:15:15.000Z", id: `11442:${LSTART_SECONDS}` });
    r.current();
    expect(ps.calls).toEqual([["-p", "11442", "-o", "lstart="]]);
  });

  it("is null without CLAUDE_PID, with a malformed one, or when the pid is gone", () => {
    expect(new ProcessEraResolver({}, fakePs({})).current()).toBeNull();
    expect(new ProcessEraResolver({ CLAUDE_PID: "nope" }, fakePs({})).current()).toBeNull();
    expect(new ProcessEraResolver({ CLAUDE_PID: "7" }, fakePs({ 7: "gone" })).current()).toBeNull();
  });

  it("a transient ps failure at startup is retried on the next call, not cached as null", () => {
    let fail = true;
    const ps: PsRunner = (args) => (fail ? null : fakePs({ 11442: LSTART })(args));
    const r = new ProcessEraResolver({ CLAUDE_PID: "11442" }, ps);
    expect(r.current()).toBeNull();
    fail = false;
    expect(r.current()?.id).toBe(`11442:${LSTART_SECONDS}`);
  });
});

describe("ProcessEraResolver.revalidate (tri-state)", () => {
  it("live when the same pid reports the same start; memoised for 5 s", () => {
    let now = 1_000;
    const ps = fakePs({ 11442: LSTART });
    const r = new ProcessEraResolver({ CLAUDE_PID: "11442" }, ps, () => now);
    r.current();
    expect(r.revalidate()).toBe("live");
    expect(r.revalidate()).toBe("live");
    expect(ps.calls).toHaveLength(2);
    now += REVALIDATION_MEMO_MS;
    expect(r.revalidate()).toBe("live");
    expect(ps.calls).toHaveLength(3);
  });

  it("pid reuse (same pid, different start) is ended, never live; ended is never un-ended", () => {
    const table: Record<number, string | "gone"> = { 11442: LSTART };
    let now = 0;
    const r = new ProcessEraResolver({ CLAUDE_PID: "11442" }, (args) => fakePs(table)(args), () => now);
    r.current();
    table[11442] = "Wed Sep  9 13:00:00 2026";
    expect(r.revalidate()).toBe("ended");
    table[11442] = LSTART;
    now += REVALIDATION_MEMO_MS * 10;
    expect(r.revalidate()).toBe("ended");
  });

  it("a failing ps is unverifiable, and a later successful one resumes live (nothing closed)", () => {
    let fail = false;
    let now = 0;
    const ps: PsRunner = (args) => (fail ? null : fakePs({ 11442: LSTART })(args));
    const r = new ProcessEraResolver({ CLAUDE_PID: "11442" }, ps, () => now);
    expect(r.current()).not.toBeNull();
    fail = true;
    expect(r.revalidate()).toBe("unverifiable");
    fail = false;
    expect(r.revalidate()).toBe("unverifiable"); // memoised
    now += REVALIDATION_MEMO_MS;
    expect(r.revalidate()).toBe("live");
  });

  it("a null era is unverifiable, never live", () => {
    expect(new ProcessEraResolver({}, fakePs({})).revalidate()).toBe("unverifiable");
  });
});

describe("checkEra / probeStarts", () => {
  it("classifies arbitrary era ids", () => {
    const id = eraIdFor(11442, LSTART_SECONDS);
    expect(checkEra(id, fakePs({ 11442: LSTART }))).toBe("live");
    expect(checkEra(id, fakePs({ 11442: "gone" }))).toBe("ended");
    expect(checkEra(id, fakePs({ 11442: "Wed Sep  9 13:00:00 2026" }))).toBe("ended");
    expect(checkEra(id, fakePs({}, { fail: true }))).toBe("unverifiable");
    expect(checkEra("garbage", fakePs({}))).toBe("ended");
  });

  it("one batched ps answers for every pid; absent rows are ended; failure is null for all", () => {
    const ps = fakePs({ 1: LSTART, 3: "Wed Sep  9 13:00:00 2026" });
    const starts = probeStarts([1, 2, 3], ps);
    expect(ps.calls).toEqual([["-p", "1,2,3", "-o", "pid=,lstart="]]);
    expect(starts.get(1)).toBe(LSTART_SECONDS);
    expect(starts.get(2)).toBe("ended");
    expect(starts.get(3)).toBe(Math.floor(Date.parse("2026-09-09T13:00:00Z") / 1000));
    const failed = probeStarts([1, 2], fakePs({}, { fail: true }));
    expect(failed.get(1)).toBeNull();
    expect(failed.get(2)).toBeNull();
    expect(probeStarts([], ps).size).toBe(0);
  });

  it("malformed batch output is not evidence of death: every pid becomes unverifiable", () => {
    const garbage: PsRunner = () => `    1 ${LSTART}\nps: unexpected column\n`;
    const starts = probeStarts([1, 2], garbage);
    expect(starts.get(1)).toBeNull();
    expect(starts.get(2)).toBeNull();
    const badTime: PsRunner = () => `    1 not a time\n`;
    expect(probeStarts([1, 2], badTime).get(2)).toBeNull();
    // Blank lines are fine.
    expect(probeStarts([1, 2], () => `\n    1 ${LSTART}\n\n`).get(2)).toBe("ended");
  });

  it("single-pid output that is not a start time is unverifiable, not live and not ended", () => {
    expect(checkEra(eraIdFor(1, LSTART_SECONDS), () => "garbage output\n")).toBe("unverifiable");
  });
});

describe("defaultPsRunner against the real ps", () => {
  it("reports this process live with a parseable start, and a pid that cannot exist as ended", async () => {
    const { defaultPsRunner, probeStart } = await import("../../src/core/session-intel/process-era.js");
    const mine = probeStart(process.pid, defaultPsRunner);
    expect(typeof mine).toBe("number");
    expect(Math.abs((mine as number) * 1000 - (Date.now() - process.uptime() * 1000))).toBeLessThan(5000);
    // PID_MAX on macOS is 99998 and on Linux at most 4194304; 2147483647 is never occupied.
    expect(probeStart(2147483647, defaultPsRunner)).toBe("ended");
  });
});
