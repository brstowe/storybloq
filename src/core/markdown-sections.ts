export type Disposition =
  | "continuation"
  | "blocked"
  | "owner-gated"
  | "carried"
  | "unclassified";

export type SectionKind = "item" | "decision";

export interface SectionRecord {
  id: string | null;
  label: string;
  disposition: Disposition;
  rationale: string;
  kind: SectionKind;
  file: string;
}

export interface ContinuationIndex {
  omittedCount: number;
  ids: string[];
  file: string;
}

export type TrajectoryDisposition =
  | "continuation"
  | "blocked"
  | "owner-gated"
  | "carried"
  | "shipped";

export interface IdOccurrence {
  id: string;
  disposition: TrajectoryDisposition;
}

export interface ParsedHandover {
  records: SectionRecord[];
  shippedIds: string[];
  unclassifiedFallback: boolean;
  // Every id-bearing occurrence (classified records plus shipped ids), in
  // DOCUMENT ORDER. This is what lets buildTrajectory resolve a same-
  // handover tie (e.g. a shipped mention and a continuation mention of the
  // same id in one handover) by whichever occurs textually first, per the
  // plan -- a plain records[] + shippedIds[] pair loses that ordering.
  orderedIdOccurrences: IdOccurrence[];
}

export interface TrajectoryEntry {
  id: string;
  occurrenceCount: number;
  firstSeenInWindow: string;
  latest: string;
  latestDisposition: TrajectoryDisposition;
}

export interface TrajectoryHandoverInput {
  filename: string;
  orderedIdOccurrences: IdOccurrence[];
}

const CAP_BYTES = 1600;
const CAP_RECORDS = 12;
const RESERVE_MIN_COUNT = 4;
const RESERVE_MIN_BYTES = 480;
const LABEL_MAX_BYTES = 120;
const RATIONALE_MAX_BYTES = 240;
const INDEX_NON_FILE_MAX_BYTES = 160;
const INDEX_MAX_IDS = 20;

// CommonMark's plain fence-open rule: at most 3 leading spaces, applied at
// the top document level where there is no enclosing list item.
const TOP_LEVEL_FENCE_MAX_INDENT = 3;
// Marker indent (up to 3) + widest marker text ("123. ", 5 chars) + up to 3
// more spaces of CommonMark's container-indentation allowance, applied only
// within a single classified section's body, where a fence may legitimately
// be nested under a list item.
const NESTED_FENCE_MAX_INDENT = 11;

const ID_TOKEN_REGEX = /\b(?:T|ISS|N|L)-\d+\b/;
const ID_TOKEN_FULL_MATCH_REGEX = new RegExp(`^${ID_TOKEN_REGEX.source}$`);

/** Whether `s` is, in its entirety, a well-formed ticket/issue/note/lesson id token (T-123, ISS-45, ...). */
export function isIdToken(s: string): boolean {
  return ID_TOKEN_FULL_MATCH_REGEX.test(s);
}

const DECISION_CUE_TOKENS = [
  "decided",
  "ruled",
  "deferred",
  "abandoned",
  "instead",
  "because",
  "owner",
  "do not",
  "never",
  "superseded",
];

const DELIMITER_WORDS = new Set([
  "for",
  "before",
  "in",
  "on",
  "only",
  "to",
  "ranked",
  "after",
]);

interface CategoryToken {
  token: string;
  category: Disposition | "shipped";
}

const CATEGORY_TOKENS: CategoryToken[] = (
  [
    { token: "worker state", category: "continuation" },
    { token: "exact next step", category: "continuation" },
    { token: "next", category: "continuation" },
    { token: "remaining", category: "continuation" },
    { token: "todo", category: "continuation" },
    { token: "open", category: "continuation" },
    { token: "queue", category: "continuation" },
    { token: "blocked", category: "blocked" },
    { token: "owner-open", category: "owner-gated" },
    { token: "owner rulings", category: "owner-gated" },
    { token: "decisions pending", category: "owner-gated" },
    { token: "shipped", category: "shipped" },
    { token: "done", category: "shipped" },
    { token: "completed", category: "shipped" },
    { token: "landed", category: "shipped" },
    { token: "carried forward", category: "carried" },
  ] satisfies CategoryToken[]
).sort((a, b) => b.token.length - a.token.length);

// ---------------------------------------------------------------------------
// Byte-safe truncation
// ---------------------------------------------------------------------------

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

function truncateUtf8(s: string, maxBytes: number, ellipsis = "..."): string {
  if (byteLength(s) <= maxBytes) return s;
  const ellipsisBytes = byteLength(ellipsis);
  const budget = Math.max(0, maxBytes - ellipsisBytes);
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const chBytes = byteLength(ch);
    if (bytes + chBytes > budget) break;
    out += ch;
    bytes += chBytes;
  }
  return out + ellipsis;
}

// ---------------------------------------------------------------------------
// Heading grammar
// ---------------------------------------------------------------------------

function normalizeHeading(heading: string): string {
  return heading.normalize("NFKC").toLowerCase();
}

function isWordChar(ch: string): boolean {
  return /[a-z0-9-]/.test(ch);
}

function isWhitespaceChar(ch: string): boolean {
  return /\s/.test(ch);
}

