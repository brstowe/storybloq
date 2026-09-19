/**
 * T-505: every Claude Code function-hooks event and `$` call the storybloq
 * Mods use, pinned in one place.
 *
 * The plugin API is early access. Its own declaration file, written by the
 * client's `/plugin-types` command, opens with:
 *
 *   "Written by Claude Code 2.1.274."
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
export const CLIENT_API_VERSION = "2.1.274";

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
  /** The `theme` row changing, so pane text keeps its contrast (ISS-1238). */
  configSet: "config.set",
  /**
   * The person entering a prompt: an open made here "answers the person's
   * input" and is placed at any width, where the session.start open waits
   * undrawn below 144 columns (ISS-1251; 2.1.277 d.ts `PaneOpenArgs`).
   */
  promptSubmit: "prompt.submit",
} as const;

/**
 * Pane placement, read from the 2.1.277 declarations on 2026-09-19
 * (ISS-1247): `CommandPresentation` says "the fullscreen layout docks a pane
 * beside the transcript from 110 columns, the main screen places it inline
 * above the prompt at any width"; the `Pane` render props carry
 * `placement: 'dock' | 'inline'` and `RenderViewport` carries `isFullscreen`.
 * `$.ui.open` takes no placement argument, and none is needed: docking is
 * the renderer's (`/tui fullscreen`, or `"tui": "fullscreen"` in settings),
 * and the 144/110 columns in `PaneOpenArgs` gate whether an open is placed at
 * all, not where.
 */
export const PLACEMENT_RULE_SOURCE = "claude-code.d.ts 2.1.277: CommandPresentation, PaneOpenArgs, RenderComponentProps.Pane.placement, RenderViewport.isFullscreen";

export type EventKey = keyof typeof EVENTS;

/**
 * Calls a Mod makes on `$`, by noun. Listed so the set the client scans
 * from source (`claude plugin validate`) can be compared against the set
 * the Mods intend to make; a call missing here is a call to justify.
 */
export const CALLS = {
  sidebar: [
    "$.clock.every",
    /** The client's `theme` row, for pane text contrast (ISS-1238). */
    "$.config.list",
    "$.fs.exists",
    "$.fs.list",
    "$.fs.read",
    "$.fs.stat",
    "$.session.usage",
    /** The merged settings, for `autoCompactWindow` (ISS-1236). */
    "$.settings.read",
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
