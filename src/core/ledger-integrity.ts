import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ZodType } from "zod";
import { ConfigSchema } from "../models/config.js";
import { IssueSchema } from "../models/issue.js";
import { LessonSchema } from "../models/lesson.js";
import { NoteSchema } from "../models/note.js";
import { RoadmapSchema } from "../models/roadmap.js";
import { TicketSchema } from "../models/ticket.js";

export type LedgerIntegrityClassification = "critical" | "item" | "auxiliary";
export type LedgerIntegrityCode = "missing_file" | "unreadable" | "invalid_json" | "schema_error";

export interface LedgerIntegrityFinding {
  readonly code: LedgerIntegrityCode;
  readonly classification: LedgerIntegrityClassification;
  readonly file: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

export interface LedgerIntegrityResult {
  readonly valid: boolean;
  readonly scannedFiles: number;
  readonly skippedSymlinks: number;
  readonly errorCount: number;
  readonly criticalErrorCount: number;
  readonly itemErrorCount: number;
  readonly auxiliaryErrorCount: number;
  readonly findings: readonly LedgerIntegrityFinding[];
}

export interface LedgerIntegrityOptions {
  /** Include sessions, snapshots, caches, and other non-ledger JSON. */
  readonly includeAuxiliary?: boolean;
}

interface FileContract {
  readonly classification: LedgerIntegrityClassification;
  readonly schema?: ZodType<unknown>;
}

const ITEM_DIRECTORIES = new Map<string, ZodType<unknown>>([
  ["tickets", TicketSchema],
  ["issues", IssueSchema],
  ["notes", NoteSchema],
  ["lessons", LessonSchema],
]);

function normalizeRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function contractFor(relativePath: string): FileContract {
  if (relativePath === ".story/config.json") {
    return { classification: "critical", schema: ConfigSchema };
  }
  if (relativePath === ".story/roadmap.json") {
    return { classification: "critical", schema: RoadmapSchema };
  }

  const match = /^\.story\/(tickets|issues|notes|lessons)\/[^/]+\.json$/.exec(relativePath);
  if (match) {
    return {
      classification: "item",
      schema: ITEM_DIRECTORIES.get(match[1]!)!,
    };
  }
  return { classification: "auxiliary" };
}

async function discoverStoryRootAt(candidate: string): Promise<string | null> {
  try {
    const stat = await lstat(join(candidate, ".story"));
    return stat.isDirectory() && !stat.isSymbolicLink() ? candidate : null;
  } catch {
    return null;
  }
}

/** Find a project by .story/ alone, even when config.json is missing. */
export async function discoverIntegrityRoot(startDir = process.cwd()): Promise<string | null> {
  let current = resolve(startDir);
  for (;;) {
    const found = await discoverStoryRootAt(current);
    if (found) return found;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function collectCanonicalJsonFiles(
  storyDir: string,
): Promise<{ files: string[]; skippedSymlinks: number }> {
  const files: string[] = [];
  let skippedSymlinks = 0;

  let rootEntries;
  try {
    rootEntries = await readdir(storyDir, { withFileTypes: true });
  } catch {
    return { files, skippedSymlinks };
  }
  for (const entry of rootEntries) {
    if (entry.isSymbolicLink()) {
      skippedSymlinks += 1;
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(join(storyDir, entry.name));
      continue;
    }
    if (!entry.isDirectory() || !ITEM_DIRECTORIES.has(entry.name)) continue;
    const itemDir = join(storyDir, entry.name);
    let itemEntries;
    try {
      itemEntries = await readdir(itemDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of itemEntries) {
      if (item.isSymbolicLink()) {
        skippedSymlinks += 1;
      } else if (item.isFile() && item.name.endsWith(".json")) {
        files.push(join(itemDir, item.name));
      }
    }
  }
  return { files: files.sort(), skippedSymlinks };
}

async function collectAllJsonFiles(
  storyDir: string,
): Promise<{ files: string[]; skippedSymlinks: number; traversalFindings: LedgerIntegrityFinding[] }> {
  const files: string[] = [];
  const traversalFindings: LedgerIntegrityFinding[] = [];
  let skippedSymlinks = 0;

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      traversalFindings.push({
        code: "unreadable",
        classification: "auxiliary",
        file: dir,
        message: `Cannot enumerate directory: ${(err as Error).message}`,
      });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        skippedSymlinks += 1;
      } else if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(path);
      }
    }
  };