function skipWhitespace(s: string, pos: number): number {
  let i = pos;
  while (i < s.length && isWhitespaceChar(s[i] as string)) i++;
  return i;
}

/**
 * `--` counts as the delimiter character at `pos` even though a single `-`
 * is itself a word character -- it is never absorbed into a word.
 */
function isDelimiterCharAt(s: string, pos: number): boolean {
  const ch = s[pos];
  if (ch === undefined) return false;
  if (ch === ":" || ch === "," || ch === "(") return true;
  return ch === "-" && s[pos + 1] === "-";
}

/**
 * Reads one word (a maximal run of letters/digits/hyphens) starting at
 * `pos`, stopping early at a `--` run so it is never absorbed into the
 * word. Returns null if `pos` is not the start of a word (e.g. an
 * unsupported punctuation character) -- this is what makes an input like
 * "Next !!!" fail to classify instead of being silently treated as if the
 * heading ended there.
 */
function readWordAt(s: string, pos: number): { word: string; nextPos: number } | null {
  let i = pos;
  let word = "";
  while (i < s.length) {
    if (s[i] === "-" && s[i + 1] === "-") break;
    const ch = s[i] as string;
    if (!isWordChar(ch)) break;
    word += ch;
    i++;
  }
  return word.length > 0 ? { word, nextPos: i } : null;
}

export function classifyHeading(rawHeading: string): Disposition | "shipped" | null {
  const normalized = normalizeHeading(rawHeading.trim());
  if (!normalized) return null;

  for (const { token, category } of CATEGORY_TOKENS) {
    if (!normalized.startsWith(token)) continue;
    const afterTokenIdx = token.length;
    if (afterTokenIdx > normalized.length) continue;

    const remainder = normalized.slice(afterTokenIdx);
    const boundaryOk =
      remainder.length === 0 ||
      /^\s/.test(remainder) ||
      /^[:,(]/.test(remainder) ||
      remainder.startsWith("--");
    if (!boundaryOk) continue;

    if (remainder.length === 0) return category;

    if (classifyRemainder(remainder)) return category;
  }

  return null;
}

/**
 * remainder is everything in the normalized heading after the category
 * token (already known to start at a valid boundary: whitespace, a
 * delimiter character, "--", or end-of-string). Parses it POSITIONALLY --
 * consume separators, recognize an immediate delimiter or delimiter word,
 * otherwise consume exactly one content word and require end-of-heading or
 * a delimiter at the position right after it. A delimiter character must
 * be found at its actual position; punctuation that never resolves to a
 * word or a delimiter (e.g. "!!!") fails the grammar outright rather than
 * being treated as if nothing followed the token.
 */
function classifyRemainder(remainder: string): boolean {
  let pos = skipWhitespace(remainder, 0);
  if (pos >= remainder.length) return true;
  if (isDelimiterCharAt(remainder, pos)) return true;

  const word1 = readWordAt(remainder, pos);
  if (word1 === null) return false;
  if (DELIMITER_WORDS.has(word1.word.toLowerCase())) return true;

  pos = skipWhitespace(remainder, word1.nextPos);
  if (pos >= remainder.length) return true;
  if (isDelimiterCharAt(remainder, pos)) return true;

  const word2 = readWordAt(remainder, pos);
  if (word2 === null) return false;
  if (DELIMITER_WORDS.has(word2.word.toLowerCase())) return true;

  // A second non-delimiter word exceeds the one-word allowance.
  return false;
}

// ---------------------------------------------------------------------------
// Fence-aware, heading-level section splitting
// ---------------------------------------------------------------------------

interface RawSection {
  level: number;
  heading: string;
  bodyLines: string[];
}

/**
 * `maxColumns` bounds how far a fence-open marker may sit from column 0
 * before it is ignored. Tabs expand to the next multiple of 4, the same
 * tab-stop model `nestedLineIndent` uses, so a tab-indented line is judged
 * by its actual expanded column like any other line -- treating "contains
 * a tab" as an automatic bypass (an earlier version of this function did)
 * let a tab-indented top-level line open a fence regardless of
 * `maxColumns`, silently reintroducing the exact swallowed-heading bug the
 * scoped tolerance was meant to fix (Codex review finding: fence-awareness).
 */
function stripFenceOpenIndent(line: string, maxColumns: number): string {
  let i = 0;
  let column = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === " ") {
      column += 1;
      i++;
      continue;
    }
    if (ch === "\t") {
      column += 4 - (column % 4);
      i++;
      continue;
    }
    break;
  }
  if (column > maxColumns) return line;
  return line.slice(i);
}

/**
 * `maxOpenIndentColumns` is deliberately a per-call parameter, not a module
 * constant: the two callers need different tolerances, and defaulting one
 * over the other here would silently apply the wrong rule to whichever
 * caller omitted it (Codex review finding: fence-awareness). At the TOP
 * document level (splitFenceAwareSections), a fence must open within
 * CommonMark's plain 3-space rule -- widening this here let a top-level
 * INDENTED CODE SAMPLE's literal "```" line be mistaken for a real fence
 * opener, swallowing every heading (and its records) until end of document.
 * WITHIN a single classified section's body (extractBullets), a fence
 * nested under a list item may legitimately sit at the item's content
 * indent (marker indent up to 3 spaces, plus marker text up to "123. " = 5
 * chars) plus up to 3 more spaces of CommonMark's container-indentation
 * allowance -- up to 11 columns -- which is what a numbered marker like
 * "10. " (content indent already 4) requires (pen ruling, T-320 commit 1
 * fence-indent fix).
 */
