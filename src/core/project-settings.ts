/**
 * T-427 project-local settings for the tool-boundary (on-tool) Bus hook.
 *
 * The on-tool PostToolUse hook is registered in `.claude/settings.local.json`, NOT
 * the shared `~/.claude/settings.json` the Stop hook uses. Two reasons:
 *
 *  1. `settings.local.json` is Claude Code's per-user, git-ignored project override,
 *     so the hook stays local to this checkout and never travels to a teammate as an
 *     auto-registered command (a supply-chain / trust vector a committed hook would be).
 *  2. Like `.story/`, a repo-local dotfile is ATTACKER-PLANTABLE. Every read and write
 *     here therefore refuses to follow a symlink at the FINAL component AND at the
 *     containing `.claude` parent (a path-based lstat of the child would silently
 *     traverse a symlinked `.claude`, so the parent is lstat'd no-follow first). The
 *     write additionally revalidates `.claude`'s dev/ino immediately before the rename.
 *     That revalidation is BEST-EFFORT: Node exposes no `renameat`/`openat`, so the final
 *     `rename` re-resolves the `.claude` path component and a same-instant swap between
 *     the check and the rename cannot be fully excluded. An attacker able to win that
 *     swap already has write access to the project root and could plant a malicious
 *     settings file directly, so the residual window grants no capability the guard is
 *     meant to deny; the check still defeats a pre-planted symlink and a slow swap. This
 *     is deliberately the OPPOSITE of `atomicWriteFollowingSymlink`, which follows
 *     symlinks on purpose for the user's own global dotfiles.
 *
 * Before installing, the module refuses to write into a git-TRACKED settings file and
 * proves (via `git check-ignore`, the authoritative source in a worktree) that the file
 * stays git-ignored, so a crash can never leave an exposable, committable hook file
 * behind. git command EXECUTION failures fail closed. When git cannot answer (absent, or
 * a non-zero exit that could be unsafe-ownership rather than "not a repo"), a filesystem
 * `.git` marker walk decides: a marker means we ARE in a repo but cannot verify tracking
 * -> fail closed; no marker up to the filesystem root means there is genuinely no repo
 * and thus no tracking/commit risk -> skip the git guards and apply only the no-follow
 * write.
 */

import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readTextNoFollow,
  syncDirectory,
} from "../bus/io.js";
import { BusError } from "../bus/errors.js";
import {
  BUSTOOL_SUBCOMMAND,
  formatHookCommand,
  parseHookCommand,
  STORYBLOQ_LEGACY_BASENAMES,
  type HookEntry,
  type MatcherGroup,
} from "./hook-migration.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
const MAX_CAS_ATTEMPTS = 4;

// The PostToolUse hook matches ALL tools (empty matcher), so it fires after every
// tool call and does only a cheap mailbox high-water check.
const TOOL_HOOK_MATCHER = "";
const SETTINGS_LOCAL_BASENAME = "settings.local.json";
const CLAUDE_GITIGNORE_RULE = SETTINGS_LOCAL_BASENAME;

export function projectSettingsPath(root: string): string {
  return join(root, ".claude", SETTINGS_LOCAL_BASENAME);
}

export function claudeDirPath(root: string): string {
  return join(root, ".claude");
}

/** The canonical on-tool hook command for a resolved storybloq binary. */
export function busToolHookCommand(binPath: string): string {
  return formatHookCommand(binPath, BUSTOOL_SUBCOMMAND);
}

// ---------------------------------------------------------------------------
// No-follow, parent-identity-checked read / write of files inside .claude
// ---------------------------------------------------------------------------

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
}

// Signals that the target file changed between our read and our commit, so the caller
// re-reads and re-applies instead of silently clobbering a concurrent edit.
class ConcurrentEditError extends Error {
  constructor() {
    super("settings file changed concurrently");
    this.name = "ConcurrentEditError";
  }
}

// Test-only seam: runs AFTER the temp file is written and BEFORE the parent-identity
// revalidation, so a test can deterministically swap `.claude` and prove the write
// aborts instead of committing through the swapped directory.
let afterTempWriteHook: (() => Promise<void>) | null = null;
// Test-only seam: runs right after the temp file is opened and BEFORE its content is
// written, so a test can throw to simulate a write/sync failure (with `.claude` intact)
// and prove the temp file is unlinked rather than leaked.
let afterTempOpenHook: (() => Promise<void>) | null = null;

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function identityOf(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
}

