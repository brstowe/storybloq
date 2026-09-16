/**
 * T-508: the ledger sidebar Mod. Draws `.story/` beside the transcript.
 *
 * Read-only by construction: it reads the ledger through `$.fs` and never
 * writes it. The write path stays the CLI and the MCP server, as the ticket
 * requires, and `claude plugin validate` prints the calls this module makes so
 * a `$.fs.write` added here would show up in a list the tests compare.
 *
 * WHERE THE NUMBERS COME FROM. `sidebar-projection.ts`, which the repo's own
 * vitest holds equal to `storybloq status --compact`. Nothing in this file
 * counts anything; it reads files, caches what it read, and draws.
 *
 * WHY THE SCAN IS CHUNKED. The compact numbers come from the whole
 * file-per-item ledger, which on a mature project is a couple of thousand
 * files, and `.story/status.json` is not a projection of them (it is a session
 * flag, four fields). A hook that read them all in one go would sit on the
 * client's budget, so the first pass runs in chunks on `$.clock.every` and the
 * pane says how many files are left. Afterwards `$.fs.stat` is the only cost
 * for a file that has not changed: the cache in `$.store` is keyed by path to
 * its mtime and the handful of fields the pane shows, so a later session
 * starts warm and a refresh re-reads only what moved.
 *
 * WHY IT POLLS. Nothing tells a session that another process wrote the
 * ledger: a peer session, the Mac app, a git pull and the CLI in a terminal
 * all leave this Mod's events silent, so the pane used to sit on the last
 * projection until this session next finished a turn (T-517). The client
 * exposes no `$.fs.watch`, so the refresh is a poll on the timer that is
 * already running: four `$.fs.stat` calls every two seconds, and nothing
 * further unless one of those four mtimes moved.
 *
 * WIDTH. The client will not draw a pane a plugin opened on its own below 144
 * terminal columns, or below 110 once the person has asked for that id. Below
 * that the same numbers go out as one `AbovePrompt` line, which is how the
 * ticket's 80-column acceptance is met.
 *
 * EVENT NAMES AND `$`. Every event name is a string literal at its `on()` call
 * and every call is spelled `$.noun.member(...)` inline, because the client
 * reads both from this source rather than from a manifest. `client-api.ts` is
 * the documentary pin the tests compare that reading against.
 */

import type { On } from "./mod.js";
import {
  extractRecord,
  projectSidebar,
  type SidebarBoardCard,
  type SidebarIssue,
  type SidebarProjection,
  type SidebarRecord,
  type SidebarTicket,
} from "./sidebar-projection.js";

type Options = Readonly<Record<string, string | number | boolean | readonly string[]>>;

/** The pane's id. Also the `requestId` its `ui.render` and `ui.close` carry. */
const PANE_ID = "storybloq";
const PANE_TITLE = "Storybloq";

/**
 * The narrowest terminal the client will dock a pane into, from the API's own
 * rule: a plugin's unasked open "waits undrawn below 144 columns (110 once
 * asked)". Below this the pane may not be on screen at all, so the one-line
 * fallback draws instead.
 */
const DOCK_MIN_COLUMNS = 110;

const STORE_KEY = "sidebar-ledger-cache-v1";
/** Under the store's 4 MiB, with room for whatever else the plugin keeps. */
const STORE_BUDGET_BYTES = 3_000_000;

/** Files per tick, and the tick, so no single dispatch sits on the budget. */
const SCAN_CHUNK = 25;
const SCAN_TICK_MS = 25;

/**
 * T-517: ticks between idle polls, so eighty of a 25 ms tick is two seconds.
 *
 * Exported because the Mod's own tests count ticks against it, and a poll
 * interval they had to restate as a number would drift from this one.
 */
export const IDLE_POLL_TICKS = 80;

/**
 * How many cards a column ever draws, and the line that stands for the rest.
 *
 * A fixed six, by the owner's ruling, and not a figure derived from
 * `props.scroll.bodyRows`. The derived cap is what produced the bug the owner
 * hit live: a Done column of 27 was headed 27 correctly, drew 18 rows and
 * showed no tail, because the pane clips at `bodyRows` and the tail WAS drawn,
 * below the cut, along with the issues and handover lines under it. Six
 * bounds every column's body at seven rows whatever the pane reports, so the
 * board is the same height on every terminal and nothing is silently cut. It
 * was eight until the owner asked for the height back.
 *
 * The tail is three dots and not "+19 more": the heading already carries the
 * true total, so the tail only has to say that the column goes on.
 */
const COLUMN_CARD_CAP = 6;
const COLUMN_TAIL = "...";
const BOARD_COLUMNS = 4;
/** What a column with nothing in it says, rather than drawing a blank frame. */
const EMPTY_COLUMN = "none";

/**
 * The rows the pane spends on everything that is not a card: the header, the
 * two blank rows around the board and the footer, and per column the heading
 * box (text plus its two border rows) and the body box's two border rows.
 */
const CHROME_ROWS = 4;
const GAP_ROWS = 2;
/** Card rows per column below which the blank rows are not worth their cost. */
const GAPS_MIN_BODY = 3;
/** The card's two border rows, its heading row and the rule under it. */
const COLUMN_FRAME_ROWS = 4;

/** Each column is a bordered card, and the border costs a column each side. */
const COLUMN_BORDER = "round";
const BORDER_COLUMNS = 2;
/** The rule under a heading, and the gaps between the four columns. */
const HEADING_RULE = "\u2500";
const COLUMN_GAP = 1;
const GAP_TOTAL = 3;
/**
 * From this width, In progress is widened and Done narrowed by about a
 * twentieth of the pane: at that size there is room to weight the board
 * toward the column being worked rather than the one already finished.
 */
const WIDE_COLUMNS = 158;
const WIDE_SHIFT = 0.05;
const MIN_COLUMN_WIDTH = 12;

/**
 * The severity buckets in the order the footer names them, with the colour a
 * nonzero one carries and the short label it falls back to.
 */
/** What the issues line says when every bucket is empty. */
const NO_ISSUES = "issues: none";

const SEVERITY_ORDER = [
  { key: "critical", long: "critical", short: "crit", tone: "red" },
  { key: "high", long: "high", short: "high", tone: "yellow" },
  { key: "medium", long: "medium", short: "med", tone: null },
  { key: "low", long: "low", short: "low", tone: null },
] as const;

/**
 * The colour an issue's id carries on a board row, by severity.
 *
 * The same two tones the footer already uses for the same two buckets, so one
 * red on the board means what a red in the issues line means. Medium and low
 * carry none: a column where every row is coloured marks nothing.
 */
const SEVERITY_TONES: Readonly<Record<string, string>> = { critical: "red", high: "yellow" };

/**
 * How each column's heading is drawn.
 *
 * One column is emphasised and it is the one that says what is happening
 * now: In progress, bold and cyan. Blocked keeps a colour because it is a
 * warning, but not the weight; Open is plain, being the resting state and the
 * column a reader lands on most; Done recedes, since finished work is
 * reference rather than news. The count rides in the heading text and is
 * never coloured apart from it.
 */
const COLUMN_STYLES = {
  blocked: { color: "yellow" },
  open: {},
  inProgress: { color: "cyan", bold: true },
  done: { dimColor: true },
} as const;

/**
 * Cells kept clear to the right of the pane's own rows.
 *
 * The engine draws its close mark in the last cell of the pane, and the
 * context fill was right-aligned straight into it: live it read "context 7%×",
 * with the mark looking like part of our string. `BoxProps` carries
 * `marginRight`, so the row simply stops short of the edge. The fill now sits
 * at the foot rather than the head, and keeps the clearance there.
 */
const PANE_EDGE_CLEARANCE = 3;

/**
 * Narrower than this and four columns are shredded rather than laid out, so
 * the same four sections stack instead. Well below the 110 the client needs
 * to dock a pane at all, so this is the in-between case: a pane that exists
 * but is too narrow to be a board.
 */
const BOARD_MIN_COLUMNS = 60;

/**
 * How a ledger write is recognised at `tool.call`. The MCP names arrive
 * prefixed by their server, the CLI's own do not; the verb at the end is what
 * separates a write from a read.
 */
const MCP_PREFIX = "mcp__storybloq__";
const LEDGER_TOOL_PREFIX = "storybloq_";
const LEDGER_WRITE_VERB = /_(create|update|set|unset|add|init|snapshot|reinforce|supersede)$/;
/**
 * The built-in tools that can write a file, from this build's own tool table
 * (`BuiltinToolInputs` in claude-code.d.ts carries Edit, Write and
 * NotebookEdit; MultiEdit is named here for builds that have it, and costs
 * nothing where it does not exist).
 */
const MUTATING_FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const BASH_TOOL = "Bash";
/**
 * The storybloq CLI's writing subcommands, the same verbs the tool names end
 * in, and how far after `storybloq` one still counts as the subcommand
 * (`storybloq note create`, so two words).
 */
