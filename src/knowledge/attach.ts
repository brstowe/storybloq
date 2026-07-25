/**
 * Storyknow attachment (fork feature) — consumer projects attach shared
 * knowledge packs via the config key `knowledge: ["<name-or-path>", ...]`.
 *
 * A bare name resolves under the storyknow home ($STORYKNOW_HOME, default
 * ~/dev/storyknow); anything path-like resolves relative to the project root.
 * Federation nodes additionally absorb the packs attached to their
 * orchestrator root (one transitive hop, deduped), so a federation attaches
 * a pack once at the root. Attached knowledge is read-only and best-effort:
 * it feeds the lesson digest, never validation, gc, or write paths.
 */
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Lesson } from "../models/lesson.js";
import {
  findOrchestratorLink,
  readJsonSafe,
  realpathSafe,
} from "../federation/inherit.js";
import { isKnowledgePackConfig, loadKnowledgeEntries } from "./pack.js";

export interface AttachedPack {
  /** Display name: the bare ref when one was used, else the pack's project name. */
  readonly name: string;
  /** Absolute (real) path of the pack root. */
  readonly root: string;
  /** The ref as written in config (for error messages / matching). */
  readonly ref: string;
}

/** Mirrors the federation node-name rule; anything else is treated as a path. */
const BARE_NAME_REGEX = /^[a-z][a-z0-9_-]{0,63}$/;

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** The directory bare pack names resolve under. */
export function storyknowHome(): string {
  const env = process.env.STORYKNOW_HOME?.trim();
  return env ? expandHome(env) : join(homedir(), "dev", "storyknow");
}

/**
 * Resolves a pack ref (bare name or path) to an AttachedPack, or null when
 * the target is missing or is not a knowledge pack. Never throws.
 */
export function resolvePack(ref: string, baseRoot: string): AttachedPack | null {
  const raw = ref.trim();
  if (!raw) return null;
  const isBare = BARE_NAME_REGEX.test(raw);
  const candidate = isBare
    ? join(storyknowHome(), raw)
    : isAbsolute(expandHome(raw))
      ? expandHome(raw)
      : resolve(baseRoot, raw);
  const root = realpathSafe(candidate);
  if (!root) return null;
  const config = readJsonSafe(join(root, ".story", "config.json"));
  if (!isKnowledgePackConfig(config)) return null;
  const projectName = typeof config?.project === "string" ? config.project : null;
  return {
    name: isBare ? raw : projectName ?? basename(root),
    root,
    ref: raw,
  };
}

function knowledgeRefsOf(config: Record<string, unknown> | null | undefined): string[] {
  const raw = config?.knowledge;
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is string => typeof r === "string" && r.trim().length > 0);
}

/**
 * All packs attached to a project: its own `knowledge` refs plus (one hop)
 * the refs of its orchestrator root when the project is a federation node.
 * Deduped by resolved pack root; unresolvable refs are silently absent.
 */
export function attachedPacksFor(
  projectRoot: string,
  config: Record<string, unknown> | null | undefined,
): AttachedPack[] {
  const out: AttachedPack[] = [];
  const seen = new Set<string>();
  const collect = (refs: string[], baseRoot: string) => {
    for (const ref of refs) {
      const pack = resolvePack(ref, baseRoot);
      if (pack && !seen.has(pack.root)) {
        seen.add(pack.root);
        out.push(pack);
      }
    }
  };
  collect(knowledgeRefsOf(config), projectRoot);
  const link = findOrchestratorLink(projectRoot, config);
  if (link) {
    const orchConfig = readJsonSafe(join(link.storyDir, "config.json"));
    collect(knowledgeRefsOf(orchConfig), link.orchestratorRoot);
  }
  return out;
}

function markTitle<T extends { title: string | null }>(item: T, mark: string): T {
  if (item.title?.startsWith(mark)) return item;
  return { ...item, title: `${mark}${item.title ?? "(untitled)"}` };
}

/**
 * Convenience: ACTIVE knowledge entries from every attached pack, titles
 * marked "[<pack>] ", as lesson-shaped items ready for the digest builder.
 */
export function attachedKnowledgeFor(
  projectRoot: string,
  config: Record<string, unknown> | null | undefined,
): Lesson[] {
  const out: Lesson[] = [];
  for (const pack of attachedPacksFor(projectRoot, config)) {
    const mark = `[${pack.name}] `;
    for (const entry of loadKnowledgeEntries(pack.root)) {
      if (entry.status !== "active") continue;
      out.push(markTitle(entry, mark) as unknown as Lesson);
    }
  }
  return out;
}
