/**
 * Storyknow pack IO (fork feature) — a pack is a knowledge-only storybloq
 * project (config type "knowledge") whose .story/knowledge/ directory holds
 * K-NNN entries shared across consumer projects.
 *
 * Packs never flow through ProjectState: this module reads and writes the
 * knowledge directory directly, taking the pack's own .story lock for writes.
 */
import { readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { KnowledgeSchema, type Knowledge } from "../models/knowledge.js";
import { KNOWLEDGE_ID_REGEX } from "../models/types.js";
import { loadDirSafe, readJsonSafe } from "../federation/inherit.js";
import {
  atomicCreate,
  atomicWrite,
  guardPath,
  serializeJSON,
} from "../core/project-loader.js";
import { ProjectLoaderError } from "../core/errors.js";

export const KNOWLEDGE_NUMERIC_REGEX = /^K-(\d+)$/;

/** True when a config object describes a storyknow pack. */
export function isKnowledgePackConfig(
  config: Record<string, unknown> | null | undefined,
): boolean {
  return config?.type === "knowledge";
}

/** Reads a pack's config, or null when absent/malformed. */
export function readPackConfig(packRoot: string): Record<string, unknown> | null {
  return readJsonSafe(join(packRoot, ".story", "config.json"));
}

/** Loads a pack's knowledge entries (best-effort, invalid files skipped). */
export function loadKnowledgeEntries(packRoot: string): Knowledge[] {
  return loadDirSafe(join(packRoot, ".story", "knowledge"), (raw) => {
    const r = KnowledgeSchema.safeParse(raw);
    return r.success ? r.data : null;
  });
}

/**
 * Next knowledge ID: scan max over entry ids AND filenames, return K-(max+1).
 * Filenames are included so a malformed (skipped) entry file can never cause
 * its id to be re-minted.
 */
export function nextKnowledgeID(
  packRoot: string,
  entries: readonly Knowledge[],
): string {
  let max = 0;
  const consider = (s: string) => {
    const m = s.match(KNOWLEDGE_NUMERIC_REGEX);
    if (m?.[1]) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  };
  for (const e of entries) consider(e.id);
  try {
    for (const f of readdirSync(join(packRoot, ".story", "knowledge"))) {
      if (f.endsWith(".json")) consider(f.slice(0, -".json".length));
    }
  } catch {
    /* directory absent — first entry */
  }
  return `K-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Writes a knowledge entry WITHOUT acquiring the pack lock.
 * Use inside withLock on the pack's .story when the lock is already held.
 */
export async function writeKnowledgeUnlocked(
  entry: Knowledge,
  packRoot: string,
  options?: { createOnly?: boolean },
): Promise<void> {
  const parsed = KnowledgeSchema.parse(entry);
  if (!KNOWLEDGE_ID_REGEX.test(parsed.id)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid knowledge ID: ${parsed.id}`,
    );
  }
  const wrapDir = resolve(packRoot, ".story");
  const targetPath = join(wrapDir, "knowledge", `${parsed.id}.json`);
  await mkdir(dirname(targetPath), { recursive: true });
  await guardPath(targetPath, wrapDir);
  const json = serializeJSON(parsed);
  if (options?.createOnly) {
    await atomicCreate(targetPath, json);
  } else {
    await atomicWrite(targetPath, json);
  }
}
