/**
 * ISS-950 gate round 2: the downgrade-only rule has to hold for the verdict a
 * call RETURNS, not only for what it later persists.
 *
 * The merge under the shared-file lock keeps the strictest basis on disk, but
 * that is the wrong guarantee on its own. Two calls for one review can both
 * read unrestricted memory; A then persists `self-reported`; B, still holding
 * the snapshot it read before A wrote, RETURNS `not-applicable`. B's merge
 * afterwards keeps A's restriction on disk and the ledger is consistent, but
 * B's verdict has already cleared the cap it should have paid. The same window
 * loses a relabel: B cannot see the skip A recorded, so a flip to `ok` with
 * zero findings passes unflagged.
 *
 * The close is a PER-REVIEW lock, held across the read, the pipeline and the
 * persist. Only calls for the same `reviewId` contend; a session running two
 * unrelated reviews serializes neither.
 *
 * The concurrency here is REAL: a second OS process driving `handleSynthesize`
 * against the same session directory. An in-process simulation would prove
 * nothing about a lock whose whole job is cross-process.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  acquireReviewCoverageLock,
  coverageMemoryPath,
} from "../../../src/autonomous/lens-harness/coverage-memory.js";
import { handleSynthesize } from "../../../src/autonomous/lens-harness/synthesize.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SYNTH = join(pkgRoot, "src", "autonomous", "lens-harness", "synthesize.js");

const CORE = ["security", "error-handling", "clean-code", "concurrency"] as const;
const LENS = "error-handling";

/** A code change: applicable to `error-handling`, so a skip on it is self-reported. */
const CODE_DIFF = [
  "diff --git a/src/example.ts b/src/example.ts",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,3 +1,4 @@",
  " export function greet(name: string): string {",
  '+  console.log("debug");',
  '   return "hello " + name;',
  " }",
  "",
].join("\n");

/** A docs-only change: not applicable to any core lens. */
const DOCS_DIFF = [
  "diff --git a/docs/guide.md b/docs/guide.md",
  "--- a/docs/guide.md",
  "+++ b/docs/guide.md",
  "@@ -1,2 +1,3 @@",
  " intro",
  "+a new sentence",
  " outro",
  "",
].join("\n");

/**
 * The child driver. It runs the REAL `handleSynthesize` in its own process and
 * prints either the one coverage entry under test or, when the call refused to
 * run at all, the error that refused it.
 */
const CHILD_SOURCE = `
import { writeFileSync } from "node:fs";
import { handleSynthesize } from ${JSON.stringify(SYNTH)};
const a = JSON.parse(process.argv[2]);
// The readiness handshake, and it is what makes the race deterministic rather
// than a bet on timing. Starting a tsx child costs far more than any margin
// worth sleeping, so the parent waits for THIS file instead of for a clock:
// everything after it is the call under test, and an implementation that does
// not wait for the lock reads the memory within microseconds of this line.
if (a.readyFile) writeFileSync(a.readyFile, "ready");
try {
  const out = handleSynthesize({
    stage: "CODE_REVIEW",
    lensResults: a.lenses.map((lens) => ({
      lens,
      output: lens === a.lens
        ? { status: "skipped", findings: [], error: null, notes: "nothing in my domain" }
        : { status: "ok", findings: [], error: null, notes: null },
    })),
    metadata: {
      activeLenses: a.lenses,
      skippedLenses: [],
      reviewRound: a.round,
      reviewId: a.reviewId,
    },
    projectRoot: a.root,
    sessionDir: a.sessionDir,
    sessionId: "sess-1",
    diff: a.diff,
    changedFiles: a.changedFiles,
  });
  const entry = out.reviewVerdict.lensCoverage.find((e) => e.lensId === a.lens);
  process.stdout.write(JSON.stringify({
    basis: entry ? entry.basis : null,
    verdict: out.reviewVerdict.verdict,
  }));
} catch (e) {
  // A refusal is a RESULT here, not a crash: the whole question is whether the
  // contender declines to produce a verdict at all.
  process.stdout.write(JSON.stringify({ errorName: e.name, errorMessage: e.message }));
}
`;

/** The restriction a peer call establishes: this lens skipped when it mattered. */
const peerFile = (reviewId: string) => ({
  [reviewId]: { [LENS]: { everSkipped: true, basis: "self-reported" } },
});

let root: string;
let sessionDir: string;
let childPath: string;

interface ChildResult {
  basis?: string | null;
  verdict?: string;
  errorName?: string;
  errorMessage?: string;
}

/**
 * `env` overrides the review-lock budget so a contender exhausts in
 * milliseconds. The production budget is 1.2s, which is right for a lock held
 * across a whole synthesize and wrong for a test that only needs the exhaustion
 * branch to be reachable.
 */
