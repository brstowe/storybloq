import { z } from "zod";

export const FeaturesSchema = z
  .object({
    tickets: z.boolean(),
    issues: z.boolean(),
    handovers: z.boolean(),
    roadmap: z.boolean(),
    reviews: z.boolean(),
    bus: z.boolean().optional(),
  })
  .passthrough();

export type Features = z.infer<typeof FeaturesSchema>;

export const BusConfigSchema = z.object({
  maxBodyBytes: z.number().int().min(1024).max(65536).optional(),
  maxHops: z.number().int().min(2).max(32).optional(),
  requireIssueForCritical: z.boolean().optional(),
}).strict();

export type BusConfig = z.infer<typeof BusConfigSchema>;

export const ConfigSchema = z
  .object({
    version: z.number().int().min(1),
    schemaVersion: z.number().int().optional(),
    project: z.string().min(1),
    type: z.string(),
    language: z.string(),
    features: FeaturesSchema,
    bus: BusConfigSchema.optional(),
    recipe: z.string().optional(),  // default "coding" applied in guide.ts handleStart
    // ISS-730: opt-in continuous cross-reference integrity check. When true,
    // loadProject runs a full validateProject pass and surfaces ERROR-level
    // findings as advisory "cross_reference" load warnings (never fatal, never
    // trips strict mode). Off by default to keep loads O(per-file) and to avoid
    // bricking reads on a pre-existing dangling reference.
    validateOnLoad: z.boolean().optional(),
    recipeOverrides: z.object({
      maxTicketsPerSession: z.number().min(0).optional(),
      compactThreshold: z.string().optional(),
      reviewBackends: z.array(z.string()).optional(),
      codexReviewBackends: z.array(z.string()).optional(),
      handoverInterval: z.number().min(0).optional(),
      stages: z.record(z.record(z.unknown())).optional(),
      branchStrategy: z.enum(["none", "per-ticket"]).optional(),
      maxParallelAgents: z.number().min(1).max(8).optional(),
    }).optional(),
    nodes: z.record(z.string(), z.unknown()).optional(),
    orchestrator: z.string().optional(),
    federation: z.record(z.unknown()).optional(),
    team: z.object({
      enabled: z.boolean().optional(),
      minCliVersion: z.string().optional(),
      minMacVersion: z.string().optional(),
      requiredFeatures: z.array(z.string()).optional(),
      claimStalenessHours: z.number().finite().nonnegative().optional(),
      idAllocator: z.enum(["local", "git-refs"]).optional(),
      idAllocatorRemote: z.string().regex(/^[A-Za-z0-9._-]+$/).refine((v) => !v.startsWith("-"), "Remote name must not start with -").optional(),
      protectedRef: z.string().min(1).refine((v) => !v.startsWith("-"), "Protected ref must not start with -").optional(),
      mergeDriverVersion: z.number().int().optional(),
    }).optional(),
  })
  .passthrough();

export type Config = z.infer<typeof ConfigSchema>;
