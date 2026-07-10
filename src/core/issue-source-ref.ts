import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  IssueSourceRefInputSchema,
  type Issue,
  type IssueSourceRef,
  type IssueSourceRefInput,
} from "../models/issue.js";
import type { ValidationFinding } from "./validation.js";
import { displayIdOf } from "./resolver.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export class IssueSourceRefError extends Error {
  readonly name = "IssueSourceRefError";
}

function normalizedLines(content: string): string[] {
  const normalized = content.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

function rangeEnd(ref: Pick<IssueSourceRefInput, "startLine" | "endLine">): number {
  return ref.endLine ?? ref.startLine;
}

function rangeText(
  content: string,
  startLine: number,
  endLine: number,
): string {
  const lines = normalizedLines(content);
  if (startLine < 1 || endLine < startLine || endLine > lines.length) {
    throw new IssueSourceRefError(
      `Line range ${startLine}-${endLine} is outside a ${lines.length}-line source file`,
    );
  }
  return lines.slice(startLine - 1, endLine).join("\n");
}

function hashText(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function hashSourceRange(
  content: string,
  startLine: number,
  endLine = startLine,
): string {
  return hashText(rangeText(content, startLine, endLine));
}

async function gitOutput(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: "utf8",
    });
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new IssueSourceRefError(stderr || (err as Error).message);
  }
}

async function resolveRevision(root: string, revision: string): Promise<string> {
  return (await gitOutput(root, ["rev-parse", "--verify", `${revision}^{commit}`])).trim();
}

async function readRevisionSource(root: string, revision: string, path: string): Promise<string> {
  return gitOutput(root, ["show", `${revision}:${path}`]);
}

async function readWorkingSource(root: string, path: string): Promise<string> {
  let absolutePath = resolve(root);
  let stat;
  for (const segment of path.split("/")) {
    absolutePath = resolve(absolutePath, segment);
    try {
      stat = await lstat(absolutePath);
    } catch (err) {
      throw new IssueSourceRefError(
        `Cannot read source path ${path}: ${(err as Error).message}`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw new IssueSourceRefError(`Source path ${path} must not traverse a symbolic link`);
    }
  }
  if (!stat?.isFile()) {
    throw new IssueSourceRefError(`Source path ${path} must be a regular file`);
  }
  return readFile(absolutePath, "utf8");
}

function assertHashMatches(
  suppliedHash: string | undefined,
  capturedHash: string,
  path: string,
): void {
  if (suppliedHash && suppliedHash.toLowerCase() !== capturedHash) {
    throw new IssueSourceRefError(
      `Content hash does not match the referenced line range in ${path}`,
    );
  }
}

/**
 * Validate and enrich source references before an issue is persisted.
 * HEAD is recorded only when it contains the same line-range bytes.
 */
export async function normalizeIssueSourceRefs(
  root: string,
  refs: readonly IssueSourceRefInput[],
): Promise<IssueSourceRef[]> {
  const normalized: IssueSourceRef[] = [];
  let headRevision: string | null | undefined;

  for (const candidate of refs) {
    const parsed = IssueSourceRefInputSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new IssueSourceRefError(
        parsed.error.issues.map((issue) => issue.message).join("; "),
      );
    }

    const ref = parsed.data;
    const endLine = rangeEnd(ref);
    let revision = ref.revision;
    let content: string;

    if (revision) {
      revision = await resolveRevision(root, revision);
      content = await readRevisionSource(root, revision, ref.path);
    } else {
      content = await readWorkingSource(root, ref.path);
    }

    const contentHash = hashSourceRange(content, ref.startLine, endLine);
    assertHashMatches(ref.contentHash, contentHash, ref.path);

    if (!revision) {
      if (headRevision === undefined) {
        try {
          headRevision = await resolveRevision(root, "HEAD");
        } catch {
          headRevision = null;
        }
      }
      if (headRevision) {
        try {
          const headContent = await readRevisionSource(root, headRevision, ref.path);
          if (hashSourceRange(headContent, ref.startLine, endLine) === contentHash) {
            revision = headRevision;
          }
        } catch {
          // The working-tree evidence remains durable through contentHash.
        }
      }
    }

    normalized.push({
      path: ref.path,
      startLine: ref.startLine,
      ...(ref.endLine !== undefined ? { endLine: ref.endLine } : {}),
      ...(revision ? { revision } : {}),
      ...(ref.snapshotId ? { snapshotId: ref.snapshotId } : {}),
      contentHash,
      ...(ref.reviewId ? { reviewId: ref.reviewId } : {}),
    });
  }

  return normalized;
}

