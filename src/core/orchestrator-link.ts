import { resolveNodePath } from "../federation/resolver.js";
import { loadProject, withProjectLock, writeConfigUnlocked } from "./project-loader.js";
import type { Config } from "../models/config.js";

/**
 * T-520: writing the UPWARD pointer -- a node's record of which orchestrator
 * it belongs to.
 *
 * `config.orchestrator` has existed in the schema since federation shipped and
 * was written by nothing and read by nothing. Making it live is what makes
 * upward citation resolution reachable at all: without it a node cannot know
 * there is another board, because root discovery is registry-based (the
 * orchestrator lists its nodes) and never walks the filesystem upward.
 *
 * WHO may call this is the design decision, not how it writes. A node is a
 * SEPARATE GIT CHECKOUT, so the orchestrator writing into it would put an
 * uncommitted change in someone else's working tree that they did not make and
 * cannot explain. So:
 *
 *   - `storybloq node link`, run FROM the node by whoever owns that checkout,
 *     is the ordinary path and the backfill for every federation that predates
 *     this feature.
 *   - `storybloq_node_init` may also call it, because creating the node's
 *     `.story/` from the orchestrator is that tool's entire documented job --
 *     the tree is already being written by design, and a field in a config it
 *     is itself creating surprises nobody.
 *   - `node add` does NEITHER. It prints the command instead.
 */
export type OrchestratorLinkResult =
  | { readonly ok: true; readonly orchestratorRoot: string; readonly unchanged: boolean }
  | { readonly ok: false; readonly reason: string };

export async function writeOrchestratorPointer(
  nodeRoot: string,
  orchestratorPath: string,
): Promise<OrchestratorLinkResult> {
  // The same resolution the reader will perform, run here so a pointer that
  // could never be followed is refused at the moment it is written rather than
  // surfacing later as a warning on every validate.
  const resolved = resolveNodePath(orchestratorPath, nodeRoot);
  if (!resolved.resolved) {
    return { ok: false, reason: `cannot use ${orchestratorPath} as an orchestrator: ${resolved.reason}` };
  }
  // No second self-reference check here: `resolveNodePath` already refuses it,
  // by comparing REALPATHS, which is strictly stronger than anything this
  // function could add with `resolve()` alone. A weaker duplicate of a
  // stronger check is a liability, not a belt.
  const orchestratorRoot = resolved.absolutePath;

  let outcome: OrchestratorLinkResult = { ok: false, reason: "write did not complete" };
  // The node's OWN lock, on the node's OWN config. Note the contrast with the
  // read path, which never locks the other board: this writes the project it
  // is being run in, which is ordinary, and reads a board it does not own,
  // which must never take a lock there.
  await withProjectLock(nodeRoot, { strict: false }, async () => {
    const { state } = await loadProject(nodeRoot);
    const current = (state.config as unknown as Record<string, unknown>).orchestrator;
    if (current === orchestratorRoot) {
      outcome = { ok: true, orchestratorRoot, unchanged: true };
      return;
    }
    await writeConfigUnlocked(
      { ...state.config, orchestrator: orchestratorRoot } as Config,
      nodeRoot,
    );
    outcome = { ok: true, orchestratorRoot, unchanged: false };
  });
  return outcome;
}
