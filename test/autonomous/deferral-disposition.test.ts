/**
 * ISS-1113, the queue half: which producer's classification an issue ends up
 * carrying when more than one of them describes the same finding.
 *
 * Three producers write into ONE `pendingDeferrals` queue and `drainDeferrals`
 * is the single site that turns an entry into an issue:
 *
 *   - `fileDeferredFindings` with the plain set  -> `accepted_out_of_scope`
 *   - `fileDeferredFindings` with the forced set -> `forced_landing`
 *   - `queueFindingsAsIssues` (the round ceiling) -> explicitly ACTIONABLE
 *
 * They collide because the fingerprint is
 * `hash([ticketId, reviewKind, severity, category, description])` and the
 * disposition is deliberately not in it -- so the same finding text deferred in
 * one round and blocking in a later one is ONE entry, and both queueing
 * functions skip a fingerprint that is already present. Whoever ran first used
 * to decide. That is settled here by rank, not by order, and every collision
 * case is asserted in BOTH orders for exactly that reason.
 *
 * The rank is over EXPLICITNESS, not actionability:
 *
 *   "forced_landing" > null (explicitly actionable) > "accepted_out_of_scope" > absent
 *
 * `null` and absent are different on purpose. `null` is the ceiling saying "this
 * is a blocker I am parking on"; absent is an entry written by a build that had
 * no opinion to record, which is every entry persisted before this change. An
 * absent value therefore never overwrites an explicit one, and it is never
 * coerced into a non-actionable value on the way out -- a pre-upgrade deferral
 * files exactly as it files today.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StageContext } from "../../src/autonomous/stages/types.js";
import { forcedLandingFilingSet } from "../../src/autonomous/stages/code-review.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import type { ResolvedRecipe } from "../../src/autonomous/recipes/loader.js";

const TICKET = "t-d1sp0s1t10n00001";

function setupProject(root: string): void {
  const storyDir = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(storyDir, sub), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-09-18",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  writeFileSync(join(storyDir, "tickets", `${TICKET}.json`), JSON.stringify({
    id: TICKET, displayId: "T-902", title: "Disposition", description: "A test.",
    type: "task", status: "inprogress", phase: "p1", order: 10,
    createdDate: "2026-09-18", completedDate: null, blockedBy: [],
  }));
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"] },
  } as unknown as ResolvedRecipe;
}

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-0000000000d1",
    recipe: "coding", state: "CODE_REVIEW", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"] },
    ticket: { id: TICKET, displayId: "T-902", title: "Disposition", claimed: true, risk: "low" },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], currentIssue: null,
    codeReviewRoundCounter: null, pendingCeilingEscalation: null,
    ...overrides,
  } as FullSessionState;
}

/** The one finding every collision case is about: identical tuple, rival classifications. */
const FINDING = {
  severity: "major",
  category: "correctness",
  description: "The retry bound is off by one",
} as const;

const OTHER = {
  severity: "minor",
  category: "style",
  description: "This name reads badly",
} as const;

