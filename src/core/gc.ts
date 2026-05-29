import type { ProjectState } from "./project-state.js";
import type { Ticket } from "../models/ticket.js";
import type { Issue } from "../models/issue.js";
import type { Lesson } from "../models/lesson.js";

export interface GcCandidate {
  type: "ticket" | "issue" | "note" | "lesson";
  id: string;
  deletedAt: string;
  deletedBy: string;
  age: number;
  activeReferences: string[];
}

export interface GcPlan {
  candidates: GcCandidate[];
  blocked: GcCandidate[];
  eligible: GcCandidate[];
  warnings: string[];
  retentionDays: number;
}

export interface GcOptions {
  retentionDays?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeGcPlan(state: ProjectState, options?: GcOptions): GcPlan {
  const retentionDays = options?.retentionDays ?? 30;
  const now = Date.now();
  const candidates: GcCandidate[] = [];
  const warnings: string[] = [];

  // ISS-711: capture the candidate's id + displayId + previousDisplayIds into
  // candidateByRef during collection (the source record is in scope here),
  // instead of re-scanning every state collection per candidate afterward.
  const candidateIds = new Set<string>();
  const candidateByRef = new Map<string, GcCandidate>();

  function collectDeleted(
    items: readonly { id: string }[],
    type: GcCandidate["type"],
  ): void {
    for (const item of items) {
      const rec = item as Record<string, unknown>;
      if (rec.lifecycle !== "deleted") continue;

      const deletedAt = rec.deletedAt as string | undefined;
      if (!deletedAt || typeof deletedAt !== "string") {
        warnings.push(`${item.id}: missing deletedAt`);
        continue;
      }

      const ts = Date.parse(deletedAt);
      if (Number.isNaN(ts)) {
        warnings.push(`${item.id}: invalid deletedAt "${deletedAt}"`);
        continue;
      }

      if (ts > now) {
        warnings.push(`${item.id}: future deletedAt "${deletedAt}"`);
        continue;
      }

      const age = Math.floor((now - ts) / MS_PER_DAY);
      if (age < retentionDays) continue;

      const candidate: GcCandidate = {
        type,
        id: item.id,
        deletedAt,
        deletedBy: (rec.deletedBy as string) ?? "unknown",
        age,
        activeReferences: [],
      };
      candidates.push(candidate);

      candidateIds.add(item.id);
      candidateByRef.set(item.id, candidate);
      if (typeof rec.displayId === "string") candidateByRef.set(rec.displayId, candidate);
      if (Array.isArray(rec.previousDisplayIds)) {
        for (const prev of rec.previousDisplayIds) {
          if (typeof prev === "string") candidateByRef.set(prev, candidate);
        }
      }
    }
  }

  collectDeleted(state.tickets, "ticket");
  collectDeleted(state.issues, "issue");
  collectDeleted(state.notes, "note");
  collectDeleted(state.lessons, "lesson");

  function findCandidate(ref: string): GcCandidate | undefined {
    return candidateByRef.get(ref);
  }

  for (const t of state.activeTickets as readonly Ticket[]) {
    if (candidateIds.has(t.id)) continue;
    for (const bid of t.blockedBy ?? []) {
      const c = findCandidate(bid);
      if (c) c.activeReferences.push(t.id);
    }
    if (t.parentTicket) {
      const c = findCandidate(t.parentTicket);
      if (c) c.activeReferences.push(t.id);
    }
  }

  for (const i of state.activeIssues as readonly Issue[]) {
    if (candidateIds.has(i.id)) continue;
    for (const tref of i.relatedTickets ?? []) {
      const c = findCandidate(tref);
      if (c) c.activeReferences.push(i.id);
    }
  }

  // supersedes is a real canonical cross-ref (LessonIdSchema): a tombstoned lesson
  // still referenced by an active lesson's supersedes must be protected, not purged.
  // (?? [] guards partial state objects that omit activeLessons.)
  for (const l of (state.activeLessons ?? []) as readonly Lesson[]) {
    if (candidateIds.has(l.id)) continue;
    if (l.supersedes) {
      const c = findCandidate(l.supersedes);
      if (c) c.activeReferences.push(l.id);
    }
  }

  const blocked = candidates.filter((c) => c.activeReferences.length > 0);
  const eligible = candidates.filter((c) => c.activeReferences.length === 0);

  return { candidates, blocked, eligible, warnings, retentionDays };
}
