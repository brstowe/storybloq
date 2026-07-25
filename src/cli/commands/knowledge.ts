/**
 * Storyknow pack CLI (fork feature) — manage K-NNN knowledge entries inside
 * a knowledge pack (a storybloq project with config type "knowledge").
 *
 * Write commands must run inside a pack. `knowledge digest` is dual-mode:
 * inside a pack it digests the pack's own entries; inside a consumer project
 * it digests the knowledge attached via the `knowledge` config key.
 */
import { withProjectLock } from "../../core/project-loader.js";
import { join } from "node:path";
import { buildLessonDigest } from "../../core/lessons.js";
import {
  formatLessonDigest,
  formatError,
  successEnvelope,
  ExitCode,
} from "../../core/output-formatter.js";
import {
  LESSON_STATUSES,
  LESSON_SOURCES,
  type LessonStatus,
  type LessonSource,
  type OutputFormat,
} from "../../models/types.js";
import type { Knowledge } from "../../models/knowledge.js";
import type { Lesson } from "../../models/lesson.js";
import {
  isKnowledgePackConfig,
  loadKnowledgeEntries,
  nextKnowledgeID,
  writeKnowledgeUnlocked,
} from "../../knowledge/pack.js";
import { attachedKnowledgeFor } from "../../knowledge/attach.js";
import { unlink } from "node:fs/promises";
import {
  todayISO,
  normalizeTags,
  CliValidationError,
} from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";

function requirePack(config: Record<string, unknown> | null | undefined): void {
  if (!isKnowledgePackConfig(config)) {
    throw new CliValidationError(
      "invalid_input",
      `Not a knowledge pack (type "${String(config?.type ?? "unknown")}"). Knowledge entries are managed inside a storyknow pack directory (config type "knowledge"); from a consumer project, use \`lesson promote\` and \`lesson digest\`.`,
    );
  }
}

function entryByRef(entries: readonly Knowledge[], ref: string): Knowledge | undefined {
  const wanted = ref.trim().toUpperCase();
  return entries.find((e) => e.id.toUpperCase() === wanted);
}

function sortEntries(entries: Knowledge[]): Knowledge[] {
  return entries.sort((a, b) => {
    if (b.reinforcements !== a.reinforcements) return b.reinforcements - a.reinforcements;
    const dateCmp = b.updatedDate.localeCompare(a.updatedDate);
    if (dateCmp !== 0) return dateCmp;
    return a.id.localeCompare(b.id);
  });
}

// --- Formatters (knowledge wording; JSON reuses the standard envelope) ---

function formatKnowledgeList(entries: readonly Knowledge[], format: OutputFormat): string {
  if (format === "json") return JSON.stringify(successEnvelope(entries), null, 2);
  if (entries.length === 0) return "No knowledge entries found.";
  const lines: string[] = [];
  for (const e of entries) {
    const status = e.status === "active" ? "[ ]" : "[x]";
    const reinforced = e.reinforcements > 0 ? ` (×${e.reinforcements})` : "";
    const tagInfo = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
    lines.push(`${status} ${e.id}: ${e.title}${reinforced}${tagInfo}`);
  }
  return lines.join("\n");
}

function formatKnowledge(e: Knowledge, format: OutputFormat): string {
  if (format === "json") return JSON.stringify(successEnvelope(e), null, 2);
  const statusBadge = e.status !== "active" ? ` (${e.status})` : "";
  const lines: string[] = [
    `# ${e.title}${statusBadge}`,
    "",
    `Status: ${e.status} | Source: ${e.source} | Reinforcements: ${e.reinforcements}`,
  ];
  if (e.tags.length > 0) lines.push(`Tags: ${e.tags.join(", ")}`);
  lines.push(`Created: ${e.createdDate} | Updated: ${e.updatedDate} | Last validated: ${e.lastValidated}`);
  if (e.supersedes) lines.push(`Supersedes: ${e.supersedes}`);
  if (e.origin) lines.push(`Origin: ${e.origin.project} ${e.origin.sourceId} (${e.origin.date})`);
  lines.push("", "## Content", "", e.content);
  if (e.context) lines.push("", "## Context", "", e.context);
  return lines.join("\n");
}

