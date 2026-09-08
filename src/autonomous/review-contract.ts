/**
 * T-487 step 2: the review contract, read from REVIEW.md, in REPORT-ONLY mode.
 *
 * WHAT THIS FILE DECIDES, AND WHY IT DECIDES IT THIS WAY.
 *
 * T-487 turns "is this finding a major" from a reviewer's taste into a
 * checkable question: which principle does it break, and does the project treat
 * that principle as blocking. The obvious implementation reads REVIEW.md and
 * caps any finding that names no principle. The obvious implementation is also
 * unsafe, because it makes the gate's strength depend on a file parsing the way
 * its reader expects, and a file can be present and say nothing this reader
 * understands.
 *
 * That is not hypothetical. This repository has had a REVIEW.md since April: a
 * review CHECKLIST (Always check / Always flag / Skip) with three headings and
 * not one blocking class in it. Every project that wrote a REVIEW.md before
 * T-487 existed is in the same state.
 *
 * So activation is PARSE-GATED, and a declaration this code cannot read
 * INVALIDATES the whole contract rather than being skipped. The two failures
 * are different and both are silent: a file that activates with one of six
 * principles caps findings against a policy its owner did not write, and a file
 * that activates with none silences nothing but says nothing either.
 *
 * THE INVARIANT, restated because the parked version of this file had it wrong.
 * It is NOT "no REVIEW.md input makes the gate quieter than having none" -- a
 * valid contract capping an inside finding that names no principle IS quieter,
 * by design, and that is the feature. It holds for INACTIVE contracts only:
 * absent, unparseable, or carrying a declaration this code cannot read, the
 * existing severity ladder stays exactly as it is.
 *
 * REPORT-ONLY. Nothing here mutates a finding, and nothing here decides a
 * round. `evaluatePrinciplePolicy` returns the input array by identity and a
 * parallel set of projections saying what a flipped policy WOULD do.
 * `projectRoundGate` is the one side-effect-free decision function that serves
 * the projection now and the application at the flip (ruling
 * `r-gma645xs5ktcxb4v` clause 19), so the two can never drift.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { findingIsBlockedByOrigin } from "./review-identity.js";
import { normalizeSeverity } from "./session-types.js";

/**
 * How hard a violation of a principle pushes.
 *
 * Deliberately three values and not the four of the severity ladder: this is
 * the POLICY the project declares, not the severity a reviewer reports.
 */
export const BLOCKING_CLASSES = ["blocking", "major", "suggestion"] as const;
export type BlockingClass = typeof BLOCKING_CLASSES[number];

export interface ReviewPrinciple {
  /** The heading text, verbatim. Owner-chosen; this code never fixes it up. */
  readonly name: string;
  /** First prose line under the heading. Informational, may be empty. */
  readonly definition: string;
  readonly blockingClass: BlockingClass;
}

/**
 * A declaration that was ATTEMPTED and could not be read.
 *
 * Kept apart from "no declaration" because they are different facts about
 * different actors: a section with no blocking line is prose, and prose is
 * legal. A section that tried to declare a class and got the word wrong is a
 * policy the owner believes is in force and is not.
 */
export interface InvalidDeclaration {
  readonly section: string;
  readonly reason: "unrecognised-class" | "valueless";
  readonly word?: string;
}

/**
 * `absent` and `unparseable` both mean the ladder stays in force, and they are
 * still kept apart, because they need different warnings and different
 * remedies. Telling someone their REVIEW.md is missing when it is sitting in
 * their repo sends them looking for the wrong thing.
 */
export type ReviewContractStatus = "active" | "absent" | "unparseable";

export interface ReviewContract {
  readonly status: ReviewContractStatus;
  readonly principles: readonly ReviewPrinciple[];
  /** Lens ids and categories the contract declares out of scope. Lowercased. */
  readonly outside: readonly string[];
  /** How many "Outside this contract" sections the file carried. */
  readonly outsideSections: number;
  readonly invalid: readonly InvalidDeclaration[];
  /** Always populated, including when absent, so a warning can name the path. */
  readonly path: string;
  /** Raw file text, present whenever the file was readable. Fed to backends. */
  readonly text?: string;
  /**
   * T-495: sha256 over the SOURCE BYTES of the same read that produced `text`.
   *
   * One site, one read. A call site that hashed the file on its own could hash
   * a version the reviewer never received -- the file can change between two
   * reads -- and the delivery record would then name the wrong contract, which
   * is worse than naming none.
   *
   * NULL exactly when `text` is absent, and never the hash of the empty string:
   * that hash is a real, stable value, so two projects with no contract at all
   * would agree on a baseline and read as having received the same one.
   */
  readonly contentHash: string | null;
}