const CLI_NAME = "storybloq";
const WRITE_VERBS = ["create", "update", "set", "unset", "add", "init", "snapshot", "reinforce", "supersede"];
const CLI_VERB_DEPTH = 2;
/**
 * The characters that are operators outside a quoted run, the runs of them
 * that cut one segment from the next, and the one that redirects.
 */
const OPERATOR_CHARACTERS = [";", "|", "&", "\n", ">", "<"];
const SEPARATOR_CHARACTERS = [";", "|", "&", "\n"];
const REDIRECT = ">";
/** `&>`, the other way of writing a redirect that takes both streams. */
const BOTH_STREAMS = "&>";
/** `<<` and `<<<`: past one, the line is a document rather than a command. */
const HEREDOC = "<<";
/** A leading `NAME=value`, which is an assignment and not the command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** The few commands that only lead up to the one that runs. */
const WRAPPER_COMMANDS = new Set(["env", "npx", "time", "nice", "sudo", "command"]);
/**
 * The options of those that take a VALUE in the next word, per wrapper.
 *
 * `sudo -u someone storybloq ticket update` runs the CLI, and a reader that
 * steps over `-u` and stops at `someone` decides the command is a username.
 * `--option=value` is one word already and needs none of this.
 */
const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  sudo: ["-u", "-g", "-h", "-p"],
  nice: ["-n"],
  env: ["-u", "-C", "-S"],
  time: ["-f", "-o"],
  npx: ["-p", "--package", "-c", "--call"],
};
/** The CLI's own global options that take the next word as their value. */
const CLI_VALUE_OPTIONS = ["--node", "--format", "--client"];
/** The shell commands that write, by what each of them writes. */
const COPY_COMMANDS = new Set(["cp", "install"]);
const MOVE_COMMAND = "mv";
const TEE_COMMAND = "tee";
const REMOVE_COMMAND = "rm";
const SED_COMMAND = "sed";
/** Where a path can arrive on a built-in file tool's event. */
const PATH_ARGUMENTS = ["file_path", "path", "notebook_path"] as const;
const STORY_DIR = ".story/";
/** The ledger directory itself, which is what says a project HAS a ledger. */
const LEDGER_DIR = ".story";

/** The cell-width approximation's special code points, and the cut mark. */
const ZERO_WIDTH_JOINER = 0x200d;
const VARIATION_SELECTOR = 0xfe0f;
const ELLIPSIS = "\u2026";

const TICKETS_DIR = ".story/tickets";
const ISSUES_DIR = ".story/issues";
const HANDOVERS_DIR = ".story/handovers";
const CONFIG_PATH = ".story/config.json";
const ROADMAP_PATH = ".story/roadmap.json";
const STATUS_PATH = ".story/status.json";

interface CachedRecord {
  readonly mtimeMs: number;
  readonly record: SidebarRecord;
}

interface ScanItem {
  readonly path: string;
  readonly kind: "ticket" | "issue";
}

/**
 * Everything this Mod remembers for the session. Module scope, not a closure,
 * so the render hook can draw what the refresh hooks left without awaiting.
 */
let cache: Record<string, CachedRecord> = {};
let cacheLoaded = false;
let projection: SidebarProjection | null = null;
let project = "";
let phases: { readonly id: string; readonly name: string }[] = [];
let handoverFilenames: string[] = [];
let queue: ScanItem[] = [];
/** Ticks since the last idle poll, and the mtimes that poll compares against. */
let idleTicks = 0;
let polledMtimes: Record<string, number> = {};
/** A scan is building its worklist, or has one left to drain. */
let scanInitializing = false;
let scanActive = false;
/** A refresh asked for while a scan was in flight, to run when it finishes. */
let pendingRefresh = false;
let ticking = false;
/** One timer for the module's life, not one per scan. */
let timerStarted = false;
/** The Mod is on and something is drawn: not the same as the pane existing. */
let sidebarEnabled = false;
let paneOpen = false;
let sessionActive = false;
let contextPercent: number | null = null;
let warm = false;
let uiAvailable = true;
/** The project has no `.story/` at all, so the Mod draws nothing anywhere. */
let noLedger = false;
let saidNoUi = false;
let saidNoLedger = false;
let saidScanFailed = false;

/** Reset between tests; a session only ever loads this module once. */
function forgetEverything(): void {
  cache = {};
  cacheLoaded = false;
  projection = null;
  project = "";
  phases = [];
  handoverFilenames = [];
  queue = [];
  idleTicks = 0;
  polledMtimes = {};
  scanInitializing = false;
  scanActive = false;
  pendingRefresh = false;
  ticking = false;
  timerStarted = false;
  sidebarEnabled = false;
  paneOpen = false;
  sessionActive = false;
  contextPercent = null;
  warm = false;
  uiAvailable = true;
  noLedger = false;
  saidNoUi = false;
  saidNoLedger = false;
  saidScanFailed = false;
}

function isTicketRecord(record: SidebarRecord): record is SidebarTicket {
  return record.kind === "ticket";
}

function isIssueRecord(record: SidebarRecord): record is SidebarIssue {
  return record.kind === "issue";
}

/** Rebuilds the projection from whatever the cache holds right now. */
function reproject(): void {
  const tickets: SidebarTicket[] = [];
  const issues: SidebarIssue[] = [];
  for (const entry of Object.values(cache)) {
    if (isTicketRecord(entry.record)) tickets.push(entry.record);
    else if (isIssueRecord(entry.record)) issues.push(entry.record);
  }
  projection = projectSidebar({ project, phases, tickets, issues, handoverFilenames });
}

/**
 * The graphemes of a string with the cells each one takes.
 *
 * One routine, used by both the measuring and the cutting, because two that
 * disagree is how "👩‍💻abc" cut to four cells came apart in the middle of the
 * emoji: the measure suppressed the code point after the zero-width joiner
 * and the cut counted it again. `Intl.Segmenter` gives the clusters (this
 * runtime has it; where it does not, the fallback is code points, which is
 * the old behaviour and no worse). A cluster is two cells wide if any code
 * point in it is wide, or if it carries the emoji variation selector, which
 * is what makes a text glyph like "♥️" render double.
 */
function graphemes(text: string): { cluster: string; cells: number }[] {
  const out: { cluster: string; cells: number }[] = [];
  for (const cluster of clustersOf(text)) {
    let cells = 0;
    let emoji = false;
    for (const character of cluster) {
      const point = character.codePointAt(0) ?? 0;
      if (point === VARIATION_SELECTOR) emoji = true;
      if (isCombining(point) || point === VARIATION_SELECTOR || point === ZERO_WIDTH_JOINER) continue;
      cells = Math.max(cells, isWide(point) ? 2 : 1);
    }
    out.push({ cluster, cells: emoji ? 2 : Math.max(cells, cluster === "" ? 0 : 1) });
  }
  return out;
}

/** Grapheme clusters where the runtime has them, code points where it does not. */
function clustersOf(text: string): string[] {
  const segmenter = (Intl as unknown as { Segmenter?: any }).Segmenter;
  if (typeof segmenter === "function") {
    const out: string[] = [];
    for (const part of new segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
      out.push(part.segment as string);
    }
    return out;
  }
  return [...text];
}

/**
 * How many terminal cells a string takes, which is not its length.
 *
 * A CJK ideograph or an emoji occupies two cells and a combining mark none,
 * so measuring `.length` overruns a column by a cell per wide character, the
 * row wraps, and the board comes apart. This is the usual approximation (the
 * East Asian Wide and Fullwidth blocks plus the emoji planes), not a full
 * Unicode width table, which is more than a sidebar can carry.
 */
function cellWidth(text: string): number {
  let width = 0;
  for (const { cells } of graphemes(text)) width += cells;
  return width;
}

function isCombining(point: number): boolean {
  return (
    (point >= 0x0300 && point <= 0x036f)
    || (point >= 0x0483 && point <= 0x0489)
    || (point >= 0x0591 && point <= 0x05bd)
    || (point >= 0x0610 && point <= 0x061a)
    || (point >= 0x064b && point <= 0x065f)
    || (point >= 0x1ab0 && point <= 0x1aff)
    || (point >= 0x1dc0 && point <= 0x1dff)
    || (point >= 0x20d0 && point <= 0x20ff)
    || (point >= 0xfe20 && point <= 0xfe2f)
  );
}

function isWide(point: number): boolean {
  return (
    (point >= 0x1100 && point <= 0x115f)
    || (point >= 0x2e80 && point <= 0x303e)
    || (point >= 0x3041 && point <= 0x33ff)
    || (point >= 0x3400 && point <= 0x4dbf)
    || (point >= 0x4e00 && point <= 0x9fff)
    || (point >= 0xa000 && point <= 0xa4cf)
    || (point >= 0xac00 && point <= 0xd7a3)
    || (point >= 0xf900 && point <= 0xfaff)
    || (point >= 0xfe10 && point <= 0xfe19)
    || (point >= 0xfe30 && point <= 0xfe6f)
    || (point >= 0xff00 && point <= 0xff60)
    || (point >= 0xffe0 && point <= 0xffe6)
    || (point >= 0x1f300 && point <= 0x1f64f)
    || (point >= 0x1f680 && point <= 0x1f6ff)
    || (point >= 0x1f900 && point <= 0x1f9ff)
    || (point >= 0x20000 && point <= 0x3fffd)
  );
}

