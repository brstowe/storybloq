/**
 * ISS-1240: the roster seat writer, riding the presence binary's hooks.
 *
 * T-507 shipped the roster core and its CLI verbs, but its only WRITER was a
 * plugin Mod the owner removed on 2026-09-15. Nothing replaced it, so
 * `roster list` answered zero seats on every project and federation pens went
 * back to hand-maintaining a committed `contacts.json` that is machine-local
 * by construction.
 *
 * WHY THE PRESENCE BINARY AND NOT THE STOP HOOK. The issue asked for
 * `roster end --state detached` on the Stop hook. The Stop hook fires at the
 * end of every TURN, not at session end (`hook-status.ts`: "A Stop hook
 * firing means this session just completed a successful turn"), and
 * `heartbeat` does not change state, so that would have marked every live
 * session detached after its first turn and left it there. `SessionEnd` is
 * the real session end, and `storybloq-presence` already registers for it.
 *
 * These tests drive the real `runPresenceHook` entry point and assert the
 * files on disk, rather than the internal helper, so they keep their meaning
 * if the wiring inside the handler is rearranged.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { runPresenceHook } from "../../src/presence/handler.js";
import { presenceFileBase } from "../../src/presence/types.js";
import { STORY_GITIGNORE_ENTRIES } from "../../src/core/init.js";
import { upsertSeat } from "../../src/core/roster.js";
import { ROSTER_STALE_MS, type RosterSeat } from "../../src/core/roster.js";
import { ROSTER_HEARTBEAT_THROTTLE_MS } from "../../src/presence/roster-hook.js";

const SESSION = "sess-roster-1240";
const SRC = join(fileURLToPath(import.meta.url), "..", "..", "..", "src");

let root: string;
let rosterDir: string;
let presenceDir: string;

function config(value: Record<string, unknown> = { version: 1 }): void {
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify(value));
}

function hook(event: string, over: Record<string, unknown> = {}, now = new Date("2026-08-20T12:00:00.000Z")) {
  return runPresenceHook({ hook_event_name: event, session_id: SESSION, cwd: root, ...over }, now);
}

function seatFiles(): string[] {
  if (!existsSync(rosterDir)) return [];
  return readdirSync(rosterDir).filter((name) => name.endsWith(".json"));
}

function seat(): RosterSeat | null {
  const files = seatFiles();
  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(rosterDir, files[0]!), "utf-8")) as RosterSeat;
}

/**
 * Sets the seat file's mtime relative to NOW.
 *
 * The throttle compares the hook's `now` against the file's mtime, so both
 * have to be on the same clock. An earlier version of these tests aged the
 * file against the real clock while driving the hook with a fixed 2026-08-20
 * date, which made the elapsed time NEGATIVE: the throttle test passed
 * because the comparison underflowed, not because the throttle worked.
 */
function setSeatAge(ageMs: number): void {
  const file = join(rosterDir, seatFiles()[0]!);
  const when = new Date(Date.now() - ageMs);
  utimesSync(file, when, when);
}

function seatMtimeMs(): number {
  return statSync(join(rosterDir, seatFiles()[0]!)).mtimeMs;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "roster-hook-"));
  mkdirSync(join(root, ".story"));
  config();
  rosterDir = join(root, ".story", "telemetry", "roster");
  presenceDir = join(root, ".story", "telemetry", "presence");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ISS-1240 seat lifecycle", () => {
  it("1. SessionStart writes exactly one running seat at generation 1", () => {
    hook("SessionStart", { source: "startup" });

    expect(seatFiles()).toHaveLength(1);
    const s = seat()!;
    expect(s.state).toBe("running");
    expect(s.generation).toBe(1);
    expect(s.clientTaskId).toBe(SESSION);
  });

  it("4. Stop heartbeats and does NOT go terminal", () => {
    hook("SessionStart", { source: "startup" }, new Date("2026-08-20T12:00:00.000Z"));
    const before = seat()!;

    hook("Stop", {}, new Date("2026-08-20T12:05:00.000Z"));

    const after = seat()!;
    // The regression the issue's own prescribed mechanism would have shipped.
    expect(after.state).toBe("running");
    expect(after.generation).toBe(before.generation);
    expect(Date.parse(after.lastSeenAt)).toBeGreaterThan(Date.parse(before.lastSeenAt));
  });

  it("5. SessionEnd detaches the seat", () => {
    hook("SessionStart", { source: "startup" }, new Date("2026-08-20T12:00:00.000Z"));
    hook("SessionEnd", {}, new Date("2026-08-20T12:30:00.000Z"));

    expect(seat()!.state).toBe("detached");
    expect(seatFiles()).toHaveLength(1);
  });

  it("11. PostToolUse writes no seat at all", () => {
    hook("PostToolUse", { tool_name: "Bash" });
    expect(seatFiles()).toHaveLength(0);
  });
});

