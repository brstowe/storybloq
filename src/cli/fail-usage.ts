/**
 * ISS-1189: builds the `usage` info attached to a yargs validation failure
 * (missing required option, too few positionals, unknown argument, invalid
 * choice) so both the text and JSON error output can show what the invoked
 * command actually requires, not just which single check tripped.
 *
 * yargs@17's `.fail(msg, err, y)` types its third parameter as the full
 * `Argv<T>` (see `@types/yargs/index.d.ts`), but the object actually handed
 * to `.fail()` at runtime is a restricted subset: verified against the
 * installed package that it has no `getOptions()` at all (not merely one
 * returning empty data), and that `.help()` -- typed to return `Argv<T>` --
 * actually returns a plain string synchronously. `FailUsageYargs` below is
 * the accurate runtime shape; callers must cast into it rather than trust
 * the declared `Argv<T>` type for this specific object.
 *
 * `getOptions().demandedOptions` was also verified empty on every registration
 * style tried, so "required" cannot be read structurally at all. Required
 * flags are instead recovered by parsing `.help()`'s formatted text, which
 * yargs always renders in full for the command being validated regardless of
 * which single check failed -- so the same parse yields the complete,
 * uniform required list on all four failure classes.
 *
 * That text-based detection is only as reliable as the text yargs renders,
 * and two real environment conditions can corrupt it: yargs auto-selects its
 * locale from LC_ALL/LANG/LANGUAGE (verified: under a French locale the
 * `[required]` tag renders as `[requis]`), and a narrow wrap width -- from a
 * real narrow terminal, or an explicit `.wrap()` call -- can split the tag
 * itself across lines (verified with `.wrap(20)`: `[required` / `]`). Rather
 * than making the parser tolerant of every locale's translation and every
 * wrap width's split point, the caller (src/cli/index.ts) forces English and
 * an unbounded wrap on `cli` before generating the `helpText` passed in here
 * -- this module has no yargs instance of its own to do that with, hence
 * `buildUsageInfo` taking already-rendered text rather than calling
 * `.help()` itself.
 *
 * Choices are NOT read off that same parsed text, even though the tags yargs
 * prints (`[choices: "a", "b"]`) look self-sufficient: a long choice value
 * can be split mid-word by yargs' own line wrapping (verified against the
 * real `ruling create --attribution` choices, one of which wraps as
 * "...owner-with-owner-ve" / "to", ...), and naively rejoining wrapped lines
 * with a space would silently corrupt it to "...owner-with-owner-ve to".
 * Choices are instead read from `getOptions().choices`, which -- unlike
 * `demandedOptions` -- IS reliably populated (verified for a two-level
 * nested command, matching `ruling create`'s own nesting), but only on the
 * OUTER, closure-captured `cli` variable in src/cli/index.ts, not on the
 * restricted `y` object `.fail()` hands the callback. `getOptions()` is not
 * declared in @types/yargs at all (not merely mistyped), so a caller must
 * supply that outer instance explicitly through `FailUsageOptionsSource`.
 */

export interface FailUsageYargs {
  help(): string;
  getDescriptions(): Record<string, string>;
}

/**
 * The outer, closure-captured yargs instance's `getOptions()` surface --
 * absent from @types/yargs entirely, verified directly against the
 * installed package. Deliberately narrow: only `choices` is read.
 */
export interface FailUsageOptionsSource {
  getOptions(): { choices?: Record<string, readonly unknown[] | undefined> };
}

export interface RequiredUsageEntry {
  flag: string;
  description: string;
  choices?: string[];
}

export interface UsageInfo {
  command: string;
  required: RequiredUsageEntry[];
}

function commandLine(helpText: string): string {
  return (helpText.split("\n")[0] ?? "").trim();
}

/**
 * Strips a trailing run of `[...]` tags off a joined block of help text, one
 * tag at a time from the end. A single greedy regex over the whole block
 * would also match a tag-shaped substring sitting mid-description (a
 * describe string can itself contain the literal text "[required]"); walking
 * backward from the true end and stopping the moment the suffix stops being
 * a bracket tag keeps a mid-line tag-lookalike out of the result.
 */