/**
 * Cuts a string to fit `cells` terminal cells, ending in one ellipsis where
 * anything was cut.
 *
 * Cluster by cluster, on the same measure the width uses, so a family emoji
 * or an accented letter is either wholly in or wholly out and never halved.
 * The ellipsis is U+2026, one cell wide.
 */
function truncate(text: string, cells: number): string {
  if (cells <= 0) return "";
  const parts = graphemes(text);
  let total = 0;
  for (const part of parts) total += part.cells;
  if (total <= cells) return text;
  const room = cells - 1;
  let width = 0;
  let out = "";
  for (const part of parts) {
    if (width + part.cells > room) break;
    width += part.cells;
    out += part.cluster;
  }
  return `${out}${ELLIPSIS}`;
}

/** The one line the narrow fallback draws, and the pane's own summary row. */
function summaryLine(withContext: boolean): string {
  // Until one scan has finished (or a warm cache came out of the store) the
  // numbers are a partial read, and drawing them would be a figure that
  // changes a second later for no reason the reader can see.
  const busy = scanActive || scanInitializing;
  if (!warm || projection === null) {
    return busy
      ? `Storybloq: reading the ledger, ${queue.length} files left`
      : "Storybloq: no ledger read yet";
  }
  const parts = [
    `${projection.currentPhase ? projection.currentPhase.name : "no phase"}`,
    `${projection.openTickets} open`,
    `${projection.inProgressTickets.length} in progress`,
    `${projection.blockedTickets} blocked`,
    `${projection.openIssues} issues`,
  ];
  if (withContext && contextPercent !== null) parts.push(`context ${contextPercent}%`);
  if (busy) parts.push(`reading ${queue.length}`);
  return `Storybloq: ${parts.join(", ")}`;
}

/** config.json, roadmap.json, the handover names and the session flag. */
async function readHeader($: any): Promise<void> {
  try {
    const configText = await $.fs.read(CONFIG_PATH);
    const parsed = JSON.parse(configText) as { project?: unknown };
    project = typeof parsed.project === "string" ? parsed.project : "";
  } catch {
    project = "";
  }
  try {
    const roadmapText = await $.fs.read(ROADMAP_PATH);
    const parsed = JSON.parse(roadmapText) as { phases?: readonly { id?: unknown; name?: unknown }[] };
    const found: { id: string; name: string }[] = [];
    for (const phase of parsed.phases ?? []) {
      if (typeof phase.id === "string") {
        found.push({ id: phase.id, name: typeof phase.name === "string" ? phase.name : phase.id });
      }
    }
    phases = found;
  } catch {
    phases = [];
  }
  try {
    const entries = await $.fs.list(HANDOVERS_DIR);
    handoverFilenames = entries
      .filter((entry: { kind: string }) => entry.kind === "file")
      .map((entry: { name: string }) => entry.name);
  } catch {
    handoverFilenames = [];
  }
  // status.json is a session flag and nothing else; the ledger numbers do
  // not come from it.
  sessionActive = false;
  if (await $.fs.exists(STATUS_PATH)) {
    try {
      const parsed = JSON.parse(await $.fs.read(STATUS_PATH)) as { sessionActive?: unknown };
      sessionActive = parsed.sessionActive === true;
    } catch {
      sessionActive = false;
    }
  }
}

async function loadCache($: any): Promise<void> {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const stored = await $.store.get(STORE_KEY);
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      cache = stored as Record<string, CachedRecord>;
      // A cache from an earlier session is enough to draw real numbers while
      // this session's scan confirms them.
      warm = Object.keys(cache).length > 0;
    }
  } catch {
    cache = {};
  }
}

async function saveCache($: any): Promise<void> {
  const text = JSON.stringify(cache);
  if (text.length > STORE_BUDGET_BYTES) {
    $.ui.log(`storybloq sidebar: the ledger cache is over ${STORE_BUDGET_BYTES} bytes, so it is not kept between sessions`);
    return;
  }
  try {
    await $.store.set(STORE_KEY, cache);
  } catch {
    // A store that refuses costs a cold start next session, nothing more.
  }
}

/** One guarded line, once: a failing sidebar must not become a chatty one. */
function noteFailure($: any, what: string): void {
  if (saidScanFailed) return;
  saidScanFailed = true;
  try {
    $.ui.log(`storybloq sidebar: ${what}, so the pane may be behind the ledger until a later turn`);
  } catch {
    // A refused log is not worth a second failure.
  }
}

/**
 * ONE timer for the module's life, not one per scan.
 *
 * `$.clock.every` runs until its `cancel()`, and a scan that registered its
 * own would leave it running: two scans, two timers, every later tick paying
 * for both. The callback returns at once unless a scan is actually draining.
 */
function startTimer($: any): void {
  if (timerStarted) return;
  try {
    $.clock.every(SCAN_TICK_MS, () => {
      tick($).catch(() => {
        finalizeScan($, "failed");
      });
    });
  } catch {
    // A hook beneath may refuse the registration. Marking it started before
    // it returned would mean no later attempt is ever made, and a scan begun
    // with no timer builds a queue that nothing drains.
    noteFailure($, "the scan timer could not be started");
    return;
  }
  timerStarted = true;
}

/**
 * The one exit from a scan, whichever way it ended.
 *
 * Releasing the in-flight flags and consuming the pending refresh belong
 * together: a failure path that released the flags but left the pending flag
 * set would strand the request, because every later tick returns at once with
 * no scan active and nothing else reads that flag. Consumed exactly once, so
 * a failed scan nobody asked to repeat is not retried on its own.
 */
function finalizeScan($: any, outcome: "done" | "failed"): void {
  scanActive = false;
  scanInitializing = false;
  ticking = false;
  if (outcome === "failed") noteFailure($, "a ledger scan did not finish");
  if (!pendingRefresh) return;
  pendingRefresh = false;
  requestScan($);
}

/**
 * Asks for a scan, coalescing.
 *
 * A refresh asked for while one is in flight is REMEMBERED, not dropped: the
 * queue the running scan is draining was listed before the write that
 * prompted this call, so that write would otherwise never be listed at all.
 * Many requests during one scan collapse into the single scan that follows it.
 */
/**
 * Does this project have a ledger at all?
 *
 * The directory itself, not `tickets/`: a fresh `storybloq init` leaves
 * `.story/` with empty subdirectories, and that IS a ledger. A board of four
 * "none" columns is the right answer there and the wrong one in a repo that
 * never ran init.
 *
 * A host that refuses the question answers yes: the Mod hiding itself because
 * `$.fs.exists` threw would be a worse failure than one empty board.
 */
async function ledgerPresent($: any): Promise<boolean> {
  try {
    return (await $.fs.exists(LEDGER_DIR)) !== false;
  } catch {
    return true;
  }
}

/**
 * Opens the pane and reads the ledger: everything `session.start` does once
 * it knows there is something to draw.
 *
 * Also the recovery path. A project that had no `.story/` when the session
 * started gets one the moment someone runs `storybloq init`, and the pane has
 * to appear then rather than at the next reload, so `turn.complete` and a
 * ledger-writing `tool.call` both come back through here.
 */
async function attach($: any): Promise<void> {
  if (!paneOpen) {
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE });
    paneOpen = true;
  }
  // The context figures belong to the window, not to the turn: they are
  // readable the moment the Mod loads into a session that has already had a
  // response. Reading them only on `turn.complete` is why the owner's header
  // was blank after a reload, with the fill only appearing a turn later.
  contextPercent = await readContextFill($);
  await readHeader($);
  await loadCache($);
  // The idle poll's baseline (T-517). Taken before the timer starts and before
  // the scan below, so the first poll compares against the ledger as it was
  // when this session read it: a write between the two is a change, not a
  // missed one. Taken after the timer, a tick could poll against an empty
  // baseline, find every path "moved" and rescan for nothing.
  polledMtimes = await ledgerMtimes($);
  startTimer($);
  requestScan($);
}

/**
 * The ledger was missing; is it there now? Attaches if it is.
 *
 * Nothing is drawn while it is absent, so this is the only way back: every
 * refresh the Mod already made asks the question again, and the answer costs
 * one `$.fs.exists` on a project that has no ledger to read anyway.
 */
async function attachIfLedgerArrived($: any): Promise<void> {
  if (!(await ledgerPresent($))) return;
  noLedger = false;
  await attach($);
}

function requestScan($: any): void {
  if (scanActive || scanInitializing) {
    pendingRefresh = true;
    return;
  }
  // The timer may still be missing because an earlier registration was
  // refused. Without it a queue would be built that nothing drains, so try
  // again here and start no scan while it is absent.
  startTimer($);
  if (!timerStarted) return;
  beginScan($).catch(() => {
    // The scan is detached, so nothing else would hear this.
    finalizeScan($, "failed");
  });
}

