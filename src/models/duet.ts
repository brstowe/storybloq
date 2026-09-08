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
export const DuetStateSchema = z.object({
  schemaVersion: z.literal(1),
  arrangementId: ArrangementIdSchema,
  revision: z.number().int().nonnegative(),
  start: z.object({ sessionId: CoordinationSessionIdSchema, previousSessionId: CoordinationSessionIdSchema.nullable(), expectedRevision: z.number().int().nonnegative(), mode: DuetModeSchema, recoveryEvidence: text.optional() }).strict(),
  nonce: z.string().uuid(),
  pen: DuetIdentitySchema,
  worker: DuetIdentitySchema,
  assignments: z.array(DuetAssignmentSchema),
}).strict();
// A recovery snapshot updated with runtime. Harness cursors remain local.
export const DuetCheckpointSchema = z.object({
  revision: z.number().int().nonnegative(),
  sessionId: CoordinationSessionIdSchema,
  pen: DuetIdentitySchema,
  worker: DuetIdentitySchema,
  assignments: z.array(DuetAssignmentSchema),
}).strict().superRefine((v, ctx) => {
  if (v.assignments.some(a => a.cursor !== undefined || a.events.some(e => e.input.kind === "cursor" || e.input.cursor !== undefined))) {
    ctx.addIssue({ code: "custom", message: "Tracked checkpoints cannot contain harness cursors" });
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
