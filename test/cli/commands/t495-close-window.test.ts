/**
 * T-495 READER: `--close-window`, its three divergence observations, and the
 * `--contract` printout.
 *
 * Closing fixes the upper bound of the population. Every refusal here exists
 * because the alternative lets the week describe a population chosen after the
 * fact, and every observation exists because a check that did not run and a
 * check that found nothing print identically unless the difference is carried
 * in the data.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  handleReviewStats,
  observeDivergence,
  renderContract,
} from "../../../src/cli/commands/review-stats.js";
import { readContractWindow, type ContractWindow } from "../../../src/core/review-stats-window.js";
import { computeP3 } from "../../../src/core/review-stats-p3.js";
import type { CommandContext } from "../../../src/cli/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CONTRACT = "# Review contract\n\n## Robustness\n\nBehaves.\n\nBlocking: blocking\n";
const CONTRACT_HASH = createHash("sha256").update(Buffer.from(CONTRACT, "utf-8")).digest("hex");
const DAY = 24 * 60 * 60 * 1000;

/**
 * Fixed instants for the cases that must isolate ONE reason for a refusal.
 *
 * Nine days apart, so the seven-day minimum is met, and the reader is always
 * handed `PINNED_NOW` so the future-close refusal cannot be what fires.
 */
const PINNED_OPENED = "2026-09-01T00:00:00.000Z";
const PINNED_CLOSED = "2026-09-10T00:00:00.000Z";
const PINNED_NOW = Date.parse("2026-09-10T00:00:01.000Z");
/**
 * The other two closes that must isolate ONE reason, both derived from
 * `PINNED_OPENED` and both before `PINNED_NOW`.
 *
 * A `Date.now()`-derived close in these cases is a TIME BOMB rather than a
 * present-tense bug: it is earlier than `PINNED_NOW` today, and later than it
 * once the real clock passes 2026-09-15, at which point the future-close
 * refusal fires first and deleting the rule each case exists to test leaves
 * the case green. Codex found it in round 3.
 */
const PINNED_BEFORE_OPENING = "2026-08-25T00:00:00.000Z";
const PINNED_THREE_DAY_CLOSE = "2026-09-04T00:00:00.000Z";
/** Exactly seven days after `PINNED_OPENED`, so the minimum is met, not beaten. */
const PINNED_SEVEN_DAY_CLOSE = "2026-09-08T00:00:00.000Z";

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "t495-close-"));
  dirs.push(root);
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(root, ".story", sub), { recursive: true });
  }
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }, null, 2));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-08-21",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }, null, 2));
  writeFileSync(join(root, "REVIEW.md"), CONTRACT, "utf-8");
  return root;
}

function ctxFor(root: string): CommandContext {
  return { root } as unknown as CommandContext;
}