function runChild(
  args: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<ChildResult> {
  return new Promise((res, rej) => {
    const child = spawn(
      process.execPath,
      [join(pkgRoot, "node_modules", "tsx", "dist", "cli.mjs"), childPath, JSON.stringify(args)],
      { cwd: pkgRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", rej);
    child.on("close", (code) => {
      if (code !== 0) return rej(new Error(`child exited ${code}: ${err}`));
      try {
        res(JSON.parse(out));
      } catch {
        rej(new Error(`unparseable child output: ${out}\n${err}`));
      }
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for the child to reach the call under test. */
async function waitForReady(file: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await sleep(10);
  }
  throw new Error(`child never signalled ready at ${file}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lens-review-lock-"));
  sessionDir = join(root, ".story", "sessions", "sess-1");
  mkdirSync(join(sessionDir, "telemetry"), { recursive: true });
  childPath = join(root, "child.mts");
  writeFileSync(childPath, CHILD_SOURCE);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the per-review lock closes the read-side window (ISS-950)", () => {
  it(
    "M-NO-REVIEW-LOCK: a second process cannot return not-applicable over a peer's self-reported skip",
    async () => {
      const reviewId = "rid-contended";
      // Stand in for call A, mid-flight: it holds the review's lock and has not
      // written its restriction yet. The memory is EMPTY right now, which is
      // exactly the snapshot B must not be allowed to act on.
      const lock = acquireReviewCoverageLock(sessionDir, reviewId);
      expect(lock.kind).toBe("held");

      // B starts now, against a docs-only diff, where the applicability tables
      // alone say not-applicable for every core lens.
      const readyFile = join(root, "b-ready");
      const pending = runChild({
        root,
        sessionDir,
        reviewId,
        round: 2,
        lens: LENS,
        lenses: [...CORE],
        diff: DOCS_DIFF,
        changedFiles: ["docs/guide.md"],
        readyFile,
      });

      // B has reached the call. An implementation that does not wait for the
      // lock has already read the (empty) memory by the time this returns.
      await waitForReady(readyFile);
      await sleep(150);
      // A finishes: its restriction lands.
      writeFileSync(coverageMemoryPath(sessionDir), JSON.stringify(peerFile(reviewId)));
      if (lock.kind === "held") lock.release();

      const result = await pending;
      // B waited, read A's restriction, and paid the cap.
      expect(result.basis).toBe("self-reported");
      expect(result.verdict).toBe("revise");
      // And it WAITED rather than being refused: a contender that exhausted
      // its budget throws instead, which is a different outcome entirely.
      expect(result.errorName).toBeUndefined();
    },
    20_000,
  );

  it(
    "two different reviews in one session do not serialize behind each other",
    async () => {
      // One review's lock is held for the whole of the other's call.
      const lock = acquireReviewCoverageLock(sessionDir, "rid-alpha");
      expect(lock.kind).toBe("held");
      try {
        const result = await runChild({
          root,
          sessionDir,
          reviewId: "rid-beta",
          round: 1,
          lens: LENS,
          lenses: [...CORE],
          diff: DOCS_DIFF,
          changedFiles: ["docs/guide.md"],
        });
        // Unblocked, and not refused: an honest skip on a docs-only change.
        expect(result.errorName).toBeUndefined();
        expect(result.basis).toBe("not-applicable");
        expect(result.verdict).toBe("approve");
      } finally {
        if (lock.kind === "held") lock.release();
      }
    },
    20_000,
  );
});


/**
 * ISS-950 gate round 3: an exhausted review lock refuses the round outright.
 *
 * The previous revision degraded instead -- it ran the pipeline with every skip
 * forced to `self-reported` and persisted the result -- and that did not close
 * the window. The persist lock protects the FILE, not the holder's verdict: a
 * contender that writes through it while the holder is mid-flight still changes
 * what the holder reads on its next round, and the holder itself, having read
 * before that write, can still return `not-applicable`. Making only the
 * contender's own answer stricter never bought the guarantee.
 *
 * So a contender that cannot take the lock runs nothing and writes nothing. It
 * throws, and the agent retries the identical call once the holder finishes.
 */
describe("an exhausted review lock refuses the round (ISS-950)", () => {
  /** Small enough that the exhaustion branch is reached in milliseconds. */
  const FAST_BUDGET = {
    STORYBLOQ_REVIEW_LOCK_RETRIES: "2",
    STORYBLOQ_REVIEW_LOCK_RETRY_MS: "5",
  };

  it("M-DEGRADED-RUN: lock exhaustion throws the typed error and writes nothing", async () => {
    const reviewId = "rid-jammed";
    const lock = acquireReviewCoverageLock(sessionDir, reviewId);
    expect(lock.kind).toBe("held");
    try {
      const result = await runChild(
        {
          root,
          sessionDir,
          reviewId,
          round: 1,
          lens: LENS,
          lenses: [...CORE],
          // The docs-only change that would otherwise APPROVE. A contender that
          // runs at all produces a verdict here, which is the escape.
          diff: DOCS_DIFF,
          changedFiles: ["docs/guide.md"],
        },
        FAST_BUDGET,
      );

      expect(result.verdict).toBeUndefined();
      expect(result.basis).toBeUndefined();
      expect(result.errorName).toBe("ReviewCoverageLockUnavailableError");
      // The message has to be actionable on its own: it names the review and
      // says the retry is the same call, not a different one.
      expect(result.errorMessage).toContain(reviewId);
      expect(result.errorMessage).toMatch(/retry/i);
      // Nothing was persisted: a refused round leaves no trace to be read as a
      // decision later.
      expect(existsSync(coverageMemoryPath(sessionDir))).toBe(false);
    } finally {
      if (lock.kind === "held") lock.release();
    }
  }, 20_000);

  it(
    "M-DEGRADED-PERSIST: a contender cannot change what the holder reads or returns",
    async () => {
      const reviewId = "rid-holder";
      // The holder, mid-flight: it has the lock and has read the memory, which
      // is empty. Its answer for a docs-only change is `not-applicable`.
      const lock = acquireReviewCoverageLock(sessionDir, reviewId);
      expect(lock.kind).toBe("held");

      const result = await runChild(
        {
          root,
          sessionDir,
          reviewId,
          round: 2,
          lens: LENS,
          lenses: [...CORE],
          diff: CODE_DIFF,
          changedFiles: ["src/example.ts"],
        },
        FAST_BUDGET,
      );
      expect(result.errorName).toBe("ReviewCoverageLockUnavailableError");
      // THE ASSERTION THAT MATTERS. A contender that degraded instead of
      // refusing would have written `self-reported` for this lens through the
      // persist lock while the holder was still mid-flight.
      expect(existsSync(coverageMemoryPath(sessionDir))).toBe(false);

      // The holder now finishes its own round against the same review.
      if (lock.kind === "held") lock.release();
      const out = handleSynthesize({
        stage: "CODE_REVIEW",
        lensResults: CORE.map((lens) => ({
          lens,
          output: { status: "skipped", findings: [], error: null, notes: null },
        })),
        metadata: {
          activeLenses: [...CORE],
          skippedLenses: [],
          reviewRound: 1,
          reviewId,
        },
        projectRoot: root,
        sessionDir,
        sessionId: "sess-1",
        diff: DOCS_DIFF,
        changedFiles: ["docs/guide.md"],
      });

      // Its verdict is the one it was always entitled to. A contender's write
      // would have pinned this lens at `self-reported` and turned the approve
      // into a revise, over a round that never should have run.
      const entry = out.reviewVerdict.lensCoverage.find((e) => e.lensId === LENS);
      expect(entry?.basis).toBe("not-applicable");
      expect(out.reviewVerdict.verdict).toBe("approve");

      // And the persisted memory records the holder's decision, nobody else's.
      const memory = JSON.parse(readFileSync(coverageMemoryPath(sessionDir), "utf-8"));
      expect(memory[reviewId][LENS]).toEqual({
        everSkipped: true,
        basis: "not-applicable",
      });
    },
    20_000,
  );

  it("a sessionless synthesize takes no lock and cannot be refused", () => {
    const out = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: CORE.map((lens) => ({
        lens,
        output: { status: "skipped", findings: [], error: null, notes: null },
      })),
      metadata: { activeLenses: [...CORE], skippedLenses: [], reviewRound: 1, reviewId: "rid-loose" },
      projectRoot: root,
      diff: DOCS_DIFF,
      changedFiles: ["docs/guide.md"],
    });
    // No session directory means no memory to race over: the tables alone
    // decide, exactly as before.
    expect(out.reviewVerdict.verdict).toBe("approve");
  });

  it("the lock file is scoped to the review and never escapes the telemetry dir", () => {
    const lock = acquireReviewCoverageLock(sessionDir, "rid/../with spaces");
    expect(lock.kind).toBe("held");
    if (lock.kind === "held") lock.release();
    // A reviewId is caller-supplied text; it must never reach the filesystem as
    // a path. Nothing was created outside the telemetry directory.
    expect(existsSync(join(root, ".story", "sessions", "with spaces"))).toBe(false);
    expect(existsSync(coverageMemoryPath(sessionDir))).toBe(false);
  });
});
