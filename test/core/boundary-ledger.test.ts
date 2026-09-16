import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEDGER_FILE,
  LEDGER_GLOBAL_CAP,
  LEDGER_MAX_INPUT_BYTES,
  LEDGER_SUBDIR,
  ingestBoundaries,
  parseLedger,
  readLedger,
  trimLedger,
  type LedgerEntry,
} from "../../src/core/session-intel/boundary-ledger.js";
import {
  boundaryLedgerReadRoots,
  boundaryLedgerRoot,
  resetLedgerRoutingCache,
} from "../../src/core/session-intel/ledger-root.js";
import {
  WORKTREE_DISCOVERY_FAILURE_TTL_MS,
  discoverWorktreeRoots,
  worktreeDiscoveryStats,
} from "../../src/core/session-intel/presence-bridge.js";
import { acquireLock, releaseLock } from "../../src/presence/io.js";
import { bareStoryInit, makeWorktreePair, makeWorktreeTriple, symlinkSync } from "./session-intel-fixtures.js";

const T0 = Date.parse("2026-09-09T12:00:00Z");
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();

function entry(sessionId: string, minute: number, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return { sessionId, era: "1:2", captureKind: "startup", timestamp: at(minute), trigger: "auto", preTokens: 417_000 + minute, postTokens: 30_000, autoCompactWindowAtStart: 450_000, ...over };
}

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "si-ledger-"));
  try {
    mkdirSync(join(root, ".story"), { recursive: true });
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("trimLedger", () => {
  it("dedupes by (sessionId, timestamp); an unclassified entry can gain an era but a classified one never changes", () => {
    const existing = [entry("a", 1, { era: null, captureKind: null }), entry("a", 2)];
    const incoming = [entry("a", 1), entry("a", 2, { era: "9:9" })];
    const r = trimLedger(existing, incoming, 20);
    expect(r.entries.find((e) => e.timestamp === at(1))!.era).toBe("1:2");
    expect(r.entries.find((e) => e.timestamp === at(2))!.era).toBe("1:2");
    expect(r.entries).toHaveLength(2);
  });

  it("keeps the newest perSession entries; an evicted entry re-ingested cannot displace a newer one", () => {
    const existing = [entry("a", 3), entry("a", 4), entry("a", 5)];
    const r = trimLedger(existing, [entry("a", 1)], 3);
    expect(r.entries.map((e) => e.timestamp)).toEqual([at(3), at(4), at(5)]);
    expect(r.windows.get("a")).toBe(3);
  });

  it("global cap is filled round-robin so a busy session cannot evict a quiet one", () => {
    const busy = Array.from({ length: 50 }, (_, i) => entry("busy", 100 + i));
    const quiet = [entry("quiet", 1)];
    const r = trimLedger([], [...busy, ...quiet], 50, 10);
    expect(r.entries).toHaveLength(10);
    expect(r.windows.get("quiet")).toBe(1);
    expect(r.windows.get("busy")).toBe(9);
    // Busy keeps its NEWEST nine.
    expect(r.entries.filter((e) => e.sessionId === "busy").map((e) => e.timestamp).sort()).toEqual(busy.slice(-9).map((e) => e.timestamp).sort());
  });

  it("with more sessions than the cap, the sessions with the oldest newest-boundary are evicted entirely, deterministically", () => {
    const incoming: LedgerEntry[] = [];
    for (let s = 0; s < 12; s++) incoming.push(entry(`s${String(s).padStart(2, "0")}`, s));
    const r = trimLedger([], incoming, 20, 10);
    expect(r.entries).toHaveLength(10);
    expect(r.evictedSessions).toEqual(["s01", "s00"]);
    expect(r.windows.has("s00")).toBe(false);
    expect(r.windows.get("s11")).toBe(1);
  });

  it("ties on newest boundary are broken by sessionId", () => {
    const r = trimLedger([], [entry("b", 1), entry("a", 1), entry("c", 1)], 20, 2);
    expect([...r.windows.keys()].sort()).toEqual(["a", "b"]);
    expect(r.evictedSessions).toEqual(["c"]);
  });
});

describe("ingestBoundaries / readLedger", () => {
  it("writes, dedupes on re-ingest, reports unchanged, and reads back typed entries", () => {
    withRoot((root) => {
      expect(ingestBoundaries(root, [], 20)).toBe("unchanged");
      expect(ingestBoundaries(root, [entry("a", 1), entry("a", 2)], 20)).toBe("written");
      expect(ingestBoundaries(root, [entry("a", 1)], 20)).toBe("unchanged");
      const read = readLedger(root);
      expect(read).toHaveLength(2);
      expect(read[0]).toEqual(entry("a", 1));
    });
  });

  it("refuses an oversize ledger before parsing (reads as empty), and tolerates garbage", () => {
    withRoot((root) => {
      const dir = join(root, ".story", "telemetry", LEDGER_SUBDIR);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, LEDGER_FILE), "[" + "1,".repeat(LEDGER_MAX_INPUT_BYTES) + "1]");
      expect(readLedger(root)).toEqual([]);
      writeFileSync(join(dir, LEDGER_FILE), "{bad");
      expect(readLedger(root)).toEqual([]);
      expect(parseLedger(JSON.stringify([{ sessionId: "a" }, { sessionId: "a", timestamp: at(1), trigger: "manual", preTokens: -1 }, { sessionId: "b", timestamp: at(1) }, { sessionId: "c", timestamp: at(1), trigger: "Auto" }]))).toEqual([
        { sessionId: "a", era: null, captureKind: null, timestamp: at(1), trigger: "manual", preTokens: null, postTokens: null, autoCompactWindowAtStart: null },
        { sessionId: "b", era: null, captureKind: null, timestamp: at(1), trigger: "unknown", preTokens: null, postTokens: null, autoCompactWindowAtStart: null },
        { sessionId: "c", era: null, captureKind: null, timestamp: at(1), trigger: "unknown", preTokens: null, postTokens: null, autoCompactWindowAtStart: null },
      ]);
    });
  });

  it("per-session retention equals the configured window", () => {
    withRoot((root) => {
      ingestBoundaries(root, Array.from({ length: 30 }, (_, i) => entry("a", i)), 7);
      const read = readLedger(root);
      expect(read).toHaveLength(7);
      expect(read.map((e) => e.timestamp)).toEqual(Array.from({ length: 7 }, (_, i) => at(23 + i)));
    });
  });
});

