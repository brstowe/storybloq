import { z } from "zod";

// --- ID format regexes ---

/** Matches legacy T-001, T-077a, T-079b */
export const TICKET_ID_REGEX = /^T-\d+[a-z]?$/;
/** Matches canonical t-[crockford16] */
export const TICKET_CANONICAL_ID_REGEX = /^t-[0-9a-hjkmnp-tvwxyz]{16}$/;

/** Matches legacy ISS-001, ISS-009 */
export const ISSUE_ID_REGEX = /^ISS-\d+$/;
/** Matches canonical i-[crockford16] */
export const ISSUE_CANONICAL_ID_REGEX = /^i-[0-9a-hjkmnp-tvwxyz]{16}$/;

// --- Ticket enums ---

export const TICKET_STATUSES = ["open", "inprogress", "complete"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_TYPES = ["task", "feature", "chore"] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

// --- Issue enums ---

export const ISSUE_STATUSES = ["open", "inprogress", "resolved"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

// --- Note enums ---

export const NOTE_STATUSES = ["active", "archived"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];
export const NOTE_ID_REGEX = /^N-\d+$/;
export const NOTE_CANONICAL_ID_REGEX = /^n-[0-9a-hjkmnp-tvwxyz]{16}$/;
export const NoteIdSchema = z
  .string()
  .refine(
    (v) => NOTE_ID_REGEX.test(v) || NOTE_CANONICAL_ID_REGEX.test(v),
    "Note ID must match N-NNN or n-[canonical]",
  );

// --- Lesson enums ---

export const LESSON_STATUSES = ["active", "deprecated", "superseded"] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];
export const LESSON_SOURCES = ["review", "correction", "postmortem", "manual"] as const;
export type LessonSource = (typeof LESSON_SOURCES)[number];
export const LESSON_ID_REGEX = /^L-\d+$/;
export const LESSON_CANONICAL_ID_REGEX = /^l-[0-9a-hjkmnp-tvwxyz]{16}$/;
export const LessonIdSchema = z
  .string()
  .refine(
    (v) => LESSON_ID_REGEX.test(v) || LESSON_CANONICAL_ID_REGEX.test(v),
    "Lesson ID must match L-NNN or l-[canonical]",
  );

// --- Team-mode enums ---

export const LIFECYCLE_VALUES = ["active", "archived", "deleted"] as const;
export type Lifecycle = (typeof LIFECYCLE_VALUES)[number];

export const ConflictEntrySchema = z.object({
  fieldPath: z.string(),
  field: z.string().optional(),
  kind: z.enum(["field", "array-element", "coupled", "delete-edit"]),
  group: z.string().optional(),
  base: z.unknown(),
  ours: z.unknown(),
  theirs: z.unknown(),
}).passthrough();
export type ConflictEntry = z.infer<typeof ConflictEntrySchema>;

export const ClaimSchema = z.object({
  user: z.string(),
  branch: z.string(),
  since: z.string(),
});
export type Claim = z.infer<typeof ClaimSchema>;

// --- Output/error types ---

export const OUTPUT_FORMATS = ["json", "md"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const ERROR_CODES = [
  "not_found",
  "validation_failed",
  "io_error",
  "project_corrupt",
  "invalid_input",
  "conflict",
  "version_mismatch",
  "file_exists",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// --- Date validation ---

export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Regex check + calendar validity. The `startsWith` check catches Date constructor
// rollover (e.g. "2026-02-29" rolls to "2026-03-01", so toISOString won't match).
export const DateSchema = z
  .string()
  .regex(DATE_REGEX, "Date must be YYYY-MM-DD")
  .refine(
    (val) => {
      const d = new Date(val + "T00:00:00Z");
      return !isNaN(d.getTime()) && d.toISOString().startsWith(val);
    },
    { message: "Invalid calendar date" },
  );

// --- Reusable ID schemas ---

export const TicketIdSchema = z
  .string()
  .refine(
    (v) => TICKET_ID_REGEX.test(v) || TICKET_CANONICAL_ID_REGEX.test(v),
    "Ticket ID must match T-NNN, T-NNNx, or t-[canonical]",
  );

export const IssueIdSchema = z
  .string()
  .refine(
    (v) => ISSUE_ID_REGEX.test(v) || ISSUE_CANONICAL_ID_REGEX.test(v),
    "Issue ID must match ISS-NNN or i-[canonical]",
  );

// --- Ref schemas (user-provided references, resolved before persisting) ---

export const TicketRefSchema = z
  .string()
  .refine(
    (v) => TICKET_ID_REGEX.test(v) || TICKET_CANONICAL_ID_REGEX.test(v),
    "Ticket ref must match T-NNN, T-NNNx, or t-[canonical]",
  );

export const IssueRefSchema = z
  .string()
  .refine(
    (v) => ISSUE_ID_REGEX.test(v) || ISSUE_CANONICAL_ID_REGEX.test(v),
    "Issue ref must match ISS-NNN or i-[canonical]",
  );

export const NoteRefSchema = z
  .string()
  .refine(
    (v) => NOTE_ID_REGEX.test(v) || NOTE_CANONICAL_ID_REGEX.test(v),
    "Note ref must match N-NNN or n-[canonical]",
  );

export const LessonRefSchema = z
  .string()
  .refine(
    (v) => LESSON_ID_REGEX.test(v) || LESSON_CANONICAL_ID_REGEX.test(v),
    "Lesson ref must match L-NNN or l-[canonical]",
  );