function extractTrailingTags(blockText: string): string[] {
  let text = blockText.trimEnd();
  const tags: string[] = [];
  for (;;) {
    const match = /\[[^\]]*\]$/.exec(text);
    if (!match) break;
    tags.unshift(match[0]);
    text = text.slice(0, match.index).trimEnd();
  }
  return tags;
}

interface ParsedEntry {
  name: string;
  required: boolean;
}

/**
 * Splits `.help()`'s Positionals:/Options: sections into per-entry blocks.
 *
 * yargs indents every entry's name exactly two spaces from the left margin,
 * and indents a wrapped continuation line further, to align it under the
 * description column -- except when the trailing tag string itself (long
 * choices, in particular) is too wide to fit even at that aligned column, in
 * which case yargs left-shifts the ENTIRE tag run back to a standalone line
 * at column 2 (verified directly against `ruling create --attribution`,
 * whose three long choice values push its `[string] [required] [choices:
 * ...]` run onto its own 2-space-indented line). Such a line is
 * distinguished from a genuine new entry by its first token: a real entry
 * always starts with the flag/positional name, never a bracket tag.
 */
function parseEntries(helpText: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  let currentName: string | null = null;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentName === null) return;
    const tags = extractTrailingTags(currentLines.join(" "));
    entries.push({ name: currentName, required: tags.includes("[required]") });
    currentName = null;
    currentLines = [];
  };

  for (const line of helpText.split("\n")) {
    if (/^ {2}(?!\[)\S/.test(line)) {
      flush();
      const token = line.trim().split(/\s+/)[0] ?? "";
      currentName = token.replace(/^--/, "");
      currentLines = [line];
    } else if (currentName !== null && line.trim() !== "") {
      currentLines.push(line);
    } else {
      flush();
    }
  }
  flush();

  return entries;
}

/**
 * Builds the `usage` payload for a validation failure: the command's usage
 * line plus every required option/positional it declares, each with its
 * registered description (verbatim, including the array-option separator
 * hint already appended to `describe` at registration -- ISS-1189's
 * addendum is satisfied without any new code) and, where present, its
 * allowed choices (read from `optionsSource`, never reconstructed from
 * wrapped help text -- see the module docblock).
 *
 * Takes the already-rendered `helpText`/`descriptions` rather than a
 * `FailUsageYargs` to call itself: the caller controls exactly when and
 * under what locale/wrap settings `.help()` runs (ISS-1189 Codex round 1 --
 * required-tag detection must not depend on the process's locale or the
 * terminal's wrap width), and calling `.help()` again in here could observe
 * different settings than what the caller already arranged.
 */
export function buildUsageInfo(
  helpText: string,
  descriptions: Record<string, string>,
  optionsSource?: FailUsageOptionsSource,
): UsageInfo {
  const entries = parseEntries(helpText);
  const choicesMap = optionsSource?.getOptions().choices;

  const required: RequiredUsageEntry[] = entries
    .filter((entry) => entry.required)
    .map((entry) => {
      const result: RequiredUsageEntry = {
        flag: entry.name,
        description: descriptions[entry.name] ?? "",
      };
      const choices = choicesMap?.[entry.name];
      if (Array.isArray(choices) && choices.length > 0) result.choices = choices.map(String);
      return result;
    });

  return { command: commandLine(helpText), required };
}

/** Text-mode `.help()` appendix budget on a validation failure (ISS-1189). */
export const FAIL_USAGE_HELP_BYTE_BUDGET = 4096;

const TRUNCATION_MARKER = "\n... (truncated; run with --help for the full option list)";

/**
 * Truncates `.help()`'s output to a byte budget, appending an explicit
 * marker line so a truncated tail is never mistaken for the whole thing.
 */
export function truncateHelpText(helpText: string, maxBytes: number): { text: string; truncated: boolean } {
  const full = Buffer.byteLength(helpText, "utf8");
  if (full <= maxBytes) return { text: helpText, truncated: false };

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const budget = Math.max(0, maxBytes - markerBytes);
  const sliced = Buffer.from(helpText, "utf8")
    .subarray(0, budget)
    .toString("utf8")
    // A byte-budget slice can land mid-codepoint; toString() replaces the
    // truncated tail with U+FFFD, which would otherwise sit right in front
    // of the marker.
    .replace(/�+$/, "");
  return { text: sliced + TRUNCATION_MARKER, truncated: true };
}
