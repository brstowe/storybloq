import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ERA_ENDED_TTL_MS,
  ERA_STORE_SUBDIR,
  ERA_UNVERIFIABLE_TTL_MS,
  ERA_VERIFY_REWRITE_MS,
  MAX_ERA_SESSION_IDS,
  appendEraSession,
  createEraIfAbsent,
  eraFileBase,
  markEraEnded,
  parseEraEntry,
  readEra,
  sweepEraStore,
  type EraEntry,
} from "../../src/core/session-intel/era-store.js";
import { eraIdFor, type PsRunner } from "../../src/core/session-intel/process-era.js";

const T0 = Date.parse("2026-09-09T12:00:00Z");
const LSTART_SECONDS = Math.floor(T0 / 1000);

function lstartFor(seconds: number): string {
  // C-locale "Wed Sep  9 12:00:00 2026" from an epoch, in UTC.
  const d = new Date(seconds * 1000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** pid -> start seconds for live processes; anything else is gone. */
function fakePs(live: Record<number, number>, opts: { fail?: boolean; delayMs?: number } = {}): PsRunner & { calls: number } {
  const run = ((args: readonly string[]) => {
    run.calls++;
    if (opts.delayMs) {
      const until = Date.now() + opts.delayMs;
      while (Date.now() < until) { /* busy */ }
    }
    if (opts.fail) return null;
    const pids = args[1]!.split(",").map(Number);
    return pids
      .filter((p) => live[p] !== undefined)
      .map((p) => `${String(p).padStart(5)} ${lstartFor(live[p]!)}`)
      .join("\n") + "\n";
  }) as PsRunner & { calls: number };
  run.calls = 0;
  return run;
}

function entry(pid: number, over: Partial<EraEntry> = {}): EraEntry {
  return {
    era: eraIdFor(pid, LSTART_SECONDS),
    pid,
    startedAt: new Date(T0).toISOString(),
    captureKind: "startup",
    autoCompactWindowAtStart: 450_000,
    autoCompactWindowSource: "user",
    capturedAt: new Date(T0 + 1000).toISOString(),
    endedAt: null,
    lastVerifiedAt: new Date(T0 + 1000).toISOString(),
    unverifiableStreak: 0,
    sessionIds: ["s1"],
    ...over,
  };
}

function withRoot(fn: (root: string, dir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "era-store-"));
  try {
    mkdirSync(join(root, ".story"), { recursive: true });
    fn(root, join(root, ".story", "telemetry", ERA_STORE_SUBDIR));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const listJson = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : []);

describe("era store: entries", () => {
  it("first writer wins; a second create for the same era reports exists and changes nothing", () => {
    withRoot((root) => {
      const first = entry(100);
      expect(createEraIfAbsent(root, first)).toBe("created");
      expect(createEraIfAbsent(root, { ...first, captureKind: "late", autoCompactWindowAtStart: 1 })).toBe("exists");
      expect(readEra(root, first.era)).toEqual(first);
    });
  });

  it("file names are pid-epoch and never contain the colon", () => {
    expect(eraFileBase("11442:1757420115")).toBe("11442-1757420115");
    expect(eraFileBase("garbage")).toBeNull();
  });

  it("readEra is null for a missing store, a missing entry, a malformed one, and a name/content mismatch", () => {
    withRoot((root, dir) => {
      expect(readEra(root, eraIdFor(1, 1))).toBeNull();
      createEraIfAbsent(root, entry(1));
      expect(readEra(root, eraIdFor(2, LSTART_SECONDS))).toBeNull();
      writeFileSync(join(dir, `3-${LSTART_SECONDS}.json`), "{bad");
      expect(readEra(root, eraIdFor(3, LSTART_SECONDS))).toBeNull();
      writeFileSync(join(dir, `4-${LSTART_SECONDS}.json`), JSON.stringify(entry(5)));
      expect(readEra(root, eraIdFor(4, LSTART_SECONDS))).toBeNull();
    });
  });

  it("parseEraEntry is lenient on optional fields and strict on identity", () => {
    const e = parseEraEntry(JSON.stringify({ era: "1:2", capturedAt: "2026-01-01T00:00:00Z", startedAt: "2026-01-01T00:00:00Z" }));
    expect(e).toMatchObject({ era: "1:2", pid: 1, captureKind: "absent", autoCompactWindowAtStart: null, endedAt: null, sessionIds: [], unverifiableStreak: 0 });
    expect(e!.lastVerifiedAt).toBe("2026-01-01T00:00:00Z");
    expect(parseEraEntry(JSON.stringify({ era: "x", capturedAt: "2026-01-01T00:00:00Z", startedAt: "2026-01-01T00:00:00Z" }))).toBeNull();
    expect(parseEraEntry(JSON.stringify({ era: "1:2", startedAt: "2026-01-01T00:00:00Z" }))).toBeNull();
    const many = parseEraEntry(JSON.stringify({ ...entry(1), sessionIds: Array.from({ length: 30 }, (_, i) => `s${i}`) }));
    expect(many!.sessionIds).toHaveLength(MAX_ERA_SESSION_IDS);
  });

  it("appendEraSession dedupes, caps, and refuses on an ended era", () => {
    withRoot((root) => {
      const e = entry(7);
      createEraIfAbsent(root, e);
      expect(appendEraSession(root, e.era, "s2")).toBe(true);
      expect(appendEraSession(root, e.era, "s2")).toBe(true);
      expect(readEra(root, e.era)!.sessionIds).toEqual(["s1", "s2"]);
      for (let i = 0; i < 30; i++) appendEraSession(root, e.era, `x${i}`);
      expect(readEra(root, e.era)!.sessionIds).toHaveLength(MAX_ERA_SESSION_IDS);
      expect(markEraEnded(root, e.era, "2026-09-09T13:00:00Z")).toBe(true);
      expect(readEra(root, e.era)!.endedAt).toBe("2026-09-09T13:00:00Z");
      appendEraSession(root, e.era, "after-end");
      expect(readEra(root, e.era)!.sessionIds).not.toContain("after-end");
      // Idempotent close keeps the first timestamp.
      markEraEnded(root, e.era, "2026-09-09T14:00:00Z");
      expect(readEra(root, e.era)!.endedAt).toBe("2026-09-09T13:00:00Z");
    });
  });
});

describe("era store: sweep", () => {
  it("a verified live era is retained regardless of age with capture fields untouched", () => {
    withRoot((root) => {
      const e = entry(10);
      createEraIfAbsent(root, e);
      const now = T0 + 72 * 3600 * 1000 + ERA_UNVERIFIABLE_TTL_MS;
      const ps = fakePs({ 10: LSTART_SECONDS });
      const r = sweepEraStore(root, { now, run: ps });
      expect(r).toMatchObject({ attempted: 1, removed: 0, ended: 0 });
      const after = readEra(root, e.era)!;
      expect(after.captureKind).toBe("startup");
      expect(after.autoCompactWindowAtStart).toBe(450_000);
      expect(after.capturedAt).toBe(e.capturedAt);
      expect(after.lastVerifiedAt).toBe(new Date(now).toISOString());
    });
  });

  it("does not rewrite lastVerifiedAt within an hour of the last verification", () => {
    withRoot((root, dir) => {
      const e = entry(10);
      createEraIfAbsent(root, e);
      const before = readFileSync(join(dir, `10-${LSTART_SECONDS}.json`), "utf-8");
      sweepEraStore(root, { now: T0 + ERA_VERIFY_REWRITE_MS - 1, run: fakePs({ 10: LSTART_SECONDS }) });
      expect(readFileSync(join(dir, `10-${LSTART_SECONDS}.json`), "utf-8")).toBe(before);
    });
  });

  it("a gone pid, or a reused pid with another start time, is closed (endedAt), then expires 24 h later", () => {
    withRoot((root) => {
      const gone = entry(20);
      const reused = entry(21);
      createEraIfAbsent(root, gone);
      createEraIfAbsent(root, reused);
      const ps = fakePs({ 21: LSTART_SECONDS + 500 });
      const r1 = sweepEraStore(root, { now: T0 + 5000, run: ps });
      expect(r1).toMatchObject({ attempted: 2, ended: 2, removed: 0 });
      expect(ps.calls).toBe(1);
      expect(readEra(root, gone.era)!.endedAt).toBe(new Date(T0 + 5000).toISOString());
      expect(readEra(root, reused.era)!.endedAt).not.toBeNull();
      const r2 = sweepEraStore(root, { now: T0 + 5000 + ERA_ENDED_TTL_MS - 1, run: ps });
      expect(r2.removed).toBe(0);
      const r3 = sweepEraStore(root, { now: T0 + 5000 + ERA_ENDED_TTL_MS + 1, run: ps });
      expect(r3.removed).toBe(2);
      expect(readEra(root, gone.era)).toBeNull();
    });
  });

  it("unverifiable ps closes nothing; three unverifiable sweeps plus 7 days expire; a live answer resets the streak", () => {
    withRoot((root) => {
      const e = entry(30);
      createEraIfAbsent(root, e);
      const failing = fakePs({}, { fail: true });
      for (let i = 1; i <= 3; i++) {
        sweepEraStore(root, { now: T0 + i * 1000, run: failing });
        const cur = readEra(root, e.era)!;
        expect(cur.endedAt).toBeNull();
        expect(cur.unverifiableStreak).toBe(i);
      }
      // Streak reached but TTL not: kept.
      expect(sweepEraStore(root, { now: T0 + 4000, run: failing }).removed).toBe(0);
      // A live answer heals it.
      sweepEraStore(root, { now: T0 + 5000, run: fakePs({ 30: LSTART_SECONDS }) });
      expect(readEra(root, e.era)!.unverifiableStreak).toBe(0);
      // Three more failures past the TTL: expired.
      const late = T0 + ERA_UNVERIFIABLE_TTL_MS + 10_000;
      sweepEraStore(root, { now: late, run: failing });
      sweepEraStore(root, { now: late + 1, run: failing });
      expect(readEra(root, e.era)).not.toBeNull();
      expect(sweepEraStore(root, { now: late + 2, run: failing }).removed).toBe(1);
    });
  });

  it("cursor schedules entries in sorted order, at most maxEntries per call, wrapping, and never starves closed or unverifiable ones", () => {
    withRoot((root, dir) => {
      for (let pid = 100; pid < 130; pid++) createEraIfAbsent(root, entry(pid));
      const failing = fakePs({}, { fail: true });
      const r1 = sweepEraStore(root, { now: T0 + 1000, run: failing });
      expect(r1.attempted).toBe(25);
      expect(r1.cursor).toBe(`124-${LSTART_SECONDS}.json`);
      expect(readFileSync(join(dir, ".cursor"), "utf-8").trim()).toBe(r1.cursor);
      // Second pass reaches the remaining five, then wraps to the first twenty.
      const r2 = sweepEraStore(root, { now: T0 + 2000, run: failing });
      expect(r2.attempted).toBe(25);
      expect(readEra(root, eraIdFor(129, LSTART_SECONDS))!.unverifiableStreak).toBe(1);
      expect(readEra(root, eraIdFor(100, LSTART_SECONDS))!.unverifiableStreak).toBe(2);
      expect(readEra(root, eraIdFor(124, LSTART_SECONDS))!.unverifiableStreak).toBe(1);
      // Every entry was attempted at least once across the two passes.
      for (let pid = 100; pid < 130; pid++) expect(readEra(root, eraIdFor(pid, LSTART_SECONDS))!.unverifiableStreak).toBeGreaterThan(0);
    });
  });

  it("the cursor clears once the pass reaches the end of the listing", () => {
    withRoot((root, dir) => {
      for (let pid = 1; pid <= 3; pid++) createEraIfAbsent(root, entry(pid));
      const r = sweepEraStore(root, { now: T0 + 1000, run: fakePs({ 1: LSTART_SECONDS, 2: LSTART_SECONDS, 3: LSTART_SECONDS }) });
      expect(r.attempted).toBe(3);
      expect(r.cursor).toBeNull();
      expect(existsSync(join(dir, ".cursor"))).toBe(false);
    });
  });

  it("a large directory with a slow ps stays within the budget and still makes progress", () => {
    withRoot((root) => {
      for (let pid = 200; pid < 225; pid++) createEraIfAbsent(root, entry(pid));
      // One batched ps per call regardless of entry count; the per-entry budget stops the loop.
      const ps = fakePs({}, { delayMs: 30 });
      let t = 0;
      const clock = () => (t += 20); // each checkpoint costs 20 ms of the 50 ms budget
      const r = sweepEraStore(root, { now: T0 + 1000, run: ps, budgetMs: 50, clock });
      expect(ps.calls).toBe(1);
      expect(r.attempted).toBeGreaterThan(0);
      expect(r.attempted).toBeLessThan(25);
      expect(r.cursor).not.toBeNull();
      const r2 = sweepEraStore(root, { now: T0 + 2000, run: fakePs({}, { fail: true }) });
      expect(r2.attempted).toBeGreaterThan(0);
    });
  });

  it("removes unparseable entries and name/content mismatches; leaves non-json and the cursor alone", () => {
    withRoot((root, dir) => {
      createEraIfAbsent(root, entry(1));
      writeFileSync(join(dir, `2-${LSTART_SECONDS}.json`), "{bad");
      writeFileSync(join(dir, `3-${LSTART_SECONDS}.json`), JSON.stringify(entry(4)));
      writeFileSync(join(dir, "notes.txt"), "keep");
      const r = sweepEraStore(root, { now: T0 + 1000, run: fakePs({ 1: LSTART_SECONDS }) });
      expect(r.removed).toBe(2);
      expect(listJson(dir)).toEqual([`1-${LSTART_SECONDS}.json`]);
      expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    });
  });

  it("unverifiable expiry re-reads under the lock: an era verified live between snapshot and delete survives", () => {
    withRoot((root, dir) => {
      const e = entry(40, { unverifiableStreak: 2, lastVerifiedAt: new Date(T0 - ERA_UNVERIFIABLE_TTL_MS - 1000).toISOString() });
      createEraIfAbsent(root, e);
      // A ps whose call side-effects a concurrent "verification" of the same era
      // before the sweep reaches its expiry decision.
      const racing: PsRunner = (args) => {
        const fresh = { ...e, unverifiableStreak: 0, lastVerifiedAt: new Date(T0).toISOString() };
        writeFileSync(join(dir, `40-${LSTART_SECONDS}.json`), JSON.stringify(fresh) + "\n");
        return fakePs({}, { fail: true })(args);
      };
      const r = sweepEraStore(root, { now: T0 + 1000, run: racing });
      expect(r.removed).toBe(0);
      const after = readEra(root, e.era)!;
      expect(after.unverifiableStreak).toBe(1);
      expect(after.lastVerifiedAt).toBe(new Date(T0).toISOString());
    });
  });

  it("publication is atomic: no partial .json is ever visible, a dead writer's tmp is swept, and a retry can still create", () => {
    withRoot((root, dir) => {
      const e = entry(50);
      // Simulate a writer that died mid-publication: a stale tmp, no final file.
      mkdirSync(dir, { recursive: true });
      const staleTmp = join(dir, `.tmp-50-${LSTART_SECONDS}-1-1-1`);
      writeFileSync(staleTmp, "{\"era\":\"50:");
      const old = (T0 - 120_000) / 1000;
      const { utimesSync } = require("node:fs") as typeof import("node:fs");
      utimesSync(staleTmp, old, old);
      expect(listJson(dir)).toEqual([]);
      expect(createEraIfAbsent(root, e)).toBe("created");
      expect(readdirSync(dir).filter((n) => n.startsWith(".tmp-"))).toEqual([staleTmp.slice(dir.length + 1)]);
      const r = sweepEraStore(root, { now: T0, run: fakePs({ 50: LSTART_SECONDS }) });
      expect(r.removed).toBe(1);
      expect(readdirSync(dir).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
      expect(readEra(root, e.era)).toEqual(e);
      // No tmp is left behind by a successful publication either.
      createEraIfAbsent(root, entry(51));
      expect(readdirSync(dir).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
    });
  });

  it("a symlinked .story or telemetry parent makes the store invisible: nothing is read, updated or deleted through it", () => {
    const outside = mkdtempSync(join(tmpdir(), "era-outside-"));
    const root = mkdtempSync(join(tmpdir(), "era-root-"));
    try {
      const realStore = join(outside, "telemetry", ERA_STORE_SUBDIR);
      mkdirSync(realStore, { recursive: true });
      const e = entry(60);
      writeFileSync(join(realStore, `60-${LSTART_SECONDS}.json`), JSON.stringify(e) + "\n");
      writeFileSync(join(realStore, `61-${LSTART_SECONDS}.json`), "{bad");
      const { symlinkSync } = require("node:fs") as typeof import("node:fs");
      symlinkSync(outside, join(root, ".story"));
      expect(readEra(root, e.era)).toBeNull();
      expect(appendEraSession(root, e.era, "x")).toBe(false);
      expect(sweepEraStore(root, { now: T0, run: fakePs({}) })).toEqual({ attempted: 0, removed: 0, ended: 0, cursor: null });
      expect(readdirSync(realStore).sort()).toEqual([`60-${LSTART_SECONDS}.json`, `61-${LSTART_SECONDS}.json`]);
      // Same with a symlinked telemetry level under a real .story.
      rmSync(join(root, ".story"));
      mkdirSync(join(root, ".story"));
      symlinkSync(join(outside, "telemetry"), join(root, ".story", "telemetry"));
      expect(readEra(root, e.era)).toBeNull();
      expect(sweepEraStore(root, { now: T0, run: fakePs({}) }).attempted).toBe(0);
      expect(readdirSync(realStore)).toHaveLength(2);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an absent store is a no-op", () => {
    withRoot((root) => {
      expect(sweepEraStore(root, { run: fakePs({}) })).toEqual({ attempted: 0, removed: 0, ended: 0, cursor: null });
    });
  });
});
