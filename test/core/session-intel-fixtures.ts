/** T-499 test fixtures: inline JSONL record builders shaped like real Claude Code transcripts. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git as fixtureGit } from "../helpers/git-fixture.js";

/** ISS-1185: a real two-root git fixture -- a main checkout plus a second worktree. */
export function git(cwd: string, args: string[]): string {
  return fixtureGit(cwd, args);
}

export interface WorktreePair {
  readonly base: string;
  readonly main: string;
  readonly worktree: string;
  readonly cleanup: () => void;
}

/**
 * A real git repository at `<base>/main` with one commit, plus a second real
 * worktree at `<base>/wt` (`git worktree add`). Mirrors the field bug
 * exactly: one git history, two independent `.story` directories, since
 * `.story` is local/gitignored state that each worktree must initialize on
 * its own.
 */
export function makeWorktreePair(prefix: string): WorktreePair {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const main = join(base, "main");
  mkdirSync(main, { recursive: true });
  git(main, ["init", "-q", "--object-format=sha1"]);
  git(main, ["config", "user.email", "test@example.com"]);
  git(main, ["config", "user.name", "Test"]);
  writeFileSync(join(main, "f.txt"), "x\n");
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "init"]);
  const worktree = join(base, "wt");
  git(main, ["worktree", "add", "-q", "-b", "wt-branch", worktree]);
  return { base, main, worktree, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export interface WorktreeTriple {
  readonly base: string;
  readonly main: string;
  /** Linked worktrees in the order `git worktree list` reports them. */
  readonly linked: readonly [string, string];
  readonly cleanup: () => void;
}

/**
 * The pair plus a second linked worktree, each with its own `.story`. Two
 * linked worktrees is the smallest fixture that can tell "the caller's own
 * checkout" apart from "every other checkout": with one, dropping the sibling
 * list and dropping self from the read set look identical.
 */
export function makeWorktreeTriple(prefix: string): WorktreeTriple {
  const pair = makeWorktreePair(prefix);
  const second = join(pair.base, "wt-two");
  git(pair.main, ["worktree", "add", "-q", "-b", "wt-branch-two", second]);
  for (const root of [pair.main, pair.worktree, second]) bareStoryInit(root);
  return { base: pair.base, main: pair.main, linked: [pair.worktree, second], cleanup: pair.cleanup };
}

/** Bare `.story` init (no full initProject): enough for readPresenceRecord/discovery tests. */
export function bareStoryInit(root: string): void {
  mkdirSync(join(root, ".story"), { recursive: true });
}

export { symlinkSync };

export const SID = "4d99abbf-5dcb-4be3-90d3-2b13e0f50b29";

export interface AssistantOpts {
  sessionId?: string;
  ts: string;
  model?: string;
  input?: number;
  creation?: number;
  read?: number;
  sidechain?: boolean;
  isMeta?: boolean;
  noUsage?: boolean;
  version?: string;
  gitBranch?: string;
  effort?: string;
  cwd?: string;
}

export function assistantRecord(o: AssistantOpts): string {
  const usage = o.noUsage ? undefined : { input_tokens: o.input ?? 2, cache_creation_input_tokens: o.creation ?? 0, cache_read_input_tokens: o.read ?? 0, output_tokens: 10 };
  return JSON.stringify({
    parentUuid: "p",
    isSidechain: o.sidechain ?? false,
    isMeta: o.isMeta,
    type: "assistant",
    message: { model: o.model ?? "claude-opus-5", role: "assistant", content: [{ type: "text", text: "ok" }], usage },
    uuid: "u",
    timestamp: o.ts,
    sessionId: o.sessionId ?? SID,
    version: o.version ?? "2.1.266",
    entrypoint: "cli",
    cwd: o.cwd ?? "/Users/x/proj",
    gitBranch: o.gitBranch ?? "main",
    effort: o.effort ?? "high",
  });
}

/** Total context for an assistant record built from the same numbers. */
export function contextOf(o: { input?: number; creation?: number; read?: number }): number {
  return (o.input ?? 2) + (o.creation ?? 0) + (o.read ?? 0);
}

export function userRecord(o: { ts: string; sessionId?: string; text?: string; isMeta?: boolean; sidechain?: boolean }): string {
  return JSON.stringify({
    parentUuid: "p",
    isSidechain: o.sidechain ?? false,
    isMeta: o.isMeta,
    type: "user",
    message: { role: "user", content: o.text ?? "hello" },
    uuid: "u",
    timestamp: o.ts,
    sessionId: o.sessionId ?? SID,
    version: "2.1.266",
    entrypoint: "cli",
    cwd: "/Users/x/proj",
    gitBranch: "main",
  });
}

export function boundaryRecord(o: { ts: string; trigger?: "auto" | "manual"; pre: number; post?: number; sessionId?: string }): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    level: "info",
    compactMetadata: { trigger: o.trigger ?? "auto", preTokens: o.pre, postTokens: o.post ?? 30_000 },
    uuid: "u",
    timestamp: o.ts,
    sessionId: o.sessionId ?? SID,
    version: "2.1.266",
    entrypoint: "cli",
    cwd: "/Users/x/proj",
  });
}

/** The two observed forms of the model-change line: backtick and ANSI-bold. */
export function localCommandRecord(o: { ts: string; form: "backtick" | "ansi"; oneMillion: boolean; model?: string; sessionId?: string }): string {
  const name = `${o.model ?? "Opus 5"}${o.oneMillion ? " (1M context)" : ""}`;
  const wrapped = o.form === "backtick" ? `\`${name}\`` : `\x1b[1m${name}\x1b[22m`;
  return JSON.stringify({
    parentUuid: "p",
    isSidechain: false,
    type: "user",
    message: { role: "user", content: `<local-command-stdout>Set model to ${wrapped} and saved as your default for new sessions</local-command-stdout>` },
    uuid: "u",
    timestamp: o.ts,
    sessionId: o.sessionId ?? SID,
    cwd: "/Users/x/proj",
  });
}

export function metaRecord(o: { type: "permission-mode" | "ai-title" | "slug" | "bridge-session"; value: string; sessionId?: string | null }): string {
  const field = o.type === "permission-mode" ? "permissionMode" : o.type === "ai-title" ? "aiTitle" : o.type === "slug" ? "slug" : "bridgeSessionId";
  const rec: Record<string, unknown> = { type: o.type, [field]: o.value };
  if (o.sessionId !== null) rec.sessionId = o.sessionId ?? SID;
  return JSON.stringify(rec);
}

/** Writes a transcript into a fake `~/.claude/projects/<encoded>/` tree and returns its path. */
export function writeTranscript(projectsDir: string, encodedDir: string, sessionId: string, lines: readonly string[], trailingNewline = true): string {
  const dir = join(projectsDir, encodedDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, lines.join("\n") + (trailingNewline ? "\n" : ""));
  return path;
}

/** A plausible growing session: n assistant turns growing by `step`, starting at `start`. */
export function growingSession(n: number, start: number, step: number, startMs = Date.parse("2026-09-09T12:00:00Z")): string[] {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(startMs + i * 60_000).toISOString();
    lines.push(userRecord({ ts }));
    lines.push(assistantRecord({ ts: new Date(startMs + i * 60_000 + 1000).toISOString(), read: start + i * step }));
  }
  return lines;
}
