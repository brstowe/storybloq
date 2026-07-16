/**
 * Federation inheritance (fork feature) — node projects absorb the
 * orchestrator root's lessons and notes at read time.
 *
 * A node discovers its orchestrator either explicitly (config.federationRoot:
 * a path to the orchestrator root, relative to the node root) or automatically
 * (a parent directory whose .story/config.json is type "orchestrator" with a
 * nodes entry resolving to this project root). config.federationRoot: false
 * opts out entirely. Inheritance is read-only and best-effort: it feeds the
 * lesson digest and note list/get, never validation, gc, or write paths.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LessonSchema, type Lesson } from "../models/lesson.js";
import { NoteSchema, type Note } from "../models/note.js";
import { resolveNodePath } from "./resolver.js";

export interface OrchestratorLink {
  /** Absolute (real) path of the orchestrator project root. */
  readonly orchestratorRoot: string;
  /** The orchestrator's .story directory. */
  readonly storyDir: string;
  /** This project's node name in the orchestrator's nodes map, when known. */
  readonly nodeName: string | null;
}

const MAX_UPWARD_LEVELS = 5;

function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* unreadable or malformed — treat as absent */
  }
  return null;
}

function realpathSafe(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** Returns the node name whose configured path resolves to projectRootReal, if any. */
function matchNode(
  orchConfig: Record<string, unknown>,
  orchRoot: string,
  projectRootReal: string,
): string | null {
  const nodes = orchConfig.nodes;
  if (!nodes || typeof nodes !== "object" || Array.isArray(nodes)) return null;
  for (const [name, value] of Object.entries(nodes as Record<string, unknown>)) {
    const rawPath = (value as Record<string, unknown> | null)?.path;
    if (typeof rawPath !== "string") continue;
    const resolved = resolveNodePath(rawPath, orchRoot);
    if (resolved.resolved && resolved.absolutePath === projectRootReal) return name;
  }
  return null;
}

/**
 * Locates the orchestrator this project belongs to, or null.
 * Never throws; any filesystem or schema problem reads as "no orchestrator".
 */
export function findOrchestratorLink(
  projectRoot: string,
  config: Record<string, unknown> | null | undefined,
): OrchestratorLink | null {
  // Orchestrators don't inherit from themselves.
  if (config?.type === "orchestrator") return null;
  const knob = config?.federationRoot;
  if (knob === false) return null;

  const projectRootReal = realpathSafe(projectRoot);
  if (!projectRootReal) return null;

  // Explicit link: federationRoot names the orchestrator root.
  if (typeof knob === "string" && knob.length > 0) {
    const orchRoot = realpathSafe(resolve(projectRoot, knob));
    if (!orchRoot) return null;
    const orchConfig = readJsonSafe(join(orchRoot, ".story", "config.json"));
    if (orchConfig?.type !== "orchestrator") return null;
    return {
      orchestratorRoot: orchRoot,
      storyDir: join(orchRoot, ".story"),
      nodeName: matchNode(orchConfig, orchRoot, projectRootReal),
    };
  }

  // Auto-discovery: walk up looking for an orchestrator that claims this root.
  let dir = projectRootReal;
  for (let i = 0; i < MAX_UPWARD_LEVELS; i++) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const configPath = join(dir, ".story", "config.json");
    if (!existsSync(configPath)) continue;
    const orchConfig = readJsonSafe(configPath);
    if (orchConfig?.type !== "orchestrator") continue;
    const nodeName = matchNode(orchConfig, dir, projectRootReal);
    if (nodeName) {
      return { orchestratorRoot: dir, storyDir: join(dir, ".story"), nodeName };
    }
  }
  return null;
}

function loadDirSafe<T>(
  dir: string,
  parse: (raw: unknown) => T | null,
): T[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const f of files) {
    const raw = readJsonSafe(join(dir, f));
    if (!raw) continue;
    const parsed = parse(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Loads the orchestrator's lessons (best-effort, invalid files skipped). */
export function loadInheritedLessons(link: OrchestratorLink): Lesson[] {
  return loadDirSafe(join(link.storyDir, "lessons"), (raw) => {
    const r = LessonSchema.safeParse(raw);
    return r.success ? r.data : null;
  });
}

/** Loads the orchestrator's notes (best-effort, invalid files skipped). */
export function loadInheritedNotes(link: OrchestratorLink): Note[] {
  return loadDirSafe(join(link.storyDir, "notes"), (raw) => {
    const r = NoteSchema.safeParse(raw);
    return r.success ? r.data : null;
  });
}

const ROOT_MARK = "[root] ";

/** Prefixes an inherited item's title so agents can tell it is orchestrator-owned (read-only here). */
export function markInheritedTitle<T extends { title: string | null }>(item: T): T {
  if (item.title?.startsWith(ROOT_MARK)) return item;
  return { ...item, title: `${ROOT_MARK}${item.title ?? "(untitled)"}` };
}

/**
 * Convenience: inherited ACTIVE lessons for a project, title-marked, or [].
 * The digest builder filters by status itself, but pre-filtering keeps
 * tombstoned/superseded root lessons from ever crossing the boundary.
 */
export function inheritedLessonsFor(
  projectRoot: string,
  config: Record<string, unknown> | null | undefined,
): Lesson[] {
  const link = findOrchestratorLink(projectRoot, config);
  if (!link) return [];
  return loadInheritedLessons(link)
    .filter((l) => l.status === "active")
    .map(markInheritedTitle);
}

/** Convenience: inherited notes for a project, title-marked, or []. */
export function inheritedNotesFor(
  projectRoot: string,
  config: Record<string, unknown> | null | undefined,
): Note[] {
  const link = findOrchestratorLink(projectRoot, config);
  if (!link) return [];
  return loadInheritedNotes(link).map(markInheritedTitle);
}