/** Lists the ledger and leaves a queue for the ticker to drain. */
async function beginScan($: any): Promise<void> {
  scanInitializing = true;
  try {
    const items: ScanItem[] = [];
    try {
      for (const entry of await $.fs.list(TICKETS_DIR)) {
        if (entry.kind === "file" && entry.name.endsWith(".json")) {
          items.push({ path: `${TICKETS_DIR}/${entry.name}`, kind: "ticket" });
        }
      }
    } catch {
      // No tickets directory: nothing to read from it.
    }
    try {
      for (const entry of await $.fs.list(ISSUES_DIR)) {
        if (entry.kind === "file" && entry.name.endsWith(".json")) {
          items.push({ path: `${ISSUES_DIR}/${entry.name}`, kind: "issue" });
        }
      }
    } catch {
      // Same.
    }
    // A file the ledger no longer has must leave the cache, or a deleted
    // ticket would keep being counted.
    const present = new Set(items.map((item) => item.path));
    for (const path of Object.keys(cache)) {
      if (!present.has(path)) delete cache[path];
    }
    queue = items;
    scanActive = true;
    reproject();
    $.ui.invalidate("ui.render");
  } finally {
    scanInitializing = false;
  }
}

/**
 * What one turn of the module's single timer does: drain an active scan, and
 * once every IDLE_POLL_TICKS look for a write nothing told this session about
 * (T-517).
 *
 * The counter lives here rather than in a second `$.clock.every`, because a
 * second timer would be a second dispatch on every 25 ms tick for the life of
 * the session, and the poll is a two-second thing.
 */
async function tick($: any): Promise<void> {
  await drainChunk($);
  idleTicks += 1;
  if (idleTicks < IDLE_POLL_TICKS) return;
  idleTicks = 0;
  try {
    await pollLedger($);
  } catch {
    // The timer's catch finalizes the ACTIVE scan as failed, which a poll that
    // could not stat or read the header has no business doing: the scan is
    // unrelated to it. A failed poll costs nothing and runs again in two
    // seconds.
  }
}

/**
 * The four directory mtimes the idle poll watches.
 *
 * Directories and not files: every CLI and MCP write lands by rename or link
 * INTO a directory (project-loader's atomicWrite and atomicCreate), so a
 * create, a delete and a replace all move the directory's own mtime, and four
 * stats stand in for a walk of a couple of thousand files. `.story` itself is
 * where roadmap.json, config.json and status.json land. An in-place edit by
 * an editor moves no directory, and that case is what the turn-end rescan is
 * still for.
 *
 * A path that cannot be stat-ed reads 0, so one that appears later moves.
 */
const POLLED_PATHS = [LEDGER_DIR, TICKETS_DIR, ISSUES_DIR, HANDOVERS_DIR] as const;

async function ledgerMtimes($: any): Promise<Record<string, number>> {
  const seen: Record<string, number> = {};
  for (const path of POLLED_PATHS) {
    try {
      const stat = await $.fs.stat(path);
      seen[path] = typeof stat?.mtimeMs === "number" ? stat.mtimeMs : 0;
    } catch {
      seen[path] = 0;
    }
  }
  return seen;
}

/**
 * Has anything moved since the last look? If so, refresh.
 *
 * Deliberately NOT gated on `paneOpen`, for the same reason the AbovePrompt
 * line is not: below the client's dock width there is no pane and that line
 * IS the sidebar, so a poll tied to the pane would leave the only thing drawn
 * standing still.
 *
 * Deliberately NOT skipped while a scan is draining either: the running scan
 * took its worklist before this write existed, so it will not see it. Asking
 * mid-scan is what `requestScan`'s pending flag is for, and the rescan
 * follows the one in flight instead of being dropped.
 *
 * Never while `noLedger`: a project with no `.story/` draws nothing at all,
 * and `turn.complete` and a ledger-writing tool call already carry the one
 * question worth asking there (has a ledger arrived?).
 */
async function pollLedger($: any): Promise<void> {
  if (!uiAvailable || !sidebarEnabled || noLedger) return;
  const seen = await ledgerMtimes($);
  let moved = false;
  for (const path of POLLED_PATHS) {
    if (polledMtimes[path] !== seen[path]) moved = true;
  }
  // The whole of the idle cost: four stats and this comparison. Dropping it
  // is M-POLL-ALWAYS-RESCANS, which re-reads the ledger every two seconds
  // whether or not anyone wrote it.
  if (!moved) return;
  polledMtimes = seen;
  // The header files (roadmap, config, status, the handover names) land in
  // `.story` itself, and a scan does not re-read them, so this mirrors what
  // `turn.complete` does. It runs only when something actually moved.
  await readHeader($);
  requestScan($);
}

/**
 * One tick: up to SCAN_CHUNK files, each stat-ed and re-read only when its
 * mtime moved. The mtime check is the whole of "updates within one prompt";
 * serving the cached fields without it is the M-STALE-CACHE mutant.
 */
async function drainChunk($: any): Promise<void> {
  // The idle guard. Without it every tick after the first scan reprojects the
  // whole ledger, serializes it, writes it to the store and invalidates, for
  // as long as the session lasts.
  if (ticking || !scanActive) return;
  ticking = true;
  let outcome: "done" | "failed" | null = null;
  try {
    let read = 0;
    while (queue.length > 0 && read < SCAN_CHUNK) {
      const item = queue.shift()!;
      read += 1;
      try {
        const stat = await $.fs.stat(item.path);
        const cached = cache[item.path];
        if (cached && cached.mtimeMs === stat.mtimeMs) continue;
        const record = extractRecord(item.kind, await $.fs.read(item.path));
        if (record === null) delete cache[item.path];
        else cache[item.path] = { mtimeMs: stat.mtimeMs, record };
      } catch {
        delete cache[item.path];
      }
    }
    if (queue.length === 0) {
      warm = true;
      reproject();
      await saveCache($);
      $.ui.invalidate("ui.render");
      outcome = "done";
    }
  } catch {
    // Whatever failed, this scan is over. Which of the two it was changes
    // only the log line: both leave through the same door.
    outcome = "failed";
  }
  if (outcome === null) {
    ticking = false;
    return;
  }
  finalizeScan($, outcome);
}

/**
 * The context fill from what `$.session.usage()` actually answers.
 *
 * `SessionContextUsage` carries `window` always, `tokens` and `percent` only
 * "from the first API response of the live window": a fresh session or one
 * just compacted has neither until its next response. Live, the owner's
 * header stayed empty because this read `percent` alone, so the percent is
 * computed from `tokens` over `window` whenever the engine did not state it,
 * and null (draw nothing) only when there is no reading at all.
 */
function contextFill(usage: any): number | null {
  const context = usage?.context;
  if (typeof context?.percent === "number") return Math.round(context.percent);
  const tokens = context?.tokens;
  const window = context?.window;
  if (typeof tokens !== "number" || typeof window !== "number" || window <= 0) return null;
  return Math.round((tokens / window) * 100);
}

/**
 * The context fill, or null, and never a rejection.
 *
 * The fill is telemetry on the header's right, and `$.session.usage` is a call
 * a host may not have or may refuse. Unguarded in `session.start` it rejects
 * AFTER the pane is opened, which takes the ledger read, the board and
 * `next(e)` with it: a missing figure would cost the whole sidebar. One helper
 * for all three call sites so the shape cannot drift between them.
 */
async function readContextFill($: any): Promise<number | null> {
  try {
    const usage = await $.session.usage();
    return contextFill(usage);
  } catch {
    return null;
  }
}

/** One piece of a command line: an operator, or a word to be read as one. */
interface Token {
  readonly text: string;
  readonly operator: boolean;
}

/**
 * A command line read ONCE, quotes and escapes honoured, operators kept apart
 * from arguments.
 *
 * Splitting on separators before reading the quotes was the bug: `echo "x;
 * storybloq ticket update"` came apart into two segments and the second
 * looked like a CLI call, and `echo '>' .story/config.json` looked like a
 * redirect into the ledger. A separator, a redirect and a quote mark only
 * mean what they say OUTSIDE a quoted run, so there is one pass and it knows
 * which run it is in.
 *
 * An unterminated quote makes the REST of the line unreadable, not the whole
 * of it. Dropping everything was a regression: a heredoc writing a ticket
 * (`cat > .story/tickets/T-001.json <<'EOF'`) has a body full of apostrophes,
 * and so does a trailing `# that's it` comment, and the write on the line
 * before them stopped sweeping. So the tokens read before the bad quote
 * opened come back with `ok: false`, and the caller judges every segment that
 * closed before it and discards the one the quote is in.
 *
 * A heredoc operator ends the read for the same reason from the other side:
 * its head is a command and its body is data, so reading the body as shell
 * would take words out of a document and call them a write.
 */
/**
 * Steps over a heredoc's delimiter word, quoted or bare, and answers with the
 * index of its last character, the word its terminator line must equal, and
 * whether `<<-` allowed that line leading tabs.
 *
 * The delimiter's own quotes are opened and closed here rather than by the
 * lexer's, so `<<'EOF'` does not read as a quote left open and throw the rest
 * of the head away, and a backslash quotes the character after it as it does
 * in the shell.
 */
