import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ArrangementSchema, type Arrangement } from "../models/arrangement.js";
import { ArrangementIdSchema } from "../models/types.js";
import { DuetOperationSchema, DuetStateSchema, type DuetOperation, type DuetState, type DuetAssignment } from "../models/duet.js";
import { ownerTaskForCurrentClient } from "../autonomous/client-profile.js";
import { CliValidationError } from "../cli/helpers.js";
import { loadArrangementsSafe, ARRANGEMENT_MAX_BYTES } from "./arrangement-loader.js";
import { isArrangementConflicted } from "./arrangement-authority.js";
import { readBoundedFile } from "./limit-config.js";
import { withProjectLock, runTransactionUnlocked, serializeJSON } from "./project-loader.js";

export const DUET_STATE_MAX_BYTES = 2 * 1024 * 1024;
const SILENCE_MS = 60 * 60 * 1000;
function refuse(message: string): never { throw new CliValidationError("invalid_input", message); }
function equal(a: unknown, b: unknown): boolean { return serializeJSON(a) === serializeJSON(b); }
type Identity = { client: "claude" | "codex"; id: string };
function same(a: Identity, b: Identity): boolean { return a.client === b.client && a.id === b.id; }
function parties(a: Arrangement) {
  const pen = a.parties.find(p => p.role === "pen")!;
  const worker = a.parties.find(p => p.role === "worker")!;
  return { pen: { client: pen.client, id: pen.identityAnchor }, worker: { client: worker.client, id: worker.identityAnchor } };
}