function formatKnowledgeResult(verb: string, e: Knowledge, format: OutputFormat): string {
  if (format === "json") return JSON.stringify(successEnvelope(e), null, 2);
  const reinforced = verb === "Reinforced" ? ` (×${e.reinforcements})` : "";
  return `${verb} knowledge ${e.id}: ${e.title}${reinforced}`;
}

// --- Read handlers ---

export function handleKnowledgeList(
  filters: { status?: string; tag?: string; source?: string },
  ctx: CommandContext,
): CommandResult {
  requirePack(ctx.state.config as Record<string, unknown>);
  let entries = loadKnowledgeEntries(ctx.root);

  if (filters.status) {
    if (!LESSON_STATUSES.includes(filters.status as LessonStatus)) {
      throw new CliValidationError(
        "invalid_input",
        `Unknown status "${filters.status}": must be one of ${LESSON_STATUSES.join(", ")}`,
      );
    }
    entries = entries.filter((e) => e.status === filters.status);
  }
  if (filters.source) {
    if (!LESSON_SOURCES.includes(filters.source as LessonSource)) {
      throw new CliValidationError(
        "invalid_input",
        `Unknown source "${filters.source}": must be one of ${LESSON_SOURCES.join(", ")}`,
      );
    }
    entries = entries.filter((e) => e.source === filters.source);
  }
  if (filters.tag) {
    const normalized = normalizeTags([filters.tag]);
    if (normalized.length === 0) {
      entries = [];
    } else {
      const tag = normalized[0]!;
      entries = entries.filter((e) => e.tags.includes(tag));
    }
  }

  return { output: formatKnowledgeList(sortEntries(entries), ctx.format) };
}

export function handleKnowledgeGet(
  id: string,
  ctx: CommandContext,
): CommandResult {
  requirePack(ctx.state.config as Record<string, unknown>);
  const entry = entryByRef(loadKnowledgeEntries(ctx.root), id);
  if (!entry) {
    return {
      output: formatError("not_found", `Knowledge entry ${id} not found`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  return { output: formatKnowledge(entry, ctx.format) };
}

export function handleKnowledgeDigest(
  ctx: CommandContext,
): CommandResult {
  const config = ctx.state.config as Record<string, unknown>;
  // Inside a pack: digest the pack's own entries. Inside a consumer project:
  // digest what's attached (marked "[<pack>] ..."), so a session can inspect
  // its shared knowledge in isolation from local lessons.
  const items = isKnowledgePackConfig(config)
    ? (loadKnowledgeEntries(ctx.root) as unknown as Lesson[])
    : attachedKnowledgeFor(ctx.root, config);
  const digest = buildLessonDigest(items);
  return { output: formatLessonDigest(digest, ctx.format) };
}

// --- Write handlers ---

export async function handleKnowledgeCreate(
  args: {
    title: string;
    content: string;
    context: string;
    source: string;
    tags?: string[];
    supersedes?: string | null;
  },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  if (!args.title.trim()) {
    throw new CliValidationError("invalid_input", "Knowledge title cannot be empty");
  }
  if (!args.content.trim()) {
    throw new CliValidationError("invalid_input", "Knowledge content cannot be empty");
  }
  if (!LESSON_SOURCES.includes(args.source as LessonSource)) {
    throw new CliValidationError(
      "invalid_input",
      `Unknown source "${args.source}": must be one of ${LESSON_SOURCES.join(", ")}`,
    );
  }

  let created: Knowledge | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    requirePack(state.config as Record<string, unknown>);
    const entries = loadKnowledgeEntries(root);
    const id = nextKnowledgeID(root, entries);
    const today = todayISO();
    const tags = args.tags ? normalizeTags(args.tags) : [];

    let resolvedSupersedes: string | null = null;
    if (args.supersedes) {
      const target = entryByRef(entries, args.supersedes);
      if (!target) {
        throw new CliValidationError(
          "not_found",
          `Supersedes target ${args.supersedes} not found`,
        );
      }
      resolvedSupersedes = target.id;
    }

    const entry: Knowledge = {
      id,
      title: args.title,
      content: args.content,
      context: args.context,
      source: args.source as LessonSource,
      tags,
      reinforcements: 0,
      lastValidated: today,
      createdDate: today,
      updatedDate: today,
      supersedes: resolvedSupersedes,
      status: "active",
    };

    await writeKnowledgeUnlocked(entry, root, { createOnly: true });

    if (resolvedSupersedes) {
      const target = entryByRef(entries, resolvedSupersedes);
      if (target && target.status !== "superseded") {
        await writeKnowledgeUnlocked(
          { ...target, status: "superseded", updatedDate: today },
          root,
        );
      }
    }

    created = entry;
  });

  if (!created) throw new Error("Knowledge entry not created");
  return { output: formatKnowledgeResult("Created", created, format) };
}

export async function handleKnowledgeUpdate(
  id: string,
  updates: {
    title?: string;
    content?: string;
    context?: string;
    tags?: string[];
    clearTags?: boolean;
    status?: string;
  },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  if (updates.title !== undefined && !updates.title.trim()) {
    throw new CliValidationError("invalid_input", "Knowledge title cannot be empty");
  }
  if (updates.content !== undefined && !updates.content.trim()) {
    throw new CliValidationError("invalid_input", "Knowledge content cannot be empty");
  }
  if (updates.status && !LESSON_STATUSES.includes(updates.status as LessonStatus)) {
    throw new CliValidationError(
      "invalid_input",
      `Unknown status "${updates.status}": must be one of ${LESSON_STATUSES.join(", ")}`,
    );
  }

  let updated: Knowledge | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    requirePack(state.config as Record<string, unknown>);
    const existing = entryByRef(loadKnowledgeEntries(root), id);
    if (!existing) {
      throw new CliValidationError("not_found", `Knowledge entry ${id} not found`);
    }

    const tagsUpdate: Partial<Knowledge> = {};
    if (updates.clearTags) {
      tagsUpdate.tags = [];
    } else if (updates.tags !== undefined) {
      tagsUpdate.tags = normalizeTags(updates.tags);
    }

    const entry: Knowledge = {
      ...existing,
      ...(updates.title !== undefined && { title: updates.title }),
      ...(updates.content !== undefined && { content: updates.content }),
      ...(updates.context !== undefined && { context: updates.context }),
      ...tagsUpdate,
      ...(updates.status !== undefined && { status: updates.status as LessonStatus }),
      updatedDate: todayISO(),
    };

    await writeKnowledgeUnlocked(entry, root);
    updated = entry;
  });

  if (!updated) throw new Error("Knowledge entry not updated");
  return { output: formatKnowledgeResult("Updated", updated, format) };
}

