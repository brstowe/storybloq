/**
 * ISS-1211: one repo, one boundary series.
 *
 * `.story/` is local, gitignored state, so every linked git worktree carries a
 * second `.story/` beside the main checkout's. A compaction boundary seen
 * while a session's cwd was a worktree therefore landed in that worktree's
 * ledger, and the main checkout reported zero compactions for a session that
 * demonstrably compacted.
 *
 * Routing fixes that in one direction each way: every WRITE goes to the main
 * worktree's `.story/`, and every READ takes the union of the main checkout
 * and its worktrees, so a boundary is recorded once per repo while entries
 * already stranded in a worktree are still counted.
 *
 * Two rules keep it honest on the prompt hook's path, whose whole budget is
 * roughly 500 ms:
 *
 *   - ONLY A RESOLVED ROUTING IS MEMOIZED. Git failing, timing out, or naming
 *     a main checkout this module refuses leaves the caller on its own root
 *     and caches NOTHING, so a repo that gains `.story/` (or a git that starts
 *     working) is picked up on the next call rather than for the life of the
 *     process. The spawn is still bounded, because `discoverWorktreeRoots`
 *     memoizes the worktree list under a short TTL in both directions. A
 *     RESOLVED routing outlives that TTL: it is kept for the life of the
 *     process, so a long-lived server learns about a worktree added later
 *     only on the write side (every hook resolves fresh) or after a restart.
 *   - THE ROUTED ROOT IS REVALIDATED AT THE WRITE. Discovery proves a root
 *     was safe when git named it, not that it still is.
 *
 * A main checkout this module refuses stops the ROUTING, never the reads: the
 * siblings are still walked so entries stranded in another worktree stay
 * countable while main has no `.story/` of its own.
 */

import {
  discoverWorktreeRoots,
  isSafeCandidateRoot,
  resetWorktreeDiscoveryCache,
  revalidateCandidateIdentity,
  sameIdentity,
  trustedRootIdentity,
  type CandidateIdentity,
  type SafeRootOptions,
  type WorktreeWalkOptions,
} from "./presence-bridge.js";

/** `.story/telemetry/<this>`: the boundary ledger's directory. */
export const LEDGER_SUBDIR = "session-intel";

/** Same cap the presence walk uses; applied to `git worktree list` itself. */
const LEDGER_WORKTREE_LIMIT = 32;

/**
 * The ledger WRITES, so unlike the presence walk it refuses a checkout that
 * has no `.story/` yet: a main checkout that is not a storybloq project is
 * left alone rather than seeded.
 */
const LEDGER_ROOT: SafeRootOptions = { subdir: LEDGER_SUBDIR, requireStory: true };

interface LedgerRouting {
  /** The checkout that owns the shared series. `root` itself for a plain checkout. */
  readonly mainRoot: string;
  /** Identity of `mainRoot` at discovery, or null when it IS `root` (nothing to revalidate). */
  readonly mainIdentity: CandidateIdentity | null;
  /** Every OTHER safe checkout of the same repo: `mainRoot` and `root` excluded. */
  readonly linkedRoots: readonly string[];
}

export interface LedgerWriteTarget {
  readonly root: string;
  /** Null when the target is the caller's own root: nothing to revalidate. */
  readonly identity: CandidateIdentity | null;
}

const routingCache = new Map<string, LedgerRouting>();

/**
 * Forgets the routing AND the underlying worktree discovery. Tests call it
 * between fixtures; nothing in production does, because a resolved routing is
 * a property of the repository layout and a degraded one is never cached.
 */
export function resetLedgerRoutingCache(): void {
  routingCache.clear();
  resetWorktreeDiscoveryCache();
}

function localRouting(root: string, linkedRoots: readonly string[] = []): LedgerRouting {
  return { mainRoot: root, mainIdentity: null, linkedRoots };
}

/**
 * Every checkout from `startIndex` on that is safe to read and is not the
 * caller itself. `roots[0]` is the main worktree and is always handled by the
 * caller of this helper, so `startIndex` is 1 in both paths: when main is
 * usable it becomes `mainRoot`, and when it is not it has nothing readable
 * under it anyway.
 */
