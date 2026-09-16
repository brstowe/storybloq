/**
 * T-505: every Claude Code function-hooks event and `$` call the storybloq
 * Mods use, pinned in one place.
 *
 * The plugin API is early access. Its own declaration file, written by the
 * client's `/plugin-types` command, opens with:
 *
 *   "Written by Claude Code 2.1.272."
 *   "EARLY ACCESS: this surface may change between releases without notice."
 *
 * Every name below was read from that file on 2026-09-15 (spike T-506, note
 * N-129). The client scans a module's source and refuses an event name that
 * is not a string literal at its `on()` call site ("the event name passed to
 * on() is not a string literal; $ is always spelled $.noun.event(...)"), so
 * the Mods spell these names as literals and this file is the pin they are
 * checked against: `claude plugin validate plugins/storybloq` prints what
 * each module hooks and calls, and the sidebar test compares that list with
 * EVENTS and CALLS here. When a client update renames one, both change.
 */

/** The client version the names below were read from. */
export const CLIENT_API_VERSION = "2.1.273";

/** Events a Mod registers with `on("<name>", hook)`; the literal must match. */
export const EVENTS = {
  sessionStart: "session.start",
  sessionCompact: "session.compact",
  sessionDetach: "session.detach",
  agentSpawn: "agent.spawn",
  turnComplete: "turn.complete",
  toolCall: "tool.call",
  uiRender: "ui.render",
  uiClose: "ui.close",
} as const;

export type EventKey = keyof typeof EVENTS;

/**
 * Calls a Mod makes on `$`, by noun. Listed so the set the client scans
 * from source (`claude plugin validate`) can be compared against the set
 * the Mods intend to make; a call missing here is a call to justify.
 */
export const CALLS = {
  sidebar: [
    "$.clock.every",
    "$.fs.exists",
    "$.fs.list",
    "$.fs.read",
    "$.fs.stat",
    "$.session.usage",
    "$.store.get",
    "$.store.set",
    "$.ui.invalidate",
    "$.ui.log",
    "$.ui.open",
    "$.ui.resolve",
  ],
} as const;

/** The environment variable the client reads to load hooks modules at all. */
export const ENABLE_FLAG = "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS";

/** The client's own session id variable, the storybloq client task id. */
export const SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";
