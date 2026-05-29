/**
 * ISS-714 integration: prepare writes a contract-keyed review snapshot, and the
 * synthesize verification gate then actually verifies findings against it.
 *
 * Before this fix the gate was inert in production: prepare never wrote a
 * snapshot and minted a lens-<ts> reviewId that the snapshot reader rejected,
 * so synthesize always reported snapshotIntegrityFailure and verified=0. These
 * tests assert the end-to-end happy path now works: prepare returns a
 * <stage>-r<round> reviewId, writes the snapshot, and synthesize verifies a
 * matching finding (verified>=1) and rejects a quote that drifts from the
 * snapshot.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handlePrepare,
  handleSynthesize,
} from "../../../src/autonomous/review-lenses/mcp-handlers.js";

let projectRoot: string;
const sessionId = "b1b1b1b1-c2c2-d3d3-e4e4-f5f5f5f5f5f5";

const FILE = "src/target.ts";
const FILE_CONTENT = "const x = 1;\nconst y = 2;\nconst z = 3;\n";
const DIFF = `--- a/${FILE}\n+++ b/${FILE}\n@@ -1,2 +1,3 @@\n const x = 1;\n+const y = 2;\n const z = 3;\n`;

function makeFinding(code: string) {
  return {
    lens: "security",
    lensVersion: "security-v2",
    severity: "major",
    recommendedImpact: "needs-revision",
    category: "test",
    description: "Finding about the assignment",
    file: FILE,
    line: 2,
    evidence: [{ file: FILE, startLine: 2, endLine: 2, code }],
    suggestedFix: null,
    confidence: 0.9,
    assumptions: null,
    requiresMoreContext: false,
  };
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "iss714-wiring-"));
  mkdirSync(join(projectRoot, ".story"), { recursive: true });
  writeFileSync(join(projectRoot, ".story", "config.json"), JSON.stringify({ version: 2, recipeOverrides: {} }));
  mkdirSync(join(projectRoot, ".story", "sessions", sessionId), { recursive: true });
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, FILE), FILE_CONTENT);
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("prepare -> synthesize snapshot wiring (ISS-714)", () => {
  it("prepare returns a <stage>-r<round> reviewId and writes the snapshot", () => {
    const out = handlePrepare({
      stage: "CODE_REVIEW",
      diff: DIFF,
      changedFiles: [FILE],
      ticketDescription: "Add y",
      reviewRound: 1,
      projectRoot,
      sessionId,
    });

    expect(out.metadata.reviewId).toBe("code-review-r1");
    const manifest = join(projectRoot, ".story", "sessions", sessionId, "review-snapshot", "code-review-r1", "manifest.json");
    expect(existsSync(manifest)).toBe(true);
  });

  it("synthesize verifies a matching finding against the snapshot prepare wrote", () => {
    const prep = handlePrepare({
      stage: "CODE_REVIEW",
      diff: DIFF,
      changedFiles: [FILE],
      ticketDescription: "Add y",
      reviewRound: 1,
      projectRoot,
      sessionId,
    });

    const sessionDir = join(projectRoot, ".story", "sessions", sessionId);
    const output = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: [{ lens: "security", status: "complete", findings: [makeFinding("const y = 2;")] }],
      metadata: {
        activeLenses: ["security"],
        skippedLenses: [],
        reviewRound: 1,
        reviewId: prep.metadata.reviewId,
      },
      projectRoot,
      sessionId,
      sessionDir,
      diff: DIFF,
      changedFiles: [FILE],
    });

    // The gate ran (not skipped, no integrity failure) and verified the finding.
    expect(output.snapshotIntegrityFailure).toBe(false);
    expect(output.verificationSkipped).toBe(false);
    expect(output.verificationCounters.proposed).toBe(1);
    expect(output.verificationCounters.verified).toBe(1);
    expect(output.verificationCounters.rejected).toBe(0);
  });

  it("synthesize rejects a finding whose quote drifts from the snapshot", () => {
    const prep = handlePrepare({
      stage: "CODE_REVIEW",
      diff: DIFF,
      changedFiles: [FILE],
      ticketDescription: "Add y",
      reviewRound: 1,
      projectRoot,
      sessionId,
    });

    const sessionDir = join(projectRoot, ".story", "sessions", sessionId);
    const output = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: [{ lens: "security", status: "complete", findings: [makeFinding("const y = 999;")] }],
      metadata: {
        activeLenses: ["security"],
        skippedLenses: [],
        reviewRound: 1,
        reviewId: prep.metadata.reviewId,
      },
      projectRoot,
      sessionId,
      sessionDir,
      diff: DIFF,
      changedFiles: [FILE],
    });

    expect(output.snapshotIntegrityFailure).toBe(false);
    expect(output.verificationSkipped).toBe(false);
    expect(output.verificationCounters.proposed).toBe(1);
    expect(output.verificationCounters.verified).toBe(0);
    expect(output.verificationCounters.rejected).toBe(1);
  });

  it("re-running prepare after content changes writes a fresh slot, never verifying against stale bytes (ISS-714)", () => {
    const sessionDir = join(projectRoot, ".story", "sessions", sessionId);

    // First prepare snapshots the original content at r1.
    const prep1 = handlePrepare({
      stage: "CODE_REVIEW", diff: DIFF, changedFiles: [FILE],
      ticketDescription: "Add y", reviewRound: 1, projectRoot, sessionId,
    });
    expect(prep1.metadata.reviewId).toBe("code-review-r1");

    // The reviewed file changes, but the agent re-runs prepare for the SAME round.
    writeFileSync(join(projectRoot, FILE), "const x = 1;\nconst y = 42;\nconst z = 3;\n");

    const prep2 = handlePrepare({
      stage: "CODE_REVIEW", diff: DIFF, changedFiles: [FILE],
      ticketDescription: "Add y", reviewRound: 1, projectRoot, sessionId,
    });
    // A fresh slot is allocated rather than reusing the immutable r1 snapshot.
    expect(prep2.metadata.reviewId).toBe("code-review-r2");

    // Synthesize against the fresh snapshot: a finding quoting the NEW content
    // verifies (it would have been rejected against the stale r1 bytes).
    const output = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: [{ lens: "security", status: "complete", findings: [makeFinding("const y = 42;")] }],
      metadata: { activeLenses: ["security"], skippedLenses: [], reviewRound: 1, reviewId: prep2.metadata.reviewId },
      projectRoot, sessionId, sessionDir, diff: DIFF, changedFiles: [FILE],
    });

    expect(output.snapshotIntegrityFailure).toBe(false);
    expect(output.verificationSkipped).toBe(false);
    expect(output.verificationCounters.verified).toBe(1);
    expect(output.verificationCounters.rejected).toBe(0);
  });

  it("verifies a lens finding on a newly-added file that is in the diff but omitted from changedFiles (ISS-722)", () => {
    // Real CODE_REVIEW flow: the agent builds changedFiles via `git diff --name-only`
    // (which omits an untracked/new file), while the diff handed to the lenses DOES
    // include it. The new file must still be snapshotted so a finding quoting it
    // verifies instead of being silently dropped as file_not_snapshotted.
    const NEW_FILE = "src/added.ts";
    writeFileSync(join(projectRoot, NEW_FILE), "const a = 1;\nconst b = 2;\n");
    const newFileDiff = `--- /dev/null\n+++ b/${NEW_FILE}\n@@ -0,0 +1,2 @@\n+const a = 1;\n+const b = 2;\n`;
    const combinedDiff = DIFF + newFileDiff;

    const prep = handlePrepare({
      stage: "CODE_REVIEW",
      diff: combinedDiff,
      changedFiles: [FILE], // NEW_FILE intentionally omitted -- name-only misses untracked files
      ticketDescription: "Add a file",
      reviewRound: 1,
      projectRoot,
      sessionId,
    });
    expect(prep.metadata.reviewId).toBe("code-review-r1");

    const sessionDir = join(projectRoot, ".story", "sessions", sessionId);
    const newFileFinding = {
      lens: "security",
      lensVersion: "security-v2",
      severity: "major",
      recommendedImpact: "needs-revision",
      category: "test",
      description: "Finding on the newly-added file",
      file: NEW_FILE,
      line: 1,
      evidence: [{ file: NEW_FILE, startLine: 1, endLine: 1, code: "const a = 1;" }],
      suggestedFix: null,
      confidence: 0.9,
      assumptions: null,
      requiresMoreContext: false,
    };

    const output = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: [{ lens: "security", status: "complete", findings: [newFileFinding] }],
      metadata: { activeLenses: ["security"], skippedLenses: [], reviewRound: 1, reviewId: prep.metadata.reviewId },
      projectRoot,
      sessionId,
      sessionDir,
      diff: combinedDiff,
      changedFiles: [FILE],
    });

    // After ISS-722 the new file is snapshotted (its path comes from the diff), so the
    // finding verifies. Before the fix it hit file_not_snapshotted -> rejected -> dropped.
    expect(output.snapshotIntegrityFailure).toBe(false);
    expect(output.verificationSkipped).toBe(false);
    expect(output.verificationCounters.proposed).toBe(1);
    expect(output.verificationCounters.verified).toBe(1);
    expect(output.verificationCounters.rejected).toBe(0);
  });

  it("falls back to a non-addressable reviewId when the fresh-slot write produces nothing, so the gate skips rather than loading a stale snapshot (ISS-714)", () => {
    const sessionDir = join(projectRoot, ".story", "sessions", sessionId);

    // First prepare writes a real r1 snapshot of the existing file.
    const prep1 = handlePrepare({
      stage: "CODE_REVIEW", diff: DIFF, changedFiles: [FILE],
      ticketDescription: "Add y", reviewRound: 1, projectRoot, sessionId,
    });
    expect(prep1.metadata.reviewId).toBe("code-review-r1");

    // Re-prepare for the same round with NO snapshottable file. Both changedFiles
    // AND the diff reference a non-existent file, so the ISS-722 union of
    // (changedFiles + diff paths) still has nothing on disk to snapshot and the
    // fresh-slot write produces nothing.
    const ghostDiff = `--- a/src/does-not-exist.ts\n+++ b/src/does-not-exist.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n`;
    const prep2 = handlePrepare({
      stage: "CODE_REVIEW", diff: ghostDiff, changedFiles: ["src/does-not-exist.ts"],
      ticketDescription: "Add y", reviewRound: 1, projectRoot, sessionId,
    });
    // The reviewId must NOT be the round-based id (which would resolve to the
    // stale r1 snapshot); it is a non-addressable lens-<ts> id.
    expect(prep2.metadata.reviewId).not.toMatch(/^code-review-r\d+$/);

    const output = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: [{ lens: "security", status: "complete", findings: [makeFinding("const y = 2;")] }],
      metadata: { activeLenses: ["security"], skippedLenses: [], reviewRound: 1, reviewId: prep2.metadata.reviewId },
      projectRoot, sessionId, sessionDir, diff: ghostDiff, changedFiles: ["src/does-not-exist.ts"],
    });

    // Gate skips (no addressable snapshot) rather than verifying against stale r1.
    expect(output.verificationSkipped).toBe(true);
    expect(output.snapshotIntegrityFailure).toBe(false);
  });
});
