import { displayIdOf } from "../core/resolver.js";
/**
 * Branch affinity detection for PICK_TICKET stage.
 * Pure functions (detection/annotation), plus async branch creation helpers for Part 2.
 */

import type { GitResult } from "./session-types.js";
import { gitHead, gitStatus, gitBlobHash, gitCheckoutNewBranch, gitBranchExists, gitCheckoutBranch, gitCheckRefFormat } from "./git-inspector.js";

// --- Types ---

export interface BranchAffinity {
  status: "none" | "matched" | "ambiguous";
  matchedIds: string[];
  branch: string | null;
}

export interface AffinityAnnotation {
  warningText: string | null;
}

// --- Constants ---

const PROTECTED_BRANCHES = new Set([
  "main", "master", "develop", "dev", "staging", "production",
]);

const ENTITY_ID_REGEX = /(?:^|[/_-])(T-\d+[a-z]?|ISS-\d+)(?=$|[/_-])/gi;

// --- Functions ---

export function detectBranchAffinity(branch: string | null): BranchAffinity {
  if (!branch) {
    return { status: "none", matchedIds: [], branch };
  }

  const baseName = branch.includes("/") ? branch.split("/").pop()! : branch;
  if (PROTECTED_BRANCHES.has(baseName) || PROTECTED_BRANCHES.has(branch)) {
    return { status: "none", matchedIds: [], branch };
  }

  const matches: string[] = [];
  let match: RegExpExecArray | null;
  ENTITY_ID_REGEX.lastIndex = 0;
  while ((match = ENTITY_ID_REGEX.exec(branch)) !== null) {
    const raw = match[1]!;
    // Normalize prefix to uppercase (T-, ISS-) but preserve digit+suffix casing
    const id = raw.replace(/^(t-|iss-)/i, (p) => p.toUpperCase());
    if (!matches.some(m => m.toUpperCase() === id.toUpperCase())) {
      matches.push(id);
    }
  }

  if (matches.length === 0) {
    return { status: "none", matchedIds: [], branch };
  }
  if (matches.length === 1) {
    return { status: "matched", matchedIds: matches, branch };
  }
  return { status: "ambiguous", matchedIds: matches, branch };
}

export function checkAffinityMismatch(
  affinity: BranchAffinity,
  pickedId: string,
): { blocked: boolean; reason: string } {
  if (affinity.status !== "matched") {
    return { blocked: false, reason: "" };
  }
  const normalized = pickedId.toUpperCase();
  if (affinity.matchedIds.some(id => id.toUpperCase() === normalized)) {
    return { blocked: false, reason: "" };
  }
  return {
    blocked: true,
    reason: `Branch "${affinity.branch}" is scoped to ${affinity.matchedIds.join(", ")}. Picking ${pickedId} would contaminate this branch.`,
  };
}

export function buildAffinityAnnotation(affinity: BranchAffinity): AffinityAnnotation {
  switch (affinity.status) {
    case "matched":
      return {
        warningText: `**[Branch affinity]** This branch is for ${affinity.matchedIds.join(", ")}. Pick that unless you have a specific reason not to.`,
      };
    case "ambiguous":
      return {
        warningText: `**[Branch warning]** Multiple IDs detected in branch name (${affinity.matchedIds.join(", ")}). Pick carefully or use targeted mode.`,
      };
    case "none":
    default:
      return { warningText: null };
  }
}

export function buildMismatchHandoverInstruction(
  affinity: BranchAffinity,
  attemptedPick: string,
  sessionId: string,
): string {
  return [
    "# Branch Mismatch -- Session Ending",
    "",
    `You attempted to pick **${attemptedPick}** but this branch (\`${affinity.branch}\`) is scoped to **${affinity.matchedIds.join(", ")}**.`,
    "Picking a different ticket would contaminate this branch's history.",
    "",
    "Write a handover documenting this mismatch and end the session.",
    "",
    "**To work on other tickets after this session ends:**",
    "- Switch to `main` and run `/story auto` from there",
    `- Use targeted mode: \`/story auto ${attemptedPick}\` (skips the branch check)`,
    '- Set `branchStrategy: "per-ticket"` in config (auto-creates branches per ticket)',
    "",
    "Call `storybloq_autonomous_guide` with:",
    "```json",
    `{ "sessionId": "${sessionId}", "action": "report", "report": { "completedAction": "handover_written", "handoverContent": "Session ended due to branch mismatch: branch ${affinity.branch} is for ${affinity.matchedIds.join(", ")}, attempted to pick ${attemptedPick}." } }`,
    "```",
  ].join("\n");
}

// --- Part 2: Per-ticket branch creation ---

export function buildTicketBranchName(id: string, title: string, prefix: "story" | "fix" = "story"): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/g, "");
  return `${prefix}/${id}-${slug}`;
}

export interface BranchCreationResult {
  branchName: string;
  created: boolean;
}

export async function createTicketBranch(
  root: string,
  gitState: { branch: string | null; mergeBase: string | null; initHead?: string },
  ticket: { id: string; displayId?: string; title: string },
  prefix: "story" | "fix" = "story",
): Promise<GitResult<BranchCreationResult>> {
  const branchName = buildTicketBranchName(displayIdOf(ticket), ticket.title, prefix);

  // 1. Idempotency: already on correct branch?
  if (gitState.branch === branchName) {
    return { ok: true, data: { branchName, created: false } };
  }

  // 2. Validate ref format
  const refCheck = await gitCheckRefFormat(root, branchName);
  if (refCheck.ok && !refCheck.data) {
    return { ok: false, reason: "git_error", message: `Invalid branch name: ${branchName}` };
  }

  // 3. Branch exists? (resume scenario)
  const exists = await gitBranchExists(root, branchName);
  if (exists.ok && exists.data) {
    const checkout = await gitCheckoutBranch(root, branchName);
    if (!checkout.ok) return checkout as GitResult<BranchCreationResult>;
    return { ok: true, data: { branchName, created: false } };
  }

  // 4. Create new branch from initHead (immutable session start, survives FINALIZE mergeBase mutation)
  const base = gitState.initHead ?? gitState.mergeBase ?? "HEAD";
  const create = await gitCheckoutNewBranch(root, branchName, base);
  if (!create.ok) return create as GitResult<BranchCreationResult>;

  return { ok: true, data: { branchName, created: true } };
}

export async function refreshGitWorkingState(root: string): Promise<{
  branch: string | null;
  expectedHead: string | undefined;
  baseline: { porcelain: string[]; dirtyTrackedFiles: Record<string, { blobHash: string }>; untrackedPaths: string[] };
} | null> {
  const head = await gitHead(root);
  const status = await gitStatus(root);
  if (!head.ok || !status.ok) return null;

  const porcelain = status.data;
  const dirtyTrackedFiles: Record<string, { blobHash: string }> = {};
  const untrackedPaths: string[] = [];

  for (const line of porcelain) {
    const code = line.slice(0, 2);
    const filePath = line.slice(3);
    if (code === "??") {
      untrackedPaths.push(filePath);
    } else {
      if (filePath.startsWith(".story/")) continue;
      const blobResult = await gitBlobHash(root, filePath);
      dirtyTrackedFiles[filePath] = { blobHash: blobResult.ok ? blobResult.data : "unknown" };
    }
  }

  return {
    branch: head.data.branch,
    expectedHead: head.data.hash,
    baseline: { porcelain, dirtyTrackedFiles, untrackedPaths },
  };
}