function findMatchingRanges(
  content: string,
  expectedHash: string,
  lineCount: number,
): number[] {
  const lines = normalizedLines(content);
  const matches: number[] = [];
  for (let start = 1; start + lineCount - 1 <= lines.length; start++) {
    const candidate = lines.slice(start - 1, start + lineCount - 1).join("\n");
    if (hashText(candidate) === expectedHash) {
      matches.push(start);
    }
  }
  return matches;
}

/** Validate durable issue provenance against its origin and current HEAD. */
export async function validateIssueSourceRefs(
  root: string,
  issues: readonly Issue[],
): Promise<ValidationFinding[]> {
  const findings: ValidationFinding[] = [];
  const revisionCache = new Map<string, Promise<string>>();
  const sourceCache = new Map<string, Promise<string>>();

  const cachedRevision = (revision: string): Promise<string> => {
    let pending = revisionCache.get(revision);
    if (!pending) {
      pending = resolveRevision(root, revision);
      revisionCache.set(revision, pending);
    }
    return pending;
  };
  const cachedSource = (revision: string, path: string): Promise<string> => {
    const key = `${revision}\0${path}`;
    let pending = sourceCache.get(key);
    if (!pending) {
      pending = readRevisionSource(root, revision, path);
      sourceCache.set(key, pending);
    }
    return pending;
  };

  let head: string | null = null;
  try {
    head = await cachedRevision("HEAD");
  } catch {
    head = null;
  }

  for (const issue of issues) {
    const entity = displayIdOf(issue);
    for (const ref of issue.sourceRefs ?? []) {
      const endLine = rangeEnd(ref);
      const lineCount = endLine - ref.startLine + 1;
      let expectedHash = ref.contentHash?.toLowerCase();

      if (ref.revision) {
        try {
          const revision = await cachedRevision(ref.revision);
          const original = await cachedSource(revision, ref.path);
          const originalHash = hashSourceRange(original, ref.startLine, endLine);
          if (expectedHash && expectedHash !== originalHash) {
            findings.push({
              level: "error",
              code: "source_ref_original_mismatch",
              message: `${ref.path}:${ref.startLine} does not match its recorded content hash at ${revision.slice(0, 12)}.`,
              entity,
            });
            continue;
          }
          expectedHash = originalHash;
        } catch (err) {
          findings.push({
            level: "error",
            code: "source_ref_original_unresolvable",
            message: `Cannot resolve ${ref.path}:${ref.startLine} at revision ${ref.revision}: ${(err as Error).message}`,
            entity,
          });
          continue;
        }
      }

      if (!expectedHash) {
        findings.push({
          level: "error",
          code: "source_ref_original_unverifiable",
          message: `${ref.path}:${ref.startLine} has neither a resolvable revision nor a content hash.`,
          entity,
        });
        continue;
      }

      let current: string;
      let currentLabel: string;
      try {
        if (head) {
          current = await cachedSource(head, ref.path);
          currentLabel = "HEAD";
        } else {
          current = await readWorkingSource(root, ref.path);
          currentLabel = "the working tree";
        }
      } catch {
        findings.push({
          level: "warning",
          code: "source_ref_missing_at_head",
          message: `${ref.path}:${ref.startLine} is valid historically but the path is absent at HEAD.`,
          entity,
        });
        continue;
      }

      try {
        if (hashSourceRange(current, ref.startLine, endLine) === expectedHash) continue;
      } catch {
        // Search the full current file before classifying the reference as stale.
      }

      const matches = findMatchingRanges(current, expectedHash, lineCount);
      if (matches.length === 1) {
        findings.push({
          level: "warning",
          code: "source_ref_moved_at_head",
          message: `${ref.path}:${ref.startLine}-${endLine} moved to ${ref.path}:${matches[0]}-${matches[0]! + lineCount - 1} at ${currentLabel}.`,
          entity,
        });
      } else if (matches.length > 1) {
        findings.push({
          level: "warning",
          code: "source_ref_ambiguous_at_head",
          message: `${ref.path}:${ref.startLine}-${endLine} matches ${matches.length} ranges at ${currentLabel}.`,
          entity,
        });
      } else {
        findings.push({
          level: "warning",
          code: "source_ref_changed_at_head",
          message: `${ref.path}:${ref.startLine}-${endLine} is valid historically but its referenced content changed at ${currentLabel}.`,
          entity,
        });
      }
    }
  }

  return findings;
}
