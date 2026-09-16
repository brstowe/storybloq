import { z } from "zod";
import { ArrangementIdSchema, CLIENT_TASK_ID_PATTERN } from "./types.js";

const key = z.string().min(1).max(128).regex(CLIENT_TASK_ID_PATTERN);
const text = z.string().max(4000);
const texts = z.array(text).max(50);
export const CoordinationSessionIdSchema = z.string().uuid();
export const DuetIdentitySchema = z.object({ client: z.enum(["claude", "codex"]), id: key }).strict();
export const DuetModeSchema = z.enum(["native-return", "manager-collected"]);
export const ReceiptInputSchema = z.object({
  id: key,
  nonce: z.string().uuid(),
  direction: z.literal("worker-to-manager"),
  source: DuetIdentitySchema,
  destination: DuetIdentitySchema,
  mode: DuetModeSchema,
  senderTool: key.nullable(),
  collectionTool: key.nullable(),
  observedAt: z.string().datetime(),
}).strict().superRefine((v, ctx) => {
  if (v.mode === "native-return" ? !v.senderTool : v.senderTool !== null || !v.collectionTool) {
    ctx.addIssue({ code: "custom", message: "Native return requires a sender; collected return requires a null sender and a collection tool" });
  }
});
export const CommunicationReceiptSchema = z.object({
  ...ReceiptInputSchema.innerType().shape,
  coordinationSessionId: CoordinationSessionIdSchema,
  recorder: DuetIdentitySchema,
}).strict().superRefine((v, ctx) => {
  const result = ReceiptInputSchema.safeParse(Object.fromEntries(Object.entries(v).filter(([k]) => k !== "coordinationSessionId" && k !== "recorder")));
  if (!result.success) ctx.addIssue({ code: "custom", message: "Invalid receipt transport evidence" });
});