function afterHeredocDelimiter(command: string, from: number): { index: number; delimiter: string; dashed: boolean } {
  let index = from;
  let delimiter = "";
  let dashed = false;
  for (let word = 0; word < 2; word += 1) {
    while (index + 1 < command.length && (command[index + 1] === " " || command[index + 1] === "\t")) index += 1;
    let quote = "";
    while (index + 1 < command.length) {
      const character = command[index + 1]!;
      if (quote !== "") {
        index += 1;
        if (character === quote) quote = "";
        else delimiter += character;
        continue;
      }
      // A backslash quotes the next character of the delimiter, so `<<\\EOF`
      // ends at a line reading EOF. Keeping the backslash means the
      // terminator is never found and the rest of the script is read as body.
      if (character === "\\") {
        index += 1;
        const escaped = command[index + 1];
        if (escaped !== undefined) {
          delimiter += escaped;
          index += 1;
        }
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        index += 1;
        continue;
      }
      if (character === " " || character === "\t" || character === "\n" || OPERATOR_CHARACTERS.includes(character)) break;
      delimiter += character;
      index += 1;
    }
    // `<<-EOF` allows leading tabs on the terminator; `<<- EOF` writes the
    // dash as a word of its own, so one more word is read for it.
    if (!delimiter.startsWith("-")) break;
    dashed = true;
    delimiter = delimiter.slice(1);
    if (delimiter !== "") break;
  }
  return { index, delimiter, dashed };
}

/**
 * Where a heredoc's body ends: the index of the newline that closes its
 * terminator line, or -1 where the terminator never comes and the rest of the
 * command is body.
 *
 * The body is never read as shell, but what follows it is: a script that
 * writes a note and then updates a ticket is one Bash call, and stopping at
 * the body would lose the write.
 */
function afterHeredocBody(command: string, from: number, delimiter: string, dashed: boolean): number {
  let start = from + 1;
  while (start <= command.length) {
    const cut = command.indexOf("\n", start);
    const last = cut === -1;
    const end = last ? command.length : cut;
    let line = command.slice(start, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (dashed) line = line.replace(/^\t+/, "");
    if (line === delimiter) return last ? command.length - 1 : end;
    if (last) return -1;
    start = end + 1;
  }
  return -1;
}

function lex(command: string): { tokens: Token[]; ok: boolean } {
  const tokens: Token[] = [];
  let text = "";
  let started = false;
  let quote = "";
  /** How many tokens were whole when the quote now open was opened. */
  let opened = 0;
  /**
   * A heredoc head is being read, so the next newline starts its body, and
   * the word that ends it. Two heredocs on one head line (`cat <<A <<B`) are
   * read as one body ending at the LAST delimiter, which is close enough: the
   * body is never read either way and what follows it still is.
   */
  let heredoc = false;
  let delimiter = "";
  let dashed = false;
  const flush = (): void => {
    if (started) tokens.push({ text, operator: false });
    text = "";
    started = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote !== "") {
      // Inside single quotes a backslash is a backslash; inside double quotes
      // it escapes the next character, as the shell reads them. (Bash keeps
      // the backslash before anything but $ \ " ` and a newline; this drops
      // it either way, which costs a character in a path nobody writes.)
      if (character === "\\" && quote === '"' && index + 1 < command.length) {
        index += 1;
        text += command[index];
        started = true;
        continue;
      }
      if (character === quote) quote = "";
      else {
        text += character;
        started = true;
      }
      continue;
    }
    if (character === "\\") {
      index += 1;
      if (index < command.length) {
        text += command[index];
        started = true;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      // Where the quote opened, so an unclosed one can give back what was
      // whole before it rather than nothing at all.
      quote = character;
      opened = tokens.length;
      started = true;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      flush();
      continue;
    }
    if (OPERATOR_CHARACTERS.includes(character)) {
      flush();
      let run = character;
      while (index + 1 < command.length && command[index + 1] === character) {
        run += character;
        index += 1;
      }
      // The body of a heredoc starts at the newline after its head and is
      // never read: it is a document, and a line of it that looks like a write
      // is prose someone is filing. What comes AFTER the terminator is shell
      // again, and dropping it was losing the write in the commonest script
      // Claude Code produces: a note written with `cat <<EOF`, then a ticket
      // updated on the line below its EOF.
      if (heredoc && run.startsWith("\n")) {
        const end = afterHeredocBody(command, index, delimiter, dashed);
        if (end === -1) return { tokens, ok: true };
        index = end;
        heredoc = false;
        tokens.push({ text: "\n", operator: true });
        continue;
      }
      // `<<` and `<<<`: the head is still a command and the REST OF ITS LINE
      // still counts, because `cat <<'EOF' > .story/tickets/T-001.json` writes
      // a ticket with the redirect sitting after the delimiter. So the
      // operator and its delimiter are stepped over and the line goes on being
      // read as shell.
      if (run.startsWith(HEREDOC)) {
        const head = afterHeredocDelimiter(command, index);
        index = head.index;
        // `<<<` is a here-string: its word IS the input, and there is no body
        // to step over.
        if (run === HEREDOC) {
          heredoc = true;
          delimiter = head.delimiter;
          dashed = head.dashed;
        }
        continue;
      }
      // `>&` and `&>` are one redirect written two ways, and a run of one
      // character would split them: the `&` would then cut the segment and
      // the redirect would lose its target. `2>&1` is the same shape and
      // still names no file of ours, so it neither sweeps nor cuts.
      if (run[0] === REDIRECT && command[index + 1] === "&") {
        run += "&";
        index += 1;
      } else if (run[0] === "&" && command[index + 1] === REDIRECT) {
        while (command[index + 1] === REDIRECT) {
          run += REDIRECT;
          index += 1;
        }
      }
      tokens.push({ text: run, operator: true });
      continue;
    }
    text += character;
    started = true;
  }
  flush();
  // An unclosed quote: give back what was already whole when it opened. The
  // word it started, and everything after, is not shell this can read.
  if (quote !== "") return { tokens: tokens.slice(0, opened), ok: false };
  return { tokens, ok: true };
}

/** A word that names something inside the ledger directory. */
function inLedger(word: string | undefined): boolean {
  return typeof word === "string" && word.includes(STORY_DIR);
}

/** The last path segment of a word, which is the name a command runs under. */
function basename(word: string): string {
  const cut = word.lastIndexOf("/");
  return cut === -1 ? word : word.slice(cut + 1);
}

/**
 * The command a segment actually runs, past the wrappers that only lead up to
 * one, and the arguments it was given.
 *
 * `storybloq` counts as the CLI only HERE, in executable position: `echo
 * storybloq ticket update` prints a sentence and writes nothing, and the two
 * read identically to anything that only looks for the word. The wrappers are
 * a named few (`env`, `npx`, `time`, `nice`, `sudo`, `command`) with their own
 * options and any leading `NAME=value` assignments stepped over. Anything
 * else in front of the command (`xargs`, a subshell, a substitution) is a
 * line this cannot read, and it returns nothing rather than guess.
 */
function executableOf(words: readonly string[]): { name: string; args: string[] } | null {
  let index = 0;
  for (;;) {
    while (index < words.length && ASSIGNMENT.test(words[index]!)) index += 1;
    if (index < words.length && WRAPPER_COMMANDS.has(basename(words[index]!))) {
      const takesValue = WRAPPER_VALUE_OPTIONS[basename(words[index]!)] ?? [];
      index += 1;
      while (index < words.length && words[index]!.startsWith("-")) {
        const option = words[index]!;
        index += 1;
        if (!option.includes("=") && takesValue.includes(option)) index += 1;
      }
      continue;
    }
    break;
  }
  if (index >= words.length) return null;
  return { name: words[index]!, args: words.slice(index + 1) };
}

/**
 * Did one segment of a command line write the ledger?
 *
 * Direction is the whole question. `cat .story/tickets/T-001.json > /tmp/x`
 * and `cp .story/tickets/T-001.json /tmp/x` both name the ledger and both
 * write a file, and neither changes a thing we draw; only where the ledger is
 * the DESTINATION has anything moved. So a redirect counts at its target and
 * a copy at its last operand. `mv` counts at either end, because moving a
 * ticket OUT of the ledger takes it off the board as surely as moving one in;
 * `tee` counts at any of its files, and `rm` and `sed -i` at the path they
 * are given.
 */
function segmentWrote(tokens: readonly Token[]): boolean {
  const words: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.operator) {
      words.push(token.text);
      continue;
    }
    // A redirect writes what follows it; `<` reads it, and the rest of the
    // operators never reach here (they are what the segments were cut on).
    if (token.text.startsWith(REDIRECT) || token.text.startsWith(BOTH_STREAMS)) {
      const target = tokens[index + 1];
      if (target !== undefined && !target.operator && inLedger(target.text)) return true;
      index += 1;
    }
  }

  const run = executableOf(words);
  if (run === null) return false;
  const name = basename(run.name);
  const args = run.args;

  // The CLI resolves `.story/` itself, so the command line need not name it;
  // what says it writes is the SUBCOMMAND. A verb further along is an
  // argument (`storybloq note list --tags update`) or prose in a flag's
  // value, and neither writes anything.
  if (name === CLI_NAME) {
    // Only the words that are SUBCOMMANDS count toward the depth: a global
    // option before the verb (`storybloq --node x ticket update`) would
    // otherwise push it out of reach and the write would go unseen.
    let depth = 0;
    for (let index = 0; index < args.length && depth < CLI_VERB_DEPTH; index += 1) {
      const word = args[index]!;
      if (word.startsWith("-")) {
        if (!word.includes("=") && CLI_VALUE_OPTIONS.includes(word)) index += 1;
        continue;
      }
      depth += 1;
      if (WRITE_VERBS.includes(word)) return true;
    }
    return false;
  }

  if (name === MOVE_COMMAND || name === TEE_COMMAND || name === REMOVE_COMMAND) return args.some(inLedger);
  if (COPY_COMMANDS.has(name)) return args.length >= 2 && inLedger(args[args.length - 1]);
  if (name === SED_COMMAND) return args.some((word) => word.startsWith("-i")) && args.some(inLedger);
  return false;
}