function sameIdentity(a: FileIdentity | null, b: FileIdentity | null): boolean {
  if (a === null || b === null) return a === b; // both absent
  return a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

// Reject a symlinked or non-directory `.claude` parent BEFORE touching a file inside it.
// lstat is no-follow on the FINAL component only, so a path-based lstat of the child
// would silently traverse a symlinked `.claude` and read/write outside the project; this
// lstat's the parent no-follow first. Returns the parent's identity when it is a real
// directory, or null when the parent is absent (a legitimately not-yet-created `.claude`,
// in which case the child is absent too).
async function assertClaudeParentReal(path: string): Promise<FileIdentity | null> {
  const dir = dirname(path);
  const stat = await lstatOrNull(dir);
  if (stat === null) return null; // .claude not created yet -> the child cannot exist
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new BusError("corrupt", ".claude is a symlink or not a directory; refusing to read or write through it.");
  }
  return identityOf(stat);
}

// Read a file inside .claude without following a symlink, returning its text (or null
// when absent) plus the identity to compare against at commit time. A symlinked `.claude`
// parent OR a symlinked target is refused as `corrupt` (never read through the link).
async function readClaudeFileNoFollow(path: string): Promise<{ content: string | null; identity: FileIdentity | null }> {
  await assertClaudeParentReal(path); // reject a symlinked .claude before reading the child
  const stat = await lstatOrNull(path);
  if (stat === null) return { content: null, identity: null };
  if (stat.isSymbolicLink()) throw new BusError("corrupt", `${basename(path)} is a symlink; refusing to read through it.`);
  if (!stat.isFile()) throw new BusError("corrupt", `${basename(path)} is not a regular file.`);
  const content = await readTextNoFollow(path);
  return { content, identity: identityOf(stat) };
}

