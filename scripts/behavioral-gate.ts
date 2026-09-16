/**
 * T-498 Commit 4: the 5c behavioural gate (recorded, not vitest).
 *
 * This script builds the machinery R1's own acceptance criterion needs --
 * capturing exactly what a real Step 2/3 invocation hands an agent, for
 * both the "oracle" (full ten raw bodies) and "brief" (what a real primed
 * invocation gets) arms -- and the deterministic RED proof that each
 * fixture is genuinely adversarial. It does NOT invoke any live model
 * session: `dispatchSession` is an injected function so the scoring
 * mechanics are unit-testable against synthetic transcripts, and the real
 * scored run (5 sessions x 4 fixtures x 2 arms = 40, fallback 8) is
 * launched only after explicit owner authorization, per the pen's ruling
 * recorded on T-498.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerAllTools } from "../src/mcp/tools.js";
import {
  createCapturingLinkedPair,
  buildNormalizer,
  stepRecommend,
  stepHandoverPrimingAndBrief,
  stepLineOne,
  stepReconciliationRecovery,
  type ReplayContext,
  type RecommendRow,
  type ExcludedRow,
  type HandoverBriefEntryLike,
} from "./priming-cost.js";
import type { TrajectoryEntry } from "../src/core/markdown-sections.js";

export type Arm = "oracle" | "brief";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolvePath(SCRIPT_DIR, "../test/skill/fixtures/behavioral-gate");

/**
 * What the two-call shape must surface for the fixture to be considered
 * solved, and what runRedProof validates against -- not just "a candidate
 * resolved" or "a handover was recovered", but the SPECIFIC one the
 * fixture expects (Codex round 1 finding: an unvalidated resolution would
 * report success even after a regression that resolves the wrong answer).
 */
export type FixtureEvidence =
  | {
      /** Fixtures 1/4: the newest handover's own line-one candidate resolves the answer directly, no reconciliation needed. */
      readonly kind: "line-one";
      /** Expected `resolvedCandidate.id`; `null` means the expected resolution is an id-less decision. */
      readonly expectedId: string | null;
      /** Required substring of `resolvedCandidate.label`, case-insensitive -- the only way to validate an id-less resolution beyond "some decision resolved". */
      readonly expectedLabelIncludes: string;
    }
  | {
      /** Fixtures 2/3: the newest handover has no usable candidate; the answer turns on an older handover's record, recovered via reconciliation. */
      readonly kind: "reconciliation";
      readonly decisiveHandoverFilename: string;
    };

export interface FixtureSpec {
  /** Short, stable shape name -- matches the plan's four named shapes. */
  readonly name: "deferred-item" | "idless-decision" | "abandoned-no-reversal" | "abandoned-intermediate-reversal";
  /** Absolute path to the fixture's project root (parent of `.story/`). */
  readonly root: string;
  /** Human-readable description of the behaviourally-correct next action, for the scorer and the recorded report -- not shown to the session. */
  readonly correctAnswer: string;
  readonly evidence: FixtureEvidence;
}

/**
 * The four fixtures named in plan-t498.md rev 7 / the pen's ruling on
 * Codex round-1 finding 7. Each root is a real `.story/` project;
 * `correctAnswer` and `evidence` are ground-truthed by hand against that
 * project's own tickets and handovers (see the runner's own tests), not
 * derived mechanically.
 */
export const FIXTURES: readonly FixtureSpec[] = [
  {
    name: "deferred-item",
    root: resolvePath(FIXTURE_ROOT, "deferred-item"),
    correctAnswer: "T-3002",
    evidence: { kind: "line-one", expectedId: "T-3002", expectedLabelIncludes: "CSV export" },
  },
  {
    name: "idless-decision",
    root: resolvePath(FIXTURE_ROOT, "idless-decision"),
    correctAnswer: "backfill script",
    evidence: { kind: "line-one", expectedId: null, expectedLabelIncludes: "backfill" },
  },
  {
    name: "abandoned-no-reversal",
    root: resolvePath(FIXTURE_ROOT, "abandoned-no-reversal"),
    correctAnswer: "T-5002",
    evidence: { kind: "reconciliation", decisiveHandoverFilename: "2026-08-05-day5.md" },
  },
  {
    name: "abandoned-intermediate-reversal",
    root: resolvePath(FIXTURE_ROOT, "abandoned-intermediate-reversal"),
    // The naive top-ranked ticket happens to coincide with the correct
    // answer here (T-5001); citing the day8 reversal is still required so
    // the transcript proves the reasoning, not a lucky ranking match.
    correctAnswer: "T-5001",
    evidence: { kind: "reconciliation", decisiveHandoverFilename: "2026-08-08-day8.md" },
  },
];

