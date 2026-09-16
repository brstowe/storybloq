/**
 * T-499 build 8: the telemetry sweep's single entry point (CLI housekeeping).
 * Era entries go through sweepEraStore; orphan pending directories (no
 * presence record) lose their files older than the presence TTL under the
 * session lock and are removed only once empty; a live session's pending
 * directory is never touched; one op/time budget bounds the whole pass.
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, utimesSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepSessionIntelTelemetry, sweepOrphanPendingDirs, ORPHAN_PENDING_TTL_MS, ORPHAN_PENDING_MAX_SCAN } from "../../src/core/session-intel/housekeeping.js";
import { createEraIfAbsent, readEra, ERA_ENDED_TTL_MS, type EraEntry } from "../../src/core/session-intel/era-store.js";
import { markCompactPending, PENDING_SUBDIR } from "../../src/core/session-intel/presence-bridge.js";
import { eraIdFor, type PsRunner } from "../../src/core/session-intel/process-era.js";
import { acquireLock, ensurePresenceDir, releaseLock } from "../../src/presence/io.js";
import { presenceFileBase } from "../../src/presence/types.js";

const T0 = Date.parse("2026-09-09T12:00:00Z");
const NOW = T0 + 3 * 24 * 3600 * 1000;
const SID = "4d99abbf-5dcb-4be3-90d3-2b13e0f50b29";
const SID2 = "5e00abbf-5dcb-4be3-90d3-2b13e0f50b30";
const SID3 = "6f00abbf-5dcb-4be3-90d3-2b13e0f50b31";
const noneAlive: PsRunner = () => "\n";

function withRoot(fn: (root: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), "si-hk-"));
  const root = join(base, "proj");
  mkdirSync(join(root, ".story"), { recursive: true });
  writeFileSync(join(root, ".story", "config.json"), "{}\n");
  try { fn(root); } finally { rmSync(base, { recursive: true, force: true }); }
}

function endedEra(pid: number, endedAt: string): EraEntry {
  return { era: eraIdFor(pid, Math.floor(T0 / 1000)), pid, startedAt: new Date(T0).toISOString(), captureKind: "startup", autoCompactWindowAtStart: 450_000, autoCompactWindowSource: "user", capturedAt: new Date(T0).toISOString(), endedAt, lastVerifiedAt: endedAt, unverifiableStreak: 0, sessionIds: [SID] };
}

/** Sets an entry's mtime to an absolute epoch-ms value. */
const setMtime = (path: string, ms: number): void => utimesSync(path, ms / 1000, ms / 1000);
const pendingDir = (root: string, sid: string) => join(root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase(sid));
/** Publishes one pending event and ages the file and directory to T0. */
function oldPending(root: string, sid: string, eventId: string): string {
  expect(markCompactPending(root, sid, { eventId, era: null, at: new Date(T0).toISOString() })).toBe(true);
  const dir = pendingDir(root, sid);
  for (const n of readdirSync(dir)) setMtime(join(dir, n), T0);
  setMtime(dir, T0);
  return dir;
}

