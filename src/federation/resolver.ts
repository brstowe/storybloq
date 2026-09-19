import { realpathSync, accessSync, existsSync, constants, readFileSync } from "node:fs";
import { join, normalize, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { PathSafetySchema } from "../models/federation-config.js";

export type ResolvedNode =
  | { resolved: true; absolutePath: string; storyDir: string; rawPath: string }
  | { resolved: false; reason: string; rawPath: string; absolutePath?: string };

function expandTilde(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

/**
 * T-520: the UPWARD pointer -- a node's record of the orchestrator it belongs
 * to, read from the node's OWN `.story/config.json`.
 *
 * The mirror image of `resolveNodePath`, and deliberately built on it rather
 * than beside it: the forward pointer (orchestrator -> node) and this one
 * (node -> orchestrator) are the same claim about the same pair of checkouts,
 * so they get the same tilde expansion, the same realpath, the same
 * self-reference refusal, the same readability check and the same "is there a
 * board there at all" test. A second copy of that discipline is a second
 * answer waiting to disagree with the first.
 *
 * The two failures are kept APART because they mean opposite things to a
 * caller. `no-pointer` is the ordinary state of every project in existence
 * before this feature (the field was declared but never written), and it must
 * change nothing. `unreadable` is a recorded pointer we could not follow,
 * which is a fact about a federation the reader is entitled to be warned
 * about -- and, per the pen's ruling, one that taints local conclusions.
 *
 * Never throws: it is called from citation resolution, which classifies and
 * does not propagate.
 */
export type OrchestratorRootResult =
  | { readonly ok: true; readonly root: string }
  | {
      readonly ok: false;
      readonly code: "no-pointer" | "unreadable";
      readonly reason: string;
      /** The path as RECORDED, for a message that can say what was tried. */
      readonly attempted?: string;
    };

export function resolveOrchestratorRoot(nodeRoot: string): OrchestratorRootResult {
  let pointer: unknown;
  try {
    const config = JSON.parse(
      readFileSync(join(nodeRoot, ".story", "config.json"), "utf-8"),
    ) as Record<string, unknown>;
    pointer = config.orchestrator;
  } catch (err: unknown) {
    // NO config at all is "not a project here", which is genuinely not a
    // federation fact: it is what a directory that was never initialised looks
    // like, and it must change nothing.
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return { ok: false, code: "no-pointer", reason: "no project config" };
    }
    // A config that EXISTS and could not be read or parsed is a different
    // thing, and reading it as "no orchestrator" would be a confident claim
    // built on a failed read -- the exact move the citation resolver refuses
    // everywhere else. We cannot know whether a pointer is in there, so the
    // honest answer is that the federation context is unverifiable, which
    // taints rather than silently dropping the other board.
    return {
      ok: false,
      code: "unreadable",
      reason: `node config could not be read (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (typeof pointer !== "string" || pointer.trim() === "") {
    return { ok: false, code: "no-pointer", reason: "no orchestrator recorded" };
  }
  // Same pre-check the forward pointer runs before touching the filesystem.
  const safety = PathSafetySchema.safeParse(pointer);
  if (!safety.success) {
    return { ok: false, code: "unreadable", reason: safety.error.issues[0]?.message ?? "invalid path", attempted: pointer };
  }
  const resolved = resolveNodePath(pointer, nodeRoot);
  if (!resolved.resolved) {
    return { ok: false, code: "unreadable", reason: resolved.reason, attempted: pointer };
  }
  return { ok: true, root: resolved.absolutePath };
}

export function resolveNodePath(rawPath: string, orchestratorRoot: string, preResolvedOrchRoot?: string): ResolvedNode {
  const expanded = expandTilde(rawPath);
  const expandedOrch = expandTilde(orchestratorRoot);
  const candidate = isAbsolute(expanded) ? expanded : resolve(expandedOrch, expanded);

  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" ? "path does not exist"
      : code === "EACCES" ? "permission denied"
      : `filesystem error: ${code ?? "unknown"}`;
    return { resolved: false, reason, rawPath };
  }

  let orchResolved: string;
  if (preResolvedOrchRoot) {
    orchResolved = preResolvedOrchRoot;
  } else {
    try {
      orchResolved = realpathSync(expandedOrch);
    } catch {
      orchResolved = normalize(expandedOrch);
    }
  }

  if (resolved === orchResolved) {
    return { resolved: false, reason: "self-reference", rawPath };
  }

  try {
    accessSync(resolved, constants.R_OK);
  } catch {
    return { resolved: false, reason: "permission denied", rawPath };
  }

  const storyDir = join(resolved, ".story");
  if (!existsSync(join(storyDir, "config.json"))) {
    return { resolved: false, reason: "no .story/config.json found", rawPath, absolutePath: resolved };
  }

  return { resolved: true, absolutePath: resolved, storyDir, rawPath };
}

export function resolveAllNodes(
  nodes: Record<string, { path: string }>,
  orchestratorRoot: string,
): Map<string, ResolvedNode> {
  const expandedOrch = expandTilde(orchestratorRoot);
  let orchResolved: string;
  try {
    orchResolved = realpathSync(expandedOrch);
  } catch {
    orchResolved = normalize(expandedOrch);
  }

  const results = new Map<string, ResolvedNode>();
  for (const [name, node] of Object.entries(nodes)) {
    results.set(name, resolveNodePath(node.path, orchestratorRoot, orchResolved));
  }
  return results;
}