describe("ISS-1240 PreToolUse throttle", () => {
  it("6. heartbeats when the seat file is older than the window", () => {
    hook("SessionStart", { source: "startup" }, new Date());
    setSeatAge(ROSTER_STALE_MS);
    const before = seatMtimeMs();

    hook("PreToolUse", { tool_name: "Bash" }, new Date());

    expect(seatMtimeMs()).toBeGreaterThan(before);
  });

  it("7. writes nothing inside the window", () => {
    hook("SessionStart", { source: "startup" }, new Date());
    setSeatAge(0);
    const before = seatMtimeMs();

    for (let i = 0; i < 25; i += 1) {
      hook("PreToolUse", { tool_name: "Bash" }, new Date());
    }

    // A burst of tool calls costs one stat each and no write: this binary's
    // whole budget is two synchronous spawns per tool call.
    expect(seatMtimeMs()).toBe(before);
  });

  it("18. a deleted seat file with the directory still present is due, not a crash", () => {
    // `seatPathFor` short-circuits when the DIRECTORY is missing, so the
    // stat is only ever reached once the directory exists. Deleting the file
    // underneath a live session is the case that actually reaches it, and a
    // throw here would bubble out of PreToolUse and block a tool call.
    hook("SessionStart", { source: "startup" }, new Date());
    rmSync(join(rosterDir, seatFiles()[0]!));

    expect(() => hook("PreToolUse", { tool_name: "Bash" }, new Date())).not.toThrow();
    expect(seatFiles()).toHaveLength(1);
  });

  it("8. writes when there is no seat file yet", () => {
    hook("PreToolUse", { tool_name: "Bash" });
    expect(seatFiles()).toHaveLength(1);
    expect(seat()!.state).toBe("running");
  });

  it("10. stays throttled with presence DISABLED and no presence record", () => {
    // The round-4 regression, and it only appears when two correct fixes meet:
    // the roster is decoupled from the presence opt-out, so with presence off
    // there is no presence record; a throttle that consulted that record would
    // evaluate "due" forever and take a locked write on EVERY tool call.
    config({ version: 1, statusWriter: { presence: false } });

    hook("PreToolUse", { tool_name: "Bash" }, new Date());
    expect(seatFiles()).toHaveLength(1);
    setSeatAge(0);
    const before = seatMtimeMs();

    for (let i = 0; i < 25; i += 1) {
      hook("PreToolUse", { tool_name: "Bash" }, new Date());
    }

    expect(seatMtimeMs()).toBe(before);
  });
});

