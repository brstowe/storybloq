import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { threeWayMerge, mergeConfig, mergeRoadmap, type MergeResult } from "../../core/merge-driver.js";
import type { EntityType } from "../../core/field-classification.js";

function entityTypeFromPath(pathname: string): EntityType | null {
  const dir = basename(dirname(pathname));
  switch (dir) {
    case "tickets": return "ticket";
    case "issues": return "issue";
    case "notes": return "note";
    case "lessons": return "lesson";
    default: return null;
  }
}

type MergeStrategy =
  | { kind: "entity"; entityType: EntityType }
  | { kind: "config" }
  | { kind: "roadmap" };

function strategyFromPath(pathname: string): MergeStrategy | null {
  const file = basename(pathname);
  if (file === "config.json") return { kind: "config" };
  if (file === "roadmap.json") return { kind: "roadmap" };
  const entityType = entityTypeFromPath(pathname);
  if (entityType) return { kind: "entity", entityType };
  return null;
}

export function handleMergeDriver(
  ancestorPath: string,
  oursPath: string,
  theirsPath: string,
  pathname: string,
): number {
  const strategy = strategyFromPath(pathname);
  if (!strategy) return 2;

  let base: Record<string, unknown>;
  let ours: Record<string, unknown>;
  let theirs: Record<string, unknown>;

  try {
    // An add/add conflict has no common ancestor, so git supplies an empty file
    // as %O. Treat an empty/whitespace ancestor as an empty base object so the
    // merge can still run: identical content on both sides merges clean, while
    // genuine field divergence (including displayId) still surfaces as a
    // structured _conflicts block rather than raw git conflict markers.
    const rawBase = readFileSync(ancestorPath, "utf-8");
    base = rawBase.trim() === "" ? {} : JSON.parse(rawBase);
    ours = JSON.parse(readFileSync(oursPath, "utf-8"));
    theirs = JSON.parse(readFileSync(theirsPath, "utf-8"));
  } catch {
    return 2;
  }

  if (typeof base !== "object" || base === null || Array.isArray(base)) return 2;
  if (typeof ours !== "object" || ours === null || Array.isArray(ours)) return 2;
  if (typeof theirs !== "object" || theirs === null || Array.isArray(theirs)) return 2;

  let result: MergeResult;
  try {
    if (strategy.kind === "config") {
      result = mergeConfig(base, ours, theirs);
    } else if (strategy.kind === "roadmap") {
      result = mergeRoadmap(base, ours, theirs);
    } else {
      result = threeWayMerge(base, ours, theirs, strategy.entityType);
    }
  } catch {
    return 2;
  }

  try {
    writeFileSync(oursPath, JSON.stringify(result.merged, null, 2) + "\n", "utf-8");
  } catch {
    return 2;
  }

  return result.clean ? 0 : 1;
}