// Parent-identity-checked, compare-before-commit atomic write of a file inside .claude:
//  - `.claude` must be a real directory (not a symlink). Its dev/ino is captured and
//    RE-VERIFIED immediately before the rename, so a swap of `.claude` to a symlink is
//    caught with high probability. This is BEST-EFFORT, not atomic: Node has no
//    `renameat`, so the final rename re-resolves the `.claude` path component and a
//    same-instant swap in the tiny window between the check and the rename cannot be
//    fully excluded. Winning that race requires project-root write access, which already
//    lets the attacker plant a malicious settings file outright, so the residual window
//    grants nothing new; the check still defeats a pre-planted symlink and a slow swap.
//  - a symlink at the target NAME is refused (rename replaces the name, but a planted
//    link is a signal we never write next to).
//  - the target's identity is re-verified against `expected` right before the rename; a
//    concurrent writer that changed it raises ConcurrentEditError so the caller retries
//    against the new content rather than silently overwriting it.
async function hardenedClaudeWrite(
  root: string,
  targetPath: string,
  content: string,
  expected: FileIdentity | null,
): Promise<void> {
  const dir = claudeDirPath(root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dirStat = await lstat(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new BusError("corrupt", ".claude is not a directory (a symlink or non-directory was rejected).");
  }
  const dirDev = dirStat.dev;
  const dirIno = dirStat.ino;

  const targetStat = await lstatOrNull(targetPath);
  if (targetStat?.isSymbolicLink()) {
    throw new BusError("corrupt", `${basename(targetPath)} is a symlink; refusing to write through it.`);
  }
  if (!sameIdentity(targetStat ? identityOf(targetStat) : null, expected)) throw new ConcurrentEditError();

  // ONE outer try wraps the temp's entire lifecycle -- open, write, sync, close, revalidate,
  // rename -- so a failure at ANY pre-rename step unlinks the temp. (A previous split left
  // the write/sync in a finally that only CLOSED the handle, leaking a `.tmp-*` file when
  // write or sync threw.) `renamed` tracks commit so a post-rename failure (a syncDirectory
  // error) never unlinks -- unlinking `temp` after rename would be a no-op, but the flag
  // makes the "never touch the committed file" intent explicit.
  const temp = join(dir, `.tmp-${basename(targetPath)}.${process.pid}.${randomUUID()}`);
  const handle = await open(temp, "wx", 0o600);
  let renamed = false;
  try {
    try {
      if (afterTempOpenHook) await afterTempOpenHook(); // seam: simulate a write/sync failure
      await handle.writeFile(content, "utf-8");
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (afterTempWriteHook) await afterTempWriteHook();
    // Revalidate the parent identity immediately before commit: abort a .claude swap.
    const dirStat2 = await lstat(dir);
    if (dirStat2.isSymbolicLink() || !dirStat2.isDirectory() || dirStat2.dev !== dirDev || dirStat2.ino !== dirIno) {
      throw new BusError("corrupt", ".claude changed identity during the write (possible symlink swap); aborted.");
    }
    // Revalidate the target identity: detect a concurrent edit landed since the read.
    const targetNow = await lstatOrNull(targetPath);
    if (targetNow?.isSymbolicLink()) {
      throw new BusError("corrupt", `${basename(targetPath)} became a symlink during the write; aborted.`);
    }
    if (!sameIdentity(targetNow ? identityOf(targetNow) : null, expected)) throw new ConcurrentEditError();
    await rename(temp, targetPath);
    renamed = true;
    await syncDirectory(dir);
  } catch (err) {
    if (!renamed) await unlink(temp).catch(() => undefined);
    throw err;
  }
}

function parseSettings(content: string | null): Record<string, unknown> {
  if (content === null || content.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new BusError("corrupt", "Invalid JSON in .claude/settings.local.json", err);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BusError("corrupt", ".claude/settings.local.json is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export async function readProjectSettingsNoFollow(root: string): Promise<Record<string, unknown>> {
  const { content } = await readClaudeFileNoFollow(projectSettingsPath(root));
  return parseSettings(content);
}

// Unconditional set of settings.local.json with parent-swap protection. A concurrent
// writer racing the commit is retried against (bounded) rather than clobbered.
export async function writeProjectSettingsNoFollow(
  root: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify(settings, null, 2) + "\n";
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const targetStat = await lstatOrNull(projectSettingsPath(root));
    if (targetStat?.isSymbolicLink()) {
      throw new BusError("corrupt", "settings.local.json is a symlink; refusing to write through it.");
    }
    const identity = targetStat && targetStat.isFile() ? identityOf(targetStat) : null;
    try {
      await hardenedClaudeWrite(root, projectSettingsPath(root), body, identity);
      return;
    } catch (err) {
      if (err instanceof ConcurrentEditError) continue;
      throw err;
    }
  }
  throw new BusError("conflict", ".claude/settings.local.json is being modified concurrently; retry.");
}

// Read-modify-write of settings.local.json with compare-before-commit: `mutate` returns
// true when it changed the object. Retries against the freshest content when a
// concurrent edit lands between read and commit; returns whether a write happened.
async function updateProjectSettings(root: string, mutate: (settings: Record<string, unknown>) => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const { content, identity } = await readClaudeFileNoFollow(projectSettingsPath(root));
    const settings = parseSettings(content);
    if (!mutate(settings)) return false;
    try {
      await hardenedClaudeWrite(root, projectSettingsPath(root), JSON.stringify(settings, null, 2) + "\n", identity);
      return true;
    } catch (err) {
      if (err instanceof ConcurrentEditError) continue; // re-read and re-apply
      throw err;
    }
  }
  throw new BusError("conflict", ".claude/settings.local.json is being modified concurrently; retry.");
}

// ---------------------------------------------------------------------------
// PostToolUse matcher-group manipulation (mirrors setup-skill's registerHook shape)
// ---------------------------------------------------------------------------

function postToolUseGroups(settings: Record<string, unknown>): unknown[] | null {
  const hooks = settings.hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return null;
  const groups = (hooks as Record<string, unknown>).PostToolUse;
  return Array.isArray(groups) ? groups : null;
}

export function hasBusToolHook(settings: Record<string, unknown>, command: string): boolean {
  const groups = postToolUseGroups(settings);
  if (!groups) return false;
  for (const group of groups) {
    if (typeof group !== "object" || group === null) continue;
    const g = group as MatcherGroup;
    if (!Array.isArray(g.hooks)) continue;
    for (const entry of g.hooks) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as HookEntry;
      if (e.type === "command" && typeof e.command === "string" && e.command.trim() === command) return true;
    }
  }
  return false;
}

// Is this a storybloq-lineage on-tool hook, regardless of the exact bin PATH? Matches
// any command whose executable basename is a known storybloq basename (incl. the
// pre-rename `claudestory`) and whose argument tail is the bus-tool subcommand. Used
// for removal + install normalization so a bin-path change (nvm/fnm switch, rename)
// never leaves a dangling on-tool hook that disable cannot find.
function isBusToolHookCommand(command: string): boolean {
  const parsed = parseHookCommand(command);
  return parsed !== null && STORYBLOQ_LEGACY_BASENAMES.has(parsed.binBasename) && parsed.rest === BUSTOOL_SUBCOMMAND;
}

interface BusToolHookSite {
  readonly matcher: string;
  readonly command: string;
}

// Every storybloq-lineage on-tool hook present (only well-formed `{type:"command"}`
// entries qualify), WITH its matcher, so normalization can tell an already-canonical
// install (exactly one, under the all-tools matcher) from a stale-bin or wrong-matcher
// entry that must be rewritten to actually fire after every tool call.
function collectBusToolHookSites(settings: Record<string, unknown>): BusToolHookSite[] {
  const groups = postToolUseGroups(settings);
  if (!groups) return [];
  const sites: BusToolHookSite[] = [];
  for (const group of groups) {
    if (typeof group !== "object" || group === null) continue;
    const g = group as MatcherGroup;
    if (!Array.isArray(g.hooks)) continue;
    const matcher = typeof g.matcher === "string" ? g.matcher : "";
    for (const entry of g.hooks) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as HookEntry;
      if (e.type === "command" && typeof e.command === "string" && isBusToolHookCommand(e.command.trim())) {
        sites.push({ matcher, command: e.command.trim() });
      }
    }
  }
  return sites;
}

