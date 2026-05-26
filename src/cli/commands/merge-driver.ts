import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { threeWayMerge } from "../../core/merge-driver.js";
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

export function handleMergeDriver(
  ancestorPath: string,
  oursPath: string,
  theirsPath: string,
  pathname: string,
): number {
  const entityType = entityTypeFromPath(pathname);
  if (!entityType) return 2;

  let base: Record<string, unknown>;
  let ours: Record<string, unknown>;
  let theirs: Record<string, unknown>;

  try {
    base = JSON.parse(readFileSync(ancestorPath, "utf-8"));
    ours = JSON.parse(readFileSync(oursPath, "utf-8"));
    theirs = JSON.parse(readFileSync(theirsPath, "utf-8"));
  } catch {
    return 2;
  }

  const result = threeWayMerge(base, ours, theirs, entityType);

  try {
    writeFileSync(oursPath, JSON.stringify(result.merged, null, 2) + "\n", "utf-8");
  } catch {
    return 2;
  }

  return result.clean ? 0 : 1;
}