describe("ISS-1113: the disposition a filed deferral ends up carrying", () => {
  let root: string;
  let sDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "iss1113-queue-"));
    setupProject(root);
    sDir = join(root, ".story", "sessions", "s1");
    mkdirSync(sDir, { recursive: true });
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

  function ctxWith(state: FullSessionState = makeState()): StageContext {
    return new StageContext(root, sDir, state, makeRecipe());
  }

  function issuesOnDisk(): Record<string, unknown>[] {
    return readdirSync(join(root, ".story", "issues"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(root, ".story", "issues", f), "utf-8")) as Record<string, unknown>);
  }

  function issueMatching(description: string): Record<string, unknown> {
    const hits = issuesOnDisk().filter((i) => String(i.impact) === description);
    expect(hits).toHaveLength(1);
    return hits[0]!;
  }

  /** The plain reviewer-deferred shape: `disposition: "deferred"` on the FINDING. */
  function deferred(f: typeof FINDING) {
    return { ...f, disposition: "deferred" };
  }

  /**
   * Stands in for the round's own `roundBlockerPredicate(provenanceGate)`. The
   * correctness finding is the blocker; the style one is not, which is what
   * makes "tags only the blocking findings" a claim that can fail.
   */
  const isBlocking = (f: { category: string }) => f.category === "correctness";

  // -------------------------------------------------------------------------
  // One producer at a time
  // -------------------------------------------------------------------------

  it("a reviewer-deferred finding files as accepted_out_of_scope, with its provenance", async () => {
    const ctx = ctxWith();
    await ctx.fileDeferredFindings([deferred(FINDING)], "code");
    const issue = issueMatching(FINDING.description);
    expect(issue.disposition).toBe("accepted_out_of_scope");
    expect(issue.metadata).toMatchObject({
      review: {
        origin: "reviewer-deferred",
        findingDisposition: "accepted_out_of_scope",
        sessionId: "00000000-0000-0000-0000-0000000000d1",
      },
    });
  });

  it("a forced-landing finding files as forced_landing", async () => {
    const ctx = ctxWith();
    await ctx.fileDeferredFindings(forcedLandingFilingSet([deferred(FINDING)], true, isBlocking), "code");
    const issue = issueMatching(FINDING.description);
    expect(issue.disposition).toBe("forced_landing");
    expect(issue.metadata).toMatchObject({ review: { origin: "forced-landing" } });
  });

  /**
   * The ceiling files a BLOCKER. `queueFindingsAsIssues` exists precisely
   * because reaching the deferral filter would mean rewriting a critical's
   * disposition to get past it, and a critical rewritten into a deferral is a
   * blocker laundered into a note. So its issue carries no disposition at all
   * and stays ordinary work.
   */
  it("a ceiling-queued blocker files with NO disposition", async () => {
    const ctx = ctxWith();
    await ctx.queueFindingsAsIssues([FINDING], "code");
    await ctx.drainDeferrals();
    const issue = issueMatching(FINDING.description);
    expect(Object.keys(issue)).not.toContain("disposition");
  });

  // -------------------------------------------------------------------------
  // Collisions -- each asserted in BOTH orders
  // -------------------------------------------------------------------------

  it.each([
    ["deferral first", "deferral"],
    ["forced first", "forced"],
  ] as const)("forced_landing beats accepted_out_of_scope (%s)", async (_label, first) => {
    const ctx = ctxWith();
    const plain = [deferred(FINDING)];
    const forced = forcedLandingFilingSet([deferred(FINDING)], true, isBlocking);
    if (first === "deferral") {
      await ctx.fileDeferredFindings(plain, "code");
      await ctx.fileDeferredFindings(forced, "code");
    } else {
      await ctx.fileDeferredFindings(forced, "code");
      await ctx.fileDeferredFindings(plain, "code");
    }
    expect(issueMatching(FINDING.description).disposition).toBe("forced_landing");
  });

  it.each([
    ["deferral first", "deferral"],
    ["ceiling first", "ceiling"],
  ] as const)("a ceiling blocker is not laundered into a deferral (%s)", async (_label, first) => {
    const ctx = ctxWith();
    if (first === "deferral") {
      await ctx.fileDeferredFindings([deferred(FINDING)], "code");
      await ctx.queueFindingsAsIssues([FINDING], "code");
    } else {
      await ctx.queueFindingsAsIssues([FINDING], "code");
      await ctx.fileDeferredFindings([deferred(FINDING)], "code");
    }
    await ctx.drainDeferrals();
    expect(Object.keys(issueMatching(FINDING.description))).not.toContain("disposition");
  });

  it.each([
    ["ceiling first", "ceiling"],
    ["forced first", "forced"],
  ] as const)("a forced landing overrides an earlier ceiling claim (%s)", async (_label, first) => {
    const ctx = ctxWith();
    const forced = forcedLandingFilingSet([deferred(FINDING)], true, isBlocking);
    if (first === "ceiling") {
      await ctx.queueFindingsAsIssues([FINDING], "code");
      await ctx.fileDeferredFindings(forced, "code");
    } else {
      await ctx.fileDeferredFindings(forced, "code");
      await ctx.queueFindingsAsIssues([FINDING], "code");
    }
    await ctx.drainDeferrals();
    expect(issueMatching(FINDING.description).disposition).toBe("forced_landing");
  });

  // -------------------------------------------------------------------------
  // Absence
  // -------------------------------------------------------------------------

  /**
   * The pre-upgrade entry shape: a queue persisted by a build that had no
   * disposition field at all. It must drain exactly as it drains today -- an
   * ordinary, ACTIONABLE issue -- and it must not overwrite a classification a
   * newer producer already recorded.
   */
  it("an entry persisted with no disposition field drains as ordinary work", async () => {
    const ctx = ctxWith(makeState({
      pendingDeferrals: [{
        fingerprint: "deadbeefdeadbeefdeadbeefdeadbeef",
        severity: "major",
        category: "correctness",
        description: FINDING.description,
        reviewKind: "code",
      }],
    } as Partial<FullSessionState>));
    await ctx.drainDeferrals();
    const issue = issueMatching(FINDING.description);
    expect(Object.keys(issue)).not.toContain("disposition");
    expect(Object.keys(issue)).not.toContain("metadata");
  });

  /**
   * The merge is only reachable while BOTH producers are still in the queue,
   * so this stages that state directly: an entry a newer producer classified,
   * plus the same fingerprint arriving from one that recorded no opinion --
   * which is what a queue persisted before this change looks like after a
   * resume. `fileDeferredFindings` drains before it returns, so a second call
   * would settle at the filed-issue seam instead, which the tests above cover.
   */
  it("a producer that says nothing does not overwrite a producer that did", async () => {
    const ctx = ctxWith();
    await ctx.fileDeferredFindings([deferred(FINDING)], "code");
    const fingerprint = ctx.state.filedDeferrals![0]!.fingerprint;

    const fresh = ctxWith(makeState({
      pendingDeferrals: [{
        fingerprint,
        severity: FINDING.severity,
        category: FINDING.category,
        description: FINDING.description,
        reviewKind: "code",
        disposition: "accepted_out_of_scope",
        origin: "reviewer-deferred",
      }],
    } as Partial<FullSessionState>));
    // The same finding again, from a path that records nothing: it must not
    // strip the classification already on the entry.
    await fresh.fileDeferredFindings(
      [{ ...FINDING, disposition: "deferred", filingDisposition: undefined }],
      "code",
    );
    expect(issueMatching(FINDING.description).disposition).toBe("accepted_out_of_scope");
  });

  /**
   * The other direction, and the one that makes rank 0 mean something: an
   * entry carrying NO disposition is what a queue persisted before this change
   * looks like, and a producer that does have an opinion must be able to
   * classify it. Rank absence any higher and a pre-upgrade entry becomes
   * permanently unclassifiable, which no test would otherwise notice because
   * no live producer ever passes an absent value.
   */
  it("a pre-upgrade entry is upgraded by a producer that does classify it", async () => {
    const ctx = ctxWith();
    // `queueFindingsAsIssues` queues without draining, which is the only way
    // to get a real fingerprint into `pendingDeferrals` and still be able to
    // rewrite the entry before anything reads it.
    const [fingerprint] = await ctx.queueFindingsAsIssues([FINDING], "code");
    expect(fingerprint).toBeDefined();
    // Strip the field: this is exactly what the entry looks like when it was
    // persisted by a build that had no disposition to record.
    ctx.writeState({
      pendingDeferrals: [{
        fingerprint: fingerprint!,
        severity: FINDING.severity,
        category: FINDING.category,
        description: FINDING.description,
        reviewKind: "code",
      }],
    } as Partial<FullSessionState>);

    await ctx.fileDeferredFindings([deferred(FINDING)], "code");
    expect(issueMatching(FINDING.description).disposition).toBe("accepted_out_of_scope");
  });

  /**
   * The same upgrade at the FILED seam: an issue this session already wrote
   * with no disposition (a pre-upgrade drain, or the ceiling's explicit
   * actionable claim) is classifiable by a later producer.
   */
  it("an already-filed issue with no disposition is classified by a later producer", async () => {
    const ctx = ctxWith();
    await ctx.queueFindingsAsIssues([FINDING], "code");
    await ctx.drainDeferrals();
    expect(Object.keys(issueMatching(FINDING.description))).not.toContain("disposition");

    await ctx.fileDeferredFindings(
      forcedLandingFilingSet([deferred(FINDING)], true, isBlocking),
      "code",
    );
    expect(issueMatching(FINDING.description).disposition).toBe("forced_landing");
  });

  // -------------------------------------------------------------------------
  // The filed-issue correction does not trample the passthrough metadata bag
  // -------------------------------------------------------------------------

  /**
   * `metadata` is `.passthrough()` and shared with every other writer, so the
   * correction may only touch the `review` key it owns. A version that
   * replaced the whole object passed every other test in this file while
   * silently deleting whatever an integration had put there.
   */
  it("keeps foreign metadata when it corrects a filed issue's disposition", async () => {
    const ctx = ctxWith();
    await ctx.fileDeferredFindings([deferred(FINDING)], "code");
    const filed = issueMatching(FINDING.description);

    // A key this code does not own, written by somebody else after the file.
    const path = join(root, ".story", "issues", `${String(filed.id)}.json`);
    writeFileSync(path, JSON.stringify({
      ...filed,
      metadata: { ...(filed.metadata as Record<string, unknown>), macApp: { pinned: true } },
    }));

    await ctx.fileDeferredFindings(
      forcedLandingFilingSet([deferred(FINDING)], true, isBlocking),
      "code",
    );
    const after = issueMatching(FINDING.description);
    expect(after.disposition).toBe("forced_landing");
    expect(after.metadata).toMatchObject({
      macApp: { pinned: true },
      review: { origin: "forced-landing", findingDisposition: "forced_landing" },
    });
  });

  it("keeps foreign metadata when it clears a disposition back to actionable", async () => {
    const ctx = ctxWith();
    await ctx.fileDeferredFindings([deferred(FINDING)], "code");
    const filed = issueMatching(FINDING.description);
    const path = join(root, ".story", "issues", `${String(filed.id)}.json`);
    writeFileSync(path, JSON.stringify({
      ...filed,
      metadata: { ...(filed.metadata as Record<string, unknown>), macApp: { pinned: true } },
    }));

    await ctx.queueFindingsAsIssues([FINDING], "code");
    const after = issueMatching(FINDING.description);
    expect(Object.keys(after)).not.toContain("disposition");
    // The provenance OF the disposition goes, because it describes a
    // classification the issue no longer carries. Nothing else does.
    expect(after.metadata).toEqual({ macApp: { pinned: true } });
  });

  it("drops the metadata key entirely when nothing but its own block was in it", async () => {
    const ctx = ctxWith();
    await ctx.fileDeferredFindings([deferred(FINDING)], "code");
    expect(issueMatching(FINDING.description).metadata).toBeDefined();

    await ctx.queueFindingsAsIssues([FINDING], "code");
    const after = issueMatching(FINDING.description);
    expect(Object.keys(after)).not.toContain("disposition");
    expect(Object.keys(after)).not.toContain("metadata");
  });

  /**
   * The correction is best-effort by contract, and the diagnostic that records
   * a failed correction is itself a write -- so it can fail for the same
   * reasons the correction just did. A round must not die reporting that a
   * non-fatal thing went wrong.
   */
  it("survives a failed correction whose diagnostic also fails", async () => {
    const ctx = ctxWith();
    await ctx.fileDeferredFindings([deferred(FINDING)], "code");

    const recorder = vi.spyOn(ctx, "appendEvent").mockImplementation(() => {
      throw new Error("events log unwritable");
    });
    // Make the ledger write fail, which is what sends control into the catch.
    const issuesDir = join(root, ".story", "issues");
    chmodSync(issuesDir, 0o555);
    try {
      await expect(ctx.fileDeferredFindings(
        forcedLandingFilingSet([deferred(FINDING)], true, isBlocking),
        "code",
      )).resolves.toBeUndefined();
      expect(recorder).toHaveBeenCalledWith(
        "deferral_disposition_reconcile_failed",
        expect.objectContaining({ incoming: "forced_landing" }),
      );
    } finally {
      chmodSync(issuesDir, 0o755);
      recorder.mockRestore();
    }
    // The issue is still there, still saying what it said before.
    expect(issueMatching(FINDING.description).disposition).toBe("accepted_out_of_scope");
  });

  // -------------------------------------------------------------------------
  // The seam between the stage and the queue
  // -------------------------------------------------------------------------

  /**
   * `forcedLandingFilingSet` is the three lines of `CodeReviewStage.report`
   * that decide which findings the forced landing is landing PAST. Tested
   * directly because the rest of this file starts one call later, at
   * `fileDeferredFindings`, and a mutant that stopped tagging the forced set
   * would otherwise only show up as a missing disposition with no test naming
   * the line that produced it.
   */
  describe("forcedLandingFilingSet", () => {
    /**
     * The case the pre-existing landing suite caught and this file did not:
     * a forced landing files findings the reviewer left OPEN, and the only
     * thing that gets them past `fileDeferredFindings`'s
     * `disposition === "deferred"` filter is the rewrite. Drop it and a forced
     * landing files nothing at all.
     */
    it("rewrites an open finding to deferred so it reaches the queue at all", async () => {
      const open = { ...FINDING, disposition: "open" };
      const ctx = ctxWith();
      await ctx.fileDeferredFindings(forcedLandingFilingSet([open], true, isBlocking), "code");
      expect(issueMatching(FINDING.description).disposition).toBe("forced_landing");
    });

    it("leaves a non-blocking open finding alone, so it is still not filed", async () => {
      const openStyle = { ...OTHER, disposition: "open" };
      const ctx = ctxWith();
      await ctx.fileDeferredFindings(forcedLandingFilingSet([openStyle], true, isBlocking), "code");
      expect(issuesOnDisk()).toHaveLength(0);
    });

    it("tags only the blocking findings, and only on a forced landing", () => {
      const findings = [deferred(FINDING), deferred(OTHER)];
      const set = forcedLandingFilingSet(findings, true, isBlocking);
      const forced = set.filter((f) => f.filingDisposition === "forced_landing");
      expect(forced.map((f) => f.description)).toEqual([FINDING.description]);
      // Everything else still files as an ordinary deferral rather than
      // vanishing from the call.
      expect(set).toHaveLength(2);
      expect(set.find((f) => f.description === OTHER.description)?.filingDisposition).toBeUndefined();
    });

    it("tags nothing when the landing was not forced", () => {
      const set = forcedLandingFilingSet([deferred(FINDING)], false, isBlocking);
      expect(set.every((f) => f.filingDisposition === undefined)).toBe(true);
    });

    /**
     * The collision this replaced: the old code spread `findings` and then a
     * `.map()`ed copy of the SAME findings into one array, so the untagged
     * copy reached the queue first and the tagged one was skipped as a
     * duplicate fingerprint. One entry per finding, tagged in place.
     */
    it("emits one entry per finding rather than a tagged duplicate", () => {
      const set = forcedLandingFilingSet([deferred(FINDING), deferred(OTHER)], true, isBlocking);
      expect(set.map((f) => f.description)).toEqual([FINDING.description, OTHER.description]);
    });
  });
});