function markFenceLines(lines: string[], maxOpenIndentColumns: number): boolean[] {
  const inFence: boolean[] = new Array(lines.length).fill(false);
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const stripped = stripFenceOpenIndent(line, maxOpenIndentColumns);
    const match = /^(`{3,}|~{3,})/.exec(stripped);
    const fenceRun = match?.[1];
    if (fenceChar === null) {
      if (fenceRun) {
        fenceChar = fenceRun[0] as string;
        fenceLen = fenceRun.length;
        inFence[i] = true;
        continue;
      }
      inFence[i] = false;
    } else {
      inFence[i] = true;
      if (
        fenceRun &&
        fenceRun[0] === fenceChar &&
        fenceRun.length >= fenceLen &&
        stripped.slice(fenceRun.length).trim() === ""
      ) {
        fenceChar = null;
        fenceLen = 0;
      }
    }
  }
  return inFence;
}

function matchAtxHeading(line: string): { level: number; text: string } | null {
  const m = /^ {0,3}(#{1,6})(?:\s+(.*))?$/.exec(line);
  if (!m) return null;
  const level = (m[1] as string).length;
  let text = (m[2] ?? "").trim();
  text = text.replace(/\s+#+\s*$/, "").trim();
  return { level, text };
}

export function splitFenceAwareSections(markdown: string): RawSection[] {
  const lines = markdown.split(/\r\n|\r|\n/);
  const inFence = markFenceLines(lines, TOP_LEVEL_FENCE_MAX_INDENT);

  const root: RawSection = { level: 0, heading: "", bodyLines: [] };
  const sections: RawSection[] = [root];
  const stack: RawSection[] = [root];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!inFence[i]) {
      const heading = matchAtxHeading(line);
      if (heading) {
        while (stack.length) {
          const top = stack[stack.length - 1] as RawSection;
          if (top.level < heading.level) break;
          stack.pop();
        }
        const section: RawSection = {
          level: heading.level,
          heading: heading.text,
          bodyLines: [],
        };
        sections.push(section);
        stack.push(section);
        continue;
      }
    }
    (stack[stack.length - 1] as RawSection).bodyLines.push(line);
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Bullet / record extraction
// ---------------------------------------------------------------------------

interface RawBullet {
  firstLine: string;
  nestedNonFenceLines: string[];
  hasNestedFence: boolean;
}

/**
 * A list-item marker is either a GFM dash/star/plus bullet or an ordered-list
 * marker: 1 to 3 digits immediately followed by "." or ")" then whitespace.
 * The digit cap means a decimal mid-line ("1.5 ratio") never matches (the
 * single digit before the "." must be followed directly by whitespace, which
 * "5" is not) and a four-digit year ("2026. ") never matches either (no
 * digit-count backtrack reaches "." from any 1-3 digit prefix of "2026") --
 * both fall through as ordinary prose, which is the intended, accepted
 * boundary of this grammar, not a gap to special-case.
 */
const BULLET_MARKER_REGEX = /^( {0,3})(?:[-*+]|\d{1,3}[.)])[ \t]+(.*)$/;

/**
 * Column width of the leading spaces-and-tabs run, expanding each tab to
 * the next multiple of 4. A bullet marker's own indent is at most 3 spaces
 * (BULLET_MARKER_REGEX), so any leading tab -- alone or after 1-3 leading
 * spaces -- always expands past that, and correctly counts as nested
 * content. Walking the full mixed-whitespace prefix (rather than checking
 * only whether the line STARTS with a tab) is what makes a "one space then
 * a tab" continuation register as deeper than a 1-3-space marker indent
 * instead of wrongly ending the bullet (Codex review finding: indentation).
 */
function nestedLineIndent(line: string): number {
  let column = 0;
  for (const ch of line) {
    if (ch === " ") {
      column += 1;
      continue;
    }
    if (ch === "\t") {
      column += 4 - (column % 4);
      continue;
    }
    break;
  }
  return column;
}

function extractBullets(bodyLines: string[]): RawBullet[] {
  const bullets: RawBullet[] = [];
  let i = 0;
  // The outer scan (finding bullet-marker lines themselves) tracks its own
  // STRICT top-level fence state INCREMENTALLY, one line at a time, and
  // only over lines that are not already claimed by a bullet's nested
  // region below. A precomputed, whole-body outer fence pass (an earlier
  // version of this function used one) independently re-evaluates every
  // line under the strict tolerance, including a bullet's own nested-fence
  // CLOSING delimiter -- which, sitting at a narrow column valid for the
  // wide-tolerance opener that started it, is then misread as a fresh
  // top-level fence-OPEN, corrupting the outer scan's state and dropping
  // every following sibling bullet (Codex review finding: fence-
  // awareness, round 4). Skipping nested-region lines entirely here, by
  // jumping straight from a bullet's marker line to the line after its
  // nested region, keeps those lines governed exclusively by their own
  // local wide-tolerance fence scan below.
  let outerFenceChar: string | null = null;
  let outerFenceLen = 0;

  while (i < bodyLines.length) {
    const line = bodyLines[i] as string;

    if (outerFenceChar === null) {
      const m = BULLET_MARKER_REGEX.exec(line);
      if (m) {
        const markerIndent = (m[1] as string).length;
        const firstLine = m[2] as string;

        // The nested region's extent is purely indentation-based
        // (blank lines always continue it), independent of fence state.
        // Known limitation (pen byte-review, T-320 commit 1): a column-0
        // line INSIDE a nested fence's body (not just its opener/closer)
        // ends the nested region right there, same as any other column-0
        // line would. This matches CommonMark itself -- a column-0 line
        // is lazy continuation only for a paragraph, and it closes the
        // list item's container for a fenced code block the same way it
        // would for any other block -- so this is spec-accurate, not a
        // bug to fix.
        let j = i + 1;
        while (j < bodyLines.length) {
          const next = bodyLines[j] as string;
          if (next.trim() === "") {
            j++;
            continue;
          }
          if (nestedLineIndent(next) <= markerIndent) break;
          j++;
        }

        // A fence nested under THIS bullet gets the wider CommonMark
        // container allowance, scoped to exactly this bullet's own nested
        // lines via a fresh, local fence scan -- never to content outside
        // any bullet's nested region, and never observed by the outer
        // scan's fence state above or below.
        const nestedRaw = bodyLines.slice(i + 1, j);
        const nestedInFence = markFenceLines(nestedRaw, NESTED_FENCE_MAX_INDENT);
        const nested: string[] = [];
        let sawFence = false;
        for (let k = 0; k < nestedRaw.length; k++) {
          const next = nestedRaw[k] as string;
          if (next.trim() === "") {
            nested.push(next);
            continue;
          }
          if (nestedInFence[k]) {
            sawFence = true;
          } else {
            nested.push(next);
          }
        }

        bullets.push({
          firstLine,
          nestedNonFenceLines: nested.filter((l) => l.trim() !== ""),
          hasNestedFence: sawFence,
        });
        i = j;
        continue;
      }
    }

    // This line is not a bullet marker claiming a nested region below --
    // advance the outer, strict-tolerance fence state over it exactly as
    // markFenceLines would, one line at a time.
    const stripped = stripFenceOpenIndent(line, TOP_LEVEL_FENCE_MAX_INDENT);
    const fenceRun = /^(`{3,}|~{3,})/.exec(stripped)?.[1];
    if (outerFenceChar === null) {
      if (fenceRun) {
        outerFenceChar = fenceRun[0] as string;
        outerFenceLen = fenceRun.length;
      }
    } else if (
      fenceRun &&
      fenceRun[0] === outerFenceChar &&
      fenceRun.length >= outerFenceLen &&
      stripped.slice(fenceRun.length).trim() === ""
    ) {
      outerFenceChar = null;
      outerFenceLen = 0;
    }
    i++;
  }
  return bullets;
}

