/**
 * The create input for an issue and the three checks every writer of one must
 * apply, in the order `handleIssueCreate` applies them (severity, then, after
 * the caller's own citation check, the dedupe key; the phase only once the
 * ledger is locked). Neutral on purpose: the CLI command and the
 * autonomous recovery-record preparer both consume it, and neither may
 * define it in terms of the other (ISS-1221).
 */
import { ISSUE_SEVERITIES, type IssueSeverity } from "../models/types.js";
import { IssueDedupeKeySchema, type IssueSourceRefInput } from "../models/issue.js";
import type { ProjectState } from "./project-state.js";

export interface IssueCreateInput {
  title: string;
  severity: string;
  impact: string;
  components: string[];
  relatedTickets: string[];
  location: string[];
  sourceRefs?: IssueSourceRefInput[];
  dedupeKey?: string;
  createdBy?: string;
  /**
   * `undefined` means "not supplied, infer it"; `null` means "resolved to no
   * phase at preparation time, write none". The distinction is what lets a
   * prepared recovery record be written exactly as it was fingerprinted.
   */
  phase?: string | null;
  citesRuling?: string[];
  /** Fork: optional project assignment (must belong to the issue's phase). */
  project?: string | null;
}

/** One refused field, named the way the writer names it in its invalid_input message. */
export interface IssueCreateRefusal {
  readonly field: "severity" | "dedupeKey" | "phase";
  readonly message: string;
}

export function validateIssueCreateSeverity(input: Pick<IssueCreateInput, "severity">): IssueCreateRefusal | null {
  if (ISSUE_SEVERITIES.includes(input.severity as IssueSeverity)) return null;
  return {
    field: "severity",
    message: `Unknown issue severity "${input.severity}": must be one of ${ISSUE_SEVERITIES.join(", ")}`,
  };
}

export function validateIssueCreateDedupeKey(input: Pick<IssueCreateInput, "dedupeKey">): IssueCreateRefusal | null {
  if (input.dedupeKey === undefined) return null;
  const parsed = IssueDedupeKeySchema.safeParse(input.dedupeKey);
  if (parsed.success) return null;
  return { field: "dedupeKey", message: parsed.error.issues.map((issue) => issue.message).join("; ") };
}

/**
 * Truthy on purpose, not non-null: an empty string is not validated here,
 * exactly as before ISS-1221, and is refused later by write validation.
 */
export function validateIssueCreatePhase(state: ProjectState, phase: string | null | undefined): IssueCreateRefusal | null {
  if (phase && !state.roadmap.phases.some((p) => p.id === phase)) {
    return { field: "phase", message: `Phase "${phase}" not found in roadmap` };
  }
  return null;
}