export const AssignmentInputSchema = z.object({
  id: key,
  scope: text.min(1),
  allowedActions: texts,
  acceptance: texts.min(1),
  nextGate: text.min(1),
  penOwes: texts.default([]),
  workerOwes: texts.default([]),
  resourceHolds: texts.default([]),
  pendingDecision: text.default(""),
}).strict();
export const DuetEventSchema = z.object({
  id: key,
  kind: z.enum(["progress", "question", "report", "review", "cursor", "status-demand", "obligations"]),
  reportId: key.optional(),
  content: text.default(""),
  evidence: texts.default([]),
  cursor: z.string().max(4096).optional(),
  penOwes: texts.optional(),
  workerOwes: texts.optional(),
  resourceHolds: texts.optional(),
  pendingDecision: text.optional(),
}).strict().superRefine((v, ctx) => {
  if ((v.kind === "report" || v.kind === "review") && !v.reportId) ctx.addIssue({ code: "custom", message: "Report and review events require reportId" });
  if (v.kind !== "cursor" && v.cursor !== undefined) ctx.addIssue({ code: "custom", message: "Only cursor events may carry a collection cursor" });
  if (v.kind === "cursor" && (v.cursor === undefined || v.content !== "" || v.evidence.length || v.reportId !== undefined || v.penOwes !== undefined || v.workerOwes !== undefined || v.resourceHolds !== undefined || v.pendingDecision !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Cursor events carry only id, kind and cursor" });
  }
});
export const DuetAssignmentSchema = z.object({
  input: AssignmentInputSchema,
  dispatchSessionId: CoordinationSessionIdSchema,
  assignee: DuetIdentitySchema,
  status: z.enum(["assigned", "needs-attention", "needs-review", "resolved"]),
  createdAt: z.string().datetime(),
  lastWorkerActivityAt: z.string().datetime(),
  lastStatusDemandAt: z.string().datetime().optional(),
  cursor: z.string().max(4096).optional(),
  events: z.array(z.object({ input: DuetEventSchema, recordedAt: z.string().datetime() }).strict()),
}).strict();
/**
 * ISS-1191: the reduced form a RESOLVED assignment takes in the tracked
 * checkpoint once compaction has run. It is a distinct shape rather than a
 * `DuetAssignmentSchema` with a shrunken `input`, because
 * `AssignmentInputSchema` requires a non-empty `scope`, `acceptance` and
 * `nextGate` -- a "reduced input" would have to INVENT that text, and an
 * invented acceptance criterion in a resolved-work record is worse than no
 * record of it at all. `id` carries the former `input.id`, which is the
 * assignment's only identity anywhere in this file (there is no separate
 * item-id field on an assignment input).
 *
 * `compacted: true` is a required literal, not an optional flag: the union
 * below has to discriminate on something a hand-edited or merge-mangled
 * file cannot accidentally satisfy, and a full assignment (which has no
 * such key, `.strict()`) can never be mistaken for a reduced one.
 */
export const CompactedAssignmentSchema = z.object({
  id: key,
  compacted: z.literal(true),
  status: z.literal("resolved"),
  dispatchSessionId: CoordinationSessionIdSchema,
  assignee: DuetIdentitySchema,
  createdAt: z.string().datetime(),
  lastWorkerActivityAt: z.string().datetime(),
  // The LAST retained event only, or none when the assignment had none.
  events: z.array(z.object({ input: DuetEventSchema, recordedAt: z.string().datetime() }).strict()).max(1),
}).strict();
export const CheckpointAssignmentSchema = z.union([DuetAssignmentSchema, CompactedAssignmentSchema]);
/** A tombstone for an assignment whose reduced record no longer fits either. */
export const ArchivedAssignmentSchema = z.object({
  id: key,
  resolvedAt: z.string().datetime(),
}).strict();
export type CompactedAssignment = z.infer<typeof CompactedAssignmentSchema>;
export type CheckpointAssignment = z.infer<typeof CheckpointAssignmentSchema>;
export type ArchivedAssignment = z.infer<typeof ArchivedAssignmentSchema>;
export function isCompactedAssignment(value: CheckpointAssignment): value is CompactedAssignment {
  return (value as CompactedAssignment).compacted === true;
}
/** The assignment's identity, whichever representation it is carried in. */
export function assignmentIdOf(value: CheckpointAssignment): string {
  return isCompactedAssignment(value) ? value.id : value.input.id;
}

export const DuetStateSchema = z.object({
  schemaVersion: z.literal(1),
  arrangementId: ArrangementIdSchema,
  revision: z.number().int().nonnegative(),
  start: z.object({ sessionId: CoordinationSessionIdSchema, previousSessionId: CoordinationSessionIdSchema.nullable(), expectedRevision: z.number().int().nonnegative(), mode: DuetModeSchema, recoveryEvidence: text.optional() }).strict(),
  nonce: z.string().uuid(),
  pen: DuetIdentitySchema,
  worker: DuetIdentitySchema,
  // ISS-1191: the runtime accepts the reduced shape too, because `recover`
  // rebuilds the runtime FROM the tracked checkpoint -- a compacted
  // checkpoint the runtime could not represent would make recovery either
  // impossible or a text-fabricating lie.
  assignments: z.array(CheckpointAssignmentSchema),
}).strict();
// A recovery snapshot updated with runtime. Harness cursors remain local.
export const DuetCheckpointSchema = z.object({
  revision: z.number().int().nonnegative(),
  sessionId: CoordinationSessionIdSchema,
  pen: DuetIdentitySchema,
  worker: DuetIdentitySchema,
  assignments: z.array(CheckpointAssignmentSchema),
  // ISS-1191: assignments whose reduced record still did not fit. Data is
  // MOVED here, never deleted, and the list only ever grows.
  compactedAssignments: z.array(ArchivedAssignmentSchema).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.assignments.some(a => !isCompactedAssignment(a) && (a.cursor !== undefined || a.events.some(e => e.input.kind === "cursor" || e.input.cursor !== undefined)))) {
    ctx.addIssue({ code: "custom", message: "Tracked checkpoints cannot contain harness cursors" });
  }
  if (v.assignments.some(a => isCompactedAssignment(a) && a.events.some(e => e.input.kind === "cursor" || e.input.cursor !== undefined))) {
    ctx.addIssue({ code: "custom", message: "Tracked checkpoints cannot contain harness cursors" });
  }
  // One identity, one representation: an id can be a live assignment or an
  // archive tombstone, never both, and never twice.
  const ids = v.assignments.map(assignmentIdOf).concat((v.compactedAssignments ?? []).map(a => a.id));
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", message: "Checkpoint assignment ids must be unique across assignments and compactedAssignments" });
  }
});
const common = { id: ArrangementIdSchema, clientTaskId: z.string().optional(), expectedRevision: z.number().int().nonnegative() };
const current = { ...common, expectedSessionId: CoordinationSessionIdSchema };
export const DuetOperationSchema = z.discriminatedUnion("action", [
  z.object({ ...common, action: z.literal("start"), expectedSessionId: CoordinationSessionIdSchema.nullable(), newSessionId: CoordinationSessionIdSchema, mode: DuetModeSchema }).strict(),
  z.object({ ...current, action: z.literal("recover"), newSessionId: CoordinationSessionIdSchema, mode: DuetModeSchema, recoveryEvidence: text.min(1) }).strict(),
  z.object({ ...current, action: z.literal("receipt"), receipt: ReceiptInputSchema }).strict(),
  z.object({ ...current, action: z.literal("assign"), assignment: AssignmentInputSchema }).strict(),
  z.object({ ...current, action: z.literal("update"), assignmentId: key, event: DuetEventSchema }).strict(),
]);
export type CommunicationReceipt = z.infer<typeof CommunicationReceiptSchema>;
export type DuetState = z.infer<typeof DuetStateSchema>;
export type DuetOperation = z.input<typeof DuetOperationSchema>;
export type DuetAssignment = z.infer<typeof DuetAssignmentSchema>;
export type DuetCheckpoint = z.infer<typeof DuetCheckpointSchema>;