  await walk(storyDir);
  return { files, skippedSymlinks, traversalFindings };
}

function parseErrorPosition(
  raw: string,
  error: Error,
): { line?: number; column?: number } {
  const explicit = /line\s+(\d+)\s+column\s+(\d+)/i.exec(error.message);
  if (explicit) {
    return { line: Number(explicit[1]), column: Number(explicit[2]) };
  }
  const positionMatch = /(?:at\s+)?position\s+(\d+)/i.exec(error.message);
  let position = positionMatch ? Number(positionMatch[1]) : null;
  if (position === null && /end of json input/i.test(error.message)) position = raw.length;
  if (position === null || !Number.isFinite(position) || position < 0) return {};
  const before = raw.slice(0, position);
  const line = before.split("\n").length;
  const lastBreak = before.lastIndexOf("\n");
  return { line, column: position - lastBreak };
}

function summarizeSchemaError(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  const shown = issues.slice(0, 5).map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
  if (issues.length > shown.length) shown.push(`and ${issues.length - shown.length} more`);
  return shown.join("; ");
}

/**
 * Parse ledger JSON without loading project state. This function is read-only
 * and intentionally has no dependency on loadProject.
 */
export async function scanLedgerIntegrity(
  root: string,
  options: LedgerIntegrityOptions = {},
): Promise<LedgerIntegrityResult> {
  const storyDir = join(resolve(root), ".story");
  const findings: LedgerIntegrityFinding[] = [];
  const collection = options.includeAuxiliary
    ? await collectAllJsonFiles(storyDir)
    : { ...(await collectCanonicalJsonFiles(storyDir)), traversalFindings: [] };

  for (const finding of collection.traversalFindings) {
    findings.push({
      ...finding,
      file: normalizeRelativePath(root, finding.file),
    });
  }

  const files = new Set(collection.files);
  for (const required of ["config.json", "roadmap.json"]) {
    const path = join(storyDir, required);
    if (!files.has(path)) {
      findings.push({
        code: "missing_file",
        classification: "critical",
        file: normalizeRelativePath(root, path),
        message: "Required Storybloq file is missing.",
      });
    }
  }

  for (const path of [...files].sort()) {
    const file = normalizeRelativePath(root, path);
    const contract = contractFor(file);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      findings.push({
        code: "unreadable",
        classification: contract.classification,
        file,
        message: `Cannot read file: ${(err as Error).message}`,
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const position = parseErrorPosition(raw, err as Error);
      findings.push({
        code: "invalid_json",
        classification: contract.classification,
        file,
        message: (err as Error).message,
        ...position,
      });
      continue;
    }

    if (contract.schema) {
      const result = contract.schema.safeParse(parsed);
      if (!result.success) {
        findings.push({
          code: "schema_error",
          classification: contract.classification,
          file,
          message: summarizeSchemaError(result.error.issues),
        });
      }
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.code.localeCompare(b.code));
  const criticalErrorCount = findings.filter((finding) => finding.classification === "critical").length;
  const itemErrorCount = findings.filter((finding) => finding.classification === "item").length;
  const auxiliaryErrorCount = findings.filter((finding) => finding.classification === "auxiliary").length;
  return {
    valid: findings.length === 0,
    scannedFiles: files.size,
    skippedSymlinks: collection.skippedSymlinks,
    errorCount: findings.length,
    criticalErrorCount,
    itemErrorCount,
    auxiliaryErrorCount,
    findings,
  };
}
