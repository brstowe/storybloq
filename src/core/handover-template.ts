/**
 * T-498 Commit 1: the handover scaffold emitted by `storybloq handover
 * template`, its `Carried forward` date-preservation rule, and the optional
 * `Override:` line grammar.
 *
 * Pure, no I/O -- callers (the CLI command handler) supply the trajectory,
 * any previously-recorded `Carried forward` entries, and current labels.
 */
import type { TrajectoryEntry, TrajectoryDisposition } from "./markdown-sections.js";
import { splitFenceAwareSections, classifyHeading, isIdToken } from "./markdown-sections.js";

/** Marks a handover file as following this scaffold's contract. */
export const HANDOVER_TEMPLATE_MARKER = "<!-- storybloq-handover v1 -->";

export interface CarriedForwardEntry {
  readonly id: string;
  readonly label: string;
  /** ISO date (YYYY-MM-DD), extracted from the handover filename it was first seen in. */
  readonly since: string;
}

export interface OverrideLine {
  readonly recommended: string;
  readonly worked: string;
  readonly because: string;
}

// A carried entry is still open work: everything except a disposition that
// has since shipped.
const OPEN_TRAJECTORY_DISPOSITIONS: ReadonlySet<TrajectoryDisposition> = new Set([
  "continuation",
  "blocked",
  "owner-gated",
  "carried",
]);

const HANDOVER_FILENAME_DATE_REGEX = /^(\d{4}-\d{2}-\d{2})-/;

export function extractDateFromHandoverFilename(filename: string): string | null {
  const m = HANDOVER_FILENAME_DATE_REGEX.exec(filename);
  return m ? (m[1] as string) : null;
}

/**
 * Named mutant (b) target: an id already carried forward with an EARLIER
 * recorded `since` date must keep that date, not be overwritten by a fresher
 * derivation just because the trajectory window shifted or the template was
 * regenerated. `prior.since <= freshSince` is a safe lexicographic compare
 * because both sides are always `YYYY-MM-DD`.
 */
export function computeCarriedForward(
  trajectory: readonly TrajectoryEntry[],
  previousCarried: readonly CarriedForwardEntry[],
  currentLabels: ReadonlyMap<string, string> = new Map(),
): CarriedForwardEntry[] {
  const previousById = new Map(previousCarried.map((e) => [e.id, e] as const));
  const result: CarriedForwardEntry[] = [];

  for (const entry of trajectory) {
    if (!OPEN_TRAJECTORY_DISPOSITIONS.has(entry.latestDisposition)) continue;
    const freshSince = extractDateFromHandoverFilename(entry.firstSeenInWindow);
    if (freshSince === null) continue;

    const prior = previousById.get(entry.id);
    const since = prior && prior.since <= freshSince ? prior.since : freshSince;
    const label = prior?.label ?? currentLabels.get(entry.id) ?? entry.id;
    result.push({ id: entry.id, label, since });
  }

  return result;
}

const OVERRIDE_BODY_REGEX = /^recommended=(\S+)\s+worked=(\S+)\s+because=(.+)$/;

/**
 * Parses the body of an `Override:` line (everything after `Override: `).
 * Named mutant (c) target: a line missing `because=` must be rejected, not
 * silently accepted with an empty rationale.
 */
export function parseOverrideBody(body: string): OverrideLine | null {
  const m = OVERRIDE_BODY_REGEX.exec(body.trim());
  if (!m) return null;
  const [, recommended, worked, because] = m as unknown as [string, string, string, string];
  if (!isIdToken(recommended) || !isIdToken(worked)) return null;
  const trimmedBecause = because.trim();
  if (trimmedBecause.length === 0) return null;
  return { recommended, worked, because: trimmedBecause };
}

export function renderOverrideLine(o: OverrideLine): string {
  return `Override: recommended=${o.recommended} worked=${o.worked} because=${o.because}`;
}

const CARRIED_BULLET_REGEX =
  /^-\s*([A-Za-z0-9-]+):\s*(.*?)\s*\(carried since (\d{4}-\d{2}-\d{2})\)\s*$/;

/**
 * Reads back the `Carried forward` heading's own bullets (this module's own
 * render format, not the generic bullet grammar) so a fresh template run can
 * preserve an earlier `since` date recorded by a previous run. Absent a
 * `Carried forward` heading, returns an empty array -- there is nothing to
 * preserve.
 */
export function parseCarriedForwardSection(markdown: string): CarriedForwardEntry[] {
  const sections = splitFenceAwareSections(markdown);
  const carried = sections.find((s) => s.level >= 1 && classifyHeading(s.heading) === "carried");
  if (!carried) return [];

  const entries: CarriedForwardEntry[] = [];
  for (const line of carried.bodyLines) {
    const m = CARRIED_BULLET_REGEX.exec(line.trim());
    if (!m) continue;
    entries.push({ id: m[1] as string, label: m[2] as string, since: m[3] as string });
  }
  return entries;
}

/** True when ANY heading in `markdown` classifies as `Carried forward`, regardless of whether it has bullets. */
export function hasCarriedForwardHeading(markdown: string): boolean {
  const sections = splitFenceAwareSections(markdown);
  return sections.some((s) => s.level >= 1 && classifyHeading(s.heading) === "carried");
}

export interface HandoverTemplateInput {
  readonly carriedForward: readonly CarriedForwardEntry[];
  readonly override?: OverrideLine | null;
}

export function renderHandoverTemplate(input: HandoverTemplateInput): string {
  const lines: string[] = [HANDOVER_TEMPLATE_MARKER, "", "# Session Handover", ""];

  if (input.override) {
    lines.push(renderOverrideLine(input.override), "");
  }

  lines.push("## Worker state", "", "- ", "");
  lines.push("## Blocked", "", "- (none)", "");
  lines.push("## Owner rulings", "", "- (none)", "");
  lines.push("## Carried forward", "");
  if (input.carriedForward.length === 0) {
    lines.push("- (nothing carried forward)");
  } else {
    for (const e of input.carriedForward) {
      lines.push(`- ${e.id}: ${e.label} (carried since ${e.since})`);
    }
  }
  lines.push("");
  lines.push("## Shipped", "", "- (none)", "");

  return lines.join("\n");
}
