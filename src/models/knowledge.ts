import { z } from "zod";
import { LESSON_STATUSES, LESSON_SOURCES, DateSchema, TimestampSchema, KnowledgeIdSchema } from "./types.js";

/**
 * Provenance of a promoted knowledge entry: which project it came from,
 * the local lesson id it was promoted from, and when.
 */
export const KnowledgeOriginSchema = z
  .object({
    project: z.string().min(1),
    sourceId: z.string().min(1),
    date: DateSchema,
  })
  .passthrough();

export type KnowledgeOrigin = z.infer<typeof KnowledgeOriginSchema>;

/**
 * A knowledge entry — lesson-shaped, but living in a storyknow pack and
 * shared across projects. Reinforcements aggregate across every consumer
 * that proves the entry true ("times proven anywhere").
 */
export const KnowledgeSchema = z
  .object({
    id: KnowledgeIdSchema,
    title: z.string().min(1, "Title cannot be empty"),
    content: z.string().refine((v) => v.trim().length > 0, "Content cannot be empty"),
    context: z.string(),
    source: z.enum(LESSON_SOURCES),
    tags: z.array(z.string()),
    reinforcements: z.number().int().min(0),
    lastValidated: DateSchema,
    createdDate: DateSchema,
    updatedDate: DateSchema,
    updatedAt: TimestampSchema,
    supersedes: KnowledgeIdSchema.nullable(),
    status: z.enum(LESSON_STATUSES),
    origin: KnowledgeOriginSchema.nullable().optional(),
  })
  .passthrough();

export type Knowledge = z.infer<typeof KnowledgeSchema>;
