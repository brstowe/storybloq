/**
 * Lesson digest builder -- compiles active lessons into ranked markdown.
 * Sorted by reinforcements descending, grouped by tag.
 */
import type { Lesson } from "../models/lesson.js";
import { displayIdOf } from "./resolver.js";
import { CliValidationError } from "../cli/helpers.js";

export type LessonDigestSelectorNamespace = "phase" | "component" | "item";

export interface ParsedLessonDigestSelector {
  namespace: LessonDigestSelectorNamespace;
  value: string;
}

export interface LessonDigestOptions {
  limit?: number;
  select?: readonly string[];
}

const SELECTOR_NAMESPACES: ReadonlySet<string> = new Set(["phase", "component", "item"]);

// Lowercase, with every run of whitespace/punctuation collapsed to one
// hyphen (leading/trailing hyphens trimmed). Stricter than the generic
// `normalizeTags` helper, which drops punctuation like "_" instead of
// hyphenating it -- this ticket's wording requires the latter.
function normalizeSelectorValue(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Parses a T-320 select entry ("phase:<id>" | "component:<name>" |
 * "item:<display or canonical id>") into its namespace and normalized value.
 */
export function parseLessonDigestSelector(raw: string): ParsedLessonDigestSelector {
  const idx = raw.indexOf(":");
  if (idx <= 0) {
    throw new CliValidationError(
      "invalid_input",
      `Invalid select entry "${raw}": must be namespaced as phase:<id>, component:<name>, or item:<id>`,
    );
  }
  const namespace = raw.slice(0, idx);
  if (!SELECTOR_NAMESPACES.has(namespace)) {
    throw new CliValidationError(
      "invalid_input",
      `Unknown select namespace "${namespace}" in "${raw}": must be one of phase, component, item`,
    );
  }
  const value = normalizeSelectorValue(raw.slice(idx + 1));
  if (!value) {
    throw new CliValidationError("invalid_input", `Invalid select entry "${raw}": value cannot be empty`);
  }
  return { namespace: namespace as LessonDigestSelectorNamespace, value };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-token match against RAW prose: `normalizedValue` (already hyphenated
// by normalizeSelectorValue, e.g. "mac-os") is split on "-" and its parts are
// re-joined with a flexible separator class, so "Mac OS", "Mac_OS", and
// "Mac-OS" in raw context text all match a "component:Mac_OS" selector even
// though none of them literally contains a hyphen the same way the selector
// does. The word-boundary lookaround only excludes adjacent alphanumerics
// (not hyphens), so "t-320" still never matches inside "t-3200" (blocked by
// the trailing "0") but correctly matches inside "T-320's" (a genuine
// separator, "'", follows).
function matchesWholeToken(text: string, normalizedValue: string): boolean {
  if (!normalizedValue) return false;
  const parts = normalizedValue.split("-").map(escapeRegExp);
  const pattern = new RegExp(`(?<![a-z0-9])${parts.join("[^a-z0-9]+")}(?![a-z0-9])`, "i");
  return pattern.test(text);
}

// Splits a RAW tag on its first ":" (before any normalization) so a
// namespaced tag's namespace and value are compared as a pair, never
// flattened together. Codex R1 round 2: normalizing "phase:hardening" as one
// string collapses its ":" into the same hyphen normalizeSelectorValue uses
// for whitespace, producing "phase-hardening" -- indistinguishable from an
// unrelated bare tag "phase-hardening" or from a "component:phase-hardening"
// selector's bare value. Keeping namespace and value separate until AFTER
// each is normalized on its own prevents that collision.
function parseRawTagForSelectorMatch(tag: string): { namespace: string | null; value: string } {
  const idx = tag.indexOf(":");
  if (idx <= 0) {
    return { namespace: null, value: normalizeSelectorValue(tag) };
  }
  return {
    namespace: normalizeSelectorValue(tag.slice(0, idx)),
    value: normalizeSelectorValue(tag.slice(idx + 1)),
  };
}

function lessonMatchesSelector(lesson: Lesson, selector: ParsedLessonDigestSelector): boolean {
  for (const rawTag of lesson.tags) {
    const parsed = parseRawTagForSelectorMatch(rawTag);
    if (parsed.namespace !== null) {
      // Namespace-scoped tag (no cross-namespace collisions): a lesson tagged
      // "phase:hardening" matches only a phase:hardening selector, never
      // component:hardening -- and never falls through to the bare-value
      // fallback below, which would otherwise let its flattened value collide
      // with an unrelated selector.
      if (parsed.namespace === selector.namespace && parsed.value === selector.value) return true;
    } else if (parsed.value === selector.value) {
      // Bare-value fallback for the existing untagged/unnamespaced lesson
      // corpus, where a tag carries no namespace of its own.
      return true;
    }
  }
  return matchesWholeToken(lesson.context, selector.value);
}

function rankByReinforcement(lessons: readonly Lesson[]): Lesson[] {
  // Ordering: reinforcements descending, then lesson id (canonical, not
  // displayId) ascending.
  return lessons.slice().sort((a, b) => {
    if (b.reinforcements !== a.reinforcements) return b.reinforcements - a.reinforcements;
    return a.id.localeCompare(b.id);
  });
}

function capped(lessons: readonly Lesson[], limit: number | undefined): Lesson[] {
  return limit !== undefined ? lessons.slice(0, Math.max(0, limit)) : lessons.slice();
}

function resolveDigestSelection(active: readonly Lesson[], options: LessonDigestOptions): Lesson[] {
  const ranked = rankByReinforcement(active);
  if (!options.select || options.select.length === 0) {
    return capped(ranked, options.limit);
  }
  const parsed = options.select.map(parseLessonDigestSelector);
  const matched = ranked.filter((l) => parsed.some((sel) => lessonMatchesSelector(l, sel)));
  if (matched.length > 0) {
    return capped(matched, options.limit);
  }
  // Falls back to the top `limit` by reinforcement when nothing matches.
  // Without a limit there is no "top N" to fall back to, so the result is
  // empty rather than silently returning the whole corpus.
  return options.limit !== undefined ? capped(ranked, options.limit) : [];
}

// Limited form: one line per lesson with the lesson id.
function buildLimitedDigest(lessons: readonly Lesson[]): string {
  return lessons
    .map((l) => {
      const reinforced = l.reinforcements > 0 ? ` (x${l.reinforcements})` : "";
      return `- ${displayIdOf(l)}: ${l.title}${reinforced}`;
    })
    .join("\n");
}

function buildFullDigest(active: readonly Lesson[]): string {
  // Group by first tag
  const grouped = new Map<string, Lesson[]>();
  for (const l of active) {
    const group = l.tags.length > 0 ? l.tags[0]! : "general";
    const arr = grouped.get(group);
    if (arr) {
      arr.push(l);
    } else {
      grouped.set(group, [l]);
    }
  }

  // Sort each group by reinforcements desc, then createdDate desc
  for (const [, arr] of grouped) {
    arr.sort((a, b) => {
      if (b.reinforcements !== a.reinforcements) return b.reinforcements - a.reinforcements;
      return b.createdDate.localeCompare(a.createdDate);
    });
  }

  // Sort groups by max reinforcement in group (highest first)
  const sortedGroups = [...grouped.entries()].sort((a, b) => {
    const maxA = Math.max(...a[1].map((l) => l.reinforcements));
    const maxB = Math.max(...b[1].map((l) => l.reinforcements));
    return maxB - maxA;
  });

  const lines: string[] = ["# Lessons Learned", ""];
  for (const [group, lessons] of sortedGroups) {
    lines.push(`## ${group}`, "");
    for (const l of lessons) {
      const reinforced = l.reinforcements > 0 ? ` (×${l.reinforcements})` : "";
      lines.push(`- **${l.title}**${reinforced}: ${l.content}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * Builds a ranked digest of active lessons.
 *
 * No arguments (or an empty `select` with no `limit`, the legacy branch):
 * the full grouped markdown digest, unchanged from before T-320.
 *
 * `limit` and/or `select` (T-320, additive): a limited form, one line per
 * lesson with its display id. `select` filters to lessons matching any of
 * the given namespaced selectors (`phase:<id>`, `component:<name>`,
 * `item:<display or canonical id>`), falling back to the top `limit` by
 * reinforcement when nothing matches -- if no `limit` is given in that case
 * there is no "top N" to fall back to, so the result is empty. `limit` caps
 * the final result either way.
 */
export function buildLessonDigest(lessons: readonly Lesson[], options?: LessonDigestOptions): string {
  // Validated here, once, so the CLI (which has no schema layer of its own)
  // and MCP (whose zod schema only constrains its own surface) enforce the
  // identical contract rather than silently diverging -- a fractional limit
  // would otherwise truncate via Array.slice's own coercion, and a negative
  // one would otherwise be silently clamped to zero.
  if (options?.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
    throw new CliValidationError("invalid_input", `Invalid limit "${options.limit}": must be a non-negative integer`);
  }

  const active = lessons.filter((l) => l.status === "active");
  if (active.length === 0) return "";

  const hasSelect = options?.select !== undefined && options.select.length > 0;
  const hasLimit = options?.limit !== undefined;
  if (!hasSelect && !hasLimit) {
    return buildFullDigest(active);
  }

  const selected = resolveDigestSelection(active, options ?? {});
  return buildLimitedDigest(selected);
}