/**
 * Every segment of a command line, cut on the separators, each on its own.
 *
 * The last segment is judged only when the line was read to its end: where an
 * unterminated quote stopped the read, that segment is the one the quote is
 * in and there is no telling what it says.
 */
function commandWroteLedger(command: string): boolean {
  const { tokens, ok } = lex(command);
  let segment: Token[] = [];
  for (const token of tokens) {
    // `&>` opens with a separator character and is not one: it is a redirect,
    // and cutting the segment there would leave its target orphaned.
    if (token.operator && SEPARATOR_CHARACTERS.includes(token.text[0]!) && !token.text.startsWith(BOTH_STREAMS)) {
      if (segmentWrote(segment)) return true;
      segment = [];
      continue;
    }
    segment.push(token);
  }
  return ok && segmentWrote(segment);
}

/**
 * Did this tool call change the ledger?
 *
 * The question has to be answered from the tool NAME first, because a ledger
 * read is the common case and a sweep per read is the cost the chunked scan
 * exists to avoid. Reading a ticket, globbing `.story`, or catting a config
 * file all mention the directory and none of them change a thing.
 *
 *   tool                                              scan
 *   storybloq_* / mcp__storybloq__* whose last word   yes
 *     is a writing verb (ticket_update, meta_set)
 *   any other storybloq tool (status, list, get)      no
 *   Write, Edit, MultiEdit, NotebookEdit at a         yes
 *     path under .story/
 *   the same four anywhere else                       no
 *   Bash running the storybloq CLI in EXECUTABLE      yes
 *     position with a writing verb in SUBCOMMAND
 *      position (it resolves .story/ itself, so the
 *      command line need not name the directory)
 *   Bash writing INTO .story/ (a redirect whose       yes
 *     destination is there, cp whose last argument
 *      is, tee at one, rm or sed -i of one)
 *   Bash moving a file at either end of .story/       yes
 *     (mv out of it takes a ticket off the board
 *      as surely as mv into it puts one on)
 *   Bash reading .story/ and writing elsewhere        no
 *     (cat a ticket into /tmp, cp one out of it)
 *   Bash naming the CLI anywhere but executable       no
 *     position (echo storybloq ticket update), or
 *      inside quotes, or in a heredoc's body, or in
 *      the segment an unterminated quote is in
 *      (the segments that closed before it still
 *      count, one at a time)
 *   Bash otherwise (cat, ls, grep, git status,        no
 *     storybloq status, storybloq ticket list)
 *   Read, Glob, Grep, LS, anything else               no
 *
 * Bash is conservative by construction: what it cannot read confidently does
 * not sweep. A missed write costs one turn of staleness, since turn.complete
 * still scans; a false positive costs a stat sweep of the whole ledger for
 * every ledger read in the session, which is worse.
 *
 * Pure, and it reads only the few fields a path or a command arrives in, so a
 * Write of a megabyte is not serialized to answer a yes or no question.
 */
function wroteLedger(e: any): boolean {
  const tool: unknown = e?.tool;
  if (typeof tool !== "string") return false;
  const bare = tool.startsWith(MCP_PREFIX) ? tool.slice(MCP_PREFIX.length) : tool;
  if (bare.startsWith(LEDGER_TOOL_PREFIX)) return LEDGER_WRITE_VERB.test(bare);
  if (tool === BASH_TOOL) {
    const command: unknown = e?.["command"];
    return typeof command === "string" && commandWroteLedger(command);
  }
  if (!MUTATING_FILE_TOOLS.has(tool)) return false;
  for (const key of PATH_ARGUMENTS) {
    const value: unknown = e?.[key];
    if (typeof value === "string" && value.includes(STORY_DIR)) return true;
  }
  return false;
}

/** Side by side, or one column after another on a narrow pane. */
function isStacked(width: number): boolean {
  return width < BOARD_MIN_COLUMNS;
}

/**
 * How many card rows each column may draw, and whether the pane can afford
 * the blank rows around the board at all.
 *
 * The pane clips what will not fit, silently, so the budget is counted out
 * before anything is drawn:
 *
 *   header 1, header gap 1, footer gap 1, footer 1   = 4 chrome rows
 *   the card's border, above and below              = 2
 *   its heading row and the rule under it           = 2
 *
 * Side by side the four columns are parallel, so one column's four frame rows
 * are the board's; stacked they run one after another, so the frames cost
 * four times that and the rows left over are shared between them. The blank
 * rows go before the cards do, because a board with one card in it still says
 * something and a gap says nothing. When even four framed headings will not
 * fit, the board falls back to one plain counted row per column, which is the
 * smallest thing that is still the board.
 *
 * What comes back is the rows one BODY may draw, tail included; the board
 * decides how many of those are cards once it knows whether anything was left
 * out.
 *
 * WHY `bodyRows` IS NOT THE ROOM. The owner reloaded a 213 column, 61 row
 * terminal and got the compact fallback where the build before drew eight
 * cards a column. `scroll.bodyRows` is not the height the surface has for us:
 * `SiteScroll` is "where a site's window sits over THE TREE A HOOK DREW in
 * it", and `ui.scroll` spells the same field "how many rows of the tree the
 * window shows at once, AS DRAWN NOW", with `contentRows` beside it and
 * "the window's last offset is `contentRows - bodyRows`, none when the tree
 * fits". A tree that fits is its own window, so `bodyRows` is the height of
 * what we last drew. Reading it as a cap is a ratchet: one short board makes
 * the next budget shorter, the compact fallback draws six rows, and the pane
 * reports six rows for ever after.
 *
 * So the field is allowed to PROVE room and never to deny it. The cap comes
 * from `viewport.rows`, which is the whole surface and so an honest upper
 * bound on the pane ("cells down the whole surface, not the room left for
 * this component"), and `bodyRows` only raises that. Above the rows the whole
 * board needs neither matters and the layout is the one the owner had before
 * any budget existed: the capped cards, a tail, and the blank rows.
 */
function rowBudget(e: any, stacked: boolean): { body: number; gaps: boolean; compact: boolean } {
  const frames = stacked ? COLUMN_FRAME_ROWS * BOARD_COLUMNS : COLUMN_FRAME_ROWS;
  const share = stacked ? BOARD_COLUMNS : 1;
  const whole = CHROME_ROWS + frames + share * (COLUMN_CARD_CAP + 1);
  const drawn: number = typeof e.props?.scroll?.bodyRows === "number" ? e.props.scroll.bodyRows : 0;
  const screen: number = typeof e.viewport?.rows === "number" ? e.viewport.rows : 0;
  const room = Math.max(drawn, screen);
  if (room <= 0 || room >= whole) return { body: COLUMN_CARD_CAP + 1, gaps: true, compact: false };
  // With the blank rows first, but only while they are affordable: below
  // GAPS_MIN_BODY rows of cards per column the gaps are costing more than
  // they are worth, and a board with cards in it beats a tidy empty one.
  for (const [gaps, floor] of [[true, GAPS_MIN_BODY], [false, 1]] as const) {
    const chrome = CHROME_ROWS - (gaps ? 0 : GAP_ROWS);
    const left = room - chrome - frames;
    if (left >= share * floor) {
      return { body: Math.min(COLUMN_CARD_CAP + 1, Math.floor(left / share)), gaps, compact: false };
    }
  }
  return { body: 0, gaps: false, compact: true };
}

/**
 * A heading that keeps its count when the column is too narrow for both.
 *
 * The count is the point of the heading, so the label is what gets cut:
 * "In progress 100" at fourteen cells is "In progr… 100", never
 * "In progress 1…", which would quietly report a different number.
 */
function headingText(label: string, count: number, width: number): string {
  const tail = ` ${count}`;
  return `${truncate(label, Math.max(1, width - tail.length))}${tail}`;
}