describe("ISS-1240 decoupling and fail-soft", () => {
  it("14. presence disabled still writes the seat", () => {
    config({ version: 1, statusWriter: { presence: false } });

    const outcome = hook("SessionStart", { source: "startup" });

    // The presence half is correctly skipped...
    expect(outcome).toBe("skipped-disabled");
    // ...and the roster half is NOT, or turning off presence would silently
    // empty the roster for everyone on that machine.
    expect(seatFiles()).toHaveLength(1);
    expect(existsSync(join(root, ".story", "telemetry", "presence"))).toBe(false);
  });

  it("12. a project with no .story/ writes nothing and does not throw", () => {
    const bare = mkdtempSync(join(tmpdir(), "roster-bare-"));
    try {
      expect(runPresenceHook({ hook_event_name: "SessionStart", session_id: SESSION, cwd: bare, source: "startup" })).toBe("skipped-no-project");
      expect(existsSync(join(bare, ".story"))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("13. a roster failure never changes the hook's own outcome", () => {
    // The roster directory is made unusable by putting a FILE where its
    // directory belongs. A non-zero exit on PreToolUse blocks the tool call,
    // so this path must stay silent no matter what the roster does.
    mkdirSync(join(root, ".story", "telemetry"), { recursive: true });
    writeFileSync(join(root, ".story", "telemetry", "roster"), "not a directory");

    expect(() => hook("SessionStart", { source: "startup" })).not.toThrow();
    expect(hook("Stop")).toBe("written");
  });
});

/** The era is read off the presence record, so the fixture writes one. */
function writeEra(era: string): void {
  mkdirSync(presenceDir, { recursive: true });
  writeFileSync(join(presenceDir, `${presenceFileBase(SESSION)}.json`), JSON.stringify({ sessionIntel: { era } }));
}

describe("ISS-1240 generation, which the era is what makes possible", () => {
  it("2. a reload under a NEW process era advances the generation in place", () => {
    writeEra("111:1000");
    hook("SessionStart", { source: "startup" }, new Date());
    expect(seat()!.generation).toBe(1);
    const firstSeatId = seat()!.seatId;

    // `--resume` is a new process, so a new era.
    writeEra("222:2000");
    hook("SessionStart", { source: "resume" }, new Date());

    const s = seat()!;
    expect(seatFiles()).toHaveLength(1);
    expect(s.seatId).toBe(firstSeatId);
    expect(s.generation).toBe(2);
  });

  it("3. the SAME era refreshes without advancing the generation", () => {
    writeEra("111:1000");
    hook("SessionStart", { source: "startup" }, new Date("2026-08-20T12:00:00.000Z"));
    const before = seat()!;

    // `/clear` keeps the process, so it keeps the era. Re-asserted rather than
    // assumed: the roster reads the era BEFORE the presence write in the same
    // hook, so this models "the era did not change" without depending on how
    // the presence record round-trips it.
    writeEra("111:1000");
    hook("SessionStart", { source: "clear" }, new Date("2026-08-20T12:10:00.000Z"));

    const after = seat()!;
    expect(seatFiles()).toHaveLength(1);
    expect(after.generation).toBe(before.generation);
    expect(Date.parse(after.lastSeenAt)).toBeGreaterThan(Date.parse(before.lastSeenAt));
  });

  it("15. an end carrying a stale generation is refused and leaves the seat running", () => {
    hook("SessionStart", { source: "startup" }, new Date());
    const live = seat()!;

    const result = upsertSeat(
      root,
      { kind: "end", client: "claude", clientTaskId: SESSION, agentId: null, generation: live.generation + 7, state: "detached" },
      new Date().toISOString(),
    );

    expect(result.ok).toBe(false);
    expect(seat()!.state).toBe("running");
  });

  it("9. a long tool-heavy turn keeps the seat inside the stale window", () => {
    hook("SessionStart", { source: "startup" }, new Date());
    // Five throttle windows of continuous tool calls: without the PreToolUse
    // heartbeat the seat would age past ROSTER_STALE_MS and a working session
    // would read as stale.
    for (let i = 0; i < 5; i += 1) {
      setSeatAge(ROSTER_HEARTBEAT_THROTTLE_MS + 1_000);
      hook("PreToolUse", { tool_name: "Bash" }, new Date());
      expect(Date.now() - seatMtimeMs()).toBeLessThan(ROSTER_STALE_MS);
    }
  });
});

describe("ISS-1240 the roster stays out of the slim binary's way", () => {
  it("16. the telemetry directory is gitignored", () => {
    expect(STORY_GITIGNORE_ENTRIES).toContain("/telemetry/");
  });

  it("17. nothing the presence binary imports pulls zod", () => {
    // `storybloq-presence` exists because the shared bundle costs ~310ms per
    // invocation. `core/roster.ts` used to take CLIENT_TASK_ID_PATTERN from
    // `models/types.js`, whose first line imports zod, so wiring the roster in
    // would have dragged zod and the whole models module into the binary.
    const seen = new Set<string>();
    const offenders: string[] = [];
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(/^\s*import\s+(?:type\s+)?[^"']*from\s+["']([^"']+)["']/gm)) {
        const spec = m[1]!;
        if (spec === "zod" || spec.startsWith("zod/")) {
          offenders.push(`${file} imports ${spec}`);
          continue;
        }
        if (!spec.startsWith(".")) continue;
        const resolved = join(file, "..", spec.replace(/\.js$/, ".ts"));
        if (existsSync(resolved)) walk(resolved);
      }
    };
    walk(join(SRC, "presence", "handler.ts"));

    expect(offenders).toEqual([]);
  });
});