function safeSiblings(roots: readonly string[], self: CandidateIdentity | null, startIndex = 1): string[] {
  const out: string[] = [];
  for (let i = startIndex; i < roots.length; i++) {
    const candidate = isSafeCandidateRoot(roots[i]!, LEDGER_ROOT);
    if (!candidate.ok) continue;
    if (sameIdentity(candidate.identity, self)) continue;
    out.push(roots[i]!);
  }
  return out;
}

/**
 * `resolved` is false for every degraded outcome (no git, not a repository,
 * an expired deadline, or a main checkout that fails the safety rules), and
 * only a `resolved` routing is allowed into the memo.
 */
function resolveRouting(root: string, opts: WorktreeWalkOptions): { routing: LedgerRouting; resolved: boolean } {
  const self = trustedRootIdentity(root);
  // git-worktree(1): "The main worktree is listed first, followed by each of
  // the linked worktrees." `[]` covers an absent git, a non-repository, a
  // spent deadline, and a timeout, and is the signal to stay entirely local.
  const roots = discoverWorktreeRoots(root, { ...opts, limit: LEDGER_WORKTREE_LIMIT });
  if (roots.length === 0) return { routing: localRouting(root), resolved: false };
  // roots[0] is the main worktree and is validated exactly once, here.
  const main = isSafeCandidateRoot(roots[0]!, LEDGER_ROOT);
  const linkedRoots = safeSiblings(roots, self);
  // A main checkout this module refuses is a reason not to ROUTE, never a
  // reason to stop reading the siblings: entries stranded in another worktree
  // stay countable while main has no `.story/` yet. Unmemoized either way, so
  // the next call re-resolves once main becomes usable.
  if (!main.ok) return { routing: localRouting(root, linkedRoots), resolved: false };
  // Self is excluded by dev/ino, never by string: the caller keeps its own
  // spelling of its own checkout even when git names the same directory by
  // its realpath.
  const routing = sameIdentity(main.identity, self)
    ? { mainRoot: root, mainIdentity: null, linkedRoots }
    : { mainRoot: roots[0]!, mainIdentity: main.identity, linkedRoots };
  return { routing, resolved: true };
}

function ledgerRouting(root: string, opts: WorktreeWalkOptions = {}): LedgerRouting {
  const cached = routingCache.get(root);
  if (cached) return cached;
  const { routing, resolved } = resolveRouting(root, opts);
  if (resolved) routingCache.set(root, routing);
  return routing;
}

/** The checkout a boundary is WRITTEN to: one repo, one series. */
export function boundaryLedgerRoot(root: string, opts: WorktreeWalkOptions = {}): string {
  return ledgerRouting(root, opts).mainRoot;
}

/** The write target with the identity the write must revalidate it against. */
export function boundaryLedgerWriteTarget(root: string, opts: WorktreeWalkOptions = {}): LedgerWriteTarget {
  const routing = ledgerRouting(root, opts);
  return { root: routing.mainRoot, identity: routing.mainIdentity };
}

/**
 * Re-checks a routed target immediately before the write. A mismatch means the
 * path git named has been replaced since discovery, so the routing is dropped
 * (the next call re-resolves) and the caller writes to its own checkout, where
 * the merged read still finds the entry.
 */
export function ledgerWriteTargetStillValid(callerRoot: string, target: LedgerWriteTarget): boolean {
  if (target.identity === null) return true;
  if (revalidateCandidateIdentity(target.root, target.identity, LEDGER_ROOT)) return true;
  routingCache.delete(callerRoot);
  return false;
}

/**
 * Every checkout a boundary may be READ from, shared series first and the
 * caller's own checkout always included, so entries stranded by the old cwd
 * routing stay visible from both sides.
 */
export function boundaryLedgerReadRoots(root: string, opts: WorktreeWalkOptions = {}): string[] {
  const { mainRoot, linkedRoots } = ledgerRouting(root, opts);
  return mainRoot === root ? [root, ...linkedRoots] : [mainRoot, root, ...linkedRoots];
}