function extractIdToken(text: string): string | null {
  const m = ID_TOKEN_REGEX.exec(text);
  return m ? m[0] : null;
}

function computeLabelSource(firstLine: string, id: string | null): string {
  if (id === null) return firstLine.trim();
  const idx = firstLine.indexOf(id);
  if (idx === -1) return firstLine.trim();
  const after = firstLine.slice(idx + id.length);
  return after.replace(/^[\s:,\-.)]+/, "");
}

function findLabelDelimiter(labelSource: string): number | null {
  let bestIdx: number | null = null;
  let bytesBefore = 0;
  let charIdx = 0;
  const chars = Array.from(labelSource);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    if (bytesBefore >= LABEL_MAX_BYTES) break;
    if (ch === ":") {
      bestIdx = charIdx;
      break;
    }
    if (ch === "-" && chars[i + 1] === "-") {
      bestIdx = charIdx;
      break;
    }
    bytesBefore += byteLength(ch);
    charIdx += ch.length;
  }
  return bestIdx;
}

function computeLabelAndRemainder(labelSource: string): {
  label: string;
  remainder: string | null;
} {
  const delimiterIdx = findLabelDelimiter(labelSource);
  if (delimiterIdx !== null) {
    const label = labelSource.slice(0, delimiterIdx).trimEnd();
    const isDoubleHyphen = labelSource.slice(delimiterIdx, delimiterIdx + 2) === "--";
    const afterDelimiter = labelSource.slice(delimiterIdx + (isDoubleHyphen ? 2 : 1));
    return { label: truncateUtf8(label, LABEL_MAX_BYTES), remainder: afterDelimiter.trim() };
  }
  return {
    label: truncateUtf8(labelSource.trim(), LABEL_MAX_BYTES),
    remainder: null,
  };
}

function computeRationale(remainder: string | null, bullet: RawBullet): string {
  if (remainder !== null && remainder.length > 0) {
    const m = /[.!?] /.exec(remainder);
    const cut = m ? remainder.slice(0, m.index + 1) : remainder;
    return truncateUtf8(cut.trim(), RATIONALE_MAX_BYTES);
  }
  const firstNestedLine = bullet.nestedNonFenceLines[0];
  if (firstNestedLine !== undefined) {
    const firstNested = firstNestedLine.trim();
    if (firstNested) return truncateUtf8(firstNested, RATIONALE_MAX_BYTES);
  }
  return "unknown";
}

