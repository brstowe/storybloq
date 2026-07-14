import { displayIdOf } from "../core/resolver.js";
/**
 * T-183: Resume marker file for 100% compaction survival.
 *
 * Writes a `.claude/rules/autonomous-resume.md` marker that Claude Code reads
 * automatically on every turn. This is a redundant safety net -- the existing
 * SessionStart hook chain stays as-is.
 *
 * Path assumption: `root` from discoverProjectRoot() is the git/project root
 * where Claude Code reads `.claude/rules/`. This holds for standalone repos
 * and worktrees (each worktree has its own `.claude/`).
 */
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

const MARKER_FILENAME = "autonomous-resume.md";

/** Strip newlines, collapse whitespace, and limit length to prevent prompt injection via .claude/rules/ marker. */
function sanitize(input: string, maxLen = 120): string {
  return input.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

export function writeResumeMarker(root: string, sessionId: string, state: {
  ticket?: { id: string; displayId?: string; title: string } | null;
  completedTickets: { id: string }[];
  resolvedIssues?: string[];
  preCompactState?: string | null;
}): void {
  try {
    const rulesDir = join(root, ".claude", "rules");
    mkdirSync(rulesDir, { recursive: true });

    const ticketInfo = state.ticket
      ? `Working on: ${sanitize(displayIdOf(state.ticket), 20)} (${sanitize(state.ticket.title)})`
      : "Between tickets";
    const progress = `Progress: ${state.completedTickets.length} tickets completed, ${(state.resolvedIssues ?? []).length} issues resolved`;

    const lines = [
      "CRITICAL: An autonomous coding session is active and waiting to resume.",
      "",
      `Session: ${sessionId}`,
      ticketInfo,
      progress,
    ];
    if (state.preCompactState) {
      lines.push(`State before compaction: ${state.preCompactState}`);
    }
    lines.push(
      "",
      "You MUST run `/story` before any other work.",
      "Its active-session guard will verify task ownership and resume this session only when safe.",
      "",
      "Do NOT do any other work until you have run `/story`.",
      "Do NOT manually create tickets, issues, or handovers.",
      "The guide manages your workflow.",
    );
    const content = lines.join("\n") + "\n";

    writeFileSync(join(rulesDir, MARKER_FILENAME), content, "utf-8");
  } catch {
    // Best-effort -- marker is redundancy, not primary mechanism
  }
}

export function removeResumeMarker(root: string): void {
  try {
    const markerPath = join(root, ".claude", "rules", MARKER_FILENAME);
    if (existsSync(markerPath)) unlinkSync(markerPath);
  } catch {
    // Best-effort
  }
}