export interface InvocationBundle {
  readonly fixture: string;
  readonly arm: Arm;
  /** Verbatim Step 2/3 instructions from the live SKILL.md -- both arms get the SAME instructions (Codex round 1/2 finding: isolate narrative-body availability as the only variable). */
  readonly skillText: string;
  readonly recommendRows: readonly RecommendRow[];
  readonly excludedRows: readonly ExcludedRow[];
  /** recommend()'s own provisional-recommendation signal (Codex round 1 finding: the skill uses this to decide whether its recommendation is provisional; dropping it made the rendered prompt an unfaithful reconstruction of the real payload). */
  readonly unreadableHandoverCount: number | null;
  readonly primingBody: string | null;
  readonly briefHandovers: readonly HandoverBriefEntryLike[];
  /** The count:10 brief:true response's own trajectory[] (Codex round 1 finding: the live skill requires reading and rendering this; omitting it from the bundle meant both scored arms would receive incomplete context). */
  readonly trajectory: readonly TrajectoryEntry[];
  /** Oracle arm only: every one of the ten handovers' full raw body, filename-keyed. */
  readonly fullBodies?: Readonly<Record<string, string>>;
}

async function makeReplayContext(root: string): Promise<{ ctx: ReplayContext; close: () => Promise<void> }> {
  const server = new McpServer({ name: "storybloq", version: "0.0.0" });
  registerAllTools(server, root);
  const client = new Client({ name: "behavioral-gate", version: "0.0.0" });
  const { clientTransport, serverTransport, log } = createCapturingLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const ctx: ReplayContext = { root, client, log, normalize: buildNormalizer(root), gitLogMode: "fixture" };
  return { ctx, close: async () => client.close() };
}

/** Fetches one handover's full raw body via `storybloq_handover_get`, for the oracle arm only. */
async function fetchRawBody(ctx: ReplayContext, filename: string): Promise<string> {
  const result = await ctx.client.callTool({
    name: "storybloq_handover_get",
    arguments: { filename, format: "json" },
  });
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = content?.[0]?.text;
  if (typeof text !== "string") throw new Error(`fetchRawBody: no text content for ${filename}`);
  const parsed = JSON.parse(text) as { data?: { content?: string } };
  if (typeof parsed.data?.content !== "string") {
    throw new Error(`fetchRawBody: malformed handover_get response for ${filename}`);
  }
  return parsed.data.content;
}

/**
 * Captures the exact material a real Step 2/3 invocation hands an agent for
 * one fixture/arm: the real `storybloq_recommend` and two-call
 * `storybloq_handover_latest` results against that fixture's actual
 * `.story/`, plus (oracle arm only) every one of the ten handovers' full
 * raw body. This is real MCP traffic against a real fixture project -- no
 * live model session is invoked here.
 */