// ---------------------------------------------------------------------------
// ISS-1211
// ---------------------------------------------------------------------------

const ledgerPath = (root: string) => join(root, ".story", "telemetry", LEDGER_SUBDIR, LEDGER_FILE);

/** Writes a ledger file directly, standing in for a boundary stranded by the old cwd routing. */
function strand(root: string, entries: LedgerEntry[]): void {
  const dir = join(root, ".story", "telemetry", LEDGER_SUBDIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(ledgerPath(root), JSON.stringify({ version: 1, entries }) + "\n");
}

describe("ISS-1211: one repo, one boundary series", () => {
  beforeEach(() => { resetLedgerRoutingCache(); });
  afterEach(() => { resetLedgerRoutingCache(); });

  it("git lists the MAIN worktree first, which is the ordering the routing relies on", () => {
    const wt = makeWorktreePair("si-ledger-order-");
    try {
      // git-worktree(1): "The main worktree is listed first, followed by each
      // of the linked worktrees." Asked from the LINKED worktree, which is the
      // side that has to find main.
      expect(discoverWorktreeRoots(wt.worktree)[0]).toBe(wt.main);
      expect(discoverWorktreeRoots(wt.worktree)).toContain(wt.worktree);
    } finally {
      wt.cleanup();
    }
  });

  it("a boundary ingested from a linked worktree lands in the MAIN checkout's ledger and nowhere else", () => {
    const wt = makeWorktreePair("si-ledger-write-");
    try {
      bareStoryInit(wt.main);
      bareStoryInit(wt.worktree);
      expect(boundaryLedgerRoot(wt.worktree)).toBe(wt.main);
      expect(ingestBoundaries(wt.worktree, [entry("ce6fc81c", 1)], 20)).toBe("written");
      expect(existsSync(ledgerPath(wt.main))).toBe(true);
      expect(existsSync(ledgerPath(wt.worktree))).toBe(false);
      expect(readLedger(wt.main).map((e) => e.sessionId)).toEqual(["ce6fc81c"]);
    } finally {
      wt.cleanup();
    }
  });

  it("a plain checkout, a non-repo, and a main checkout without .story all route to the caller's own root", () => {
    const wt = makeWorktreePair("si-ledger-self-");
    try {
      bareStoryInit(wt.main);
      // The main checkout is its own main.
      expect(boundaryLedgerRoot(wt.main)).toBe(wt.main);
      expect(boundaryLedgerReadRoots(wt.main)[0]).toBe(wt.main);
      // Reached through a symlinked ancestor, the SAME checkout keeps its own
      // spelling: self is excluded by dev/ino, never by string comparison, so
      // a caller is never routed to an equivalent path under another name
      // (git reports realpaths, which would never string-match).
      const alias = join(wt.base, "main-alias");
      symlinkSync(wt.main, alias);
      resetLedgerRoutingCache();
      expect(boundaryLedgerRoot(alias)).toBe(alias);
      expect(boundaryLedgerReadRoots(alias)).toEqual([alias]);
    } finally {
      wt.cleanup();
    }
    resetLedgerRoutingCache();
    // A main checkout with no `.story/` is never given one: the worktree keeps
    // its own ledger rather than seeding a project directory next door.
    const noStory = makeWorktreePair("si-ledger-nostory-");
    try {
      bareStoryInit(noStory.worktree);
      expect(boundaryLedgerRoot(noStory.worktree)).toBe(noStory.worktree);
      expect(ingestBoundaries(noStory.worktree, [entry("a", 1)], 20)).toBe("written");
      expect(existsSync(join(noStory.main, ".story"))).toBe(false);
      expect(existsSync(ledgerPath(noStory.worktree))).toBe(true);
    } finally {
      noStory.cleanup();
    }
    resetLedgerRoutingCache();
    // Not a git repository at all: git fails, the routing stays local.
    const bare = mkdtempSync(join(tmpdir(), "si-ledger-norepo-"));
    try {
      mkdirSync(join(bare, ".story"), { recursive: true });
      expect(boundaryLedgerRoot(bare)).toBe(bare);
      expect(boundaryLedgerReadRoots(bare)).toEqual([bare]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("readLedger merges the shared ledger with entries stranded in a worktree, read from either side", () => {
    const wt = makeWorktreePair("si-ledger-merge-");
    try {
      bareStoryInit(wt.main);
      bareStoryInit(wt.worktree);
      strand(wt.main, [entry("main-session", 1)]);
      strand(wt.worktree, [entry("ce6fc81c", 2)]);
      // Acceptance 2 + 3: main reports the boundary that only the worktree saw.
      expect(readLedger(wt.main).map((e) => e.sessionId).sort()).toEqual(["ce6fc81c", "main-session"]);
      resetLedgerRoutingCache();
      // And the worktree still sees both: neither side loses history.
      expect(readLedger(wt.worktree).map((e) => e.sessionId).sort()).toEqual(["ce6fc81c", "main-session"]);
    } finally {
      wt.cleanup();
    }
  });

  it("the merge gains a classification and never loses one, and dedupes the same boundary seen in two checkouts", () => {
    const wt = makeWorktreePair("si-ledger-dedupe-");
    try {
      bareStoryInit(wt.main);
      bareStoryInit(wt.worktree);
      strand(wt.main, [entry("a", 1, { era: null, captureKind: null }), entry("a", 2)]);
      strand(wt.worktree, [entry("a", 1), entry("a", 2, { era: "9:9" })]);
      const read = readLedger(wt.main);
      expect(read).toHaveLength(2);
      expect(read.find((e) => e.timestamp === at(1))!.era).toBe("1:2");
      expect(read.find((e) => e.timestamp === at(2))!.era).toBe("1:2");
    } finally {
      wt.cleanup();
    }
  });

  it("refuses a main checkout whose telemetry path runs through a symlink and keeps the ledger local", () => {
    const wt = makeWorktreePair("si-ledger-symlink-");
    try {
      bareStoryInit(wt.main);
      bareStoryInit(wt.worktree);
      // `.story/` is a real directory, but `telemetry` under it is a symlink
      // pointing outside the checkout: the routing must not write or read
      // through a path component it cannot prove is a real directory.
      const elsewhere = join(wt.base, "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      symlinkSync(elsewhere, join(wt.main, ".story", "telemetry"));
      expect(boundaryLedgerRoot(wt.worktree)).toBe(wt.worktree);
      expect(boundaryLedgerReadRoots(wt.worktree)).toEqual([wt.worktree]);
      expect(ingestBoundaries(wt.worktree, [entry("a", 1)], 20)).toBe("written");
      expect(existsSync(ledgerPath(wt.worktree))).toBe(true);
      expect(existsSync(join(elsewhere, LEDGER_SUBDIR, LEDGER_FILE))).toBe(false);
    } finally {
      wt.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// ISS-1211 gate round 1
// ---------------------------------------------------------------------------

describe("ISS-1211 gate: routing cost, degradation and safety", () => {
  beforeEach(() => { resetLedgerRoutingCache(); worktreeDiscoveryStats.spawns = 0; });
  afterEach(() => { resetLedgerRoutingCache(); });

  it("resolves a root's routing with ONE git spawn, shares it across reads and writes, and re-spawns only per root or after a reset", () => {
    const wt = makeWorktreePair("si-ledger-memo-");
    try {
      bareStoryInit(wt.main);
      bareStoryInit(wt.worktree);
      expect(boundaryLedgerRoot(wt.worktree)).toBe(wt.main);
      expect(worktreeDiscoveryStats.spawns).toBe(1);
      boundaryLedgerReadRoots(wt.worktree);
      readLedger(wt.worktree);
      ingestBoundaries(wt.worktree, [entry("a", 1)], 20);
      expect(worktreeDiscoveryStats.spawns).toBe(1);
      // A DIFFERENT root is resolved independently: the memo is keyed by root,
      // never shared between projects.
      expect(boundaryLedgerRoot(wt.main)).toBe(wt.main);
      expect(worktreeDiscoveryStats.spawns).toBe(2);
      resetLedgerRoutingCache();
      expect(boundaryLedgerRoot(wt.worktree)).toBe(wt.main);
      expect(worktreeDiscoveryStats.spawns).toBe(3);
    } finally {
      wt.cleanup();
    }
  });

  it("a FAILED discovery is retried only after the failure TTL: one hook process pays for git once, a long-lived one recovers in seconds", () => {
    const bare = mkdtempSync(join(tmpdir(), "si-ledger-norepo-ttl-"));
    try {
      mkdirSync(join(bare, ".story"), { recursive: true });
      let t = 1_000_000;
      const clock = () => t;
      // Degraded outcomes are never memoized, so every call below reaches
      // discovery; only the failure TTL keeps git from being spawned again.
      expect(boundaryLedgerRoot(bare, { clock })).toBe(bare);
      expect(worktreeDiscoveryStats.spawns).toBe(1);
      t += 1_000;
      expect(boundaryLedgerRoot(bare, { clock })).toBe(bare);
      expect(worktreeDiscoveryStats.spawns).toBe(1);
      t += WORKTREE_DISCOVERY_FAILURE_TTL_MS;
      expect(boundaryLedgerRoot(bare, { clock })).toBe(bare);
      expect(worktreeDiscoveryStats.spawns).toBe(2);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("a main checkout that gains .story afterwards is picked up on the next call, without a second git spawn", () => {
    const wt = makeWorktreePair("si-ledger-late-story-");
    try {
      bareStoryInit(wt.worktree);
      expect(boundaryLedgerRoot(wt.worktree)).toBe(wt.worktree);
      expect(worktreeDiscoveryStats.spawns).toBe(1);
      bareStoryInit(wt.main);
      // No reset: a routing that did not resolve was never cached.
      expect(boundaryLedgerRoot(wt.worktree)).toBe(wt.main);
      expect(worktreeDiscoveryStats.spawns).toBe(1);
      expect(ingestBoundaries(wt.worktree, [entry("a", 1)], 20)).toBe("written");
      expect(existsSync(ledgerPath(wt.main))).toBe(true);
      expect(existsSync(ledgerPath(wt.worktree))).toBe(false);
    } finally {
      wt.cleanup();
    }
  });

  it("an already-spent caller budget resolves nothing and spawns nothing, and does not poison the next call", () => {
    const wt = makeWorktreePair("si-ledger-deadline-");
    try {
      bareStoryInit(wt.main);
      bareStoryInit(wt.worktree);
      strand(wt.main, [entry("shared", 1)]);
      const t = 5_000_000;
      const spent = { deadline: t, clock: () => t };
      expect(boundaryLedgerRoot(wt.worktree, spent)).toBe(wt.worktree);
      expect(readLedger(wt.worktree, spent)).toEqual([]);
      expect(worktreeDiscoveryStats.spawns).toBe(0);
      // With budget, the very next call resolves properly.
      expect(boundaryLedgerRoot(wt.worktree)).toBe(wt.main);
      expect(readLedger(wt.worktree).map((e) => e.sessionId)).toEqual(["shared"]);
      expect(worktreeDiscoveryStats.spawns).toBe(1);
    } finally {
      wt.cleanup();
    }
  });

  it("three checkouts: the read set is main, then the caller's own checkout, then every sibling in git's order", () => {
    const three = makeWorktreeTriple("si-ledger-triple-");
    try {
      // Pins the fixture's own assumption about git's ordering, so a change in
      // git would fail here rather than silently weaken the expectations below.
      expect(discoverWorktreeRoots(three.main)).toEqual([three.main, three.linked[0], three.linked[1]]);
      expect(boundaryLedgerReadRoots(three.linked[1])).toEqual([three.main, three.linked[1], three.linked[0]]);
      expect(boundaryLedgerReadRoots(three.linked[0])).toEqual([three.main, three.linked[0], three.linked[1]]);
      expect(boundaryLedgerReadRoots(three.main)).toEqual([three.main, three.linked[0], three.linked[1]]);
      strand(three.main, [entry("from-main", 1)]);
      strand(three.linked[0], [entry("from-wt-one", 2)]);
      strand(three.linked[1], [entry("from-wt-two", 3)]);
      resetLedgerRoutingCache();
      expect(readLedger(three.linked[1]).map((e) => e.sessionId)).toEqual(["from-main", "from-wt-one", "from-wt-two"]);
      resetLedgerRoutingCache();
      expect(readLedger(three.main).map((e) => e.sessionId)).toEqual(["from-main", "from-wt-one", "from-wt-two"]);
    } finally {
      three.cleanup();
    }
  });

  it("a routed main replaced by a symlink after discovery is refused at the write, and the boundary lands locally", () => {
    const wt = makeWorktreePair("si-ledger-swap-");
    try {
      bareStoryInit(wt.main);
      bareStoryInit(wt.worktree);
      expect(boundaryLedgerRoot(wt.worktree)).toBe(wt.main);
      const aside = join(wt.base, "main-moved-aside");
      renameSync(wt.main, aside);
      symlinkSync(aside, wt.main);
      expect(ingestBoundaries(wt.worktree, [entry("a", 1)], 20)).toBe("written");
      expect(existsSync(ledgerPath(wt.worktree))).toBe(true);
      expect(existsSync(ledgerPath(aside))).toBe(false);
    } finally {
      wt.cleanup();
    }
  });

  // Running as root defeats the 0o500: the write would succeed and the
  // fallback would never be exercised. Same guard as ruling-loader.test.ts.
  it.skipIf((process.geteuid?.() ?? process.getuid?.()) === 0)("a routed root whose telemetry directory cannot be created falls back to the caller's own checkout", () => {
    const wt = makeWorktreePair("si-ledger-unwritable-");
    const mainStory = join(wt.main, ".story");
    try {
      bareStoryInit(wt.main);
      bareStoryInit(wt.worktree);
      expect(boundaryLedgerRoot(wt.worktree)).toBe(wt.main);
      // `.story/` is still a real, non-symlinked directory, so the routing
      // itself stays valid; nothing can be created inside it.
      chmodSync(mainStory, 0o500);
      expect(ingestBoundaries(wt.worktree, [entry("a", 1)], 20)).toBe("written");
      expect(existsSync(ledgerPath(wt.worktree))).toBe(true);
    } finally {
      try { chmodSync(mainStory, 0o700); } catch { /* already gone */ }
      wt.cleanup();
    }
  });

  it("a ledger lock held by another writer is reported as lock-busy, never silently dropped", () => {
    const wt = makeWorktreePair("si-ledger-lock-");
    try {
      bareStoryInit(wt.main);
      bareStoryInit(wt.worktree);
      expect(ingestBoundaries(wt.worktree, [entry("a", 1)], 20)).toBe("written");
      const lockPath = join(wt.main, ".story", "telemetry", LEDGER_SUBDIR, "boundaries.lock");
      expect(acquireLock(lockPath, 300)).toBe(true);
      try {
        expect(ingestBoundaries(wt.worktree, [entry("a", 2)], 20)).toBe("lock-busy");
      } finally {
        releaseLock(lockPath);
      }
      expect(ingestBoundaries(wt.worktree, [entry("a", 2)], 20)).toBe("written");
      expect(readLedger(wt.main)).toHaveLength(2);
    } finally {
      wt.cleanup();
    }
  });

  it("a main checkout that is not usable stops the ROUTING, never the sibling reads: stranded entries stay countable", () => {
    const three = makeWorktreeTriple("si-ledger-nomain-");
    try {
      // The repo's main checkout is not a storybloq project (yet): nothing to
      // route to, but the other worktrees still hold real boundaries.
      rmSync(join(three.main, ".story"), { recursive: true, force: true });
      strand(three.linked[0], [entry("stranded", 1)]);
      expect(boundaryLedgerRoot(three.linked[1])).toBe(three.linked[1]);
      expect(boundaryLedgerReadRoots(three.linked[1])).toEqual([three.linked[1], three.linked[0]]);
      expect(readLedger(three.linked[1]).map((e) => e.sessionId)).toEqual(["stranded"]);
    } finally {
      three.cleanup();
    }
  });

  it("the merge is a pure union: a checkout already at the global cap keeps every entry it had", () => {
    const wt = makeWorktreePair("si-ledger-cap-");
    try {
      bareStoryInit(wt.main);
      bareStoryInit(wt.worktree);
      strand(wt.main, Array.from({ length: LEDGER_GLOBAL_CAP }, (_, i) => entry("main-s", i)));
      strand(wt.worktree, Array.from({ length: 5 }, (_, i) => entry("wt-s", 1_000 + i)));
      const read = readLedger(wt.main);
      // A flat LEDGER_GLOBAL_CAP over the union would round-robin the two
      // sessions and evict five of main's own on-disk entries.
      expect(read).toHaveLength(LEDGER_GLOBAL_CAP + 5);
      expect(read.filter((e) => e.sessionId === "main-s")).toHaveLength(LEDGER_GLOBAL_CAP);
      expect(read.filter((e) => e.sessionId === "wt-s")).toHaveLength(5);
      resetLedgerRoutingCache();
      expect(readLedger(wt.worktree)).toHaveLength(LEDGER_GLOBAL_CAP + 5);
    } finally {
      wt.cleanup();
    }
  });
});