// Reject links before mkdir, including dangling final links. Canonicalize the
// project root to permit platform aliases such as /tmp -> /private/tmp.
function checkedPath(root: string, parts: string[], create = false): string {
  let path = realpathSync(root);
  const base = path;
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]!);
    const rel = relative(base, path);
    if (rel === ".." || rel.startsWith(`..${sep}`)) refuse("Duet path escapes project");
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (i < parts.length - 1 && create) { mkdirSync(path); stat = lstatSync(path); }
      else continue;
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) refuse("Unsafe duet path: regular files and directories required");
  }
  return path;
}
function runtimePath(root: string, id: string, create = false) {
  ArrangementIdSchema.parse(id);
  return checkedPath(root, [".story", "duet-sessions", id, "state.json"], create);
}
function loadRuntime(root: string, id: string): DuetState | null {
  const path = runtimePath(root, id);
  try { lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const raw = readBoundedFile(path, DUET_STATE_MAX_BYTES);
  if (!raw) refuse("Duet recovery required: runtime is unreadable or exceeds capacity");
  const result = DuetStateSchema.safeParse(JSON.parse(raw));
  if (!result.success || result.data.arrangementId !== id) refuse("Duet recovery required: invalid runtime identity/schema");
  const state = result.data;
  if (new Set(state.assignments.map(a => a.input.id)).size !== state.assignments.length) refuse("Duet recovery required: duplicate assignment ids");
  return state;
}
export interface DuetRoute {
  status: "current" | "stale" | "missing" | "conflicted" | "recovery-required";
  mode?: "native-return" | "manager-collected";
  reason?: string;
}
export interface DuetView { arrangement: Arrangement; state: DuetState | null; route: DuetRoute }
function checkpointFor(state: DuetState) {
  return {
    revision: state.revision, sessionId: state.start.sessionId, pen: state.pen, worker: state.worker,
    assignments: state.assignments.map(assignment => {
      const { cursor: _cursor, ...rest } = assignment;
      return { ...rest, events: assignment.events.filter(e => e.input.kind !== "cursor").map(event => {
        const { cursor: _eventCursor, ...input } = event.input;
        return { ...event, input };
      }) };
    }),
  };
}
function routeFor(a: Arrangement, state: DuetState | null): DuetRoute {
  if (isArrangementConflicted(a)) return { status: "conflicted" };
  if (!a.currentCoordinationSessionId) return { status: "missing" };
  const pair = parties(a);
  if (!state || state.start.sessionId !== a.currentCoordinationSessionId || !same(pair.pen, state.pen) || !same(pair.worker, state.worker) || !equal(a.coordinationCheckpoint, checkpointFor(state))) return { status: "recovery-required" };
  const receipt = [...(a.communicationReceipts ?? [])].reverse().find(r =>
    r.coordinationSessionId === a.currentCoordinationSessionId && r.nonce === state.nonce &&
    r.mode === state.start.mode && same(r.source, pair.worker) && same(r.destination, pair.pen) && same(r.recorder, pair.pen));
  if (receipt && a.lifecycle === "active") return { status: "current", mode: receipt.mode };
  return { status: a.communicationReceipts?.length ? "stale" : "missing" };
}
export function readDuetCoordination(root: string, arrangement: Arrangement): DuetView {
  try {
    const state = loadRuntime(root, arrangement.id);
    return { arrangement, state, route: routeFor(arrangement, state) };
  } catch {
    return { arrangement, state: null, route: { status: isArrangementConflicted(arrangement) ? "conflicted" : "recovery-required", reason: "Runtime cannot be verified; recover before dispatch" } };
  }
}
export function duetStatusDemandDue(assignment: DuetAssignment, now = Date.now()): boolean {
  if (assignment.status === "resolved") return false;
  const last = Date.parse(assignment.lastWorkerActivityAt);
  if (assignment.lastStatusDemandAt && Date.parse(assignment.lastStatusDemandAt) >= last) return false;
  return now - last >= SILENCE_MS;
}
async function persist(root: string, arrangement: Arrangement, state: DuetState, recoveryBackup?: string) {
  arrangement.coordinationCheckpoint = checkpointFor(state);
  const arrangementContent = serializeJSON(ArrangementSchema.parse(arrangement));
  const stateContent = serializeJSON(DuetStateSchema.parse(state));
  if (Buffer.byteLength(arrangementContent) > ARRANGEMENT_MAX_BYTES) refuse("Arrangement receipt capacity reached; preserve this history and create a new arrangement");
  if (Buffer.byteLength(stateContent) > DUET_STATE_MAX_BYTES) refuse("Duet runtime capacity reached; preserve this history and create a new arrangement");
  const aPath = checkedPath(root, [".story", "arrangements", `${arrangement.id}.json`], true);
  const sPath = runtimePath(root, arrangement.id, true);
  const ignorePath = checkedPath(root, [".story", "duet-sessions", ".gitignore"], true);
  await runTransactionUnlocked(root, [
    { op: "write", target: ignorePath, content: "*\n" },
    ...(recoveryBackup === undefined ? [] : [{ op: "write" as const, target: checkedPath(root, [".story", "duet-sessions", arrangement.id, "recovery", `${state.start.sessionId}.json`], true), content: recoveryBackup }]),
    { op: "write", target: aPath, content: arrangementContent },
    { op: "write", target: sPath, content: stateContent },
  ]);
}

/** Operation identity and caller attribution are claims, never credentials. */
export async function coordinateDuet(root: string, input: DuetOperation): Promise<DuetView> {
  const parsed = DuetOperationSchema.safeParse(input);
  if (!parsed.success) refuse(`Invalid duet operation: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const op = parsed.data;
  let output: DuetView | undefined;
  await withProjectLock(root, { strict: true }, async () => {
    const arrangement = loadArrangementsSafe(root).arrangements.find(a => a.id === op.id);
    if (!arrangement) refuse("Arrangement missing or unreadable; cannot coordinate");
    if (arrangement.lifecycle !== "active" || isArrangementConflicted(arrangement)) refuse("Coordination requires an active, unconflicted arrangement");
    const pair = parties(arrangement);
    const actor = ownerTaskForCurrentClient(op.clientTaskId);
    if (!actor || !same(actor, pair.pen)) refuse("Only the arrangement pen may record coordination state");
    let state: DuetState | null = null;
    let recoveryBackup: string | undefined;
    try { state = loadRuntime(root, op.id); } catch {
      if (op.action !== "recover") refuse("Duet recovery required: runtime cannot be read safely");
      // Preserve corrupt-but-bounded bytes before replacing them. Unsafe paths
      // and oversized files require manual preservation, never a blind reset.
      const bytes = readBoundedFile(runtimePath(root, op.id), DUET_STATE_MAX_BYTES);
      if (bytes === null) refuse("Recovery requires preserving unreadable runtime before replacement");
      recoveryBackup = bytes;
    }
    if (op.action !== "recover" && arrangement.currentCoordinationSessionId && routeFor(arrangement, state).status === "recovery-required") refuse("Duet recovery required: historical runtime is missing or does not match arrangement");
    const finish = () => { output = { arrangement, state, route: routeFor(arrangement, state) }; };
    if ((op.action === "start" || op.action === "recover") && arrangement.currentCoordinationSessionId === op.newSessionId && state) {
      if (state.start.previousSessionId !== op.expectedSessionId || state.start.expectedRevision !== op.expectedRevision || state.start.mode !== op.mode || state.start.recoveryEvidence !== (op.action === "recover" ? op.recoveryEvidence : undefined)) refuse("Session start retry conflicts with original request");
      finish(); return;
    }
    if ((arrangement.currentCoordinationSessionId ?? null) !== op.expectedSessionId) refuse("Stale coordination session; reload before writing");
    if (!state && op.action !== "start" && op.action !== "recover") refuse("Duet recovery required: start coordination first");
    const checkRevision = () => { if ((state?.revision ?? 0) !== op.expectedRevision) refuse("Stale duet revision; reload before writing"); };
    const now = new Date().toISOString();
    if (op.action === "recover") {
      const checkpoint = arrangement.coordinationCheckpoint;
      if (routeFor(arrangement, state).status !== "recovery-required") refuse("Runtime is healthy; use start to rotate normally");
      if (state) refuse("Readable runtime diverges from checkpoint; preserve and reconcile both histories before recovery");
      if (!checkpoint || checkpoint.sessionId !== op.expectedSessionId || checkpoint.revision !== op.expectedRevision || !same(checkpoint.pen, pair.pen) || !same(checkpoint.worker, pair.worker)) refuse("Recovery checkpoint does not match session, revision and parties");
      if (op.newSessionId === op.expectedSessionId || (arrangement.communicationReceipts ?? []).some(r => r.coordinationSessionId === op.newSessionId)) refuse("Recovery requires a fresh coordination session id");
      state = { schemaVersion: 1, arrangementId: op.id, revision: checkpoint.revision, start: { sessionId: op.newSessionId, previousSessionId: op.expectedSessionId, expectedRevision: op.expectedRevision, mode: op.mode, recoveryEvidence: op.recoveryEvidence }, nonce: randomUUID(), ...pair, assignments: checkpoint.assignments };
      arrangement.currentCoordinationSessionId = op.newSessionId;
    } else if (op.action === "start") {
      checkRevision();
      if (state && !arrangement.currentCoordinationSessionId) refuse("Duet recovery required: orphan runtime");
      if ((arrangement.communicationReceipts ?? []).some(r => r.coordinationSessionId === op.newSessionId)) refuse("Coordination session id has already been used");
      state = { schemaVersion: 1, arrangementId: op.id, revision: state?.revision ?? 0, start: { sessionId: op.newSessionId, previousSessionId: op.expectedSessionId, expectedRevision: op.expectedRevision, mode: op.mode }, nonce: randomUUID(), ...pair, assignments: state?.assignments ?? [] };
      arrangement.currentCoordinationSessionId = op.newSessionId;
    } else if (op.action === "receipt") {
      const receipt = op.receipt;
      if (receipt.nonce !== state!.nonce || receipt.mode !== state!.start.mode || !same(receipt.source, pair.worker) || !same(receipt.destination, pair.pen)) refuse("Receipt does not match current challenge, mode and parties");
      const existing = arrangement.communicationReceipts?.find(r => r.coordinationSessionId === op.expectedSessionId && r.id === receipt.id);
      if (existing) {
        const { coordinationSessionId: _s, recorder: _r, ...content } = existing;
        if (!equal(content, receipt)) refuse("Receipt retry conflicts with immutable evidence");
        finish(); return;
      }
      checkRevision();
      if (Date.parse(receipt.observedAt) > Date.now() + 300_000) refuse("Receipt observation is in the future");
      arrangement.communicationReceipts = [...(arrangement.communicationReceipts ?? []), { ...receipt, coordinationSessionId: op.expectedSessionId, recorder: pair.pen }];
    } else if (op.action === "assign") {
      const existing = state!.assignments.find(a => a.input.id === op.assignment.id);
      if (existing) {
        if (!equal(existing.input, op.assignment)) refuse("Assignment id already has a different immutable scope");
        finish(); return;
      }
      checkRevision();
      if (routeFor(arrangement, state).status !== "current") refuse("Verify the return route before dispatch");
      state!.assignments.push({ input: op.assignment, dispatchSessionId: op.expectedSessionId, assignee: pair.worker, status: "assigned", createdAt: now, lastWorkerActivityAt: now, events: [] });
    } else {
      const assignment = state!.assignments.find(a => a.input.id === op.assignmentId);
      if (!assignment) refuse("Unknown assignment; recover its identity before updating");
      const event = op.event;
      const existing = assignment.events.find(e => e.input.id === event.id);
      if (existing) {
        if (!equal(existing.input, event)) refuse("Event retry conflicts with original content");
        finish(); return;
      }
      if (event.kind === "report") {
        const duplicate = assignment.events.find(e => e.input.kind === "report" && e.input.reportId === event.reportId);
        if (duplicate) {
          const { id: _oldId, ...oldContent } = duplicate.input;
          const { id: _newId, ...newContent } = event;
          if (!equal(oldContent, newContent)) refuse("Report id conflicts with recorded report");
          finish(); return;
        }
      }
      checkRevision();
      if (assignment.status === "resolved") refuse("Resolved assignments cannot be reopened");
      if (event.kind === "review") {
        const latest = [...assignment.events].reverse().find(e => e.input.kind === "report");
        if (assignment.status !== "needs-review" || latest?.input.reportId !== event.reportId) refuse("Review must acknowledge the latest reported result");
        assignment.status = "resolved";
      }
      if (event.kind === "report") assignment.status = "needs-review";
      if (event.kind === "question") assignment.status = "needs-attention";
      if (["progress", "question", "report"].includes(event.kind)) assignment.lastWorkerActivityAt = now;
      if (event.kind === "cursor") {
        if (event.cursor === undefined) refuse("Cursor event requires a collection cursor");
        assignment.cursor = event.cursor;
      }
      if (event.kind === "status-demand") {
        if (!duetStatusDemandDue(assignment)) refuse("Status demand requires 60 silent minutes and no previous demand in this interval");
        assignment.lastStatusDemandAt = now;
      }
      assignment.events.push({ input: event, recordedAt: now });
    }
    state!.revision++;
    arrangement.updatedAt = now;
    await persist(root, arrangement, state!, recoveryBackup);
    finish();
  });
  return output!;
}