export async function captureInvocationBundle(
  fixture: FixtureSpec,
  arm: Arm,
  skillPath: string,
): Promise<InvocationBundle> {
  const { ctx, close } = await makeReplayContext(fixture.root);
  try {
    const recommend = await stepRecommend(ctx);
    const unreadableHandoverCount =
      (recommend.report as { unreadableHandoverCount?: number | null }).unreadableHandoverCount ?? null;
    const handover = await stepHandoverPrimingAndBrief(ctx);
    const skillText = await readFile(skillPath, "utf-8");

    let fullBodies: Record<string, string> | undefined;
    if (arm === "oracle") {
      fullBodies = {};
      for (const h of handover.briefHandovers) {
        fullBodies[h.filename] = h.body ?? (await fetchRawBody(ctx, h.filename));
      }
    }

    return {
      fixture: fixture.name,
      arm,
      skillText,
      recommendRows: recommend.rows,
      excludedRows: recommend.excluded,
      unreadableHandoverCount,
      primingBody: handover.primingBody,
      briefHandovers: handover.briefHandovers,
      trajectory: handover.trajectory,
      ...(fullBodies ? { fullBodies } : {}),
    };
  } finally {
    await close();
  }
}

/**
 * Renders a captured bundle into the literal prompt text a clean session
 * would receive: the live skill instructions, then the tool results in the
 * same shape a real invocation produces (recommend's JSON, the two
 * handover_latest calls' JSON), then -- oracle arm only -- every older
 * handover's full raw body as extra material alongside that scaffolding
 * (never as a replacement instruction set; Codex round 2 finding 4).
 */