export type ReviewContractWarningKind =
  | "review-contract-absent"
  | "review-contract-unparseable"
  | "review-contract-invalid-class"
  | "review-contract-empty-outside"
  | "review-contract-duplicate-outside"
  | "review-contract-config-silences-implicit";

export interface ReviewContractWarning {
  readonly kind: ReviewContractWarningKind;
  readonly level: "warning" | "error";
  readonly message: string;
}

const REVIEW_FILENAME = "REVIEW.md";

/**
 * A declaration was ATTEMPTED. Separate from the pattern that reads its value,
 * because collapsing the two makes `Blocking:` with no value indistinguishable
 * from prose, and prose is legal while a valueless declaration is not.
 */
const DECL_LINE = /^\s*blocking(?:\s+class)?\s*:/i;
/** ...and it carries a value. */
const CLASS_LINE = /^\s*blocking(?:\s+class)?\s*:\s*(\S+)/i;

/** A markdown heading of level 2 or deeper. Level 1 is the document title. */
const HEADING = /^(#{2,6})\s+(.+?)\s*$/;

const OUTSIDE_HEADING = /^outside this contract$/i;

/** The setup step that writes the file, named in every message that asks for it. */
const SETUP_HINT = "`storybloq setup-skill` then the /story setup flow proposes one";

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,;]+$/, "");
}

/**
 * ONE normalizer for every value that takes part in a coverage or config match:
 * the Outside entries, a finding's category, and a contributing lens id.
 *
 * Codex found the asymmetry in review: entries were trimmed, lowercased and
 * depunctuated while the values they were matched against were only lowercased,
 * so `" Performance; "` missed an Outside entry of `performance` and was
 * classified INSIDE, where it can be capped. A matcher whose two sides
 * normalize differently is a matcher that fails on the inputs a human types.
 */
function coverageKey(value: string): string {
  return stripTrailingPunctuation(value.trim().toLowerCase());
}

function asBlockingClass(value: string): BlockingClass | undefined {
  const v = stripTrailingPunctuation(value.toLowerCase());
  return (BLOCKING_CLASSES as readonly string[]).includes(v)
    ? (v as BlockingClass)
    : undefined;
}

interface ParseResult {
  readonly principles: ReviewPrinciple[];
  readonly invalid: InvalidDeclaration[];
  readonly outside: string[];
  readonly outsideSections: number;
}

function parseContract(text: string): ParseResult {
  const principles: ReviewPrinciple[] = [];
  const invalid: InvalidDeclaration[] = [];
  const outside = new Set<string>();
  let outsideSections = 0;

  let name: string | null = null;
  let definition = "";
  let blockingClass: BlockingClass | undefined;
  let inOutside = false;

  const flush = (): void => {
    // A section becomes a principle ONLY by carrying a class this code knows.
    // A heading alone is not a principle: that is precisely what the legacy
    // checklist files are made of.
    if (name !== null && blockingClass !== undefined) {
      principles.push({ name, definition, blockingClass });
    }
    name = null;
    definition = "";
    blockingClass = undefined;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const heading = HEADING.exec(rawLine);
    if (heading) {
      flush();
      const title = heading[2]!;
      if (OUTSIDE_HEADING.test(title.replace(/\*/g, "").trim())) {
        inOutside = true;
        outsideSections += 1;
        continue;
      }
      inOutside = false;
      name = title;
      continue;
    }

    if (inOutside) {
      for (const part of rawLine.replace(/\*/g, "").split(",")) {
        const entry = coverageKey(part);
        if (entry !== "") outside.add(entry);
      }
      continue;
    }

    if (name === null) continue; // prose before any heading belongs to nothing

    // Strip emphasis before matching, so one pattern covers every spelling.
    const line = rawLine.replace(/\*/g, "");
    if (DECL_LINE.test(line)) {
      // EVERY declaration is examined, not just the first. `??=` kept the first
      // and never looked at a second, so a good-then-bad section activated with
      // the bad word never seen.
      const classMatch = CLASS_LINE.exec(line);
      if (!classMatch) {
        invalid.push({ section: name, reason: "valueless" });
        continue;
      }
      const parsed = asBlockingClass(classMatch[1]!);
      if (parsed === undefined) {
        invalid.push({
          section: name,
          reason: "unrecognised-class",
          word: stripTrailingPunctuation(classMatch[1]!.toLowerCase()),
        });
        continue;
      }
      blockingClass ??= parsed;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed !== "" && definition === "") definition = trimmed;
  }
  flush();
  return { principles, invalid, outside: [...outside], outsideSections };
}