export async function handleKnowledgeReinforce(
  id: string,
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  let reinforced: Knowledge | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    requirePack(state.config as Record<string, unknown>);
    const existing = entryByRef(loadKnowledgeEntries(root), id);
    if (!existing) {
      throw new CliValidationError("not_found", `Knowledge entry ${id} not found`);
    }

    const today = todayISO();
    const entry: Knowledge = {
      ...existing,
      reinforcements: existing.reinforcements + 1,
      lastValidated: today,
      updatedDate: today,
    };

    await writeKnowledgeUnlocked(entry, root);
    reinforced = entry;
  });

  if (!reinforced) throw new Error("Knowledge entry not reinforced");
  return { output: formatKnowledgeResult("Reinforced", reinforced, format) };
}

export async function handleKnowledgeDelete(
  id: string,
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  let deletedId = id;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    requirePack(state.config as Record<string, unknown>);
    const entries = loadKnowledgeEntries(root);
    const existing = entryByRef(entries, id);
    if (!existing) {
      throw new CliValidationError("not_found", `Knowledge entry ${id} not found`);
    }
    const referencing = entries.filter((e) => e.supersedes === existing.id);
    if (referencing.length > 0) {
      throw new CliValidationError(
        "conflict",
        `Cannot delete ${existing.id}: referenced by ${referencing.map((e) => e.id).join(", ")} via supersedes`,
      );
    }
    await unlink(join(root, ".story", "knowledge", `${existing.id}.json`));
    deletedId = existing.id;
  });

  if (format === "json") {
    return { output: JSON.stringify(successEnvelope({ id: deletedId, deleted: true }), null, 2) };
  }
  return { output: `Deleted knowledge ${deletedId}` };
}
