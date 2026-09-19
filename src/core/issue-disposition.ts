/**
 * ISS-1113: the one list of dispositions that mean "this issue is not work",
 * and the guard every consumer of that fact asks.
 *
 * It lives in its own module with no RUNTIME imports for two reasons. It is read by
 * `ProjectState` (a count), by `recommend` (the structured actionability
 * tier), and by two autonomous stages, and a shared list that imported any of
 * them would put a cycle between the model layer and the ranking layer. And
 * keeping it here makes the list the thing a reader finds: ISS-1154 added
 * three values and wired exactly one consumer, which is how ISSUE_SWEEP came
 * to be handing out `owner_gated` issues as work for a year.
 *
 * The values are the `IssueSchema.disposition` enum. That enum is the schema
 * (it refuses anything else at the boundary); this list is the SUBSET that is
 * non-actionable. They are identical today because every value the enum
 * carries is non-actionable, and they are deliberately separate names so that
 * adding an actionable disposition later does not silently make it invisible.
 *
 * That "subset" claim is pinned by the compiler at the bottom of this file
 * rather than left to the comment.
 */

// Type-only, so it erases: no runtime edge, and it runs in the direction the
// layers already run (core reads models, never the reverse).
import type { IssueDisposition } from "../models/issue.js";

export const NON_ACTIONABLE_DISPOSITIONS = [
  // ISS-1154
  "escalate_only",
  "owner_gated",
  "duplicate",
  // ISS-1113: set at birth by the three filing paths.
  //  - pre_existing:           a lens finding in code this change did not touch
  //  - accepted_out_of_scope:  a reviewer deferred it
  //  - forced_landing:         a landing was forced past it
  "pre_existing",
  "accepted_out_of_scope",
  "forced_landing",
] as const;

export type NonActionableDisposition = (typeof NON_ACTIONABLE_DISPOSITIONS)[number];

const LOOKUP: ReadonlySet<string> = new Set<string>(NON_ACTIONABLE_DISPOSITIONS);

/**
 * ABSENT IS ACTIONABLE, and so is an unrecognized value.
 *
 * Absent is the backward-compatibility rule: every issue filed before ISS-1154
 * carries no disposition and must keep ranking exactly as it does today. An
 * unrecognized value gets the same answer rather than a throw or a demotion,
 * because this guard is called from counting and routing paths where a single
 * malformed record must not be able to hide real work. The schema is what
 * refuses a bad value, at the boundary, once.
 */
export function isNonActionableDisposition(
  disposition: string | null | undefined,
): disposition is NonActionableDisposition {
  return disposition != null && LOOKUP.has(disposition);
}

/**
 * The subset claim, enforced.
 *
 * A value listed here that the schema does not carry can never appear on a
 * loaded issue, so it would be a dead entry silently doing nothing. This
 * breaks the build instead. The other direction is deliberately NOT pinned: a
 * new disposition is not automatically non-actionable, and deciding that is a
 * judgement the person adding it has to make.
 */
type AssertSubset<T extends U, U> = T;
type _NonActionableAreRealDispositions = AssertSubset<
  NonActionableDisposition,
  IssueDisposition
>;
