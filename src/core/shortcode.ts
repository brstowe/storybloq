/**
 * Fork feature: a project's SHORTCODE -- a terse, stable, lowercase handle for
 * one storybloq board (`bia-crm`, `backinaction`, `dawn-custom`).
 *
 * Every project has one, including an orchestrator ROOT: the root is a board in
 * its own right, not merely the thing nodes hang off, and the dashboard needs a
 * handle for it like any other.
 *
 * The default is DERIVED from the project directory's own name, so a board that
 * has never heard of this feature still answers the question -- no migration,
 * no backfill, nothing written at init. `shortcode` in `.story/config.json`
 * overrides that derivation when the directory name is wrong, ugly, or shared.
 *
 * NOT in `status --compact`. That payload is T-320's pinned schema, which by
 * its own documented rule gains no keys, and `/story` priming asserts two runs
 * against fresh fixture COPIES are byte-identical -- a value derived from the
 * directory name cannot be stable across copies of one board. Full
 * `status --format json` carries it, which is what the dashboard reads.
 *
 * Deliberately an IDENTIFIER ONLY. Nothing resolves by it: node names, CLI
 * targeting and cross-node refs are all untouched. That is what keeps a
 * duplicate a reporting matter (`validate` warns) rather than a correctness
 * one, and what lets `shortcode set` be a one-field write with no federation
 * read behind it.
 */

import { basename } from "node:path";

/** Lowercase slug: starts and ends alphanumeric, hyphens only inside. */
export const SHORTCODE_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const SHORTCODE_MIN_LENGTH = 2;
export const SHORTCODE_MAX_LENGTH = 32;

/** Where the shortcode a reader is holding actually came from. */
export type ShortcodeSource = "config" | "directory";

export interface ResolvedShortcode {
  readonly shortcode: string;
  readonly source: ShortcodeSource;
}

/**
 * Why a candidate was refused, in the writer's own words. `null` means valid.
 *
 * One function so the CLI's refusal and `validate`'s finding cannot drift into
 * disagreeing about what a shortcode is.
 */
export function shortcodeRefusal(value: string): string | null {
  if (value !== value.trim()) {
    return "Shortcode must not have leading or trailing whitespace.";
  }
  if (value.length < SHORTCODE_MIN_LENGTH) {
    return `Shortcode must be at least ${SHORTCODE_MIN_LENGTH} characters.`;
  }
  if (value.length > SHORTCODE_MAX_LENGTH) {
    return `Shortcode must be at most ${SHORTCODE_MAX_LENGTH} characters (got ${value.length}).`;
  }
  if (!SHORTCODE_REGEX.test(value)) {
    if (/[A-Z]/.test(value)) {
      return "Shortcode must be lowercase: use a-z, 0-9 and hyphens, starting and ending alphanumeric.";
    }
    return "Shortcode must match a-z, 0-9 and hyphens, starting and ending alphanumeric (e.g. bia-crm).";
  }
  return null;
}

export function isValidShortcode(value: string): boolean {
  return shortcodeRefusal(value) === null;
}

/**
 * Best-effort slug of arbitrary text. Returns `null` when nothing usable
 * survives, so callers decide what an unusable name means rather than
 * inheriting a silent empty string.
 */
export function slugifyShortcode(input: string): string | null {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SHORTCODE_MAX_LENGTH)
    // A trailing hyphen can reappear after the length cut.
    .replace(/-+$/g, "");
  if (slug.length < SHORTCODE_MIN_LENGTH) return null;
  return slug;
}

/**
 * The directory-derived default. `null` when the directory name slugifies to
 * nothing usable (a single character, or all punctuation) -- the caller then
 * reports no shortcode rather than inventing one.
 */
export function deriveShortcodeFromDir(root: string): string | null {
  return slugifyShortcode(basename(root));
}

/**
 * The shortcode a reader should use, and where it came from.
 *
 * FAILS OPEN to the directory default. `ConfigSchema` declares `shortcode` as a
 * bare optional string and is `.parse`d (not safe-parsed) by `project-loader`,
 * so a strict schema here would turn one bad character in config.json into a
 * throw that breaks every command that loads the project -- the same trap
 * `reviewEffort` documents. An invalid override costs the board its chosen
 * handle for today, never its ability to open; `validate` is what tells the
 * owner their override is being ignored.
 */
export function resolveShortcode(
  root: string,
  config: { readonly shortcode?: unknown },
): ResolvedShortcode | null {
  const override = config.shortcode;
  if (typeof override === "string" && isValidShortcode(override)) {
    return { shortcode: override, source: "config" };
  }
  const derived = deriveShortcodeFromDir(root);
  if (derived === null) return null;
  return { shortcode: derived, source: "directory" };
}
