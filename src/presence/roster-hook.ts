/**
 * ISS-1240: the roster's seat writer.
 *
 * T-507 shipped the roster core, its CLI verbs and a read-only
 * `storybloq_roster_get`, but its only WRITER was a plugin Mod the owner
 * removed on 2026-09-15. Nothing replaced it, so `roster list` answered zero
 * seats on every project and federation pens fell back to hand-maintaining a
 * committed contacts file that is machine-local by construction and wrong for
 * everyone who pulls it. ISS-1205's guard keeps that filename out of `src/`
 * entirely, so it is not named here either.
 *
 * WHY IT RIDES THE PRESENCE BINARY. `storybloq-presence` already registers for
 * `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop` and `SessionEnd`, and
 * already pays for root discovery. Adding hook entries to the `storybloq` CLI
 * instead would cost a ~310ms process spawn per event, which is the exact cost
 * this binary exists to avoid.
 *
 * WHY NOT THE STOP HOOK FOR THE TERMINAL WRITE. The issue asked for
 * `roster end --state detached` on Stop. Stop fires at the end of every TURN,
 * not at session end, and `heartbeat` does not change state, so that would
 * have marked every live session detached after its first turn and left it
 * there for the rest of the session. `SessionEnd` is the real one.
 *
 * FAIL-SOFT IS NOT OPTIONAL HERE. A non-zero exit on `PreToolUse` BLOCKS the
 * tool call, so every path in this module swallows its own failures and
 * returns an outcome the caller ignores. The roster is telemetry; it may never
 * cost the user a tool call.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import {
  ROSTER_STALE_MS,
  ROSTER_SUBDIR,
  MAX_ROSTER_RECORD_BYTES,
  parseSeat,
  rosterFileBase,
  upsertSeat,
  type RosterSeat,
} from "../core/roster.js";
import { readBoundedNoFollow, telemetrySubdirIfPresent } from "./io.js";
import { presenceFileBase } from "./types.js";

/**
 * How stale the seat file may get before a `PreToolUse` writes again.
 *
 * DERIVED, never a literal: `PreToolUse` fires on every tool call, so the
 * throttle is what keeps a tool-heavy turn from taking a locked write per
 * call, and a quarter of the stale window means a seat cannot approach
 * staleness while calls are flowing. Hardcoding it would let the two drift
 * apart the day `ROSTER_STALE_MS` is retuned, and a throttle longer than the
 * stale window would report a working session as stale.
 */
export const ROSTER_HEARTBEAT_THROTTLE_MS = ROSTER_STALE_MS / 4;

/** This binary is registered on Claude's hooks only; Codex seats arrive over the Bus. */
const CLIENT = "claude" as const;

export type RosterHookOutcome =
  | "skipped-not-roster-event"
  | "skipped-throttled"
  | "written"
  | "skipped-refused"
  | "skipped-failed";

/**
 * The seat file's own path, WITHOUT creating anything.
 *
 * The throttle reads this and nothing else. It deliberately does not consult
 * the presence record: the roster is decoupled from the presence opt-out, so
 * with presence disabled that record does not exist, and a throttle sourced
 * from it would read "due" forever and take a locked write on every single
 * tool call -- the precise cost the throttle exists to prevent.
 */
function seatPathFor(root: string, clientTaskId: string): string | null {
  const dir = telemetrySubdirIfPresent(root, ROSTER_SUBDIR);
  if (dir === null) return null;
  return join(dir, `${rosterFileBase(CLIENT, clientTaskId, null)}.json`);
}

/** The stored seat, read WITHOUT the lock: this is only the CAS input. */
function currentSeat(root: string, clientTaskId: string): RosterSeat | null {
  const path = seatPathFor(root, clientTaskId);
  if (path === null) return null;
  const text = readBoundedNoFollow(path, MAX_ROSTER_RECORD_BYTES);
  if (text === null) return null;
  return parseSeat(text, rosterFileBase(CLIENT, clientTaskId, null));
}