// Add the tool hook under the all-tools matcher group, idempotently. Returns whether
// the settings object was mutated. Refuses to proceed if `hooks`/`hooks.PostToolUse`
// exist but are the wrong shape (never clobbers a user's own structured hooks).
function addBusToolHook(settings: Record<string, unknown>, command: string): boolean {
  if (hasBusToolHook(settings, command)) return false;
  if (!("hooks" in settings)) settings.hooks = {};
  const hooks = settings.hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    throw new BusError("corrupt", ".claude/settings.local.json has an unexpected hooks format");
  }
  const hooksRecord = hooks as Record<string, unknown>;
  if (!("PostToolUse" in hooksRecord)) hooksRecord.PostToolUse = [];
  const groups = hooksRecord.PostToolUse;
  if (!Array.isArray(groups)) {
    throw new BusError("corrupt", ".claude/settings.local.json has an unexpected hooks.PostToolUse format");
  }
  const entry: HookEntry = { type: "command", command };
  for (const group of groups) {
    if (typeof group !== "object" || group === null) continue;
    const g = group as MatcherGroup;
    if ((g.matcher ?? "") === TOOL_HOOK_MATCHER && Array.isArray(g.hooks)) {
      g.hooks.push(entry);
      return true;
    }
  }
  groups.push({ matcher: TOOL_HOOK_MATCHER, hooks: [entry] });
  return true;
}

// Remove every storybloq on-tool hook (matched by subcommand, any bin path) from the
// PostToolUse groups, pruning emptied groups. Returns whether settings was mutated.
function removeBusToolHooks(settings: Record<string, unknown>): boolean {
  const groups = postToolUseGroups(settings);
  if (!groups) return false;
  let changed = false;
  for (const group of groups) {
    if (typeof group !== "object" || group === null) continue;
    const g = group as MatcherGroup;
    if (!Array.isArray(g.hooks)) continue;
    const before = g.hooks.length;
    g.hooks = g.hooks.filter((entry) => {
      if (typeof entry !== "object" || entry === null) return true;
      const e = entry as HookEntry;
      return !(e.type === "command" && typeof e.command === "string" && isBusToolHookCommand(e.command.trim()));
    });
    if (g.hooks.length !== before) changed = true;
  }
  if (changed) {
    // Drop any group we just emptied (leave user groups with other hooks intact).
    const hooksRecord = settings.hooks as Record<string, unknown>;
    hooksRecord.PostToolUse = (hooksRecord.PostToolUse as unknown[]).filter((group) => {
      if (typeof group !== "object" || group === null) return true;
      const g = group as MatcherGroup;
      return !Array.isArray(g.hooks) || g.hooks.length > 0;
    });
  }
  return changed;
}