/**
 * Read and classify the project's review contract.
 *
 * Never throws. Every failure mode resolves to a status that keeps the existing
 * severity ladder in force, because the alternative is a reader that decides
 * how strict the gate is by whether a file happened to open.
 */
export function loadReviewContract(projectRoot: string): ReviewContract {
  const path = join(projectRoot, REVIEW_FILENAME);

  // Read as BYTES, hash the bytes, and decode from the same buffer.
  //
  // `Buffer.from(readFileSync(path, "utf-8"), "utf-8")` re-encodes text that
  // has ALREADY been decoded, and decoding replaces invalid UTF-8 sequences, so
  // two different files can produce the same hash while the docblock above
  // claims source-byte identity. Codex found it. One read, one buffer, and the
  // hash names the bytes on disk.
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    // ENOENT is the only error that means "no contract was offered". Anything
    // else -- a directory at that path, a permission error, an I/O fault --
    // means a contract may well exist and we could not read it, which is a
    // DIFFERENT problem and must not be reported as absence.
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      status: code === "ENOENT" ? "absent" : "unparseable",
      principles: [],
      outside: [],
      outsideSections: 0,
      invalid: [],
      path,
      contentHash: null,
    };
  }

  const text = bytes.toString("utf-8");
  const { principles, invalid, outside, outsideSections } = parseContract(text);
  // An unreadable declaration invalidates the WHOLE contract. Activating on the
  // survivors would apply a policy narrower than the one its owner wrote, and
  // the capping direction makes that silence rather than noise.
  const status: ReviewContractStatus =
    invalid.length > 0 ? "unparseable" : principles.length > 0 ? "active" : "unparseable";
  return {
    status,
    principles,
    outside,
    outsideSections,
    invalid,
    path,
    text,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * The findings `storybloq validate` surfaces for the review contract.
 *
 * Silent when NO review backend is effective, because nothing reviews, so
 * nothing is missing. The list is the EFFECTIVE one, not the raw override
 * array: a project that configured nothing still reviews with codex and agent,
 * and reading the raw array left exactly those projects silent.
 */
export function reviewContractWarnings(
  contract: ReviewContract,
  opts: {
    readonly effectiveBackends: readonly string[];
    readonly neverBlock?: readonly string[];
  },
): readonly ReviewContractWarning[] {
  if (opts.effectiveBackends.length === 0) return [];

  const out: ReviewContractWarning[] = [];

  if (contract.status === "absent") {
    out.push({
      kind: "review-contract-absent",
      level: "warning",
      message:
        `No ${REVIEW_FILENAME} found at ${contract.path}, and review backends are configured `
        + `(${opts.effectiveBackends.join(", ")}). Reviewers are running without a quality contract, `
        + `so findings are classified by the built-in severity ladder. That ladder remains in force `
        + `and the review gate is live; to declare which principles block, add ${REVIEW_FILENAME} `
        + `(${SETUP_HINT}).`,
    });
    return out;
  }

  for (const bad of contract.invalid) {
    out.push({
      kind: "review-contract-invalid-class",
      level: "error",
      message: bad.reason === "valueless"
        ? `${contract.path}: section "${bad.section}" declares a blocking class with no value. `
          + `The whole contract is ignored for policy purposes and the built-in severity ladder `
          + `remains in force. Expected one of ${BLOCKING_CLASSES.join(", ")}.`
        : `${contract.path}: section "${bad.section}" declares blocking class "${bad.word}", which is `
          + `not one of ${BLOCKING_CLASSES.join(", ")}. The whole contract is ignored for policy `
          + `purposes and the built-in severity ladder remains in force.`,
    });
  }

  if (contract.status === "unparseable") {
    if (out.length === 0) {
      out.push({
        kind: "review-contract-unparseable",
        level: "warning",
        message:
          `${contract.path} exists but declares no principle with a recognised blocking class `
          + `(expected a heading followed by a line such as "Blocking: blocking", where the class is `
          + `one of ${BLOCKING_CLASSES.join(", ")}). The file is being ignored for policy purposes, `
          + `the built-in severity ladder remains in force, and the review gate is live. `
          + `A review checklist written before the contract existed reads exactly this way `
          + `(${SETUP_HINT}).`,
      });
    }
    return out;
  }

  // Active from here down.
  if (contract.outside.length === 0) {
    // The QUIETEST configuration: everything is inside the contract, so every
    // finding that names no declared principle is capped. An owner may want
    // that. "I chose full coverage" and "my Outside line did not parse" are
    // indistinguishable from the outcome, so this is never silent.
    out.push({
      kind: "review-contract-empty-outside",
      level: "warning",
      message:
        `${contract.path} declares no "Outside this contract" entries, so every finding is treated as `
        + `inside the contract and any finding naming no declared principle would be capped to `
        + `suggestion. That is the widest coverage and the quietest gate. If that is intended, `
        + `nothing needs changing; if not, list the lens ids or categories the contract does not cover.`,
    });
  }
  if (contract.outsideSections > 1) {
    out.push({
      kind: "review-contract-duplicate-outside",
      level: "warning",
      message:
        `${contract.path} carries ${contract.outsideSections} "Outside this contract" sections. `
        + `Their entries are unioned, which is probably what was meant, but a reader of the file `
        + `cannot see that from one section alone.`,
    });
  }
  // Through the SAME normalizer the exemption uses. `neverBlock: [" Security; "]`
  // exempted the finding while this warning stayed silent, so the override that
  // took effect was the one nobody was told about.
  const silenced = (opts.neverBlock ?? [])
    .map(coverageKey)
    .filter((c) => IMPLICIT_PRINCIPLES.has(c));
  for (const entry of silenced) {
    out.push({
      kind: "review-contract-config-silences-implicit",
      level: "warning",
      message:
        `neverBlock lists "${entry}", which is a principle this contract applies even when it is not `
        + `declared. Explicit config wins, so findings in that category keep the backend's own `
        + `decision and the contract adds nothing. That is a deliberate override; it is named here `
        + `because it is otherwise invisible.`,
    });
  }
  return out;
}

/**
 * The project's blocking policy, read from the RAW config file.
 *
 * WHY RAW, and it is not a shortcut. `blockingPolicy` is not declared in
 * `ConfigSchema.recipeOverrides`, and that object is a plain `z.object`, so an
 * undeclared key is STRIPPED by `parse`. A warning keyed on `state.config`
 * would therefore read `undefined` on every project, configured or not, and be
 * a check that cannot fire -- the same shape as the raw-array gate this
 * workstream exists to fix, arriving from the other side. `synthesize.ts` reads
 * the raw file for exactly this reason and this follows that precedent.
 *
 * Never throws. A missing or malformed config yields the schema defaults, which
 * are the values the lens harness would apply anyway.
 */
export function readBlockingPolicy(projectRoot: string): {
  readonly alwaysBlock: readonly string[];
  readonly neverBlock: readonly string[];
} {
  const fallback = {
    alwaysBlock: ["injection", "auth-bypass", "hardcoded-secrets"] as readonly string[],
    neverBlock: [] as readonly string[],
  };
  try {
    const raw = JSON.parse(readFileSync(join(projectRoot, ".story", "config.json"), "utf-8")) as {
      recipeOverrides?: { blockingPolicy?: { alwaysBlock?: unknown; neverBlock?: unknown } };
    };
    const bp = raw?.recipeOverrides?.blockingPolicy;
    if (!bp || typeof bp !== "object") return fallback;
    const strings = (v: unknown, dflt: readonly string[]): readonly string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : dflt;
    return {
      alwaysBlock: strings(bp.alwaysBlock, fallback.alwaysBlock),
      neverBlock: strings(bp.neverBlock, fallback.neverBlock),
    };
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// The projection, in REPORT-ONLY mode
// ---------------------------------------------------------------------------

export type PolicyBlock = "block" | "baseline";
export type Coverage = "inside" | "outside";

/** The backend's own already-computed decision. Preserved, never re-derived. */
export interface BaselineDecision {
  readonly severity: string;
  readonly blocking: boolean;
}

export interface FindingProjection {
  readonly index: number;
  readonly actualSeverity: string;
  readonly projectedSeverity: string;
  readonly unresolved: boolean;
  readonly policyBlock: PolicyBlock;
  /** The critical-or-major consumer's projected answer for this finding. */
  readonly projectedRoundBlocker: boolean;
  /** The criticals-only consumer's projected answer. A subset, by construction. */
  readonly projectedUnresolvedCritical: boolean;
  readonly coverage: Coverage;
  readonly reason: string;
  readonly undeclaredName?: string;
  /** True when the clause-18 floor is the only thing keeping this baseline. */
  readonly floorSuppressed: boolean;
}

export interface ProjectDecisionInput {
  readonly finding: unknown;
  readonly index: number;
  readonly baseline: BaselineDecision;
  readonly contract: ReviewContract;
  /** `roundBlockerPredicate(gate)` from the stage. Never re-implemented here. */
  readonly isRoundBlocker: (raw: unknown) => boolean;
  readonly alwaysBlock?: readonly string[];
  readonly neverBlock?: readonly string[];
}

/**
 * `correctness` and `security` are principles even when the contract omits
 * them. A reviewer reporting a wrong answer or an exposed credential is not
 * filing a style note, and no owner should have to enumerate that for it to be
 * true. They are applied regardless of COVERAGE, and only coverage: explicit
 * config still wins, and an inactive contract still applies nothing.
 */
const IMPLICIT_PRINCIPLES: ReadonlySet<string> = new Set(["correctness", "security"]);

/**
 * T-495: is this principle one the contract applies without declaring it?
 *
 * Exported so the measurement can tell a promotion by a DECLARED blocking-class
 * principle from a promotion by an implicit one. Deriving that from the
 * projection's `reason` prose instead would make the classification break on a
 * wording change, and the two are different findings about the contract: one
 * says the declaration is doing work, the other says the implicit set is.
 */
export function isImplicitPrinciple(name: string): boolean {
  return IMPLICIT_PRINCIPLES.has(name.toLowerCase());
}

/** Severities that have somewhere to fall. Capping a suggestion is a no-op. */
const CAPPABLE: ReadonlySet<string> = new Set(["major", "critical"]);

/**
 * Clause 18: promotion has a severity floor.
 *
 * The reviewer's severity IS the reviewer's statement that the instance is
 * small, and no owner ruling authorised a minor to block a round. Without this,
 * the OR in the combined gate consults no severity at all and a minor naming a
 * blocking-class principle becomes a round blocker.
 */
/**
 * The generic severity rule, used ONLY where the contract moved the severity
 * and the backend's decision therefore no longer describes this finding.
 * It mirrors the stages' own `critical || major` question.
 */
function severityRuleBlocks(severity: string): boolean {
  const s = normalizeSeverity(severity);
  return s === "critical" || s === "major";
}

function meetsPromotionFloor(severity: string): boolean {
  const s = normalizeSeverity(severity);
  return s === "critical" || s === "major";
}

function fieldOf(raw: unknown, key: string): string {
  if (typeof raw !== "object" || raw === null) return "";
  const v = (raw as Record<string, unknown>)[key];
  return typeof v === "string" ? v.toLowerCase() : "";
}

/** A finding's category, normalized for matching. */
function categoryKey(raw: unknown): string {
  return coverageKey(fieldOf(raw, "category"));
}

function lensIdsOf(raw: unknown): readonly string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const v = (raw as Record<string, unknown>).contributingLenses;
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").map(coverageKey);
}

/**
 * Coverage, by LENS PRECEDENCE.
 *
 * A merged lens finding carries ONE category (the representative's) and its
 * members' categories do not survive dedup, so classifying the lens path by
 * category would classify it by an arbitrary member's word. Lens ids are what a
 * merge preserves, so lens ids decide, and a single covered member keeps the
 * merge inside.
 *
 * RECORDED COST: a category entry on the Outside line is INERT for lens-path
 * findings. ISS-1141 owns the fix; until then this is a cost, not an accident.
 *
 * An unrecognised category is INSIDE. That is the laundering guard, not a
 * safety argument: defaulting to outside would let any finding exempt itself
 * from the contract by inventing a category.
 */
function coverageOf(raw: unknown, outside: ReadonlySet<string>): Coverage {
  const lenses = lensIdsOf(raw);
  if (lenses.length > 0) {
    return lenses.every((id) => outside.has(id)) ? "outside" : "inside";
  }
  return outside.has(categoryKey(raw)) ? "outside" : "inside";
}

/**
 * What a flipped policy WOULD decide for one finding. Decides nothing itself.
 *
 * PRECEDENCE, first applicable step decides (ruling clause 12):
 *   1. the origin guard, always and independent
 *   2. an inactive or invalid contract applies nothing
 *   3. explicit config wins in BOTH directions, including over the implicit set
 *   4. the implicit principles, regardless of coverage and only coverage
 *   5. coverage, by lens precedence
 *   6. the declared-principle rules
 */
export function projectDecision(input: ProjectDecisionInput): FindingProjection {
  const { finding, index, baseline, contract, isRoundBlocker } = input;
  const actualSeverity = normalizeSeverity(baseline.severity);
  const outsideSet = new Set(contract.outside);
  const coverage = coverageOf(finding, outsideSet);
  const unresolved = isRoundBlocker(finding);

  const settle = (
    policyBlock: PolicyBlock,
    reason: string,
    over: { projectedSeverity?: string; undeclaredName?: string; floorSuppressed?: boolean } = {},
  ): FindingProjection => {
    const projectedSeverity = over.projectedSeverity ?? actualSeverity;
    const projectedRoundBlocker = unresolved
      && ((projectedSeverity === actualSeverity
        ? baseline.blocking
        : severityRuleBlocks(projectedSeverity))
        || policyBlock === "block");
    return {
      index,
      actualSeverity,
      projectedSeverity,
      unresolved,
      policyBlock,
      // THE COMBINED GATE (clause 14). The conjunction is what stops the policy
      // from resurrecting a settled finding; the disjunction inside it is what
      // lets the class add blocking a bare severity would not.
      //
      // THE SEVERITY SIDE IS NOT `baseline.blocking` WHENEVER THE CONTRACT MOVED
      // THE SEVERITY, and getting that wrong defeated the whole measurement.
      // Clause 14: capping sets the severity to `suggestion` BEFORE the baseline
      // rule runs, so it stops blocking through the SEVERITY axis, which is
      // clause 7's documented downgrade. Reading the backend's pre-cap decision
      // instead reported "nothing would change" for every capping case -- the
      // one behaviour the report-only week exists to measure. Codex found it.
      //
      // When the contract does NOT move the severity, the backend's own
      // decision is preserved unchanged (clause 13): it was made about the
      // severity that still applies, and this module does not recompute it.
      projectedRoundBlocker,
      // The criticals-only consumer is the SAME decision restricted to
      // criticals, not a second computation from severity. Deriving it from
      // severity alone would discard the backend decision the branch above
      // preserved, which is how the config-preservation defect came back at the
      // aggregate after being fixed per finding. Codex found that too.
      projectedUnresolvedCritical:
        projectedRoundBlocker && normalizeSeverity(projectedSeverity) === "critical",
      coverage,
      reason,
      ...(over.undeclaredName === undefined ? {} : { undeclaredName: over.undeclaredName }),
      floorSuppressed: over.floorSuppressed ?? false,
    };
  };

  /** A promotion, or the floor's refusal of one, recorded either way. */
  const promote = (reason: string): FindingProjection =>
    meetsPromotionFloor(actualSeverity)
      ? settle("block", reason)
      : settle("baseline", `${reason}, but below the promotion floor`, { floorSuppressed: true });

  // 1. The guard belongs to the origin axis, only ever ADDS blocking, and is
  //    safe with or without a policy. Nothing it has blocked may be capped:
  //    otherwise a reintroduced finding naming no principle is capped to
  //    suggestion, laundering a real regression through the principle axis.
  if (findingIsBlockedByOrigin(finding)) {
    return settle("baseline", "blocked by the origin guard; the contract does not touch it");
  }

  // 2. Clause 7, enforced by position rather than by remembering.
  if (contract.status !== "active") {
    return settle("baseline", `contract ${contract.status}; the severity ladder is in force`);
  }

  const category = categoryKey(finding);
  const principle = fieldOf(finding, "principle");

  // 3. Explicit config wins in both directions, INCLUDING over the implicit
  //    set. The backend has already applied these lists, and the two backends
  //    key them differently (lens ids in lenses, category in this evaluator),
  //    so the decision is PRESERVED rather than reconstructed.
  // The two backends key these lists DIFFERENTLY: lenses matches LENS IDS
  // (`blocking-policy.ts`), this evaluator's ancestor matched category. A
  // category-only check therefore misses a lens finding muted by lens id whose
  // category is something else entirely, and clause 13 requires that finding's
  // backend decision to survive untouched. So a config entry matching EITHER
  // key counts as "the backend already decided this one".
  const configured = new Set(
    [...(input.alwaysBlock ?? []), ...(input.neverBlock ?? [])].map(coverageKey),
  );
  const configuredLens = lensIdsOf(finding).find((id) => configured.has(id));
  if (configured.has(category)) {
    return settle("baseline", `category "${category}" is named in explicit config; backend decision preserved`);
  }
  if (configuredLens !== undefined) {
    return settle("baseline", `lens "${configuredLens}" is named in explicit config; backend decision preserved`);
  }

  // 4. Regardless of COVERAGE, and only coverage.
  if (IMPLICIT_PRINCIPLES.has(principle)) {
    return promote(`names the implicit principle "${principle}"`);
  }

  // 5.
  if (coverage === "outside") {
    return settle("baseline", "outside the contract's declared coverage");
  }

  // 6.
  const declared = new Map(
    contract.principles.map((p) => [p.name.toLowerCase(), p] as const),
  );
  if (principle === "") {
    return CAPPABLE.has(actualSeverity)
      ? settle("baseline", "names no principle from the review contract", { projectedSeverity: "suggestion" })
      : settle("baseline", "names no principle from the review contract; already at or below suggestion");
  }
  const match = declared.get(principle);
  if (match === undefined) {
    return CAPPABLE.has(actualSeverity)
      ? settle("baseline", `names principle "${principle}", which the contract does not declare`, {
        projectedSeverity: "suggestion",
        undeclaredName: principle,
      })
      : settle("baseline", `names principle "${principle}", which the contract does not declare`, {
        undeclaredName: principle,
      });
  }
  // Severity is UNTOUCHED here: clause 11 withdrew the class-as-ceiling. The
  // class governs blocking and nothing else.
  return match.blockingClass === "blocking"
    ? promote(`names "${match.name}", declared blocking`)
    : settle("baseline", `names "${match.name}", declared ${match.blockingClass}`);
}

export interface PolicyProjection {
  /** Whether the contract is in force. False means the severity ladder rules. */
  readonly active: boolean;
  /** The input findings, returned BY IDENTITY. This run changes no severity. */
  readonly findings: readonly unknown[];
  readonly projections: readonly FindingProjection[];
  /** Indices blocked by the reintroduced guard. LIVE this run. */
  readonly blockedByOrigin: readonly number[];
  /**
   * CLAUSE 18'S MEASUREMENT, and it is about MINORS specifically: how many
   * minor findings would have been promoted had the floor not been applied.
   * Reported so the floor is revisitable on evidence rather than on argument.
   *
   * Counting every below-floor severity instead was a real overstatement: a
   * suggestion naming a blocking-class principle is also refused by the floor,
   * and folding it in here would inflate the number the ruling asked for with
   * cases nobody proposed promoting. Codex found it.
   */
  readonly floorSuppressedMinorCount: number;
  /** Every promotion the floor refused, at any severity. Context, not the metric. */
  readonly floorSuppressedTotal: number;
}

export function evaluatePrinciplePolicy(input: {
  readonly contract: ReviewContract;
  readonly findings: readonly unknown[];
  /** One per finding, in order: the backend's own effective decision. */
  readonly baselines: readonly BaselineDecision[];
  readonly isRoundBlocker: (raw: unknown) => boolean;
  readonly alwaysBlock?: readonly string[];
  readonly neverBlock?: readonly string[];
}): PolicyProjection {
  const { contract, findings, baselines, isRoundBlocker } = input;
  // A SHORT `baselines` ARRAY IS A CALLER BUG, NOT A NON-BLOCKING FINDING.
  // Defaulting to `{ blocking: false }` invented a backend decision that was
  // never made, in the quiet direction, and hid the integration error that
  // produced it. Clause 13 is about preserving the backend's decision; you
  // cannot preserve one you were not given.
  if (baselines.length !== findings.length) {
    throw new Error(
      `evaluatePrinciplePolicy: ${findings.length} findings but ${baselines.length} baselines. `
      + `Every finding must carry the backend's own decision; there is no default for a missing one.`,
    );
  }
  const blockedByOrigin: number[] = [];
  const projections: FindingProjection[] = [];

  findings.forEach((f, index) => {
    if (findingIsBlockedByOrigin(f)) blockedByOrigin.push(index);
    projections.push(projectDecision({
      finding: f,
      index,
      baseline: baselines[index]!,
      contract,
      isRoundBlocker,
      ...(input.alwaysBlock === undefined ? {} : { alwaysBlock: input.alwaysBlock }),
      ...(input.neverBlock === undefined ? {} : { neverBlock: input.neverBlock }),
    }));
  });

  return {
    active: contract.status === "active",
    findings,
    projections,
    blockedByOrigin,
    floorSuppressedMinorCount: projections.filter(
      (p) => p.floorSuppressed && normalizeSeverity(p.actualSeverity) === "minor",
    ).length,
    floorSuppressedTotal: projections.filter((p) => p.floorSuppressed).length,
  };
}

// ---------------------------------------------------------------------------
// The round gate: ONE function for the projection now and the flip later
// ---------------------------------------------------------------------------

export interface ProjectedGate {
  /** Projected: what the consumer's check would answer AFTER the contract. */
  readonly hasCriticalOrMajor: boolean;
  readonly hasUnresolvedCritical: boolean;
  /** What the stage computes today, carried so the week can report the delta. */
  readonly baselineHasCriticalOrMajor: boolean;
  readonly baselineHasUnresolvedCritical: boolean;
  readonly policyBlockedIndices: readonly number[];
  readonly forcedLandingAllowed: boolean;
}

export function projectRoundGate(input: {
  readonly projections: readonly FindingProjection[];
  readonly baselineHasCriticalOrMajor: boolean;
  readonly baselineHasUnresolvedCritical: boolean;
}): ProjectedGate {
  const policyBlockedIndices = input.projections
    .filter((p) => p.policyBlock === "block" && p.unresolved)
    .map((p) => p.index);
  // BOTH DIRECTIONS, AGGREGATED FROM THE PER-FINDING DECISIONS rather than
  // recomputed from severity here. The class axis only ever ADDS (clause 14), and capping only ever
  // REMOVES (clauses 4 and 7); a gate that ORs the policy onto the stage's
  // current flags can express the first and not the second, so a capped
  // critical would go on reporting an unresolved critical that the contract had
  // just silenced. For an uncapped finding the projection equals the stage's
  // own answer, so nothing moves where the contract says nothing. Recomputing
  // from severity at this level threw away the backend decision each projection
  // had just preserved, so a config-exempt non-blocking major reappeared as a
  // round blocker: the same defect, one level up.
  const hasUnresolvedCritical = input.projections.some((p) => p.projectedUnresolvedCritical);
  const hasCriticalOrMajor = input.projections.some((p) => p.projectedRoundBlocker);
  return {
    hasCriticalOrMajor,
    hasUnresolvedCritical,
    baselineHasCriticalOrMajor: input.baselineHasCriticalOrMajor,
    baselineHasUnresolvedCritical: input.baselineHasUnresolvedCritical,
    policyBlockedIndices,
    // `forcedLanding` is guarded on criticals only, so the guard is what has to
    // widen for a blocking-class major to stop it (clause 19).
    forcedLandingAllowed: !hasUnresolvedCritical && policyBlockedIndices.length === 0,
  };
}