/**
 * True when a `PreToolUse` heartbeat is due.
 *
 * mtime rather than the parsed `lastSeenAt`, and unlocked, because this is an
 * optimisation and not a correctness guard: `applySeatEvent`'s generation
 * check and `upsertSeat`'s per-record lock still decide every real write, so a
 * throttle that fires early or late costs one extra write or a slightly later
 * heartbeat and can never produce a wrong seat. A missing file is always due.
 */
function heartbeatDue(root: string, clientTaskId: string, now: number): boolean {
  const path = seatPathFor(root, clientTaskId);
  if (path === null) return true;
  try {
    return now - statSync(path).mtimeMs >= ROSTER_HEARTBEAT_THROTTLE_MS;
  } catch {
    return true;
  }
}

/**
 * The process era for this session, off the presence record, or null.
 *
 * The era (`<pid>:<epochSeconds>`) is what lets a reload advance the seat's
 * generation IN PLACE: `applySeatEvent` treats a start whose `sessionId`
 * matches the stored one as a refresh and only bumps the generation when it
 * differs, so passing the session id for both would pin the generation at 1
 * forever. Read best-effort and only on `SessionStart`; when presence is
 * disabled there is no record and reloads degrade to refresh semantics, which
 * is a numbering limitation and touches nothing else.
 */
function eraOf(root: string, sessionId: string): string | null {
  try {
    const dir = telemetrySubdirIfPresent(root, "presence");
    if (dir === null) return null;
    const text = readBoundedNoFollow(join(dir, `${presenceFileBase(sessionId)}.json`));
    if (text === null) return null;
    const raw = JSON.parse(text) as { sessionIntel?: { era?: unknown } | null };
    const era = raw.sessionIntel?.era;
    return typeof era === "string" && era.length > 0 ? era : null;
  } catch {
    return null;
  }
}

/**
 * Records this hook event against the session's roster seat.
 *
 * Called after root discovery and BEFORE the presence opt-out, so that
 * disabling presence does not silently empty the roster. Never throws.
 */
/**
 * A fresh seat for this session.
 *
 * Shared by `SessionStart` and by the Stop/PreToolUse fallback for a session
 * whose `SessionStart` was missed, so the era lookup and the identity tuple
 * have one spelling rather than two that can drift apart.
 */
function startSeat(root: string, sessionId: string, nowIso: string): boolean {
  return upsertSeat(
    root,
    {
      kind: "start",
      client: CLIENT,
      clientTaskId: sessionId,
      agentId: null,
      sessionId: eraOf(root, sessionId) ?? sessionId,
      description: null,
    },
    nowIso,
  ).ok;
}

export function recordRosterSeat(
  root: string,
  event: string,
  sessionId: string,
  now: Date,
): RosterHookOutcome {
  try {
    const nowIso = now.toISOString();
    if (event === "SessionStart") {
      return startSeat(root, sessionId, nowIso) ? "written" : "skipped-refused";
    }
    if (event === "Stop" || event === "PreToolUse") {
      if (event === "PreToolUse" && !heartbeatDue(root, sessionId, now.getTime())) return "skipped-throttled";
      const current = currentSeat(root, sessionId);
      if (current === null) {
        // No seat yet: a session whose SessionStart was missed still gets one,
        // which is what keeps a tool call in a never-started session visible.
        return startSeat(root, sessionId, nowIso) ? "written" : "skipped-refused";
      }
      const result = upsertSeat(
        root,
        { kind: "heartbeat", client: CLIENT, clientTaskId: sessionId, agentId: null, generation: current.generation },
        nowIso,
      );
      return result.ok ? "written" : "skipped-refused";
    }
    if (event === "SessionEnd") {
      const current = currentSeat(root, sessionId);
      if (current === null) return "skipped-refused";
      const result = upsertSeat(
        root,
        { kind: "end", client: CLIENT, clientTaskId: sessionId, agentId: null, generation: current.generation, state: "detached" },
        nowIso,
      );
      return result.ok ? "written" : "skipped-refused";
    }
    // PostToolUse and anything else: the during-turn window is already covered
    // by the throttled PreToolUse heartbeat, and doing both would double the
    // per-tool-call cost for no added liveness.
    return "skipped-not-roster-event";
  } catch {
    // Telemetry must never cost a tool call.
    return "skipped-failed";
  }
}