// True only when the sole storybloq on-tool hook present is ALREADY canonical: exactly
// one lineage entry, under the all-tools matcher, with the command shape. A canonical
// command sitting under a tool-specific matcher (so it would NOT fire after every tool)
// is deliberately NOT canonical and gets rewritten by install.
function isAlreadyCanonical(settings: Record<string, unknown>, command: string): boolean {
  const sites = collectBusToolHookSites(settings);
  return sites.length === 1 &&
    sites[0]!.command === command &&
    sites[0]!.matcher === TOOL_HOOK_MATCHER;
}

// ---------------------------------------------------------------------------
// Git tracked / ignored guards (fail closed on execution failure)
// ---------------------------------------------------------------------------

type GitOutcome =
  | { kind: "exit"; code: number; stdout: string }
  | { kind: "absent" } // git binary not found -> no git here
  | { kind: "unavailable" }; // timeout / signal / spawn failure -> cannot determine

async function runGit(root: string, args: string[]): Promise<GitOutcome> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, timeout: GIT_TIMEOUT_MS });
    return { kind: "exit", code: 0, stdout };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; stdout?: unknown };
    if (typeof e.code === "number") {
      return { kind: "exit", code: e.code, stdout: typeof e.stdout === "string" ? e.stdout : "" };
    }
    if (e.killed || e.signal) return { kind: "unavailable" }; // timed out / killed
    if (e.code === "ENOENT") return { kind: "absent" }; // git not installed
    return { kind: "unavailable" }; // any other spawn failure
  }
}

// Bounded upward walk from `startDir` looking for a `.git` marker (a directory, a
// gitfile, or even a symlink -- any presence counts). A marker is filesystem ground
// truth that we ARE inside a git repo, independent of whether the git binary can run.
async function hasGitMarkerUpward(startDir: string): Promise<boolean> {
  // Walk to the filesystem root (dirname(dir) === dir). The path hierarchy is finite, so
  // no arbitrary depth cap is needed -- and a cap would let a deep checkout, combined with
  // an unavailable/failing git, bypass the fail-closed classification by "proving" no
  // marker exists when the walk simply stopped early.
  let dir = startDir;
  for (;;) {
    if ((await lstatOrNull(join(dir, ".git"))) !== null) return true;
    const parent = dirname(dir);
    if (parent === dir) return false; // reached the filesystem root
    dir = parent;
  }
}

// Decide whether the git tracked/ignored guards must run. git's exit status ALONE cannot
// distinguish "genuinely not a repo" (safe to skip the guards) from "a repo git refuses
// to inspect" (unsafe ownership, a malformed gitfile -- must fail closed): both surface
// as a non-zero exit, and an absent git binary is equally ambiguous. So on any answer
// other than a clean exit 0, a filesystem `.git` marker walk is the tie-breaker: a marker
// means we are in a repo but cannot verify tracking -> fail closed; no marker up to the
// filesystem root means there is genuinely no repo (no tracking/commit risk) -> skip.
// A transient spawn failure (timeout/kill) always fails closed regardless of markers.
async function isGitWorkTree(root: string): Promise<boolean> {
  const r = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (r.kind === "exit" && r.code === 0) return r.stdout.trim() === "true";
  if (r.kind === "unavailable") {
    throw new BusError("io_error", "git could not be run to verify worktree state; refusing to install to avoid a committable hook. Retry, or run `storybloq bus setup --delivery poll`.");
  }
  // git is ABSENT, or exited non-zero (128 = not-a-repo OR unsafe-ownership / fatal).
  if (await hasGitMarkerUpward(root)) {
    throw new BusError(
      "io_error",
      "This looks like a git repository but git could not confirm its state (git is absent, reports unsafe ownership, or failed); refusing to install a possibly-committable on-tool hook. Fix the git environment, or run `storybloq bus setup --delivery poll`.",
    );
  }
  return false;
}

// Exit 0 => tracked; exit 1 => untracked. Anything else (execution failure, unexpected
// status) fails closed -- these run only after isGitWorkTree confirmed a worktree, so a
// failure here is anomalous and must not be read as "untracked".
async function isPathTracked(root: string, relPath: string): Promise<boolean> {
  const r = await runGit(root, ["ls-files", "--error-unmatch", relPath]);
  if (r.kind === "exit" && r.code === 0) return true;
  if (r.kind === "exit" && r.code === 1) return false;
  throw new BusError("io_error", "git ls-files could not determine the tracking state; refusing to install.");
}

