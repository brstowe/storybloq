/**
 * Diff scope parser and origin classifier for lens review findings (ISS-823
 * carry-over from the retired review-lenses fork, T-192).
 *
 * Parses unified diff format to extract changed file paths and added line
 * numbers, then classifies findings as "introduced" (in the diff) or
 * "pre-existing" (surrounding code). Operates on the package finding shape:
 * any object carrying nullable `file`/`line` coordinates.
 */

import type { Stage } from "@storybloq/lenses";

// ── Types ────────────────────────────────────────────────────

export interface DiffScope {
  readonly changedFiles: ReadonlySet<string>;
  readonly addedLines: ReadonlyMap<string, ReadonlySet<number>>;
}

// ── Parser ───────────────────────────────────────────────────

/**
 * Parse a unified diff to extract changed files and added line numbers.
 *
 * Scans for `+++ b/<path>` file headers and `@@ ... +start,count @@` hunks,
 * then tracks lines starting with `+` (added) within each hunk.
 */
export function parseDiffScope(diff: string): DiffScope {
  const changedFiles = new Set<string>();
  const addedLines = new Map<string, Set<number>>();

  if (!diff) return { changedFiles, addedLines };

  const lines = diff.split("\n");
  let currentFile: string | null = null;
  let currentLineNum = 0;

  for (const line of lines) {
    // File header: +++ b/path/to/file or +++ /dev/null (deleted file)
    if (line.startsWith("+++ ")) {
      if (line.startsWith("+++ /dev/null")) {
        currentFile = null;
        continue;
      }
      // Strip +++ b/ prefix (standard git diff format) and normalize
      const rawPath = line.startsWith("+++ b/") ? line.slice(6) : line.slice(4);
      currentFile = normalizePath(rawPath);
      changedFiles.add(currentFile);
      if (!addedLines.has(currentFile)) {
        addedLines.set(currentFile, new Set());
      }
      currentLineNum = 0;
      continue;
    }

    // Hunk header: @@ -a,b +start,count @@ optional context
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      currentLineNum = parseInt(hunkMatch[1]!, 10) - 1;
      continue;
    }

    if (!currentFile) continue;

    // Deleted line: skip (doesn't exist in the new file)
    if (line.startsWith("-")) continue;

    // Added line (+) or context line ( ): advance line counter
    currentLineNum++;
    if (line.startsWith("+")) {
      addedLines.get(currentFile)!.add(currentLineNum);
    }
  }

  return { changedFiles, addedLines };
}

// ── Classifier ───────────────────────────────────────────────

/** Normalize a path by stripping leading ./ for consistent comparison. */
function normalizePath(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p;
}

/**
 * Classify a finding's origin based on whether its location falls within the
 * diff scope.
 *
 * Rules:
 * - PLAN_REVIEW: always "introduced" (plans are new text)
 * - CODE_REVIEW, no file: "introduced" (unlocatable)
 * - CODE_REVIEW, file not in diff: "pre-existing"
 * - CODE_REVIEW, file in diff, no line: "introduced" (conservative)
 * - CODE_REVIEW, file in diff, line in addedLines: "introduced"
 * - CODE_REVIEW, file in diff, line NOT in addedLines: "pre-existing"
 */
export function classifyOrigin(
  finding: { file: string | null; line: number | null },
  scope: DiffScope,
  stage: Stage,
): "introduced" | "pre-existing" {
  if (stage === "PLAN_REVIEW") return "introduced";
  if (!finding.file) return "introduced";

  const file = normalizePath(finding.file);
  if (!scope.changedFiles.has(file)) return "pre-existing";
  if (finding.line == null) return "introduced";

  const fileLines = scope.addedLines.get(file);
  if (!fileLines || !fileLines.has(finding.line)) return "pre-existing";

  return "introduced";
}
