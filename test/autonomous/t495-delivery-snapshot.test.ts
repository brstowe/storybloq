/**
 * T-495: the recorded delivery metadata describes the text that was actually
 * PACKAGED, not a later read of the same file.
 *
 * Its own file because it mocks `node:fs` at module scope, which the rest of
 * the delivery suite must not have.
 *
 * THE DEFECT IT REFUSES, found by Codex in code round 1 and present in the
 * first implementation of both legs: read REVIEW.md into the packet, then call
 * `loadReviewContract` again afterwards to obtain its hash. Two reads. A
 * REVIEW.md edited between them makes the record name contract B while the
 * reviewer received A, and an exact key binding then reports that round as
 * VERIFIED DELIVERY of a contract it never saw. That is the precise reading
 * this entire measurement exists to make impossible, reintroduced inside the
 * code that measures it, and no assertion over an unchanging file can see it.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every read of REVIEW.md after the FIRST returns different content. So a
 * single-snapshot implementation records the first read's metadata, and any
 * implementation that reads again records the mutant's.
 */
const state = vi.hoisted(() => ({ reviewReads: 0, second: "" as string }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    default: real,
    readFileSync: ((p: unknown, ...rest: unknown[]) => {
      const isReview = typeof p === "string" && p.endsWith("REVIEW.md");
      if (isReview) {
        state.reviewReads += 1;
        if (state.reviewReads > 1 && state.second !== "") {
          return rest[0] === undefined || typeof rest[0] === "object"
            ? Buffer.from(state.second, "utf-8")
            : state.second;
        }
      }
      return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real.readFileSync,
  };
});

const { buildReviewContextPacket } = await import("../../src/autonomous/review-context-packet.js");
const { packageContext } = await import("../../src/autonomous/lens-harness/context-packager.js");
const { readContractDeliveries } = await import("../../src/autonomous/principle-policy-report.js");

const CONTRACT = "# Review contract\n\n## Robustness\n\nBehaves.\n\nBlocking: blocking\n";
const OTHER = "# A DIFFERENT contract\n\n## Tidiness\n\nNo.\n\nBlocking: major\n";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  state.reviewReads = 0;
  state.second = "";
});

function fixture(): { root: string; sessionDir: string } {
  const root = mkdtempSync(join(tmpdir(), "t495-snapshot-"));
  dirs.push(root);
  const sessionDir = join(root, ".story", "sessions", "s1");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(root, "RULES.md"), "# Rules\n", "utf-8");
  writeFileSync(join(root, "REVIEW.md"), CONTRACT, "utf-8");
  return { root, sessionDir };
}

const hashOf = (t: string): string =>
  createHash("sha256").update(Buffer.from(t, "utf-8")).digest("hex");

describe("T-495: one snapshot per delivery observation", () => {
  it("the PACKET leg records the hash of the text it packaged, not of a later read", () => {
    const { root, sessionDir } = fixture();
    state.second = OTHER;
    const packet = buildReviewContextPacket({
      sessionDir, projectRoot: root, target: "T-001", stage: "code",
      generation: 1, roundNum: 2, budget: 100_000, captureDirective: "capture",
      sessionId: "sess-1", itemAttemptId: "att-1",
    });
    // The packet really carried the original, and the mutant's content really
    // was available to a second read: both halves of the trap are live.
    expect(packet.text).toContain(CONTRACT);
    expect(packet.text).not.toContain(OTHER);
    expect(state.reviewReads).toBeGreaterThanOrEqual(1);

    const [rec] = readContractDeliveries(sessionDir).entries;
    expect(rec).toBeDefined();
    expect(rec!.contentHash).toBe(hashOf(CONTRACT));
    expect(rec!.contentHash).not.toBe(hashOf(OTHER));
    expect(rec!.sourceChars).toBe(CONTRACT.length);
  });

  it("the LENS leg records the hash of the text it packaged, not of a later read", () => {
    const { root, sessionDir } = fixture();
    state.second = OTHER;
    const ctx = packageContext({
      stage: "CODE_REVIEW" as never,
      diff: "diff", changedFiles: [], activeLenses: ["security"],
      ticketDescription: "t", projectRoot: root, tokenBudgetPerLens: 10_000,
      sessionDir, sessionId: "sess-1", roundNum: 3,
    });
    expect(ctx.projectRules).toContain(CONTRACT);
    expect(ctx.projectRules).not.toContain(OTHER);

    const [rec] = readContractDeliveries(sessionDir).entries;
    expect(rec).toBeDefined();
    expect(rec!.contentHash).toBe(hashOf(CONTRACT));
    expect(rec!.contentHash).not.toBe(hashOf(OTHER));
    expect(rec!.sourceChars).toBe(CONTRACT.length);
  });
});