// Exit 0 => ignored; exit 1 => NOT ignored. Authoritative in a worktree (understands
// parent rules, wildcards, and last-match-wins negations). Anything else fails closed.
async function isPathIgnored(root: string, relPath: string): Promise<boolean> {
  const r = await runGit(root, ["check-ignore", "-q", relPath]);
  if (r.kind === "exit" && r.code === 0) return true;
  if (r.kind === "exit" && r.code === 1) return false;
  throw new BusError("io_error", "git check-ignore could not determine the ignore state; refusing to install.");
}

// Append the ignore rule to `.claude/.gitignore` (last-match-wins re-ignores a path a
// wildcard negation re-included). Parent-swap protected; retried against a concurrent
// edit. Called only when git reports the path is not yet ignored.
async function appendClaudeGitignoreRule(root: string): Promise<void> {
  const gitignorePath = join(claudeDirPath(root), ".gitignore");
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const { content, identity } = await readClaudeFileNoFollow(gitignorePath);
    let next = content ?? "";
    if (next.length > 0 && !next.endsWith("\n")) next += "\n";
    next += CLAUDE_GITIGNORE_RULE + "\n";
    try {
      await hardenedClaudeWrite(root, gitignorePath, next, identity);
      return;
    } catch (err) {
      if (err instanceof ConcurrentEditError) continue;
      throw err;
    }
  }
  throw new BusError("conflict", ".claude/.gitignore is being modified concurrently; retry.");
}

// Prove settings.local.json stays git-ignored, using git check-ignore as the sole
// authority in a worktree. Appends the rule when git reports the path is not ignored,
// then RE-REQUIRES git to confirm -- so a negation that still re-includes the path (a
// later `!**`) fails closed rather than being papered over by a naive literal parser.
async function ensureSettingsGitIgnored(root: string, relSettings: string): Promise<void> {
  if (await isPathIgnored(root, relSettings)) return;
  await appendClaudeGitignoreRule(root);
  if (!(await isPathIgnored(root, relSettings))) {
    throw new BusError(
      "io_error",
      ".claude/settings.local.json is not git-ignored (a parent rule or a negation re-includes it after `.claude/.gitignore`); refusing to write a committable on-tool hook. Fix your gitignore rules, then retry.",
    );
  }
}

// ---------------------------------------------------------------------------
// Install / remove the on-tool hook
// ---------------------------------------------------------------------------

export interface ProjectHookResult {
  readonly changed: boolean;
  readonly command: string;
}

export async function installProjectBusToolHook(root: string, binPath: string): Promise<ProjectHookResult> {
  const command = busToolHookCommand(binPath);
  const relSettings = join(".claude", SETTINGS_LOCAL_BASENAME);

  if (await isGitWorkTree(root)) {
    if (await isPathTracked(root, relSettings)) {
      throw new BusError(
        "conflict",
        ".claude/settings.local.json is tracked by git; the on-tool Bus hook must stay local. Untrack it (git rm --cached .claude/settings.local.json) and retry, or run `storybloq bus setup --delivery poll`.",
      );
    }
    await ensureSettingsGitIgnored(root, relSettings);
  }

  // Normalize to EXACTLY the canonical hook (single entry, all-tools matcher). A no-op
  // only when the sole on-tool hook is already canonical; otherwise strip any stale-bin
  // or wrong-matcher entries and add the canonical command under the all-tools matcher.
  const changed = await updateProjectSettings(root, (settings) => {
    if (isAlreadyCanonical(settings, command)) return false;
    removeBusToolHooks(settings);
    addBusToolHook(settings, command);
    return true;
  });
  return { changed, command };
}

// Remove the on-tool hook regardless of the bin path it was installed with (matched by
// subcommand). No binPath needed: disable must clear a hook even after an nvm/fnm Node
// switch changed the resolved bin.
export async function removeProjectBusToolHook(root: string): Promise<{ changed: boolean }> {
  const changed = await updateProjectSettings(root, (settings) => removeBusToolHooks(settings));
  return { changed };
}

export const __testing = {
  addBusToolHook,
  removeBusToolHooks,
  isBusToolHookCommand,
  isAlreadyCanonical,
  collectBusToolHookSites,
  setAfterTempWriteHook: (fn: (() => Promise<void>) | null) => { afterTempWriteHook = fn; },
  setAfterTempOpenHook: (fn: (() => Promise<void>) | null) => { afterTempOpenHook = fn; },
};