export function renderPromptForBundle(bundle: InvocationBundle): string {
  const parts: string[] = [
    "# Skill instructions (verbatim, live SKILL.md)",
    bundle.skillText,
    "",
    "# storybloq_recommend result (count: 10)",
    JSON.stringify(
      {
        recommendations: bundle.recommendRows,
        excluded: bundle.excludedRows,
        unreadableHandoverCount: bundle.unreadableHandoverCount,
      },
      null,
      2,
    ),
    "",
    "# storybloq_handover_latest result (count: 1, priming: true)",
    JSON.stringify({ primingBody: bundle.primingBody }, null, 2),
    "",
    "# storybloq_handover_latest result (count: 10, brief: true)",
    JSON.stringify({ handovers: bundle.briefHandovers, trajectory: bundle.trajectory }, null, 2),
  ];
  if (bundle.fullBodies) {
    parts.push(
      "",
      "# Extra material (oracle arm only): every handover's full raw body",
      JSON.stringify(bundle.fullBodies, null, 2),
    );
  }
  parts.push(
    "",
    "# Task",
    "You have just loaded this project's context via /story. State your next action and justify it, citing any older handover you relied on.",
  );
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Session dispatch and scoring -- NOT wired to any live model call in this
// commit. `dispatchSession` is injected so the runner and scorer are fully
// unit-testable against synthetic transcripts; the real scored run requires
// explicit owner authorization (pen ruling on T-498) and is launched
// separately, outside this script's own test suite.
// ---------------------------------------------------------------------------

export interface SessionTranscript {
  readonly fixture: string;
  readonly arm: Arm;
  readonly model: string;
  readonly transcript: string;
}

export type SessionDispatcher = (prompt: string, model: string) => Promise<string>;

/** The real dispatcher this repo would wire in once authorized -- deliberately unimplemented here. */
export const UNAUTHORIZED_DISPATCHER: SessionDispatcher = async () => {
  throw new Error(
    "behavioral-gate: no session dispatcher is wired in this commit -- the 5c scored run requires explicit owner authorization (see T-498's pen ruling) before any live session is launched",
  );
};

export async function runOneSession(
  fixture: FixtureSpec,
  arm: Arm,
  skillPath: string,
  model: string,
  dispatch: SessionDispatcher,
): Promise<SessionTranscript> {
  const bundle = await captureInvocationBundle(fixture, arm, skillPath);
  const prompt = renderPromptForBundle(bundle);
  const transcript = await dispatch(prompt, model);
  return { fixture: fixture.name, arm, model, transcript };
}

export interface ScoreResult {
  readonly pass: boolean;
  readonly namedCorrectAlternative: boolean;
  readonly citedDecisiveHandover: boolean;
  readonly reason: string;
}

/**
 * Derives the accepted citation forms for a reconciliation fixture's
 * decisive handover from its filename alone -- no per-fixture hand lists.
 * Widened 2026-09-13 after the real 5c run: the rubric is "names the
 * correct alternative AND attributes it to the specific older handover",
 * and a citation by exact date or day label is that attribution just as
 * much as the literal filename is -- a literal filename-with-extension
 * match was stricter than the rubric ever intended. Accepts: the filename
 * with or without ".md", the ISO date parsed from the filename, and the
 * slug label after the date (e.g. "day5"), with or without a space before
 * the trailing digits. Deliberately narrow: only the SPECIFIC parsed date
 * and slug count, not "any date-shaped string" -- a quote of the
 * handover's prose with no date/slug/filename attribution, or a
 * different handover's date, must still fail (see the scoreTranscript
 * tests for both).
 */
function decisiveHandoverCitationForms(decisiveHandoverFilename: string): readonly string[] {
  const filenameWithExt = decisiveHandoverFilename.toLowerCase();
  const filenameNoExt = filenameWithExt.replace(/\.md$/, "");
  const match = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(filenameNoExt);
  if (!match) return [filenameWithExt, filenameNoExt];
  const [, date, slug] = match as unknown as [string, string, string];
  const slugSpaced = slug.replace(/^([a-z]+)(\d+)$/i, "$1 $2");
  return Array.from(new Set([filenameWithExt, filenameNoExt, date, slug, slugSpaced]));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `text.includes(form)` alone is not enough for the short forms: "day5"
 * would also match inside "day50" or "weekday5", and the spaced "day 5"
 * would match inside "day 50" -- accepting a citation of the WRONG day.
 * Word-boundary anchors on both ends of each form reject an adjacent
 * letter or digit while still allowing adjacent punctuation/whitespace
 * (parens, periods, commas), so "(day5)" and "day5." still match but
 * "day50" and "weekday5" do not.
 */
function citesDecisiveHandover(text: string, decisiveHandoverFilename: string): boolean {
  return decisiveHandoverCitationForms(decisiveHandoverFilename).some((form) =>
    new RegExp(`\\b${escapeRegExp(form)}\\b`).test(text),
  );
}

/**
 * Blind, mechanical scorer: does the transcript name the fixture's correct
 * answer and cite the specific older handover its rationale depends on?
 * This checks textual presence only -- it does not itself judge whether
 * the CITED rationale is sound; that judgement is the human/blind-scorer
 * step 5c's own process still performs on the real run. Mirrors the
 * scoring rubric named in the ticket: "chooses the correct alternative and
 * cites the specific older handover + rationale."
 */
export function scoreTranscript(transcript: string, fixture: FixtureSpec): ScoreResult {
  const text = transcript.toLowerCase();
  const namedCorrectAlternative = text.includes(fixture.correctAnswer.toLowerCase());
  const citedDecisiveHandover =
    fixture.evidence.kind === "reconciliation"
      ? citesDecisiveHandover(text, fixture.evidence.decisiveHandoverFilename)
      : true; // fixtures 1/4 resolve via line one directly; no older-handover citation required
  const pass = namedCorrectAlternative && citedDecisiveHandover;
  const reason = pass
    ? "named the correct alternative and cited the required evidence"
    : !namedCorrectAlternative
      ? `did not name the expected answer ("${fixture.correctAnswer}")`
      : `named the correct alternative but did not cite ${fixture.evidence.kind === "reconciliation" ? fixture.evidence.decisiveHandoverFilename : "(unexpected)"}`;
  return { pass, namedCorrectAlternative, citedDecisiveHandover, reason };
}

// ---------------------------------------------------------------------------
// RED proof (deterministic, no live model call): per fixture, confirms (a)
// the naive ranking is genuinely adversarial, (b) the pre-T-498 count:3
// single-call shape cannot fully reach the decisive evidence, and (c) the
// live (post-T-498) two-call shape's own deterministic resolution
// (stepLineOne / stepReconciliationRecovery) DOES surface it. This is the
// mechanical half of "recorded, not vitest" -- it proves the evidence
// reaches the agent; whether the agent then reasons about it correctly is
// what the real scored run measures.
// ---------------------------------------------------------------------------

export interface RedProofResult {
  readonly fixture: string;
  /** recommend()'s naive top-ranked id -- the answer an agent gets WITHOUT reading any older handover. Whether this counts as "adversarial" is a per-fixture, human-verified design fact (see the runner's own tests): fixtures 1/2/4 need it to differ from the correct answer; fixture 3's naive id happens to coincide with the correct one, but citing the reversal is still required by the scoring rubric. */
  readonly rankingTopId: string | null;
  readonly oldShapeFilenames: readonly string[];
  readonly oldShapeReachesDecisiveHandover: boolean | null;
  readonly newShapeSurfacesEvidence: boolean;
  readonly newShapeDetail: string;
}

export async function runRedProof(fixture: FixtureSpec, skillPath: string): Promise<RedProofResult> {
  const { ctx, close } = await makeReplayContext(fixture.root);
  try {
    const { rows: recommendRows } = await stepRecommend(ctx);
    const rankingTopId = recommendRows[0]?.id ?? null;

    const handover = await stepHandoverPrimingAndBrief(ctx);

    // What the pre-T-498 single `count: 3` call (no brief, no priming)
    // would have reached -- newest-first, same ordering `count: 10 brief:
    // true` already returned, so no separate tool call is needed.
    const oldFilenames = handover.briefHandovers.slice(0, 3).map((h) => h.filename);
    const oldShapeReachesDecisiveHandover =
      fixture.evidence.kind === "reconciliation" ? oldFilenames.includes(fixture.evidence.decisiveHandoverFilename) : null;

    const { resolvedCandidate } = await stepLineOne(ctx, handover.primingBody, handover.briefHandovers, recommendRows, []);
    const reconciliation = await stepReconciliationRecovery(ctx, handover.briefHandovers.slice(1));

    let newShapeSurfacesEvidence: boolean;
    let newShapeDetail: string;
    if (fixture.evidence.kind === "line-one") {
      // Fixtures 1/4: the deterministic candidate walk must resolve the
      // SPECIFIC expected candidate -- id (or null, for an id-less
      // decision) AND a label substring -- not merely "some" candidate,
      // which would still report success after a regression that
      // resolves the wrong answer (Codex round 1 finding).
      const { expectedId, expectedLabelIncludes } = fixture.evidence;
      const idMatches = resolvedCandidate !== null && resolvedCandidate.id === expectedId;
      const labelMatches =
        resolvedCandidate !== null &&
        resolvedCandidate.label.toLowerCase().includes(expectedLabelIncludes.toLowerCase());
      newShapeSurfacesEvidence = idMatches && labelMatches;
      newShapeDetail =
        resolvedCandidate === null
          ? "line one resolved nothing"
          : `line one resolved ${resolvedCandidate.id ?? "(id-less decision)"}: ${resolvedCandidate.label}` +
            (newShapeSurfacesEvidence ? "" : ` (expected id ${expectedId ?? "(id-less)"} / label containing "${expectedLabelIncludes}")`);
    } else {
      // Fixtures 2/3: reconciliation must have the decisive handover's
      // record available (recovered or already-loaded) for the agent to
      // reason over -- the chronological "who wins" judgement itself is
      // not computed here (see plan-t498.md rev 7 / pen ruling on finding 7).
      const { decisiveHandoverFilename } = fixture.evidence;
      const perHandover = reconciliation.perHandover.find((p) => p.filename === decisiveHandoverFilename);
      const recordsAvailable = (perHandover?.records ?? []).length > 0;
      newShapeSurfacesEvidence = recordsAvailable;
      newShapeDetail = recordsAvailable
        ? `reconciliation has ${decisiveHandoverFilename}'s records available (tier: ${perHandover?.tier})`
        : `reconciliation could not surface ${decisiveHandoverFilename}'s records`;
    }

    return {
      fixture: fixture.name,
      rankingTopId,
      oldShapeReachesDecisiveHandover,
      oldShapeFilenames: oldFilenames,
      newShapeSurfacesEvidence,
      newShapeDetail,
    };
  } finally {
    await close();
  }
}