/** One card row: the id whole and dim, the title cut to what is left. */
function cardRow(elements: any, card: SidebarBoardCard, width: number): unknown {
  const room = width - cellWidth(card.id) - 1;
  const title = room > 0 ? truncate(card.title, room) : "";
  // The id is dim on every row, ticket or issue, so the eye runs down the
  // titles; a severe issue colours ITS ID and nothing else, which marks the
  // row without turning the column into a traffic light. Only the two that
  // mean act on this are coloured: medium and low read as any other row.
  const idProps: Record<string, unknown> = { dimColor: true, children: truncate(card.id, width) };
  const tone = card.kind === "issue" && card.severity !== null ? SEVERITY_TONES[card.severity] : undefined;
  if (tone !== undefined) idProps["color"] = tone;
  return elements.Text({
    wrap: "truncate",
    children: [
      // The id whole, never cut: a half id is worse than no id. The title
      // takes what is left, and the eye runs down the titles.
      elements.Text(idProps),
      elements.Text({ children: title === "" ? "" : ` ${title}` }),
    ],
  });
}

/**
 * The rows of one column's body, every body the same height.
 *
 * The four bodies draw the same number of rows, so the cards end level
 * instead of leaving a ragged edge: a column with fewer cards is padded with
 * blanks, and a column with nothing in it says so in a dim word rather than
 * showing an empty frame. The tail row is part of that common height, held
 * back by the budget, so a capped column can say it was capped without
 * standing a row taller than the rest.
 */
function bodyRowsOf(
  elements: any,
  cards: readonly SidebarBoardCard[],
  width: number,
  shown: number,
  height: number,
): unknown[] {
  const rows: unknown[] = [];
  if (cards.length === 0) {
    rows.push(elements.Text({ dimColor: true, wrap: "truncate", children: truncate(EMPTY_COLUMN, width) }));
  } else {
    for (const card of cards.slice(0, shown)) rows.push(cardRow(elements, card, width));
    if (cards.length > shown) rows.push(elements.Text({ dimColor: true, wrap: "truncate", children: COLUMN_TAIL }));
  }
  while (rows.length < height) rows.push(elements.Text({ children: " " }));
  return rows;
}

/**
 * One column: a bordered card with its heading at the top, a rule under the
 * heading, and the card rows beneath.
 *
 * One box and not two. The heading is enclosed by the card's own top and side
 * borders and the rule below it, which is the divider; two stacked bordered
 * boxes drew a double line between heading and body. The rule is a Text of
 * box-drawing dashes spanning the inner width, so it meets both side borders;
 * it cannot render the ├ and ┤ junctions, since a child of the box cannot
 * reach into the border cells the renderer owns.
 *
 * The count in the heading is the WHOLE column, not the rows drawn, so a
 * capped column still tells the truth about the project; the tail says the
 * column goes on. Titles are cut to the column's width, not the pane's.
 *
 * Takes the resolved element table rather than `$`: these are plain
 * constructors, and the client's scan is strict about where `$` may travel.
 */
function boardColumn(
  elements: any,
  key: string,
  heading: string,
  style: Readonly<Record<string, unknown>>,
  cards: readonly SidebarBoardCard[],
  width: number,
  shown: number,
  height: number,
): unknown {
  // The border takes a column on each side, so the text inside has that much
  // less. Getting this wrong wraps every row and the board falls apart.
  const textWidth = Math.max(1, width - BORDER_COLUMNS);
  return elements.Box({
    key,
    flexDirection: "column",
    borderStyle: COLUMN_BORDER,
    width,
    overflow: "hidden",
    children: [
      elements.Text({
        key: `${key}-heading`,
        ...style,
        wrap: "truncate",
        children: headingText(heading, cards.length, textWidth),
      }),
      elements.Text({ key: `${key}-rule`, dimColor: true, wrap: "truncate", children: HEADING_RULE.repeat(textWidth) }),
      ...bodyRowsOf(elements, cards, textWidth, shown, height),
    ],
  });
}

/** The board reduced to four counted rows, when no frame will fit. */
function compactBoard(elements: any, board: any, width: number): unknown {
  const line = (
    key: string,
    label: string,
    style: Readonly<Record<string, unknown>>,
    cards: readonly SidebarBoardCard[],
  ): unknown =>
    elements.Text({ key, ...style, wrap: "truncate", children: headingText(label, cards.length, width) });
  return elements.Box({
    key: "board",
    flexDirection: "column",
    children: [
      line("board-blocked", "Blocked", COLUMN_STYLES.blocked, board.blocked),
      line("board-open", "Open", COLUMN_STYLES.open, board.open),
      line("board-inprogress", "In progress", COLUMN_STYLES.inProgress, board.inProgress),
      line("board-done", "Done", COLUMN_STYLES.done, board.done),
    ],
  });
}

/**
 * The four column widths.
 *
 * Stacked, every card takes the pane. Side by side, the width less the three
 * gaps splits four ways, the leftover cells going to Open; from WIDE_COLUMNS
 * up, a twentieth of the pane moves from Done to In progress, so the board
 * leans toward the work in hand. The four widths and the gaps always sum to
 * the pane's width, whatever the arithmetic above did.
 */
function columnWidths(width: number, stacked: boolean): number[] {
  if (stacked) return [width, width, width, width];
  const base = Math.max(MIN_COLUMN_WIDTH, Math.floor((width - GAP_TOTAL) / BOARD_COLUMNS));
  const widths = [base, base, base, base];
  widths[1] = (widths[1] ?? base) + Math.max(0, width - GAP_TOTAL - base * BOARD_COLUMNS);
  if (width >= WIDE_COLUMNS) {
    const shift = Math.min(Math.round(width * WIDE_SHIFT), (widths[3] ?? base) - MIN_COLUMN_WIDTH);
    if (shift > 0) {
      widths[2] = (widths[2] ?? base) + shift;
      widths[3] = (widths[3] ?? base) - shift;
    }
  }
  return widths;
}

function boardNode(elements: any, board: any, width: number, stacked: boolean, body: number): unknown {
  const widths = columnWidths(width, stacked);
  // Every body the same height, and that height inside the budget: as many
  // rows as the fullest column can show, one of them given up to the tail
  // when anything was left out, so a capped column says so without standing a
  // row taller than the rest.
  const columns = [board.blocked, board.open, board.inProgress, board.done] as readonly SidebarBoardCard[][];
  const longest = Math.max(...columns.map((column) => column.length));
  // Never more than the cap, whatever the budget allows: a body of seven rows
  // is six cards and a tail, not seven cards.
  let shown = Math.min(body, longest, COLUMN_CARD_CAP);
  if (columns.some((column) => column.length > shown)) shown = Math.max(0, Math.min(shown, body - 1));
  const omitted = columns.some((column) => column.length > shown);
  const height = Math.max(1, Math.min(body, shown + (omitted ? 1 : 0)));
  // Left to right in the order the work moves: what is stuck, what can be
  // picked up, what is being done, what is finished.
  return elements.Box({
    key: "board",
    flexDirection: stacked ? "column" : "row",
    gap: stacked ? 0 : COLUMN_GAP,
    children: [
      boardColumn(elements, "board-blocked", "Blocked", COLUMN_STYLES.blocked, board.blocked, widths[0]!, shown, height),
      boardColumn(elements, "board-open", "Open", COLUMN_STYLES.open, board.open, widths[1]!, shown, height),
      boardColumn(elements, "board-inprogress", "In progress", COLUMN_STYLES.inProgress, board.inProgress, widths[2]!, shown, height),
      boardColumn(elements, "board-done", "Done", COLUMN_STYLES.done, board.done, widths[3]!, shown, height),
    ],
  });
}

/**
 * The header row: the wordmark, and nothing else.
 *
 * No mark, no phase, and no longer the context fill. The owner had the
 * rasterized S here and took it out, the phase went when the board stopped
 * being one phase's, and the fill moved to the foot of the pane, so what is
 * left is the brand and one row of height.
 */
function headerNode(elements: any): unknown {
  return elements.Box({
    key: "header",
    flexDirection: "row",
    alignItems: "center",
    marginRight: PANE_EDGE_CLEARANCE,
    children: [elements.Text({ bold: true, children: "Storybloq" })],
  });
}

/**
 * The foot of the pane: the issues breakdown flush left, the context fill
 * right-aligned on the same row.
 *
 * The four buckets are always all there, so the shape of the line does not
 * move about; what changes is the weight. A zero bucket is dim and a nonzero
 * one is not, critical reads red and high yellow when they have anything in
 * them, and the separators are dim throughout, so the eye lands on the
 * severities that exist. The context fill is neutral and gets its width
 * first, the issues line taking what is left and going to the short labels
 * when the long ones will not fit.
 *
 * No right margin here: the engine's close mark is a top-right thing, and the
 * header is what keeps clear of it.
 */
