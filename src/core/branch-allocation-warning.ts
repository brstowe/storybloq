import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectState } from "./project-state.js";
import {
  atomicWriteInDir,
  directoryIdentity,
  ensureTelemetrySubdir,
  removeRegularFile,
} from "../presence/io.js";

export type ReservableType = "ticket" | "issue" | "note" | "lesson";

const GIT_TIMEOUT_MS = 500;
const ID_WARNINGS_SUBDIR = "id-warnings";
const RATE_LIMIT_MS = 24 * 60 * 60 * 1000;
// ISS-1190 pen ruling: this marker directory has no cadence of its own to
// piggyback on session-intel's sweeps (presence/pending), so it sweeps
// itself, opportunistically, on every call -- bounded to one readdir plus
// one lstat per existing marker, never unbounded growth.
const MARKER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
}

/**
 * PITFALL (ISS-1190): a missing git binary, or any other reason the command
 * cannot run or fails, must mean "cannot determine", never a thrown error --
 * the caller decides what that means (usually: no warning).
 */
function runGit(root: string, args: readonly string[]): GitResult {
  try {
    const stdout = execFileSync("git", ["-C", root, ...args], {
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * `git rev-parse --is-inside-work-tree` is the gate for everything below:
 * `.story/` does not require its project to BE a git repository, and outside
 * one, `symbolic-ref -q --short HEAD` fails with the exact same non-zero
 * exit a real detached HEAD produces -- indistinguishable by exit code
 * alone. Without this gate, every create in a non-git project would read as
 * "detached HEAD" and warn on every single call. Checked once, up front,
 * bundling "git is missing" and "not a repository" into the same "cannot
 * determine" outcome, since both mean the same thing here: no warning.
 */
function isInsideGitRepo(root: string): boolean {
  const result = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout === "true";
}

interface BranchState {
  readonly branchName: string | null;
  readonly detached: boolean;
}

/** Only meaningful once `isInsideGitRepo` has confirmed a real repository. */
function resolveCurrentBranch(root: string): BranchState {
  const result = runGit(root, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (!result.ok) return { branchName: null, detached: true };
  const name = result.stdout.length > 0 ? result.stdout : null;
  return { branchName: name, detached: name === null };
}

/**
 * Default branch = the remote's symbolic HEAD target (`origin/HEAD ->
 * origin/main`), falling back to `init.defaultBranch`. Null when neither is
 * configured -- "cannot decide" always means no warning, never a guess.
 */
function resolveDefaultBranch(root: string, remote: string): string | null {
  const symbolic = runGit(root, ["symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`]);
  if (symbolic.ok && symbolic.stdout.length > 0) {
    const prefix = `${remote}/`;
    return symbolic.stdout.startsWith(prefix) ? symbolic.stdout.slice(prefix.length) : symbolic.stdout;
  }
  const configured = runGit(root, ["config", "init.defaultBranch"]);
  return configured.ok && configured.stdout.length > 0 ? configured.stdout : null;
}

function markerKey(branchName: string): string {
  return createHash("sha256").update(branchName).digest("hex").slice(0, 32);
}

/** Best-effort removal of markers untouched for longer than MARKER_EXPIRY_MS. */
function sweepStaleMarkers(dir: string, now: number): void {
  const identity = directoryIdentity(dir);
  if (identity === null) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    try {
      const st = lstatSync(path);
      if (now - st.mtimeMs > MARKER_EXPIRY_MS) removeRegularFile(dir, path, identity);
    } catch {
      // Vanished between readdir and lstat; nothing to do.
    }
  }
}

/**
 * ISS-1190 SCOPE item 2: `reconcile` (when it finds a collision) and `team
 * doctor` print this exact same one-line remedy -- the shared constant is
 * what keeps the three call sites from drifting apart.
 */
export const ENABLE_GIT_REFS_REMEDY =
  "Enable git-refs allocation: storybloq team init && storybloq team config set idAllocator git-refs";

function warningText(displayId: string, branchName: string): string {
  return `display id ${displayId} minted locally on branch ${branchName}; another branch can mint the same id. ${ENABLE_GIT_REFS_REMEDY}`;
}

/**
 * Warns once per branch per 24h when `type`'s id was minted by the LOCAL
 * allocator on a non-default branch or detached HEAD. The create handlers
 * only consult `idAllocator` when `team.enabled === true` (see ticket.ts,
 * issue.ts, note.ts, lesson.ts); with `team.enabled` false or absent, every
 * create mints locally regardless of a stale `idAllocator` value left over
 * in config, so this check must gate on the same pair the create handlers
 * do, not on `idAllocator` alone (else disabling team mode while retaining
 * a "git-refs" `idAllocator` silently suppressed a real local-mint warning).
 * Never warns when the default branch cannot be determined, on the default
 * branch itself, within the 24h rate-limit window for that branch, or when
 * git is unavailable or root is not a git repository.
 */
export function checkBranchAllocationWarning(
  root: string,
  _type: ReservableType,
  state: ProjectState,
  displayId: string,
): string | null {
  const usesGitRefs = state.config.team?.enabled === true && state.config.team?.idAllocator === "git-refs";
  if (usesGitRefs) return null;
  if (!isInsideGitRepo(root)) return null;

  const { branchName, detached } = resolveCurrentBranch(root);

  const remote = state.config.team?.idAllocatorRemote ?? "origin";
  const defaultBranch = resolveDefaultBranch(root, remote);
  if (defaultBranch === null) return null;

  const onDefaultBranch = !detached && branchName === defaultBranch;
  if (onDefaultBranch) return null;

  const branchLabel = branchName ?? "HEAD";
  const dir = ensureTelemetrySubdir(root, ID_WARNINGS_SUBDIR);
  if (dir === null) {
    // No writable marker directory -- warn every time rather than staying
    // silent forever because a rate limit we cannot record.
    return warningText(displayId, branchLabel);
  }

  const now = Date.now();
  sweepStaleMarkers(dir, now);

  const markerPath = join(dir, `${markerKey(branchLabel)}.marker`);
  let withinWindow = false;
  try {
    const st = lstatSync(markerPath);
    withinWindow = now - st.mtimeMs <= RATE_LIMIT_MS;
  } catch {
    withinWindow = false;
  }
  if (withinWindow) return null;

  atomicWriteInDir(dir, markerPath, String(now));
  return warningText(displayId, branchLabel);
}