function containsCueToken(text: string): boolean {
  const lower = text.toLowerCase();
  return DECISION_CUE_TOKENS.some((token) => lower.includes(token));
}

function buildRecordFromBullet(
  bullet: RawBullet,
  disposition: Disposition,
  file: string,
): SectionRecord {
  const id = extractIdToken(bullet.firstLine);
  const labelSource = computeLabelSource(bullet.firstLine, id);
  const { label, remainder } = computeLabelAndRemainder(labelSource);
  const rationale = computeRationale(remainder, bullet);
  const kind: SectionKind =
    id === null && containsCueToken(bullet.firstLine) ? "decision" : "item";
  return { id, label, disposition, rationale, kind, file };
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

export function parseHandoverMarkdown(
  markdown: string,
  file: string,
): ParsedHandover {
  const sections = splitFenceAwareSections(markdown);
  const records: SectionRecord[] = [];
  const shippedIds: string[] = [];
  const orderedIdOccurrences: IdOccurrence[] = [];

  let anyClassified = false;

  for (const section of sections) {
    if (section.level === 0) continue;
    const category = classifyHeading(section.heading);
    if (category === null) continue;
    anyClassified = true;

    const bullets = extractBullets(section.bodyLines);
    if (category === "shipped") {
      for (const bullet of bullets) {
        const id = extractIdToken(bullet.firstLine);
        if (id) {
          shippedIds.push(id);
          orderedIdOccurrences.push({ id, disposition: "shipped" });
        }
      }
      continue;
    }

    for (const bullet of bullets) {
      const record = buildRecordFromBullet(bullet, category, file);
      records.push(record);
      if (record.id !== null) {
        // `category` here is never "unclassified" in practice -- that
        // disposition is only ever produced by buildUnclassifiedFallback,
        // not by classifyHeading -- so this narrows safely to the
        // trajectory-relevant subset of Disposition.
        orderedIdOccurrences.push({ id: record.id, disposition: category as TrajectoryDisposition });
      }
    }
  }

  if (anyClassified) {
    return { records, shippedIds, unclassifiedFallback: false, orderedIdOccurrences };
  }

  const fallback = buildUnclassifiedFallback(sections, file);
  return {
    records: fallback ? [fallback] : [],
    shippedIds,
    unclassifiedFallback: true,
    orderedIdOccurrences: [],
  };
}

function buildUnclassifiedFallback(
  sections: RawSection[],
  file: string,
): SectionRecord | null {
  // The root (level 0) section holds content before the first heading, and
  // the first real heading is typically the document title (H1); its
  // bodyLines hold the first paragraph after the title.
  const root = sections.find((s) => s.level === 0);
  const title = sections.find((s) => s.level >= 1);
  const candidateLines = title ? title.bodyLines : root?.bodyLines ?? [];

  const paragraphLines: string[] = [];
  for (const line of candidateLines) {
    if (line.trim() === "") {
      if (paragraphLines.length > 0) break;
      continue;
    }
    if (BULLET_MARKER_REGEX.test(line)) break;
    paragraphLines.push(line);
  }
  if (paragraphLines.length === 0) return null;

  const bullet: RawBullet = {
    firstLine: paragraphLines.join(" ").trim(),
    nestedNonFenceLines: [],
    hasNestedFence: false,
  };
  const record = buildRecordFromBullet(bullet, "unclassified", file);
  return record;
}

// ---------------------------------------------------------------------------
// Byte-budget selection
// ---------------------------------------------------------------------------

function recordBytes(record: SectionRecord): number {
  return byteLength(JSON.stringify(record));
}

/**
 * The bound this module promises is on the ACTUAL final serialized form the
 * caller receives -- array brackets, commas, and property names included --
 * not a sum of independently-stringified pieces (round-1 code review finding:
 * byte-budget).
 */
function fitsEnvelope(records: SectionRecord[], index: ContinuationIndex | null): boolean {
  return byteLength(JSON.stringify({ records, index })) <= CAP_BYTES;
}

/**
 * Binary search for the LONGEST UTF-8-safe label prefix (via `truncateUtf8`,
 * so the ellipsis marker and JSON escaping are already reflected in the
 * real serialized size `fitsEnvelope` measures) whose envelope fits the
 * remaining budget -- not a fixed shrink target (round-2 code review
 * finding: record-selection -- a fixed target rejects a record that could
 * still fit with further truncation, and can end the reserve pass
 * prematurely). `truncateUtf8(label, n)` is monotonic non-decreasing in
 * `n`, which is what makes the search valid. Returns null only when even
 * the minimal (fully truncated) label does not fit.
 */
function shrinkLabelToFit(
  selected: SectionRecord[],
  record: SectionRecord,
): SectionRecord | null {
  let lo = 0;
  let hi = byteLength(record.label);
  let best: string | null = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const label = truncateUtf8(record.label, mid);
    if (fitsEnvelope([...selected, { ...record, label }], null)) {
      best = label;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return best === null ? null : { ...record, label: best };
}

/**
 * Tries to add `candidate` to the already-committed `selected` array,
 * shrinking it (rationale, then label, per the plan's ordering) until it
 * fits the real envelope or every shrink stage has been exhausted. Returns
 * the record actually to add, or null if the candidate cannot be admitted
 * (cap already full, or not even a minimally-shrunk form fits).
 */
function tryAdmit(selected: SectionRecord[], candidate: SectionRecord): SectionRecord | null {
  if (selected.length + 1 > CAP_RECORDS) return null;

  if (fitsEnvelope([...selected, candidate], null)) return candidate;

  const rationaleDropped =
    candidate.rationale === "unknown" ? candidate : { ...candidate, rationale: "unknown" };
  if (fitsEnvelope([...selected, rationaleDropped], null)) return rationaleDropped;

  return shrinkLabelToFit(selected, rationaleDropped);
}

// ---------------------------------------------------------------------------
// T-498 Commit 2: document-order continuation candidates
// ---------------------------------------------------------------------------

/**
 * T-498 design decision 1: the CROSS-handover budget's own 800-byte reserve
 * for `handovers[0]`'s continuation candidates -- a NEW, SEPARATE cap from
 * `CAP_BYTES` (1,600), never drawn from the 14,200-byte cross-handover
 * structured budget. `CONTINUATION_CAP_RECORDS` reuses `CAP_RECORDS`: the
 * plan names a new BYTE reserve, not a new record-count ceiling.
 */
const CONTINUATION_CAP_BYTES = 800;
const CONTINUATION_CAP_RECORDS = CAP_RECORDS;

export interface ContinuationCandidate {
  readonly id: string | null;
  readonly kind: SectionKind;
  readonly label: string;
  readonly rationale: string;
}

export interface ContinuationCandidatesResult {
  readonly candidates: ContinuationCandidate[];
  readonly omittedContinuationCount: number;
  readonly omittedContinuationIds: string[];
}

function toContinuationCandidate(r: SectionRecord): ContinuationCandidate {
  return { id: r.id, kind: r.kind, label: r.label, rationale: r.rationale };
}

/**
 * The full envelope this budget promises: the admitted candidates PLUS the
 * omission-disclosure fields, which cost real bytes too (round-2-style
 * finding this module already learned from `fitsEnvelope`: a bound on the
 * pieces alone is not a bound on what the caller actually receives).
 */
function continuationEnvelopeFits(
  candidates: SectionRecord[],
  omittedContinuationCount: number,
  omittedContinuationIds: string[],
): boolean {
  return (
    byteLength(
      JSON.stringify({
        candidates: candidates.map(toContinuationCandidate),
        omittedContinuationCount,
        omittedContinuationIds,
      }),
    ) <= CONTINUATION_CAP_BYTES
  );
}

function continuationCandidatesFit(candidates: SectionRecord[]): boolean {
  return continuationEnvelopeFits(candidates, 0, []);
}

/** Same binary-search shrink as `shrinkLabelToFit`, scoped to the continuation-candidate envelope. */
function shrinkContinuationLabelToFit(
  selected: SectionRecord[],
  record: SectionRecord,
): SectionRecord | null {
  let lo = 0;
  let hi = byteLength(record.label);
  let best: string | null = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const label = truncateUtf8(record.label, mid);
    if (continuationCandidatesFit([...selected, { ...record, label }])) {
      best = label;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return best === null ? null : { ...record, label: best };
}

/** Same shrink-then-cap approach as `tryAdmit` (try as-is, drop rationale, shrink label), scoped to `CONTINUATION_CAP_BYTES`/`CONTINUATION_CAP_RECORDS`. */
function tryAdmitContinuation(
  selected: SectionRecord[],
  candidate: SectionRecord,
): SectionRecord | null {
  if (selected.length + 1 > CONTINUATION_CAP_RECORDS) return null;

  if (continuationCandidatesFit([...selected, candidate])) return candidate;

  const rationaleDropped =
    candidate.rationale === "unknown" ? candidate : { ...candidate, rationale: "unknown" };
  if (continuationCandidatesFit([...selected, rationaleDropped])) return rationaleDropped;

  return shrinkContinuationLabelToFit(selected, rationaleDropped);
}

function continuationOmittedIdsFrom(
  omittedOriginalIndices: number[],
  records: readonly SectionRecord[],
): string[] {
  const ids = omittedOriginalIndices
    .map((i) => records[i]?.id)
    .filter((x): x is string => x !== null && x !== undefined);
  return ids.slice(0, INDEX_MAX_IDS);
}

/**
 * T-498 design decision 1: the document-order, continuation-disposition-only
 * primitive that line one's resolution logic needs -- distinct from
 * `selectBoundedRecords`'s display-shaped, reserve-then-reorder output.
 * Reads from the SAME pre-`selectBoundedRecords` ordered `records[]`
 * `parseHandoverMarkdown` already builds (per "What already exists": that
 * list is in true document order and is not itself reshuffled).
 *
 * No reserve pass: for THIS purpose, "first in the source" is the whole
 * priority, so every continuation-disposition record is tried for admission
 * in document order, one single pass, with items after a capacity-exhausted
 * point evicted from the end (mirroring `fitIndex`) only when the FULL
 * envelope -- omission fields included -- still does not fit.
 */
export function selectContinuationCandidates(
  records: readonly SectionRecord[],
  _file: string,
): ContinuationCandidatesResult {
  const continuationEntries = records
    .map((r, i) => ({ r, i }))
    .filter((x) => x.r.disposition === "continuation");

  const selected: SectionRecord[] = [];
  const selectedOriginalIndices: number[] = [];
  const admitted = new Set<number>();

  for (const { r, i } of continuationEntries) {
    const result = tryAdmitContinuation(selected, r);
    if (result === null) continue;
    selected.push(result);
    selectedOriginalIndices.push(i);
    admitted.add(i);
  }

  const omittedOriginalIndices = continuationEntries
    .map((x) => x.i)
    .filter((i) => !admitted.has(i));

  if (omittedOriginalIndices.length === 0) {
    return {
      candidates: selected.map(toContinuationCandidate),
      omittedContinuationCount: 0,
      omittedContinuationIds: [],
    };
  }

  const working = [...selected];
  const workingIndices = [...selectedOriginalIndices];
  const omitted = [...omittedOriginalIndices];
  let omittedIds = continuationOmittedIdsFrom(omitted, records);

  while (
    working.length > 0 &&
    !continuationEnvelopeFits(working, omitted.length, omittedIds)
  ) {
    working.pop();
    const evicted = workingIndices.pop() as number;
    omitted.push(evicted);
    omittedIds = continuationOmittedIdsFrom(omitted, records);
  }

  // The candidate-eviction loop above only pops `working`, so it cannot help
  // once `working` is already empty. A parser-accepted id can still be
  // arbitrarily long, so `omittedContinuationIds` alone (even capped to
  // `INDEX_MAX_IDS` entries) can exceed the 800-byte envelope on its own --
  // shrink the disclosed id list itself until the envelope fits, mirroring
  // `buildIndex`'s own trim-to-fit. `omittedContinuationCount` is left
  // untouched: it is a plain count, not user-controlled text, and stays
  // accurate regardless of how many ids end up disclosed.
  while (omittedIds.length > 0 && !continuationEnvelopeFits(working, omitted.length, omittedIds)) {
    omittedIds = omittedIds.slice(0, -1);
  }

  return {
    candidates: working.map(toContinuationCandidate),
    omittedContinuationCount: omitted.length,
    omittedContinuationIds: omittedIds,
  };
}

export function selectBoundedRecords(
  candidates: SectionRecord[],
  file: string,
): { records: SectionRecord[]; index: ContinuationIndex | null } {
  const selected: SectionRecord[] = [];
  // Parallel to `selected`: the ORIGINAL candidate index each entry came
  // from, tracked explicitly rather than by object identity (round-1 code
  // review finding: omission-accounting -- a shrunk record is a new object,
  // so identity-based omission detection double-counted it).
  const selectedOriginalIndices: number[] = [];
  const admitted = new Set<number>();

  const decisionEntries = candidates
    .map((c, i) => ({ c, i }))
    .filter((x) => x.c.kind === "decision");
  const totalDecisions = decisionEntries.length;
  const reserveFloorCount = Math.min(RESERVE_MIN_COUNT, totalDecisions);
  const totalDecisionBytes = decisionEntries.reduce(
    (sum, x) => sum + recordBytes(x.c),
    0,
  );
  const reserveFloorBytes = Math.min(RESERVE_MIN_BYTES, totalDecisionBytes);

  let reservedBytes = 0;
  let reservedCount = 0;

  for (const { c, i } of decisionEntries) {
    if (reservedCount >= reserveFloorCount && reservedBytes >= reserveFloorBytes) {
      break;
    }
    const result = tryAdmit(selected, c);
    if (result === null) break;
    selected.push(result);
    selectedOriginalIndices.push(i);
    admitted.add(i);
    reservedBytes += recordBytes(result);
    reservedCount++;
  }

  // Fill pass, per the plan: id-bearing records in document order, THEN
  // remaining id-less bullets -- two separate passes, not one combined
  // document-order walk (pen byte-review finding: an id-less bullet sitting
  // before an id-bearing one in the source document must not take budget
  // the id-bearing one needs).
  for (let i = 0; i < candidates.length; i++) {
    if (admitted.has(i)) continue;
    if ((candidates[i] as SectionRecord).id === null) continue;
    const result = tryAdmit(selected, candidates[i] as SectionRecord);
    if (result === null) continue;
    selected.push(result);
    selectedOriginalIndices.push(i);
    admitted.add(i);
  }

  for (let i = 0; i < candidates.length; i++) {
    if (admitted.has(i)) continue;
    if ((candidates[i] as SectionRecord).id !== null) continue;
    const result = tryAdmit(selected, candidates[i] as SectionRecord);
    if (result === null) continue;
    selected.push(result);
    selectedOriginalIndices.push(i);
    admitted.add(i);
  }

  const omittedOriginalIndices = candidates
    .map((_, i) => i)
    .filter((i) => !admitted.has(i));

  if (omittedOriginalIndices.length === 0) {
    return { records: selected, index: null };
  }

  return fitIndex(selected, selectedOriginalIndices, omittedOriginalIndices, candidates, file);
}

function indexNonFileBytes(omittedCount: number, ids: string[]): number {
  return byteLength(JSON.stringify({ omittedCount, ids }));
}

/**
 * Shapes a `ContinuationIndex` from a raw omitted-id list: caps to
 * `INDEX_MAX_IDS` ids, then shrinks further until the non-file part (per
 * T-320's amendment) fits `INDEX_NON_FILE_MAX_BYTES`. Exported (beyond this
 * module's own per-handover eviction path) so a CROSS-handover budget walk
 * (T-320 commit 2) can build a full, standalone index for a handover it
 * demotes entirely -- covering every id that handover ever had, not just the
 * ones this module's own per-handover selection evicted.
 */
export function buildIndex(
  omittedCount: number,
  candidateIds: string[],
  file: string,
): ContinuationIndex {
  let ids = candidateIds.slice(0, INDEX_MAX_IDS);
  while (ids.length > 0 && indexNonFileBytes(omittedCount, ids) > INDEX_NON_FILE_MAX_BYTES) {
    ids = ids.slice(0, -1);
  }
  return { omittedCount, ids, file };
}

function buildIndexFromOmitted(
  omittedOriginalIndices: number[],
  candidates: SectionRecord[],
  file: string,
): ContinuationIndex {
  const ids = omittedOriginalIndices
    .map((i) => candidates[i]?.id)
    .filter((x): x is string => x !== null && x !== undefined);
  return buildIndex(omittedOriginalIndices.length, ids, file);
}

function fitIndex(
  selected: SectionRecord[],
  selectedOriginalIndices: number[],
  omittedOriginalIndices: number[],
  candidates: SectionRecord[],
  file: string,
): { records: SectionRecord[]; index: ContinuationIndex } {
  const working = [...selected];
  const workingIndices = [...selectedOriginalIndices];
  const omitted = [...omittedOriginalIndices];

  let index = buildIndexFromOmitted(omitted, candidates, file);

  // `working` is ordered [reserve-pass records..., fill-pass records...], so
  // popping from the end evicts the last fill-pass record first and only
  // reaches reserve-pass decisions (most-recently-reserved first) once every
  // fill-pass record is gone -- exactly the eviction order the plan
  // specifies, with no separate bookkeeping needed.
  // `+ 1` treats the index as occupying one of the 12 record slots itself
  // (conservative by design, per the plan's "competes for the SAME
  // 1,600-byte/12-record budget").
  while (
    working.length > 0 &&
    (!fitsEnvelope(working, index) || working.length + 1 > CAP_RECORDS)
  ) {
    working.pop();
    const evictedOriginalIndex = workingIndices.pop() as number;
    omitted.push(evictedOriginalIndex);
    index = buildIndexFromOmitted(omitted, candidates, file);
  }

  return { records: working, index };
}

// ---------------------------------------------------------------------------
// Trajectory list
// ---------------------------------------------------------------------------

/**
 * Within one handover, reduces its (already document-order) occurrences to
 * the FIRST disposition per id -- resolving a same-id tie (e.g. shipped AND
 * continuation both name it) by whichever occurrence is textually first
 * (round-1 code review finding: trajectory-ordering). Relying on Map
 * insertion order over the document-ordered stream is what implements
 * "textually first" here. Extracted (ISS-1154) so `computeActionability`'s
 * `continuationMentionCount` can share this exact reduction with
 * `buildTrajectory`, rather than re-deriving it and risking the two
 * disagreeing on which disposition "won" a same-handover tie.
 */
export function firstDispositionPerHandover(
  orderedIdOccurrences: readonly IdOccurrence[],
): Map<string, TrajectoryDisposition> {
  const firstDisposition = new Map<string, TrajectoryDisposition>();
  for (const occurrence of orderedIdOccurrences) {
    if (!firstDisposition.has(occurrence.id)) {
      firstDisposition.set(occurrence.id, occurrence.disposition);
    }
  }
  return firstDisposition;
}

export function buildTrajectory(
  handovers: TrajectoryHandoverInput[],
): TrajectoryEntry[] {
  const byId = new Map<
    string,
    {
      occurrenceCount: number;
      firstSeenInWindow: string;
      latest: string;
      latestDisposition: TrajectoryDisposition;
    }
  >();

  // handovers is expected newest-to-oldest. We iterate in that order so the
  // FIRST time we see an id, it's the newest (latest) mention.
  for (const handover of handovers) {
    const firstDispositionThisHandover = firstDispositionPerHandover(handover.orderedIdOccurrences);
    // occurrenceCount counts handovers whose continuation/blocked/
    // owner-gated/carried sections name the id -- a shipped-only mention
    // sets latest/latestDisposition (via firstDispositionThisHandover
    // above) but never increments occurrenceCount (pen byte-review
    // finding).
    const hasNonShippedMention = new Set<string>();
    for (const occurrence of handover.orderedIdOccurrences) {
      if (occurrence.disposition !== "shipped") {
        hasNonShippedMention.add(occurrence.id);
      }
    }

    for (const [id, disposition] of firstDispositionThisHandover) {
      if (!byId.has(id)) {
        byId.set(id, {
          occurrenceCount: 0,
          firstSeenInWindow: handover.filename,
          latest: handover.filename,
          latestDisposition: disposition,
        });
      }
    }

    for (const id of hasNonShippedMention) {
      const entry = byId.get(id) as {
        occurrenceCount: number;
        firstSeenInWindow: string;
        latest: string;
        latestDisposition: TrajectoryDisposition;
      };
      entry.occurrenceCount += 1;
      entry.firstSeenInWindow = handover.filename;
    }
  }

  return Array.from(byId.entries()).map(([id, entry]) => ({ id, ...entry }));
}