function footerNode(
  elements: any,
  bySeverity: Readonly<Record<string, number>>,
  context: number | null,
  width: number,
): unknown {
  const contextText = context === null ? "" : `context ${context}%`;
  const room = Math.max(1, width - cellWidth(contextText) - 1);
  const counts = SEVERITY_ORDER.map((severity) => bySeverity[severity.key] ?? 0);
  // A ledger with nothing open says so in a word. Four zeros is four numbers
  // to read before finding out there is nothing to read, and it looks like a
  // pane that failed rather than a project with no open issues. The
  // abbreviated row says the same word, since there is nothing to abbreviate.
  if (counts.every((count) => count === 0)) {
    return elements.Box({
      key: "footer",
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      children: [
        elements.Box({
          key: "issues",
          flexDirection: "row",
          width: Math.min(room, cellWidth(NO_ISSUES)),
          overflow: "hidden",
          children: [elements.Text({ dimColor: true, wrap: "truncate", children: NO_ISSUES })],
        }),
        elements.Text({ key: "context", wrap: "truncate", children: contextText }),
      ],
    });
  }
  const long = `issues: ${SEVERITY_ORDER.map((s, i) => `${counts[i]} ${s.long}`).join(", ")}`;
  const short = SEVERITY_ORDER.map((s, i) => `${counts[i]} ${s.short}`).join(" ");
  const abbreviated = cellWidth(long) > room;

  const parts: unknown[] = [];
  if (!abbreviated) parts.push(elements.Text({ children: "issues: " }));
  SEVERITY_ORDER.forEach((severity, index) => {
    const count = counts[index] ?? 0;
    const props: Record<string, unknown> = {
      children: `${count} ${abbreviated ? severity.short : severity.long}`,
    };
    if (count === 0) props["dimColor"] = true;
    else if (severity.tone !== null) props["color"] = severity.tone;
    if (index > 0) {
      parts.push(elements.Text({ dimColor: true, children: abbreviated ? " " : ", " }));
    }
    parts.push(elements.Text(props));
  });

  return elements.Box({
    key: "footer",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    children: [
      // ONE Text, not a row of them. The coloured fragments are its children,
      // which keeps each its colour, and the truncation is the parent's: a Box
      // of Texts has no wrap prop to set, so when even the abbreviated buckets
      // outgrew the room the row wrapped and the footer took two rows out of a
      // budget counted for one. The room is the width, so the cut is the
      // context fill's clearance and not the pane's edge.
      elements.Box({
        key: "issues",
        flexDirection: "row",
        width: Math.min(room, cellWidth(abbreviated ? short : long)),
        overflow: "hidden",
        children: [elements.Text({ wrap: "truncate", children: parts })],
      }),
      elements.Text({ key: "context", wrap: "truncate", children: contextText }),
    ],
  });
}

export function registerSidebar(on: On, _options: Options): void {
  forgetEverything();

  // The pane. `ui.render` fires once per input value and again on
  // `$.ui.invalidate("ui.render")`, so this hook only draws what the refresh
  // hooks have already computed: it awaits nothing.
  (on("ui.render", ($: any, e: any, next: (e: any) => unknown) => {
    // Nothing is drawn without a ledger, pane or band: there is no pane open
    // to render into, and the band's line would be the empty board in one row.
    if (noLedger) return next(e);
    if (e.component === "Pane" && e.requestId === PANE_ID) {
      const elements = $.ui.resolve(e);
      const { Box, Text } = elements;
      const width: number = typeof e.props?.bodyColumns === "number" ? e.props.bodyColumns : 40;
      // The header, then one blank row: the break the owner asked for, so the
      // wordmark does not read as part of the first column heading. A single
      // space and not an empty string, because an empty Text collapses to no
      // row at all in this client and the break simply did not draw.
      const stacked = isStacked(width);
      const budget = rowBudget(e, stacked);
      const rows: unknown[] = [headerNode(elements)];
      if (budget.gaps) rows.push(Text({ key: "header-gap", children: " " }));
      if (projection === null) {
        // Nothing to draw a board from yet: the one line that says why.
        rows.push(Text({ children: truncate(summaryLine(false), width) }));
      } else {
        rows.push(
          budget.compact
            ? compactBoard(elements, projection.board, width)
            : boardNode(elements, projection.board, width, stacked, budget.body),
        );
        if (budget.gaps) rows.push(Text({ key: "issues-gap", children: " " }));
        rows.push(footerNode(elements, projection.issuesBySeverity, contextPercent, width));
        if (sessionActive) {
          rows.push(Text({ dimColor: true, wrap: "truncate", children: "an autonomous session is active" }));
        }
      }
      return Box({ flexDirection: "column", children: rows });
    }
    // The narrow fallback: the client leaves a plugin's pane undrawn on a
    // small terminal, so the same numbers go out as one line above the prompt.
    // Gated on the Mod being on and on the width, and deliberately NOT on
    // the pane existing. Below DOCK_MIN_COLUMNS the client draws no pane at
    // all, so this line IS the sidebar; tying it to `paneOpen` would let a
    // close of something never drawn turn off the only thing that was.
    if (e.component === "AbovePrompt" && sidebarEnabled) {
      const columns: number = typeof e.viewport?.columns === "number" ? e.viewport.columns : 0;
      if (columns > 0 && columns < DOCK_MIN_COLUMNS) {
        const { Text } = $.ui.resolve(e);
        return Text({ dimColor: true, children: truncate(summaryLine(true), columns) });
      }
    }
    return next(e);
    // A client without the UI events refuses this registration rather than
    // throwing at the call site; that is the "renders nothing" case, and the
    // scan admits `.catch` here and nothing else.
  }) as { catch: (fn: (error: unknown) => void) => void }).catch(() => {
    uiAvailable = false;
  });

  on("session.start", async ($: any, e: any, next: (e: any) => unknown) => {
    if (!uiAvailable) {
      if (!saidNoUi) {
        saidNoUi = true;
        $.ui.log("storybloq sidebar: this client has no UI render events, so the pane is not drawn");
      }
      return next(e);
    }
    // A `-p` run and the SDK draw nowhere: `surface` is null and nobody is at
    // the prompt, so there is no pane to open and no ledger worth reading for
    // a sidebar nobody will see.
    if (e.surface === null || e.isInteractive !== true) return next(e);
    // On, whatever happens next: the refresh hooks stay armed so the pane can
    // appear the moment a ledger does.
    sidebarEnabled = true;
    // No `.story/` means no pane, by the owner's ruling. A project that never
    // ran `storybloq init` was getting four bordered "none" columns and an
    // all-zero issues line, which is a dashboard reporting on nothing; the Mod
    // hides instead, and says so once in the log rather than every turn.
    if (!(await ledgerPresent($))) {
      noLedger = true;
      if (!saidNoLedger) {
        saidNoLedger = true;
        $.ui.log("storybloq sidebar: no .story directory here, so the pane stays closed until storybloq init runs");
      }
      return next(e);
    }
    noLedger = false;
    // `session.start` fires again on a reload, and an open of an open id only
    // retitles it, but asking twice is still asking twice: `attach` asks once.
    await attach($);
    return next(e);
  });

  // A turn is the unit the acceptance names: a `.story/` write during it shows
  // up by the next prompt.
  on("turn.complete", async ($: any, e: any, next: (e: any) => unknown) => {
    if (!uiAvailable || !sidebarEnabled) return next(e);
    if (noLedger) {
      await attachIfLedgerArrived($);
      return next(e);
    }
    contextPercent = await readContextFill($);
    await readHeader($);
    requestScan($);
    return next(e);
  });

  // A ledger write inside a turn has to show up inside that turn: the owner
  // moved a ticket to in progress, waited five seconds and moved it back, and
  // the board sat on the old column the whole time because nothing asked for
  // a rescan until the turn ended. So this runs the call first and then, only
  // for a call that can have written `.story/`, requests a scan; the scan is
  // mtime-keyed, so the cost of one that changed nothing is a stat sweep.
  //
  // Filtered here rather than by an `on()` matcher on the tool name: a
  // matcher prints as `tool.call{tool=/.../}` in the client's scan, and the
  // contract test compares that list against the bare event names pinned in
  // client-api.ts, which is not this Mod's file to change.
  on("tool.call", async ($: any, e: any, next: (e: any) => unknown) => {
    const result = await next(e);
    if (uiAvailable && sidebarEnabled && wroteLedger(e)) {
      // `storybloq init` is a ledger write like any other, and it is the one
      // that turns a hidden Mod into a drawn one, so the no-ledger case goes
      // through the same filter rather than waiting for the turn to end.
      if (noLedger) await attachIfLedgerArrived($);
      else requestScan($);
    }
    return result;
  });

  on("session.compact", async ($: any, e: any, next: (e: any) => unknown) => {
    if (!uiAvailable || !sidebarEnabled || noLedger) return next(e);
    contextPercent = await readContextFill($);
    $.ui.invalidate("ui.render");
    return next(e);
  });

  // The person closed the pane: there is no longer one to draw into, and a
  // later `session.start` may open it again. This does not turn the Mod off,
  // which is why it touches `paneOpen` and not `sidebarEnabled`.
  on("ui.close", ($: any, e: any, next: (e: any) => unknown) => {
    if (e.requestId === PANE_ID) paneOpen = false;
    return next(e);
  });
}
