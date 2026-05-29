import { displayIdOf } from "./resolver.js";
import { execFileSync } from "node:child_process";
import type { ProjectState } from "./project-state.js";

export interface ReservationTagResult {
  tags: Map<string, Set<string>>;
  owners: Map<string, Map<string, string | null>>;
  fetchError?: string;
}

export interface ReservationHealth {
  valid: Map<string, Set<string>>;
  orphan: Map<string, Set<string>>;
  mismatched: Map<string, Set<string>>;
}

const REF_PREFIX = "refs/storybloq/ids/";

const TYPE_MAP: Record<string, string> = {
  tickets: "ticket",
  issues: "issue",
  notes: "note",
  lessons: "lesson",
};

function parseRef(refName: string): { entityType: string; displayId: string } | null {
  if (!refName.startsWith(REF_PREFIX)) return null;
  const rest = refName.substring(REF_PREFIX.length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) return null;
  const plural = rest.substring(0, slashIdx);
  const displayId = rest.substring(slashIdx + 1);
  const entityType = TYPE_MAP[plural];
  if (!entityType || !displayId) return null;
  return { entityType, displayId };
}

export function fetchLocalReservationTags(root: string): ReservationTagResult {
  const tags = new Map<string, Set<string>>();
  const owners = new Map<string, Map<string, string | null>>();

  try {
    const stdout = execFileSync("git", ["for-each-ref", "--format=%(refname) %(objectname)", "refs/storybloq/ids"], {
      cwd: root,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    if (!stdout) return { tags, owners };

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [refName, objectId] = trimmed.split(/\s+/, 2);
      if (!refName) continue;
      const parsed = parseRef(refName);
      if (!parsed) continue;
      let set = tags.get(parsed.entityType);
      if (!set) {
        set = new Set();
        tags.set(parsed.entityType, set);
      }
      set.add(parsed.displayId);
      let ownerByDisplay = owners.get(parsed.entityType);
      if (!ownerByDisplay) {
        ownerByDisplay = new Map();
        owners.set(parsed.entityType, ownerByDisplay);
      }
      ownerByDisplay.set(parsed.displayId, readOwner(root, objectId));
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { tags, owners, fetchError: message };
  }

  return { tags, owners };
}

function readOwner(root: string, objectId?: string): string | null {
  if (!objectId) return null;
  try {
    const payload = execFileSync("git", ["cat-file", "-p", objectId], {
      cwd: root,
      encoding: "utf-8",
      timeout: 5000,
    });
    const parsed = JSON.parse(payload) as { ownerId?: unknown };
    return typeof parsed.ownerId === "string" ? parsed.ownerId : null;
  } catch {
    return null;
  }
}

function itemsByDisplayId(items: readonly { id: string; displayId?: string | null }[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const item of items) {
    const displayId = displayIdOf(item);
    const ids = map.get(displayId);
    if (ids) ids.push(item.id);
    else map.set(displayId, [item.id]);
  }
  return map;
}

export function classifyReservations(
  tagsOrResult: Map<string, Set<string>> | ReservationTagResult,
  state: ProjectState,
): ReservationHealth {
  const tags = tagsOrResult instanceof Map ? tagsOrResult : tagsOrResult.tags;
  const owners = tagsOrResult instanceof Map ? new Map<string, Map<string, string | null>>() : tagsOrResult.owners;
  const valid = new Map<string, Set<string>>();
  const orphan = new Map<string, Set<string>>();
  const mismatched = new Map<string, Set<string>>();

  const itemsByType: Record<string, readonly { id: string; displayId?: string | null }[]> = {
    ticket: state.tickets,
    issue: state.issues,
    note: state.notes,
    lesson: state.lessons,
  };

  for (const [entityType, reservedIds] of tags) {
    const items = itemsByType[entityType];
    if (!items) continue;

    const existingIds = itemsByDisplayId(items);
    const validSet = new Set<string>();
    const orphanSet = new Set<string>();
    const mismatchedSet = new Set<string>();
    const ownerByDisplay = owners.get(entityType);

    for (const displayId of reservedIds) {
      const ownerId = ownerByDisplay?.get(displayId) ?? null;
      const itemIds = existingIds.get(displayId);
      if (!itemIds) {
        orphanSet.add(displayId);
      } else if (ownerId && !itemIds.includes(ownerId)) {
        mismatchedSet.add(displayId);
      } else {
        validSet.add(displayId);
      }
    }

    if (validSet.size > 0) valid.set(entityType, validSet);
    if (orphanSet.size > 0) orphan.set(entityType, orphanSet);
    if (mismatchedSet.size > 0) mismatched.set(entityType, mismatchedSet);
  }

  return { valid, orphan, mismatched };
}
