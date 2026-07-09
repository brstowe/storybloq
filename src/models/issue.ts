import { z } from "zod";
import {
  ISSUE_STATUSES,
  ISSUE_SEVERITIES,
  LIFECYCLE_VALUES,
  DateSchema,
  TimestampSchema,
  IssueIdSchema,
  TicketIdSchema,
  ConflictEntrySchema,
} from "./types.js";

export const IssueSchema = z
  .object({
    id: IssueIdSchema,
    title: z.string().min(1),
    status: z.enum(ISSUE_STATUSES),
    severity: z.enum(ISSUE_SEVERITIES),
    components: z.array(z.string()),
    impact: z.string(),
    resolution: z.string().nullable(),
    location: z.array(z.string()),
    discoveredDate: DateSchema,
    resolvedDate: DateSchema.nullable(),
    relatedTickets: z.array(TicketIdSchema),
    // Optional fields — older issues may omit these
    order: z.number().int().optional(),
    phase: z.string().nullable().optional(),
    // Optional ref into roadmap.projects; only meaningful while the issue's
    // phase matches the project's phase
    project: z.string().nullable().optional(),
    // Attribution fields — unused in v1
    createdBy: z.string().nullable().optional(),
    assignedTo: z.string().nullable().optional(),
    lastModifiedBy: z.string().nullable().optional(),
    updatedDate: DateSchema.nullable().optional(),
    updatedAt: TimestampSchema,
    displayId: z.string().optional(),
    previousDisplayIds: z.array(z.string()).optional(),
    lifecycle: z.enum(LIFECYCLE_VALUES).optional(),
    rank: z.string().optional(),
    createdAt: z.string().optional(),
    deletedAt: z.string().optional(),
    deletedBy: z.string().optional(),
    _conflicts: z.array(ConflictEntrySchema).optional(),
  })
  .passthrough();

export type Issue = z.infer<typeof IssueSchema>;