describe("sweepSessionIntelTelemetry", () => {
  it("removes an era ended past its TTL and an orphan pending directory; keeps a live session's directory and a fresh era; idempotent", () => {
    withRoot((root) => {
      const stale = endedEra(1, new Date(T0 + 3600 * 1000).toISOString());
      const fresh = endedEra(2, new Date(NOW - 1000).toISOString());
      expect(NOW - Date.parse(stale.endedAt!)).toBeGreaterThan(ERA_ENDED_TTL_MS);
      createEraIfAbsent(root, stale);
      createEraIfAbsent(root, fresh);
      const presenceDir = ensurePresenceDir(root)!;
      const liveDir = oldPending(root, SID, "e1");
      writeFileSync(join(presenceDir, `${presenceFileBase(SID)}.json`), "{}");
      const orphanDir = oldPending(root, SID2, "e2");

      const r = sweepSessionIntelTelemetry(root, { now: NOW, run: noneAlive });
      expect(r.eras.removed).toBe(1);
      expect(readEra(root, stale.era)).toBeNull();
      expect(readEra(root, fresh.era)).not.toBeNull();
      expect(r.pending).toMatchObject({ examined: 2, filesRemoved: 1, dirsRemoved: 1, exhausted: false, cursor: null });
      expect(existsSync(orphanDir)).toBe(false);
      expect(readdirSync(liveDir)).toHaveLength(1);
      expect(sweepSessionIntelTelemetry(root, { now: NOW, run: noneAlive }).pending).toMatchObject({ examined: 1, filesRemoved: 0, dirsRemoved: 0, exhausted: false });
    });
  });

  it("an event published after the listing survives (its own mtime is young) and the directory stays; a record that reappears stops the sweep under the lock", () => {
    withRoot((root) => {
      ensurePresenceDir(root);
      const dir = oldPending(root, SID2, "old");
      // A concurrent publisher: a fresh event beside the old one, directory mtime old.
      expect(markCompactPending(root, SID2, { eventId: "new", era: null, at: new Date(NOW).toISOString() })).toBe(true);
      for (const n of readdirSync(dir)) if (n.includes("new")) setMtime(join(dir, n), NOW);
      setMtime(dir, T0);
      const r = sweepOrphanPendingDirs(root, { now: NOW });
      expect(r).toMatchObject({ examined: 1, filesRemoved: 1, dirsRemoved: 0, exhausted: false });
      const left = readdirSync(dir);
      expect(left).toHaveLength(1);
      expect(left[0]).toContain("new");

      // A record that reappears: nothing is touched even though the file is old.
      setMtime(join(dir, left[0]!), T0);
      const presenceDir = ensurePresenceDir(root)!;
      writeFileSync(join(presenceDir, `${presenceFileBase(SID2)}.json`), "{}");
      expect(sweepOrphanPendingDirs(root, { now: NOW })).toMatchObject({ examined: 1, filesRemoved: 0, dirsRemoved: 0, exhausted: false });
      expect(readdirSync(dir)).toHaveLength(1);
    });
  });

  it("a busy session lock skips the directory for this pass", () => {
    withRoot((root) => {
      const presenceDir = ensurePresenceDir(root)!;
      const dir = oldPending(root, SID2, "e");
      const lockPath = join(presenceDir, `${presenceFileBase(SID2)}.lock`);
      expect(acquireLock(lockPath, 0)).toBe(true);
      try {
        expect(sweepOrphanPendingDirs(root, { now: NOW })).toMatchObject({ examined: 1, filesRemoved: 0, dirsRemoved: 0, exhausted: false });
        expect(readdirSync(dir)).toHaveLength(1);
      } finally {
        releaseLock(lockPath);
      }
      expect(sweepOrphanPendingDirs(root, { now: NOW }).dirsRemoved).toBe(1);
    });
  });

  it("a directory holding a non-regular entry is left completely alone: no file in it is unlinked", () => {
    withRoot((root) => {
      ensurePresenceDir(root);
      const dir = oldPending(root, SID2, "e");
      symlinkSync(join(dir, "missing"), join(dir, "link"));
      mkdirSync(join(dir, "nested"));
      setMtime(dir, T0);
      expect(sweepOrphanPendingDirs(root, { now: NOW })).toMatchObject({ examined: 1, filesRemoved: 0, dirsRemoved: 0, exhausted: false });
      expect(readdirSync(dir).sort()).toEqual(["link", "nested", readdirSync(dir).find((n) => n.endsWith(".json"))!].sort());
      expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toHaveLength(1);
    });
  });

  it("one op budget bounds the whole pass and the next pass continues; the time budget stops a pass too", () => {
    withRoot((root) => {
      ensurePresenceDir(root);
      const a = oldPending(root, SID2, "a");
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(a, `x${i}.json`), "{}");
        setMtime(join(a, `x${i}.json`), T0);
      }
      const b = oldPending(root, SID3, "b");
      // 6 files + rmdir in a, 1 file + rmdir in b = 9 ops; budget 4 stops inside a.
      const r1 = sweepOrphanPendingDirs(root, { now: NOW, maxOps: 4 });
      expect(r1).toMatchObject({ filesRemoved: 4, dirsRemoved: 0, exhausted: true });
      expect(readdirSync(a)).toHaveLength(2);
      expect(readdirSync(b)).toHaveLength(1);
      // Cut short INSIDE a: the cursor stays before a, so pass 2 retries a
      // first (2 files + rmdir = 3 ops) and has one op left for b's file.
      expect(r1.cursor).toBeNull();
      const r2 = sweepOrphanPendingDirs(root, { now: NOW, maxOps: 4 });
      expect(r2).toMatchObject({ examined: 2, filesRemoved: 3, dirsRemoved: 1, exhausted: true });
      expect(existsSync(a)).toBe(false);
      expect(existsSync(b)).toBe(true);
      expect(readdirSync(b)).toHaveLength(0);
      expect(sweepOrphanPendingDirs(root, { now: NOW, maxOps: 4 })).toMatchObject({ examined: 1, filesRemoved: 0, dirsRemoved: 1, exhausted: false });
      expect(existsSync(b)).toBe(false);

      // Time budget: a clock already past the deadline does nothing.
      const c = oldPending(root, SID2, "c");
      let t = 0;
      const clock = () => (t += 1000);
      expect(sweepOrphanPendingDirs(root, { now: NOW, budgetMs: 1, clock })).toMatchObject({ examined: 0, filesRemoved: 0, dirsRemoved: 0, exhausted: true });
      expect(readdirSync(c)).toHaveLength(1);
    });
  });

  it("the cursor advances past retained directories: an orphan behind more than maxDirs live sessions is reached within two passes, and every pass is bounded", () => {
    withRoot((root) => {
      const presenceDir = ensurePresenceDir(root)!;
      for (let i = 0; i < 70; i++) {
        const sid = `0000${String(i).padStart(4, "0")}-5dcb-4be3-90d3-2b13e0f50b29`;
        oldPending(root, sid, "live");
        writeFileSync(join(presenceDir, `${presenceFileBase(sid)}.json`), "{}");
      }
      const orphan = oldPending(root, SID3, "orphan");
      const r1 = sweepOrphanPendingDirs(root, { now: NOW });
      expect(r1.examined).toBe(64);
      expect(r1.exhausted).toBe(false);
      expect(r1.cursor).not.toBeNull();
      const r2 = sweepOrphanPendingDirs(root, { now: NOW });
      // Stream order is the filesystem's: the orphan fell in pass 1 or pass 2.
      expect(r1.dirsRemoved + r2.dirsRemoved).toBe(1);
      expect(r2.examined).toBe(7); // the remainder, then the natural end clears the cursor
      expect(r2.cursor).toBeNull();
      expect(existsSync(orphan)).toBe(false);
      expect(sweepOrphanPendingDirs(root, { now: NOW }).examined).toBe(64);
    });
  });

  it("a pass cut short by the time budget still advances: discovery resumes after the cursor instead of restarting, until the orphan is reached", () => {
    withRoot((root) => {
      const presenceDir = ensurePresenceDir(root)!;
      for (let i = 0; i < 30; i++) {
        const sid = `0000${String(i).padStart(4, "0")}-5dcb-4be3-90d3-2b13e0f50b29`;
        oldPending(root, sid, "live");
        writeFileSync(join(presenceDir, `${presenceFileBase(sid)}.json`), "{}");
      }
      const orphan = oldPending(root, SID3, "orphan");
      // 100 ms per clock read, 600 ms budget: a handful of entries per pass,
      // and a pass can end inside the orphan's own sweep.
      let t = 0;
      const clock = () => (t += 100);
      const seen: string[] = [];
      let passes = 0;
      while (existsSync(orphan) && passes < 40) {
        const r = sweepOrphanPendingDirs(root, { now: NOW, budgetMs: 600, clock });
        passes += 1;
        expect(r.examined).toBeGreaterThan(0);
        expect(r.examined).toBeLessThanOrEqual(7);
        if (r.cursor === null) {
          seen.length = 0; // natural end: the next pass legitimately starts over
        } else {
          expect(seen).not.toContain(r.cursor); // never re-examines ground already covered before wrapping
          seen.push(r.cursor);
        }
      }
      expect(existsSync(orphan)).toBe(false);
      expect(passes).toBeLessThanOrEqual(20);
    });
  });

  it("every dirent read counts toward the scan cap, non-directories included: a flooded root bounds each pass's reads", () => {
    withRoot((root) => {
      ensurePresenceDir(root);
      oldPending(root, SID3, "orphan");
      const base = join(root, ".story", "telemetry", PENDING_SUBDIR);
      const cap = 64;
      // More stray files than the cap: no pass can read the whole root.
      for (let i = 0; i < cap + 8; i++) writeFileSync(join(base, `stray-${String(i).padStart(3, "0")}`), "");
      let reads = 0;
      const counting = fs.Dir.prototype.readSync;
      // Root reads only: the orphan's own listing goes through the same API.
      const spy = vi.spyOn(fs.Dir.prototype, "readSync").mockImplementation(function (this: fs.Dir) { if (this.path === base) reads += 1; return counting.call(this); });
      try {
        for (let pass = 0; pass < 3; pass++) {
          reads = 0;
          const r = sweepOrphanPendingDirs(root, { now: NOW, maxScan: cap });
          expect(r.exhausted).toBe(true);
          expect(r.examined).toBeLessThanOrEqual(1);
          expect(reads).toBe(cap); // exactly the cap: the pre-read check stops the pass
        }
      } finally {
        spy.mockRestore();
      }
      expect(ORPHAN_PENDING_MAX_SCAN).toBeGreaterThanOrEqual(cap);
    });
  });

  it("no telemetry or presence directory: nothing happens", () => {
    withRoot((root) => {
      expect(sweepSessionIntelTelemetry(root, { now: T0, run: noneAlive })).toEqual({ eras: { attempted: 0, removed: 0, ended: 0, cursor: null }, pending: { examined: 0, filesRemoved: 0, dirsRemoved: 0, exhausted: false, cursor: null } });
      // A pending directory with no presence directory at all: no lock can be taken, nothing is touched.
      const dir = oldPending(root, SID2, "e");
      expect(sweepOrphanPendingDirs(root, { now: NOW })).toMatchObject({ examined: 0, filesRemoved: 0, dirsRemoved: 0, exhausted: false });
      expect(readdirSync(dir)).toHaveLength(1);
    });
  });
});
