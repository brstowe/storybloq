import type { Ticket } from "../models/ticket.js";
import type { Issue } from "../models/issue.js";
import type { Note } from "../models/note.js";
import type { Lesson } from "../models/lesson.js";
import type { ProjectState } from "./project-state.js";
import { TICKET_ID_REGEX, ISSUE_ID_REGEX, NOTE_ID_REGEX, LESSON_ID_REGEX } from "../models/types.js";
import { maxSequentialNumber } from "./id-allocation.js";
import { compareByRank, rebalanceRanks, REBALANCE_THRESHOLD } from "./fractional-index.js";

const TICKET_NUMERIC_REGEX = /^T-(\d+)[a-z]?$/;
const ISSUE_NUMERIC_REGEX = /^ISS-(\d+)$/;
const NOTE_NUMERIC_REGEX = /^N-(\d+)$/;
const LESSON_NUMERIC_REGEX = /^L-(\d+)$/;

export type EntityType = "ticket" | "issue" | "note" | "lesson";

export interface ReconcileRename {
  entityType: EntityType;
  id: string;
  oldDisplayId: string;
  newDisplayId: string;
  reason: string;
}

export interface ReconcileWarning {
  message: string;
}

export interface ReconcilePlan {
  renames: ReconcileRename[];
  warnings: ReconcileWarning[];
}

export type ReconcileResult =
  | { ok: true; plan: ReconcilePlan }
  | { ok: false; errors: string[] };

interface Resolvable {
  id: string;
  displayId?: string | null;
  previousDisplayIds?: string[] | null;
}

interface EntityWithTimestamp extends Resolvable {
  _conflicts?: unknown[] | null;
}

function effectiveDisplayId(item: Resolvable): string {
  return item.displayId ?? item.id;
}

function getEntityTimestamp(entityType: EntityType, entity: Record<string, unknown>): string | null {
  const field = entityType === "issue" ? "discoveredDate" : "createdDate";
  const value = entity[field];
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  if (isNaN(parsed)) return null;
  return value;
}

function isLegacyId(entityType: EntityType, id: string): boolean {
  switch (entityType) {
    case "ticket": return TICKET_ID_REGEX.test(id);
    case "issue": return ISSUE_ID_REGEX.test(id);
    case "note": return NOTE_ID_REGEX.test(id);
    case "lesson": return LESSON_ID_REGEX.test(id);
  }
}

function hasLegacyPriority(entityType: EntityType, item: Resolvable): boolean {
  return isLegacyId(entityType, item.id) && effectiveDisplayId(item) === item.id;
}

function compareEntities(
  entityType: EntityType,
  a: EntityWithTimestamp & Record<string, unknown>,
  b: EntityWithTimestamp & Record<string, unknown>,
): number {
  const aLegacy = hasLegacyPriority(entityType, a);
  const bLegacy = hasLegacyPriority(entityType, b);
  if (aLegacy && !bLegacy) return -1;
  if (!aLegacy && bLegacy) return 1;

  const aTs = getEntityTimestamp(entityType, a);
  const bTs = getEntityTimestamp(entityType, b);
  if (aTs !== null && bTs === null) return -1;
  if (aTs === null && bTs !== null) return 1;
  if (aTs !== null && bTs !== null && aTs !== bTs) {
    return aTs < bTs ? -1 : 1;
  }

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function hasConflicts(entity: EntityWithTimestamp): boolean {
  const c = entity._conflicts;
  return Array.isArray(c) && c.length > 0;
}

function reconcileEntityType<T extends EntityWithTimestamp & Record<string, unknown>>(
  entityType: EntityType,
  items: readonly T[],
  displayPrefix: string,
  numericRegex: RegExp,
): { renames: ReconcileRename[]; nextSeq: number } {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const did = effectiveDisplayId(item);
    let group = groups.get(did);
    if (!group) {
      group = [];
      groups.set(did, group);
    }
    group.push(item);
  }

  let nextSeq = maxSequentialNumber(items as readonly Resolvable[], numericRegex) + 1;
  const renames: ReconcileRename[] = [];

  for (const [displayId, group] of groups) {
    if (group.length <= 1) continue;

    const sorted = [...group].sort((a, b) => compareEntities(entityType, a, b));
    const winner = sorted[0]!;
    const losers = sorted.slice(1);

    for (const loser of losers) {
      const newDisplayId = `${displayPrefix}${String(nextSeq).padStart(3, "0")}`;
      nextSeq++;

      const winnerLabel = hasLegacyPriority(entityType, winner)
        ? "legacy ID priority"
        : getEntityTimestamp(entityType, winner as Record<string, unknown>) !== null &&
            getEntityTimestamp(entityType, loser as Record<string, unknown>) === null
          ? "valid timestamp vs missing"
          : getEntityTimestamp(entityType, winner as Record<string, unknown>) !== null &&
              getEntityTimestamp(entityType, loser as Record<string, unknown>) !== null &&
              getEntityTimestamp(entityType, winner as Record<string, unknown>) !== getEntityTimestamp(entityType, loser as Record<string, unknown>)
            ? "earlier timestamp"
            : "lower canonical ID";

      renames.push({
        entityType,
        id: loser.id,
        oldDisplayId: displayId,
        newDisplayId,
        reason: `${effectiveDisplayId(winner)} wins (${winnerLabel})`,
      });
    }
  }

  return { renames, nextSeq };
}

