/**
 * ISS-760: lens verification gate degraded mode.
 *
 * (a) A per-entry snapshot failure (unreadable file, directory, escaping
 *     symlink) must NOT abort the whole review snapshot. Every READABLE entry
 *     is snapshotted, the failures are recorded in the manifest's failedPaths,
 *     and the verification gate RUNS against the partial snapshot -- so a
 *     fabricated quote against a snapshotted file is still rejected instead
 *     of flowing to the merger unverified. Telemetry distinguishes
 *     gate-ran-degraded from gate-skipped, and the round still classifies as
 *     lenses-unverified (it must not silently flip to lenses-verified).
 *
 * (b) The orchestrator secrets meta-finding must reach the merger. It is
 *     injected POST-verification-gate (its evidence quotes the redacted
 *     placeholder, which can never match the pre-redaction snapshot bytes, so
 *     pre-gate injection would be self-rejected) and is exempt from the
 *     verification counters.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handlePrepare,
  handleSynthesize,
} from "../../../src/autonomous/review-lenses/mcp-handlers.js";
import { writeReviewSnapshot } from "../../../src/autonomous/review-lenses/review-snapshot.js";
import { classifyLensReviewPath } from "../../../src/autonomous/review-verdict.js";

const sessionId = "c3c3c3c3-d4d4-e5e5-f6f6-a7a7a7a7a7a7";
const FILE = "src/target.ts";
const FILE_CONTENT = "const x = 1;\nconst y = 2;\nconst z = 3;\n";
const DIR_ENTRY = "src/adir";
const DIFF = `--- a/${FILE}\n+++ b/${FILE}\n@@ -1,2 +1,3 @@\n const x = 1;\n+const y = 2;\n const z = 3;\n`;

let projectRoot: string;
let sessionDir: string;

function makeFinding(file: string, code: string) {
  return {
    lens: "security",
    lensVersion: "security-v2",
    severity: "major",
    recommendedImpact: "needs-revision",
    category: "test",
    description: `Finding in ${file}`,
    file,
    line: 2,
    evidence: [{ file, startLine: 2, endLine: 2, code }],
    suggestedFix: null,
    confidence: 0.9,
    assumptions: null,
    requiresMoreContext: false,
  };
}

function makeSecretsMetaFinding() {
  return {
    lens: "orchestrator",
    lensVersion: "gate-v1",
    severity: "critical",
    recommendedImpact: "blocker",
    category: "hardcoded-secrets",
    description:
      "Detected potential secrets in diff. Lines redacted before passing to review lenses.",
    file: null,
    line: null,
    evidence: [
      { file: FILE, startLine: 1, endLine: 1, code: "[REDACTED -- potential secret]" },
    ],
    suggestedFix: "Remove secrets from source code. Use environment variables or a secrets manager.",
    confidence: 0.9,
    assumptions: null,
    requiresMoreContext: false,
  };
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "iss760-gate-"));
  mkdirSync(join(projectRoot, ".story"), { recursive: true });
  writeFileSync(join(projectRoot, ".story", "config.json"), JSON.stringify({ version: 2, recipeOverrides: {} }));
  sessionDir = join(projectRoot, ".story", "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, FILE), FILE_CONTENT);
  mkdirSync(join(projectRoot, DIR_ENTRY), { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

// ── (a) writer: partial snapshot with failedPaths ────────────────────

describe("writeReviewSnapshot degraded mode (ISS-760a)", () => {
  it("records a directory entry in failedPaths and snapshots the readable file", () => {
    const result = writeReviewSnapshot({
      projectRoot,
      sessionId,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: [FILE, DIR_ENTRY],
    });
    expect(result.manifest.files.map((f) => f.path)).toEqual([FILE]);
    expect(result.manifest.fileCount).toBe(1);
    expect(result.manifest.failedPaths).toEqual([DIR_ENTRY]);
    expect(existsSync(join(result.snapshotDir, FILE))).toBe(true);
  });

  it.skipIf(typeof process.geteuid === "function" && process.geteuid() === 0)(
    "records an unreadable (chmod 000) entry in failedPaths without aborting",
    () => {
      const unreadable = "src/locked.ts";
      writeFileSync(join(projectRoot, unreadable), "top secret\n");
      chmodSync(join(projectRoot, unreadable), 0o000);
      try {
        const result = writeReviewSnapshot({
          projectRoot,
          sessionId,
          reviewId: "code-review-r1",
          stage: "code-review",
          round: 1,
          files: [FILE, unreadable],
        });
        expect(result.manifest.files.map((f) => f.path)).toEqual([FILE]);
        expect(result.manifest.failedPaths).toEqual([unreadable]);
      } finally {
        chmodSync(join(projectRoot, unreadable), 0o644);
      }
    },
  );

  it("records an escaping symlink in failedPaths without snapshotting its target", () => {
    const external = join(mkdtempSync(join(tmpdir(), "iss760-ext-")), "outside.txt");
    writeFileSync(external, "secret");
    symlinkSync(external, join(projectRoot, "src", "escape-link.ts"));
    const result = writeReviewSnapshot({
      projectRoot,
      sessionId,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: [FILE, "src/escape-link.ts"],
    });
    expect(result.manifest.files.map((f) => f.path)).toEqual([FILE]);
    expect(result.manifest.failedPaths).toEqual(["src/escape-link.ts"]);
    expect(existsSync(join(result.snapshotDir, "src", "escape-link.ts"))).toBe(false);
  });
});

// ── (a) gate: runs degraded instead of skipping ──────────────────────

describe("verification gate runs degraded on a partial snapshot (ISS-760a)", () => {
  it("rejects a fabricated quote in the same round, records degraded telemetry, and stays lenses-unverified", () => {
    const prep = handlePrepare({
      stage: "CODE_REVIEW",
      diff: DIFF,
      changedFiles: [FILE, DIR_ENTRY],
      ticketDescription: "Add y",
      reviewRound: 1,
      projectRoot,
      sessionId,
    });

    // The partial snapshot EXISTS under the contract-keyed reviewId.
    expect(prep.metadata.reviewId).toBe("code-review-r1");
    const manifestPath = join(sessionDir, "review-snapshot", "code-review-r1", "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.failedPaths).toContain(DIR_ENTRY);
    expect(manifest.files.map((f: { path: string }) => f.path)).toContain(FILE);

    const output = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: [{
        lens: "security",
        status: "complete",
        findings: [
          makeFinding(FILE, "const y = 999;"), // fabricated quote -> rejected
          makeFinding(FILE, "const y = 2;"),   // real quote -> verified
          makeFinding(DIR_ENTRY, "anything"),  // cites a failed path -> rejected
        ],
      }],
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
      changedFiles: [FILE, DIR_ENTRY],
    });

    // Gate RAN (degraded), did not skip: fabricated evidence is rejected.
    expect(output.verificationSkipped).toBe(false);
    expect(output.snapshotIntegrityFailure).toBe(false);
    expect(output.verificationDegraded).toBe(true);
    expect(output.verificationCounters.proposed).toBe(3);
    expect(output.verificationCounters.verified).toBe(1);
    expect(output.verificationCounters.rejected).toBe(2);

    // Telemetry distinguishes gate-ran-degraded from skipped.
    const telemetry = readFileSync(join(sessionDir, "verification-telemetry.jsonl"), "utf-8")
      .trim().split("\n").map((l) => JSON.parse(l));
    const entry = telemetry.findLast((e) => e.reviewId === prep.metadata.reviewId);
    expect(entry.verificationSkipped).toBe(false);
    expect(entry.verificationDegraded).toBe(true);

    // The round REMAINS lenses-unverified (as it is today via the skip path);
    // degraded-ran must not silently flip it to lenses-verified.
    expect(classifyLensReviewPath(sessionDir, prep.metadata.reviewId)).toBe("lenses-unverified");
  });
});

// ── (b) secrets meta-finding reaches the merger ──────────────────────

describe("secrets meta-finding injection (ISS-760b)", () => {
  it("prepare metadata carries the secretsMetaFinding field (null when the gate did not fire)", () => {
    const prep = handlePrepare({
      stage: "CODE_REVIEW",
      diff: DIFF,
      changedFiles: [FILE],
      ticketDescription: "Add y",
      reviewRound: 1,
      projectRoot,
      sessionId,
    });
    expect("secretsMetaFinding" in prep.metadata).toBe(true);
    expect(prep.metadata.secretsMetaFinding).toBeNull();
  });

  it("synthesize injects the meta-finding post-gate into the merger findings, exempt from counters", () => {
    const prep = handlePrepare({
      stage: "CODE_REVIEW",
      diff: DIFF,
      changedFiles: [FILE],
      ticketDescription: "Add y",
      reviewRound: 1,
      projectRoot,
      sessionId,
    });

    const output = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: [{ lens: "security", status: "complete", findings: [makeFinding(FILE, "const y = 2;")] }],
      metadata: {
        activeLenses: ["security"],
        skippedLenses: [],
        reviewRound: 1,
        reviewId: prep.metadata.reviewId,
        secretsMetaFinding: makeSecretsMetaFinding(),
      },
      projectRoot,
      sessionId,
      sessionDir,
      diff: DIFF,
      changedFiles: [FILE],
    });

    // The gate RAN (real snapshot) and the meta-finding survived it: its
    // redacted evidence would have been self-rejected pre-gate.
    expect(output.verificationSkipped).toBe(false);
    expect(output.validatedFindings.some((f) => f.issueKey === "orchestrator:hardcoded-secrets:gate")).toBe(true);
    expect(output.mergerPrompt).toContain("hardcoded-secrets");

    // Exempt from verification counters and from pre-existing filing.
    expect(output.verificationCounters.proposed).toBe(1);
    expect(output.verificationCounters.verified).toBe(1);
    expect(output.verificationCounters.rejected).toBe(0);
    expect(output.preExistingFindings.some((f) => f.category === "hardcoded-secrets")).toBe(false);
  });

  it("synthesize falls back to the prepare-persisted meta-finding when metadata does not echo it", () => {
    // Simulate what handlePrepare persists when the secrets gate fires (the
    // MCP metadata round-trip flattens fields, so synthesize reads this file).
    writeFileSync(
      join(sessionDir, "secrets-meta-finding.json"),
      JSON.stringify({ reviewId: "code-review-r1", metaFinding: makeSecretsMetaFinding() }),
    );

    const prep = handlePrepare({
      stage: "CODE_REVIEW",
      diff: DIFF,
      changedFiles: [FILE],
      ticketDescription: "Add y",
      reviewRound: 1,
      projectRoot,
      sessionId,
    });
    expect(prep.metadata.reviewId).toBe("code-review-r1");

    const output = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: [{ lens: "security", status: "complete", findings: [makeFinding(FILE, "const y = 2;")] }],
      metadata: { activeLenses: ["security"], skippedLenses: [], reviewRound: 1, reviewId: prep.metadata.reviewId },
      projectRoot,
      sessionId,
      sessionDir,
      diff: DIFF,
      changedFiles: [FILE],
    });
    expect(output.validatedFindings.some((f) => f.issueKey === "orchestrator:hardcoded-secrets:gate")).toBe(true);
  });

  it("a persisted meta-finding for a DIFFERENT reviewId is not injected", () => {
    writeFileSync(
      join(sessionDir, "secrets-meta-finding.json"),
      JSON.stringify({ reviewId: "code-review-r99", metaFinding: makeSecretsMetaFinding() }),
    );

    const prep = handlePrepare({
      stage: "CODE_REVIEW",
      diff: DIFF,
      changedFiles: [FILE],
      ticketDescription: "Add y",
      reviewRound: 1,
      projectRoot,
      sessionId,
    });

    const output = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: [{ lens: "security", status: "complete", findings: [makeFinding(FILE, "const y = 2;")] }],
      metadata: { activeLenses: ["security"], skippedLenses: [], reviewRound: 1, reviewId: prep.metadata.reviewId },
      projectRoot,
      sessionId,
      sessionDir,
      diff: DIFF,
      changedFiles: [FILE],
    });
    expect(output.validatedFindings.some((f) => f.issueKey === "orchestrator:hardcoded-secrets:gate")).toBe(false);
  });
});