function setWindow(root: string, over: Partial<ContractWindow>): void {
  const path = join(root, ".story", "config.json");
  const cfg = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  cfg.contractMeasurement = {
    openedAt: new Date(Date.now() - 8 * DAY).toISOString(),
    closedAt: null,
    baselineHash: CONTRACT_HASH,
    roots: [root],
    closeObservations: null,
    ...over,
  };
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** One accepted round, artifact plus its measurement record. */
function writeRound(root: string, i: number, at: Date): void {
  const sessionDir = join(root, ".story", "sessions", "s1");
  const reviews = join(sessionDir, "telemetry", "reviews");
  mkdirSync(reviews, { recursive: true });
  const artifact = {
    target: "T-1", stage: "code", round: 1, reviewer: "codex", verdict: "approve",
    findingsCount: 1,
    severityCounts: { critical: 0, major: 0, minor: 1, suggestion: 0 },
    startedAt: at.toISOString(), durationMs: 1, summary: "s", findings: [],
    timestamp: at.toISOString(),
    reviewAttemptId: `ra-${i}`, itemAttemptId: "ia-1", generation: 1,
    _contentHash: `hash-${i}`,
  };
  writeFileSync(join(reviews, `r${i}.json`), JSON.stringify(artifact));
  const record = {
    sessionId: "s1", itemId: "T-1", target: "T-1", itemAttemptId: "ia-1",
    reviewAttemptId: `ra-${i}`, artifactFileName: `r${i}.json`, artifactContentHash: `hash-${i}`,
    stage: "code", round: 1, generation: 1, backend: "codex", leg: "packet",
    kind: "measured", evaluatedContentHash: CONTRACT_HASH, contractStatus: "active",
    contractActive: true, effectivePolicy: { alwaysBlock: ["critical"], neverBlock: [] },
    delivered: {
      contentHash: CONTRACT_HASH, reviewMdIncluded: true, truncated: false,
      truncatedAtChars: null, deliveredChars: 10,
    },
    deliveryBinding: "exact", deliveryVerified: true, deliveryVerifiedBy: "key-binding",
    findings: [{
      index: 0, principle: null, coverage: "inside", actualSeverity: "minor",
      projectedSeverity: "minor", policyBlock: "baseline", floorSuppressed: false,
      outcome: "capped-names-none", reason: "r", undeclaredName: null,
      baseline: { severity: "minor", blocking: false },
    }],
    gate: {
      hasCriticalOrMajor: false, hasUnresolvedCritical: false,
      baselineHasCriticalOrMajor: false, baselineHasUnresolvedCritical: false,
      policyBlockedIndices: [], forcedLandingAllowed: false,
    },
    stageNextAction: "IMPLEMENT", floorSuppressedMinorCount: 0, floorSuppressedTotal: 0,
    timestamp: at.toISOString(),
  };
  writeFileSync(
    join(sessionDir, "principle-policy.jsonl"),
    `${JSON.stringify(record)}\n`,
    { flag: "a" },
  );
}

/**
 * A repo whose SETUP commit is back-dated well before any window under test.
 *
 * `git log` filters on the COMMITTER date, so both env vars are set: a
 * setup commit made at "now" lands inside every window opened in the past and
 * would make a clean fixture report a divergence that the fixture created.
 */
function initRepo(root: string): void {
  const old = new Date(Date.now() - 30 * DAY).toISOString();
  const run = (args: string[], env: Record<string, string> = {}): void => {
    execFileSync("git", args, { cwd: root, stdio: "ignore", env: { ...process.env, ...env } });
  };
  run(["init", "-q"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "T"]);
  run(["add", "REVIEW.md"]);
  run(["commit", "-q", "-m", "add contract"], {
    GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old,
  });
}

function fillWindow(root: string, n: number): void {
  const at = new Date(Date.now() - 2 * DAY);
  for (let i = 0; i < n; i++) writeRound(root, i, at);
}

// ── T40 ──────────────────────────────────────────────────────────

describe("T40: --close-window refuses before day seven and refuses to re-close", () => {
  it("refuses a window opened three days ago", async () => {
    const root = newRoot();
    setWindow(root, { openedAt: new Date(Date.now() - 3 * DAY).toISOString() });
    fillWindow(root, 24);
    const res = await handleReviewStats({ closeWindow: true }, ctxFor(root));
    expect(res.exitCode).toBe(1);
    expect(res.output).toMatch(/seven days have not elapsed/);
    expect(readContractWindow(root)?.closedAt).toBeNull();
  });

  it("refuses to re-close a closed window", async () => {
    const root = newRoot();
    // ONE reference instant for both timestamps. Taking `closedAt` from a
    // `Date.now()` that runs BEFORE `setWindow` computes its default
    // `openedAt` makes the span a hair under seven days whenever the clock
    // advances between the two calls, and the window is then rejected for its
    // DATES: the command returns "No readable measurement window" and the
    // re-close guard is never reached. Codex found it in round 2.
    const ref = Date.now();
    setWindow(root, {
      openedAt: new Date(ref - 8 * DAY).toISOString(),
      closedAt: new Date(ref - DAY).toISOString(),
      closeObservations: {
        reReadHash: CONTRACT_HASH, commitsTouchingReview: 0, reviewDirty: false, notes: [],
      },
    });
    fillWindow(root, 24);
    // The PRECONDITION, asserted rather than assumed: this test is about the
    // re-close guard, so the window must be readable before it runs.
    expect(readContractWindow(root)).not.toBeNull();
    const before = readContractWindow(root)?.closedAt;
    const res = await handleReviewStats({ closeWindow: true }, ctxFor(root));
    expect(res.exitCode).toBe(1);
    expect(res.output).toMatch(/already closed/);
    // The refusal is TOTAL: `closedAt` is not re-stamped either.
    expect(readContractWindow(root)?.closedAt).toBe(before);
  });

  it("refuses below the twenty-round population floor", async () => {
    const root = newRoot();
    setWindow(root, {});
    fillWindow(root, 12);
    const res = await handleReviewStats({ closeWindow: true }, ctxFor(root));
    expect(res.exitCode).toBe(1);
    expect(res.output).toMatch(/Only 12 in-window accepted round/);
    expect(readContractWindow(root)?.closedAt).toBeNull();
  });

  it("closes at the floor and records the observations in the same write", async () => {
    const root = newRoot();
    setWindow(root, {});
    fillWindow(root, 20);
    const res = await handleReviewStats({ closeWindow: true }, ctxFor(root));
    expect(res.exitCode ?? 0).toBe(0);
    const w = readContractWindow(root);
    // NOT `w?.closedAt`, which is `undefined` when the whole window failed to
    // parse and would pass every assertion below vacuously.
    expect(w).not.toBeNull();
    expect(w!.closedAt).not.toBeNull();
    // A closed window ALWAYS carries its observations, because a closed window
    // without them does not parse as a window at all.
    expect(w!.closeObservations).not.toBeNull();
    expect(w!.closeObservations!.reReadHash).toBe(CONTRACT_HASH);
  });
});

describe("a closed window carrying no observations does not parse as a window", () => {
  it("reads as absent rather than as a clean closed week", async () => {
    const root = newRoot();
    setWindow(root, { closedAt: new Date().toISOString(), closeObservations: null });
    expect(readContractWindow(root)).toBeNull();
    // And the reader says so rather than printing a verdict.
    const res = await handleReviewStats({ contract: true }, ctxFor(root));
    expect(res.output).toMatch(/UNDETERMINED \(no window\)/);
  });
});

// ── T53: the three divergence observations ───────────────────────

describe("T53: the close command observes all three divergence checks", () => {
  it("a clean repo observes all three and none diverges", async () => {
    const root = newRoot();
    initRepo(root);
    const window: ContractWindow = {
      openedAt: new Date(Date.now() - 8 * DAY).toISOString(),
      closedAt: null, baselineHash: CONTRACT_HASH, roots: [root], closeObservations: null,
    };
    const obs = await observeDivergence(root, window, Date.now());
    expect(obs.reReadHash).toBe(CONTRACT_HASH);
    expect(obs.commitsTouchingReview).toBe(0);
    expect(obs.reviewDirty).toBe(false);
    expect(obs.notes).toEqual([]);
  });

  it("a commit touching REVIEW.md inside the window is counted", async () => {
    const root = newRoot();
    initRepo(root);
    writeFileSync(join(root, "REVIEW.md"), `${CONTRACT}\n## Quality\n\nq\n\nBlocking: major\n`);
    execFileSync("git", ["add", "REVIEW.md"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "edit contract"], { cwd: root, stdio: "ignore" });
    const window: ContractWindow = {
      // Opened before both commits, so both are inside the window.
      openedAt: new Date(Date.now() - 8 * DAY).toISOString(),
      closedAt: null, baselineHash: CONTRACT_HASH, roots: [root], closeObservations: null,
    };
    const obs = await observeDivergence(root, window, Date.now());
    // ONE: the edit, not the back-dated setup commit, which is outside.
    expect(obs.commitsTouchingReview).toBe(1);
    // And the re-read no longer matches, which is the OTHER check catching the
    // same edit. Both are reported; neither stands in for the other.
    expect(obs.reReadHash).not.toBe(CONTRACT_HASH);
  });

  it("a dirty REVIEW.md at close is observed", async () => {
    const root = newRoot();
    initRepo(root);
    writeFileSync(join(root, "REVIEW.md"), `${CONTRACT}\nuncommitted\n`);
    const window: ContractWindow = {
      openedAt: new Date(Date.now() - 8 * DAY).toISOString(),
      closedAt: null, baselineHash: CONTRACT_HASH, roots: [root], closeObservations: null,
    };
    const obs = await observeDivergence(root, window, Date.now());
    expect(obs.reviewDirty).toBe(true);
    // Detected by the dirty check, and by the re-read; NOT by the commit log,
    // which is why three checks exist rather than one.
    expect(obs.commitsTouchingReview).toBe(0);
  });

  it("outside a git repository the two git checks are NOT OBSERVED, not zero", async () => {
    const root = newRoot();
    const window: ContractWindow = {
      openedAt: new Date(Date.now() - 8 * DAY).toISOString(),
      closedAt: null, baselineHash: CONTRACT_HASH, roots: [root], closeObservations: null,
    };
    const obs = await observeDivergence(root, window, Date.now());
    expect(obs.commitsTouchingReview).toBeNull();
    expect(obs.reviewDirty).toBeNull();
    expect(obs.notes.length).toBeGreaterThan(0);
    // And the reader refuses to certify the week rather than reading the nulls
    // as clean results.
    const p3 = computeP3({
      records: [], artifacts: [], scan: {
        roots: [root], startedAt: "x", finishedAt: "y", atomic: false,
        failures: [], readFailures: 0, state: { [`p3:${root}`]: "COMPLETE" },
      },
      window: { ...window, closedAt: new Date().toISOString(), closeObservations: obs },
      nowMs: Date.now(),
    });
    expect(p3.verdict.status.code).toBe("divergence-unobserved");
  });

  it("a REVIEW.md that cannot be read leaves the re-read unobserved", async () => {
    const root = newRoot();
    initRepo(root);
    rmSync(join(root, "REVIEW.md"));
    const window: ContractWindow = {
      openedAt: new Date(Date.now() - 8 * DAY).toISOString(),
      closedAt: null, baselineHash: CONTRACT_HASH, roots: [root], closeObservations: null,
    };
    const obs = await observeDivergence(root, window, Date.now());
    expect(obs.reReadHash).toBeNull();
    expect(obs.notes.some((n) => n.includes("REVIEW.md"))).toBe(true);
  });
});

// ── the printout ─────────────────────────────────────────────────

describe("the git observations look at history the default walk would hide", () => {
  it("counts a commit on a branch that changed and restored REVIEW.md before merging", async () => {
    // A path-limited `git log` applies history simplification by default. At a
    // merge that is TREESAME for this path to one parent, git follows that
    // parent only, so a branch that edited REVIEW.md and restored it before
    // merging is invisible: the check reports a clean count over history it
    // never walked. Filtering dates afterwards cannot recover a commit the walk
    // did not emit. Codex found it.
    const root = newRoot();
    initRepo(root);
    const at = (offsetDays: number): Record<string, string> => {
      const d = new Date(Date.now() - offsetDays * DAY).toISOString();
      return { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d };
    };
    const run = (args: string[], env: Record<string, string> = {}): void => {
      execFileSync("git", args, { cwd: root, stdio: "ignore", env: { ...process.env, ...env } });
    };
    run(["checkout", "-q", "-b", "side"]);
    writeFileSync(join(root, "REVIEW.md"), `${CONTRACT}\nedited on the branch\n`);
    run(["commit", "-q", "-a", "-m", "edit on branch"], at(4));
    writeFileSync(join(root, "REVIEW.md"), CONTRACT);
    run(["commit", "-q", "-a", "-m", "restore on branch"], at(3));
    run(["checkout", "-q", "-"]);
    run(["merge", "-q", "--no-ff", "-m", "merge side", "side"], at(2));

    const window: ContractWindow = {
      openedAt: new Date(Date.now() - 6 * DAY).toISOString(),
      closedAt: null, baselineHash: CONTRACT_HASH, roots: [root], closeObservations: null,
    };
    const obs = await observeDivergence(root, window, Date.now());
    // The two branch commits are inside the window; the setup commit is not.
    // A simplified walk reports 0 here and the week reads as clean.
    expect(obs.commitsTouchingReview).toBe(2);
    // And the contract is back to the baseline, so this is the case ONLY the
    // commit check can catch: the re-read matches and the tree is clean.
    expect(obs.reReadHash).toBe(CONTRACT_HASH);
    expect(obs.reviewDirty).toBe(false);
  });

  it("an untracked REVIEW.md that .gitignore matches still reads as DIRTY", async () => {
    // `git status` omits ignored files by default, so an ignored, untracked
    // contract printed nothing and read as clean, contradicting the rule the
    // helper states: an untracked contract is exactly as unaccounted for as a
    // modified one.
    const root = newRoot();
    const old = new Date(Date.now() - 30 * DAY).toISOString();
    const run = (args: string[], env: Record<string, string> = {}): void => {
      execFileSync("git", args, { cwd: root, stdio: "ignore", env: { ...process.env, ...env } });
    };
    run(["init", "-q"]);
    run(["config", "user.email", "t@example.com"]);
    run(["config", "user.name", "T"]);
    writeFileSync(join(root, ".gitignore"), "REVIEW.md\n");
    run(["add", ".gitignore"]);
    run(["commit", "-q", "-m", "ignore the contract"], {
      GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old,
    });

    const window: ContractWindow = {
      openedAt: new Date(Date.now() - 8 * DAY).toISOString(),
      closedAt: null, baselineHash: CONTRACT_HASH, roots: [root], closeObservations: null,
    };
    const obs = await observeDivergence(root, window, Date.now());
    expect(obs.reviewDirty).toBe(true);
    // No commit ever touched it, so the commit check cannot catch this one.
    expect(obs.commitsTouchingReview).toBe(0);
  });
});

describe("readContractWindow refuses a window whose instants are not usable", () => {
  // A `closedAt` of "not-a-date" passed the shape check, and the reader then
  // treated the window as closed while SKIPPING its upper-bound filter, because
  // `Date.parse` returned NaN. The same hole let a hand-edited early close
  // bypass the seven-day minimum that closing refuses at.
  for (const [name, over] of [
    ["an unparseable openedAt", { openedAt: "not-a-date" }],
    ["an unparseable closedAt", {
      closedAt: "not-a-date",
      closeObservations: {
        reReadHash: CONTRACT_HASH, commitsTouchingReview: 0, reviewDirty: false, notes: [],
      },
    }],
    ["a close dated before its own opening", {
      openedAt: PINNED_OPENED,
      closedAt: PINNED_BEFORE_OPENING,
      closeObservations: {
        reReadHash: CONTRACT_HASH, commitsTouchingReview: 0, reviewDirty: false, notes: [],
      },
    }],
    ["a close only three days after opening", {
      openedAt: PINNED_OPENED,
      closedAt: PINNED_THREE_DAY_CLOSE,
      closeObservations: {
        reReadHash: CONTRACT_HASH, commitsTouchingReview: 0, reviewDirty: false, notes: [],
      },
    }],
    // BOTH INSTANTS PINNED, and the span is comfortably over seven days. With
    // `openedAt` left to the fixture default the two `Date.now()` calls happen
    // at different moments and the span lands a hair UNDER seven days, so the
    // window was rejected for its dates and this case never reached the count
    // check at all: the mutant that accepts `-1` survived against a green test.
    ["a negative commit count", {
      openedAt: PINNED_OPENED,
      closedAt: PINNED_CLOSED,
      closeObservations: {
        reReadHash: CONTRACT_HASH, commitsTouchingReview: -1, reviewDirty: false, notes: [],
      },
    }],
  ] as const) {
    it(`reads as absent for ${name}`, () => {
      const root = newRoot();
      setWindow(root, over as Record<string, unknown>);
      // PINNED_CLOSED is a fixed instant, so the reader is given a clock just
      // after it. Without that the future-close refusal would reject the
      // fixture and the negative count would never be reached, which is the
      // ambiguity these fixtures exist to avoid.
      expect(readContractWindow(root, PINNED_NOW)).toBeNull();
    });
  }

  it("accepts a span of EXACTLY seven days, from the same opening", () => {
    // The control for the three-day case, and for the boundary itself. Without
    // it a window refused for its SPAN is indistinguishable from one refused
    // for any of the other date rules, and nothing pins which side of seven
    // days the minimum falls on.
    const root = newRoot();
    setWindow(root, {
      openedAt: PINNED_OPENED,
      closedAt: PINNED_SEVEN_DAY_CLOSE,
      closeObservations: {
        reReadHash: CONTRACT_HASH, commitsTouchingReview: 0, reviewDirty: false, notes: [],
      },
    });
    expect(readContractWindow(root, PINNED_NOW)).not.toBeNull();
  });

  it("accepts that same window when the commit count is a real one", () => {
    // The control for the case above. Without it, a window rejected for its
    // DATES is indistinguishable from one rejected for its count.
    const root = newRoot();
    setWindow(root, {
      openedAt: PINNED_OPENED,
      closedAt: PINNED_CLOSED,
      closeObservations: {
        reReadHash: CONTRACT_HASH, commitsTouchingReview: 0, reviewDirty: false, notes: [],
      },
    });
    expect(readContractWindow(root, PINNED_NOW)).not.toBeNull();
  });

  it("refuses a close time in the FUTURE", () => {
    // Opened eight days ago and closed TOMORROW satisfies every other check,
    // and the reader would treat it as closed while its population kept
    // growing as the clock advanced toward that timestamp: a supposedly fixed
    // week still taking new members. Codex found it in round 2.
    const root = newRoot();
    const ref = Date.parse("2026-09-10T00:00:00.000Z");
    setWindow(root, {
      openedAt: new Date(ref - 8 * DAY).toISOString(),
      closedAt: new Date(ref + DAY).toISOString(),
      closeObservations: {
        reReadHash: CONTRACT_HASH, commitsTouchingReview: 0, reviewDirty: false, notes: [],
      },
    });
    expect(readContractWindow(root, ref)).toBeNull();
    // The control: the same window closed a minute AGO is accepted, so the
    // refusal is about the future, not about these dates.
    setWindow(root, {
      openedAt: new Date(ref - 8 * DAY).toISOString(),
      closedAt: new Date(ref - 60_000).toISOString(),
      closeObservations: {
        reReadHash: CONTRACT_HASH, commitsTouchingReview: 0, reviewDirty: false, notes: [],
      },
    });
    expect(readContractWindow(root, ref)).not.toBeNull();
  });

  it("allows a close inside the clock-skew tolerance", () => {
    const root = newRoot();
    const ref = Date.parse("2026-09-10T00:00:00.000Z");
    setWindow(root, {
      openedAt: new Date(ref - 8 * DAY).toISOString(),
      closedAt: new Date(ref + 60_000).toISOString(),
      closeObservations: {
        reReadHash: CONTRACT_HASH, commitsTouchingReview: 0, reviewDirty: false, notes: [],
      },
    });
    expect(readContractWindow(root, ref)).not.toBeNull();
  });

  it("accepts a legitimate close at exactly seven days", () => {
    const root = newRoot();
    const ref = Date.now();
    setWindow(root, {
      openedAt: new Date(ref - 7 * DAY).toISOString(),
      closedAt: new Date(ref).toISOString(),
      closeObservations: {
        reReadHash: CONTRACT_HASH, commitsTouchingReview: 0, reviewDirty: false, notes: [],
      },
    });
    expect(readContractWindow(root)).not.toBeNull();
  });
});

describe("the close-time population is counted against the window that WILL be written", () => {
  it("refuses when a future-skewed round makes the open count reach the floor", async () => {
    // An OPEN window admits artifacts up to `nowMs` plus five minutes; the
    // CLOSED window excludes everything after `closedAt`, which is `nowMs`. So
    // 19 real rounds plus one timestamped a minute ahead passed the floor while
    // the closed week would hold 19, and a window cannot be re-opened.
    const root = newRoot();
    setWindow(root, {});
    const at = new Date(Date.now() - 2 * DAY);
    for (let i = 0; i < 19; i++) writeRound(root, i, at);
    writeRound(root, 19, new Date(Date.now() + 60 * 1000));
    const res = await handleReviewStats({ closeWindow: true }, ctxFor(root));
    expect(res.exitCode).toBe(1);
    expect(res.output).toMatch(/Only 19 in-window accepted round/);
    expect(readContractWindow(root)?.closedAt).toBeNull();
  });
});

describe("a policy record naming another session is a scan failure, not evidence", () => {
  it("does not let session B's log supply measurements for B while stored under A", async () => {
    const root = newRoot();
    initRepo(root);
    setWindow(root, {});
    fillWindow(root, 24);
    // Session B's artifact exists; B's own policy log does not. B's record is
    // copied into session A's directory. Joining on the record's OWN sessionId
    // would make the misplaced file usable evidence for B.
    const at = new Date(Date.now() - 2 * DAY);
    const bReviews = join(root, ".story", "sessions", "s2", "telemetry", "reviews");
    mkdirSync(bReviews, { recursive: true });
    writeFileSync(join(bReviews, "r0.json"), JSON.stringify({
      target: "T-2", stage: "code", round: 1, reviewer: "codex", verdict: "approve",
      findingsCount: 0, severityCounts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
      startedAt: at.toISOString(), durationMs: 1, summary: "s", findings: [],
      timestamp: at.toISOString(), reviewAttemptId: "ra-s2", itemAttemptId: "ia-2",
      generation: 1, _contentHash: "hash-s2",
    }));
    const aLog = join(root, ".story", "sessions", "s1", "principle-policy.jsonl");
    const first = readFileSync(aLog, "utf-8").split("\n")[0]!;
    const foreign = JSON.parse(first) as Record<string, unknown>;
    writeFileSync(aLog, `${JSON.stringify({
      ...foreign, sessionId: "s2", reviewAttemptId: "ra-s2", artifactContentHash: "hash-s2",
    })}\n`, { flag: "a" });

    const res = await handleReviewStats({ contract: true }, ctxFor(root));
    // The misplaced record is refused, so B's artifact has no measurement.
    expect(res.output).toMatch(/name a session other than the directory holding them/);
    expect(res.output).toMatch(/measurement-absent 1/);
  });
});

describe("a damaged measurement log is a scan failure, not a smaller week", () => {
  it("an unreadable line makes the scan PARTIAL and the verdict UNDETERMINED", async () => {
    // Skipping the damaged line silently shrinks the population by exactly the
    // records that were damaged, and the reader then computes a rate over the
    // survivors while claiming to describe the week. That is this ticket's
    // failure class aimed at its own input.
    const root = newRoot();
    // A REAL repo, so the divergence-unobserved rung cannot be what fires
    // either: it outranks scan-incomplete and would pass for the wrong reason.
    initRepo(root);
    setWindow(root, {});
    fillWindow(root, 24);
    // Closed FIRST, so the open-window rung cannot be what fires: that rung
    // outranks scan-incomplete and would make this pass for the wrong reason.
    await handleReviewStats({ closeWindow: true }, ctxFor(root));
    writeFileSync(
      join(root, ".story", "sessions", "s1", "principle-policy.jsonl"),
      "{ this is not json\n",
      { flag: "a" },
    );
    const res = await handleReviewStats({ contract: true }, ctxFor(root));
    expect(res.output).toMatch(/UNDETERMINED \(scan incomplete\)/);
    expect(res.output).toMatch(/unreadable line/);
    expect(res.warnings?.[0] ?? "").toMatch(/read failure/);
  });

  it("a log that is entirely readable leaves the scan COMPLETE", async () => {
    const root = newRoot();
    initRepo(root);
    setWindow(root, {});
    fillWindow(root, 24);
    await handleReviewStats({ closeWindow: true }, ctxFor(root));
    const res = await handleReviewStats({ contract: true }, ctxFor(root));
    expect(res.output).not.toMatch(/UNDETERMINED \(scan incomplete\)/);
    expect(res.output).toContain("Scan: COMPLETE");
  });
});

describe("--contract prints the reader's report", () => {
  it("prints the three verdict lines and the not-an-authorisation sentence", async () => {
    const root = newRoot();
    setWindow(root, {});
    fillWindow(root, 24);
    await handleReviewStats({ closeWindow: true }, ctxFor(root));
    const res = await handleReviewStats({ contract: true }, ctxFor(root));
    expect(res.exitCode ?? 0).toBe(0);
    expect(res.output).toContain("OUTCOME");
    expect(res.output).toContain("DELIVERY COVERAGE");
    expect(res.output).toContain("POPULATION");
    expect(res.output).toMatch(/NOT an authorisation/i);
    expect(res.output).not.toMatch(/flip authorised/i);
    // 24 verified packet rounds: outcome clean, delivery complete, floor met.
    expect(res.output).toMatch(/OUTCOME .*against 20%   PASS/);
    expect(res.output).toMatch(/DELIVERY COVERAGE packet .*24\/24 100\.0%.*PASS/);
  });

  it("prints undefined membership rather than a measured zero when there is no window", async () => {
    const root = newRoot();
    const res = await handleReviewStats({ contract: true }, ctxFor(root));
    expect(res.output).toMatch(/Membership is undefined/);
    expect(res.output).not.toMatch(/In-window identified accepted rounds: 0\. Floor 20: NOT met/);
  });

  it("refuses a verdict with no window and names the command that opens one", async () => {
    const root = newRoot();
    const res = await handleReviewStats({ contract: true }, ctxFor(root));
    expect(res.output).toMatch(/UNDETERMINED \(no window\)/);
    expect(res.output).toContain("--open-window");
  });

  it("prints `-` and never 0% over an empty window", async () => {
    const root = newRoot();
    setWindow(root, {});
    const res = await handleReviewStats({ contract: true }, ctxFor(root));
    expect(res.output).toContain("In-window identified accepted rounds: 0");
    expect(res.output).not.toMatch(/\| 0\.0% \|/);
  });

  it("the renderer READS the verdict rather than deciding it", () => {
    // A renderer that computed its own PASS could print a disclosure beside a
    // number the disclosure does not describe. Handing it a result whose row
    // says PASS with an impossible rate proves the text came from the field.
    const scan = {
      roots: ["/r"], startedAt: "x", finishedAt: "y", atomic: false as const,
      failures: [], readFailures: 0, state: { "p3:/r": "COMPLETE" as const },
    };
    const real = computeP3({ records: [], artifacts: [], window: null, scan, nowMs: 0 });
    const forged = {
      ...real,
      verdict: {
        ...real.verdict,
        rows: [{
          family: "outcome" as const, label: "OUTCOME", measured: "99 of 100 excluded, 99.0%",
          against: "20%", pass: true,
        }],
      },
    };
    expect(renderContract(forged, scan)).toMatch(/99 of 100 excluded, 99\.0%.*against 20%   PASS/);
  });

  it("QUALIFIES the one-bucket claim, because it assumes unique artifact join keys", () => {
    // Codex round 4. The unqualified sentence reads as a checkable invariant
    // and rests on a precondition nothing enforces: two member artifacts
    // sharing a join key put one record in two buckets. A line that reads as a
    // guarantee while resting on an unstated assumption is this ticket's own
    // failure class, so the sentence has to carry the assumption.
    const scan = {
      roots: ["/r"], startedAt: "x", finishedAt: "y", atomic: false as const,
      failures: [], readFailures: 0, state: { "p3:/r": "COMPLETE" as const },
    };
    const real = computeP3({ records: [], artifacts: [], window: null, scan, nowMs: 0 });
    const out = renderContract(real, scan);
    expect(out).toContain("assuming member artifacts have unique join keys");
    expect(out).not.toMatch(/so every\s+record is in exactly one bucket\.(?! Two)/);
  });
});