export function computeReconcilePlan(state: ProjectState): ReconcileResult {
  const errors: string[] = [];

  for (const t of state.tickets) {
    if (hasConflicts(t as EntityWithTimestamp)) {
      errors.push(`Unresolved conflict on ticket ${t.id}. Run 'storybloq resolve' first.`);
    }
  }
  for (const i of state.issues) {
    if (hasConflicts(i as EntityWithTimestamp)) {
      errors.push(`Unresolved conflict on issue ${i.id}. Run 'storybloq resolve' first.`);
    }
  }
  for (const n of state.notes) {
    if (hasConflicts(n as EntityWithTimestamp)) {
      errors.push(`Unresolved conflict on note ${n.id}. Run 'storybloq resolve' first.`);
    }
  }
  for (const l of state.lessons) {
    if (hasConflicts(l as EntityWithTimestamp)) {
      errors.push(`Unresolved conflict on lesson ${l.id}. Run 'storybloq resolve' first.`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const tickets = reconcileEntityType("ticket", state.tickets as (Ticket & Record<string, unknown>)[], "T-", TICKET_NUMERIC_REGEX);
  const issues = reconcileEntityType("issue", state.issues as (Issue & Record<string, unknown>)[], "ISS-", ISSUE_NUMERIC_REGEX);
  const notes = reconcileEntityType("note", state.notes as (Note & Record<string, unknown>)[], "N-", NOTE_NUMERIC_REGEX);
  const lessons = reconcileEntityType("lesson", state.lessons as (Lesson & Record<string, unknown>)[], "L-", LESSON_NUMERIC_REGEX);

  const renames = [...tickets.renames, ...issues.renames, ...notes.renames, ...lessons.renames];
  const warnings: ReconcileWarning[] = [];

  const renamedDisplayIds = new Set(renames.map((r) => r.oldDisplayId));
  for (const t of state.tickets) {
    for (const ref of t.blockedBy) {
      if (renamedDisplayIds.has(ref)) {
        warnings.push({ message: `Ticket ${effectiveDisplayId(t)} has blockedBy ref '${ref}' which was renumbered. Verify ref is canonical.` });
      }
    }
    if (t.parentTicket && renamedDisplayIds.has(t.parentTicket)) {
      warnings.push({ message: `Ticket ${effectiveDisplayId(t)} has parentTicket ref '${t.parentTicket}' which was renumbered. Verify ref is canonical.` });
    }
  }
  for (const i of state.issues) {
    for (const ref of i.relatedTickets) {
      if (renamedDisplayIds.has(ref)) {
        warnings.push({ message: `Issue ${effectiveDisplayId(i)} has relatedTickets ref '${ref}' which was renumbered. Verify ref is canonical.` });
      }
    }
  }

  return { ok: true, plan: { renames, warnings } };
}

export interface RebalanceChange {
  entityType: "ticket" | "issue";
  id: string;
  phase: string | null;
  oldRank: string;
  newRank: string;
}

export interface RebalanceResult {
  changes: RebalanceChange[];
  phasesRebalanced: number;
}

export function computeRebalancePlan(state: ProjectState): RebalanceResult {
  const changes: RebalanceChange[] = [];
  let phasesRebalanced = 0;

  const phases = state.roadmap?.phases ?? [];
  for (const phase of phases) {
    const tickets = state.phaseTickets(phase.id);
    const ranked = tickets.filter((t) => {
      if (t.rank == null) return false;
      if ((t as Record<string, unknown>)._conflicts) return false;
      return true;
    });

    if (ranked.length === 0) continue;

    const needsRebalance = ranked.some((t) => t.rank!.length > REBALANCE_THRESHOLD);
    if (!needsRebalance) continue;

    const sorted = [...ranked].sort(compareByRank);
    const freshRanks = rebalanceRanks(sorted.length);

    let phaseChanged = false;
    for (let i = 0; i < sorted.length; i++) {
      const oldRank = sorted[i]!.rank!;
      const newRank = freshRanks[i]!;
      if (oldRank !== newRank) {
        changes.push({
          entityType: "ticket",
          id: sorted[i]!.id,
          phase: phase.id,
          oldRank,
          newRank,
        });
        phaseChanged = true;
      }
    }
    if (phaseChanged) phasesRebalanced++;
  }

  return { changes, phasesRebalanced };
}
