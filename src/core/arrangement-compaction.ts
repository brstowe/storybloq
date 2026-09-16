import { ArrangementSchema, type Arrangement } from "../models/arrangement.js";
import {
  assignmentIdOf,
  isCompactedAssignment,
  type ArchivedAssignment,
  type CheckpointAssignment,
  type CompactedAssignment,
  type DuetAssignment,
  type DuetCheckpoint,
  type DuetState,
} from "../models/duet.js";
import { serializeJSON } from "./project-loader.js";
import { ARRANGEMENT_MAX_BYTES } from "./arrangement-loader.js";

/**
 * ISS-1191: arrangement capacity is a CHECKPOINT problem, not a receipts
 * problem. On the two measured files that hit the 64 KiB wall, one receipt
 * held about 550 bytes while `coordinationCheckpoint.assignments` held
 * 50,655 bytes across 12 assignments -- 30,857 of it in RESOLVED work that
 * nothing ever pruned, because every event carries its own full `input`
 * payload alongside the assignment's own.
 *
 * The design constraint that shapes this whole module is `routeFor`'s
 * equality check: the tracked checkpoint must equal a projection RECOMPUTED
 * from the runtime, or the duet reads as `recovery-required`. So compaction
 * splits in two:
 *
 * - `projectCheckpoint` is SIZE-INDEPENDENT and is the only thing that
 *   consistency checking ever uses. Same runtime plus same archive, same
 *   bytes -- for ever, regardless of how large the arrangement grew, what
 *   else was edited in it, or whether a `recover` has since rebuilt the
 *   runtime from a checkpoint.
 * - `compactCheckpoint` is the only size-AWARE function and runs on write
 *   paths only. It can EXTEND the archive; it can never shrink it, so a
 *   later size drop can never un-archive an id and flip a healthy duet to
 *   `recovery-required`.
 *
 * Nothing here deletes: a resolved assignment is first reduced (its last
 * event kept), and only if that still does not fit is it moved to
 * `compactedAssignments` as a tombstone carrying its id and resolution time.
 */

/** Above this share of the cap, reduction alone is not trusted to hold. */
export const ARRANGEMENT_COMPACT_THRESHOLD = 0.8;
/** How many reduced resolved assignments stay in the checkpoint verbatim. */
export const ARRANGEMENT_COMPACT_KEEP_RESOLVED = 5;

export type ProjectionResult =
  | { ok: true; checkpoint: DuetCheckpoint }
  | { ok: false; reason: string };

function statusOf(assignment: CheckpointAssignment): string {
  return assignment.status;
}

/**
 * Resolution time from RETAINED EVIDENCE, never the clock: a tombstone
 * minted from `Date.now()` would differ on every recomputation and break
 * projection stability outright.
 */
function resolvedAtOf(assignment: CheckpointAssignment): string {
  const events = assignment.events;
  const review = [...events].reverse().find((e) => e.input.kind === "review");
  return review?.recordedAt ?? events[events.length - 1]?.recordedAt ?? assignment.lastWorkerActivityAt;
}

/** Harness cursors are local by contract and never enter a tracked file. */
function withoutCursors(assignment: DuetAssignment): DuetAssignment {
  const { cursor: _cursor, ...rest } = assignment;
  return {
    ...rest,
    events: assignment.events
      .filter((e) => e.input.kind !== "cursor")
      .map((event) => {
        const { cursor: _eventCursor, ...input } = event.input;
        return { ...event, input };
      }),
  } as DuetAssignment;
}

/** The reduced record: identity, timing, and the LAST event as evidence. */
function reduce(assignment: DuetAssignment): CompactedAssignment {
  const last = assignment.events[assignment.events.length - 1];
  return {
    id: assignment.input.id,
    compacted: true,
    status: "resolved",
    dispatchSessionId: assignment.dispatchSessionId,
    assignee: assignment.assignee,
    createdAt: assignment.createdAt,
    lastWorkerActivityAt: assignment.lastWorkerActivityAt,
    events: last === undefined ? [] : [last],
  };
}

function sortArchive(archive: readonly ArchivedAssignment[]): ArchivedAssignment[] {
  return [...archive].sort((a, b) => (a.resolvedAt === b.resolvedAt ? a.id.localeCompare(b.id) : a.resolvedAt.localeCompare(b.resolvedAt)));
}

/**
 * The canonical, size-independent tracked projection of a runtime state.
 *
 * Fails (rather than silently dropping) when an ARCHIVED id is carried by a
 * runtime assignment that is not resolved. Dropping it would hide a real
 * divergence behind a checkpoint that still compares equal: the archive
 * would describe that id as resolved history while the runtime describes it
 * as live work.
 */
