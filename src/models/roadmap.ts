import { z } from "zod";
import { DateSchema } from "./types.js";

export const BlockerSchema = z
  .object({
    name: z.string().min(1),
    // Legacy format (pre-T-082)
    cleared: z.boolean().optional(),
    // New date-based format (T-082 migration)
    createdDate: DateSchema.optional(),
    clearedDate: DateSchema.nullable().optional(),
    // Present in all current data but optional for future minimal blockers
    note: z.string().nullable().optional(),
  })
  .passthrough();

export type Blocker = z.infer<typeof BlockerSchema>;

// Stored phase state, orthogonal to the ticket-derived status: a parked phase
// (any of these values) is excluded from work selection (ticket next,
// recommend, autonomous PICK_TICKET). Absent/null = active.
export const PHASE_STATES = ["pending", "paused", "skipped"] as const;

export const PhaseStateSchema = z.enum(PHASE_STATES);

export type PhaseState = z.infer<typeof PhaseStateSchema>;

export const PhaseSchema = z
  .object({
    id: z.string().min(1),
    label: z.string(),
    name: z.string(),
    description: z.string(),
    summary: z.string().optional(),
    state: PhaseStateSchema.nullable().optional(),
  })
  .passthrough();

export type Phase = z.infer<typeof PhaseSchema>;

// A project is a named grouping within a single phase; tickets/issues carry an
// optional `project` ref. An assignment only counts while the item's phase
// matches the project's phase (stale assignments are surfaced by validate).
export const ProjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    phase: z.string().min(1),
    color: z.string().optional(),
  })
  .passthrough();

export type Project = z.infer<typeof ProjectSchema>;

export const RoadmapSchema = z
  .object({
    title: z.string(),
    date: DateSchema,
    phases: z.array(PhaseSchema),
    blockers: z.array(BlockerSchema),
    projects: z.array(ProjectSchema).optional(),
  })
  .passthrough();

export type Roadmap = z.infer<typeof RoadmapSchema>;