export function projectCheckpoint(state: DuetState, archive: readonly ArchivedAssignment[]): ProjectionResult {
  const archived = new Set(archive.map((entry) => entry.id));
  const kept: CheckpointAssignment[] = [];
  for (const assignment of state.assignments) {
    const id = assignmentIdOf(assignment);
    if (archived.has(id)) {
      if (statusOf(assignment) !== "resolved") {
        return { ok: false, reason: `Assignment ${id} is archived as resolved history but is ${statusOf(assignment)} in the runtime` };
      }
      continue;
    }
    if (isCompactedAssignment(assignment)) {
      kept.push({ ...assignment, events: assignment.events.filter((e) => e.input.kind !== "cursor" && e.input.cursor === undefined) });
      continue;
    }
    const clean = withoutCursors(assignment);
    kept.push(clean.status === "resolved" ? reduce(clean) : clean);
  }
  const sorted = sortArchive(archive);
  return {
    ok: true,
    checkpoint: {
      revision: state.revision,
      sessionId: state.start.sessionId,
      pen: state.pen,
      worker: state.worker,
      assignments: kept,
      ...(sorted.length > 0 && { compactedAssignments: sorted }),
    },
  };
}

/**
 * The pre-ISS-1191 projection, kept for exactly one purpose: recognizing an
 * arrangement written by an older client as consistent instead of flipping
 * every live duet to `recovery-required` on upgrade. See
 * `checkpointMatches` for the conditions under which it still counts.
 */
export function legacyProjectCheckpoint(state: DuetState): DuetCheckpoint | null {
  if (state.assignments.some(isCompactedAssignment)) return null;
  return {
    revision: state.revision,
    sessionId: state.start.sessionId,
    pen: state.pen,
    worker: state.worker,
    assignments: (state.assignments as DuetAssignment[]).map(withoutCursors),
  };
}

/** The bytes this arrangement would occupy carrying `checkpoint`. */
export function projectedArrangementBytes(arrangement: Arrangement, checkpoint: DuetCheckpoint): number {
  const candidate = { ...arrangement, coordinationCheckpoint: checkpoint };
  const parsed = ArrangementSchema.safeParse(candidate);
  return Buffer.byteLength(serializeJSON(parsed.success ? parsed.data : candidate));
}

/**
 * The write-path projection: reduce first, and only if the result still
 * exceeds `ARRANGEMENT_COMPACT_THRESHOLD` of the cap, move the oldest
 * resolved assignments past `ARRANGEMENT_COMPACT_KEEP_RESOLVED` into the
 * archive and project again.
 */
export function compactCheckpoint(arrangement: Arrangement, state: DuetState): ProjectionResult {
  const archive = arrangement.coordinationCheckpoint?.compactedAssignments ?? [];
  const reduced = projectCheckpoint(state, archive);
  if (!reduced.ok) return reduced;
  const limit = ARRANGEMENT_MAX_BYTES * ARRANGEMENT_COMPACT_THRESHOLD;
  if (projectedArrangementBytes(arrangement, reduced.checkpoint) <= limit) return reduced;

  const resolved = reduced.checkpoint.assignments
    .filter((a) => statusOf(a) === "resolved")
    .sort((a, b) => (a.createdAt === b.createdAt ? assignmentIdOf(a).localeCompare(assignmentIdOf(b)) : a.createdAt.localeCompare(b.createdAt)));
  const overflow = resolved.slice(0, Math.max(0, resolved.length - ARRANGEMENT_COMPACT_KEEP_RESOLVED));
  if (overflow.length === 0) return reduced;
  const extended = [...archive, ...overflow.map((a) => ({ id: assignmentIdOf(a), resolvedAt: resolvedAtOf(a) }))];
  return projectCheckpoint(state, extended);
}

/**
 * Whether the arrangement's stored checkpoint is a faithful record of this
 * runtime. The single place that verdict is computed, so route status,
 * `compact` and `rotate` can never disagree about it.
 */
export function checkpointMatches(arrangement: Arrangement, state: DuetState): boolean {
  const stored = arrangement.coordinationCheckpoint;
  if (!stored) return false;
  const canonical = projectCheckpoint(state, stored.compactedAssignments ?? []);
  if (!canonical.ok) return false;
  if (serializeJSON(stored) === serializeJSON(canonical.checkpoint)) return true;
  // Delimited legacy tolerance: only an unambiguously pre-ISS-1191
  // checkpoint (no archive, no reduced entry) may match the old projection.
  if (stored.compactedAssignments !== undefined || stored.assignments.some(isCompactedAssignment)) return false;
  const legacy = legacyProjectCheckpoint(state);
  return legacy !== null && serializeJSON(stored) === serializeJSON(legacy);
}

export interface ArrangementCapacity {
  bytes: number;
  max: number;
  pct: number;
  checkpointBytes: number;
}

/** What `arrangement get` and `earmark get` report (ISS-1191 scope item 3). */
export function arrangementCapacity(arrangement: Arrangement): ArrangementCapacity {
  const parsed = ArrangementSchema.safeParse(arrangement);
  const bytes = Buffer.byteLength(serializeJSON(parsed.success ? parsed.data : arrangement));
  const checkpoint = arrangement.coordinationCheckpoint;
  return {
    bytes,
    max: ARRANGEMENT_MAX_BYTES,
    pct: Math.round((bytes / ARRANGEMENT_MAX_BYTES) * 1000) / 10,
    checkpointBytes: checkpoint === undefined ? 0 : Buffer.byteLength(serializeJSON(checkpoint)),
  };
}
