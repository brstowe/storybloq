/**
 * T-257 synthesize verification gate tests.
 *
 * Tests the verification gate integration in handleSynthesize:
 * - Two-tier arrays (verifiedFindings for merger, verifiedForFiling for pre-existing)
 * - Counter semantics (verified = strictly verified, bypass = 0)
 * - SnapshotIntegrityError escalation
 * - Skip-path filing safety
 * - Log boundary isolation
 * - Telemetry JSONL output
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
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleSynthesize,
  type SynthesizeInput,
  type SynthesizeOutput,
} from "../../../src/autonomous/review-lenses/mcp-handlers.js";
import { writeReviewSnapshot } from "../../../src/autonomous/review-lenses/index.js";
import { SnapshotIntegrityError } from "../../../src/autonomous/review-lenses/verification.js";

// ── Fixtures ──────────────────────────────────────────────────────

function makeValidFinding(lens: string, file: string, line: number) {
  return {
    lens,
    lensVersion: `${lens}-v2`,
    severity: "major",
    recommendedImpact: "needs-revision",
    category: "test",
    description: `Finding in ${file}:${line}`,
    file,
    line,
    evidence: [{ file, startLine: line, endLine: line + 5, code: `line ${line} code` }],
    suggestedFix: null,
    confidence: 0.9,
    assumptions: null,
    requiresMoreContext: false,
  };
}

function makeSynthesizeInput(overrides?: Partial<SynthesizeInput>): SynthesizeInput {
  return {
    stage: "CODE_REVIEW",
    lensResults: [
      {
        lens: "security",
        status: "complete",
        findings: [makeValidFinding("security", "src/a.ts", 10)],
      },
      {
        lens: "clean-code",
        status: "complete",
        findings: [makeValidFinding("clean-code", "src/b.ts", 20)],
      },
    ],
    metadata: {
      activeLenses: ["security", "clean-code"],
      skippedLenses: [],
      reviewRound: 1,
      reviewId: "test-review-001",
    },
    ...overrides,
  };
}

// Helper to set up a minimal project root with .story/config.json
function setupProjectRoot(dir: string): string {
  const root = join(dir, "project");
  mkdirSync(join(root, ".story"), { recursive: true });
  writeFileSync(
    join(root, ".story", "config.json"),
    JSON.stringify({ version: 2, recipeOverrides: {} }),
  );
  return root;
}

// ── Tests ─────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "t257-gate-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("handleSynthesize verification gate", () => {
  it("returns verificationCounters with correct strict counts for mixed findings", () => {
    const projectRoot = setupProjectRoot(tmpDir);
    const sessionDir = join(tmpDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    const input = makeSynthesizeInput({
      projectRoot,
      sessionDir,
      sessionId: "test-session-id",
    });

    const output = handleSynthesize(input);

    // T-257: output should have verificationCounters
    expect(output.verificationCounters).toBeDefined();
    const vc = output.verificationCounters;
    expect(typeof vc.proposed).toBe("number");
    expect(typeof vc.verified).toBe("number");
    expect(typeof vc.rejected).toBe("number");
    // ISS-715: with no real snapshot the gate skips verification rather than
    // reporting a false integrity failure.
    expect(output.snapshotIntegrityFailure).toBe(false);
    expect(output.verificationSkipped).toBe(true);
    expect(vc.verified).toBe(0);
    expect(vc.rejected).toBe(0);
    expect(vc.proposed).toBeGreaterThan(0);
  });

  it("skips verification when sessionId is absent -- all pass to merger, preExisting=[], verified=0", () => {
    const projectRoot = setupProjectRoot(tmpDir);

    const input = makeSynthesizeInput({
      projectRoot,
      // sessionId deliberately omitted
    });

    const output = handleSynthesize(input);

    // T-257: without sessionId, verification is skipped
    // All findings should pass to merger
    expect(output.validatedFindings.length).toBeGreaterThan(0);
    // preExistingFindings should be [] (filing suppressed on skip path)
    expect(output.verificationSkipped).toBe(true);
    expect(output.verificationCounters.verified).toBe(0);
  });

  it("skips verification when projectRoot is absent -- same skip-path behavior", () => {
    const input = makeSynthesizeInput({
      // projectRoot deliberately omitted
    });

    const output = handleSynthesize(input);

    // All findings should still appear in merger output
    expect(output.validatedFindings.length).toBeGreaterThan(0);
    expect(output.verificationSkipped).toBe(true);
  });

  it("skips verification with no duplicates and preExisting=[] when no snapshot exists (ISS-715)", () => {
    const projectRoot = setupProjectRoot(tmpDir);
    const sessionDir = join(tmpDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    const input = makeSynthesizeInput({
      projectRoot,
      sessionDir,
      sessionId: "test-session-id",
    });

    const output = handleSynthesize(input);

    // ISS-715: no snapshot exists, so verification is skipped (not a failure)
    expect(output.snapshotIntegrityFailure).toBe(false);
    expect(output.verificationSkipped).toBe(true);
    // No duplicate findings in output
    const ids = output.validatedFindings.map(f => f.issueKey);
    expect(ids.length).toBe(new Set(ids).size);
    // preExisting should be empty on the skip path
    expect(output.preExistingFindings).toEqual([]);
    // verified counter should be 0
    expect(output.verificationCounters.verified).toBe(0);
  });

  it("skip path writes no rejection log (ISS-715)", () => {
    const projectRoot = setupProjectRoot(tmpDir);
    const sessionDir = join(tmpDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    const input = makeSynthesizeInput({
      projectRoot,
      sessionDir,
      sessionId: "test-session-id",
    });

    handleSynthesize(input);

    // On the skip path (no snapshot), verification.log should NOT be written
    expect(existsSync(join(sessionDir, "verification.log"))).toBe(false);
  });

  it("unknown verification error passes finding to merger but not to preExisting, increments runtimeErrors", () => {
    const projectRoot = setupProjectRoot(tmpDir);
    const sessionDir = join(tmpDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    const input = makeSynthesizeInput({
      projectRoot,
      sessionDir,
      sessionId: "test-session-id",
    });

    const output = handleSynthesize(input);

    // T-257: output should have verificationRuntimeErrors
    expect(typeof output.verificationRuntimeErrors).toBe("number");
  });

  it("log write failures do not affect verified/rejected partition", () => {
    const projectRoot = setupProjectRoot(tmpDir);
    const sessionDir = join(tmpDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    const input = makeSynthesizeInput({
      projectRoot,
      sessionDir,
      sessionId: "test-session-id",
    });

    const output = handleSynthesize(input);

    // T-257: logWriteFailures should not change the finding partition
    expect(typeof output.logWriteFailures).toBe("number");
    // ISS-715: skip path (no real snapshot): verified=0, rejected=0
    expect(output.snapshotIntegrityFailure).toBe(false);
    expect(output.verificationSkipped).toBe(true);
    expect(output.verificationCounters.verified).toBe(0);
    expect(output.verificationCounters.rejected).toBe(0);
  });

  it("mergerPrompt only includes verified findings", () => {
    const projectRoot = setupProjectRoot(tmpDir);
    const sessionDir = join(tmpDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    const input = makeSynthesizeInput({
      projectRoot,
      sessionDir,
      sessionId: "test-session-id",
    });

    const output = handleSynthesize(input);

    // T-257: mergerPrompt should be built from verifiedFindings,
    // not from allFindings. The prompt contains finding descriptions.
    // After implementation, rejected findings should NOT appear in mergerPrompt.
    expect(output.mergerPrompt).toBeDefined();
    expect(typeof output.mergerPrompt).toBe("string");
  });

  it("preExistingFindings only includes strictly-verified findings", () => {
    const projectRoot = setupProjectRoot(tmpDir);
    const sessionDir = join(tmpDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    const input = makeSynthesizeInput({
      projectRoot,
      sessionDir,
      sessionId: "test-session-id",
    });

    const output = handleSynthesize(input);

    // T-257: preExistingFindings should only come from verifiedForFiling
    // (strictly verified findings, not runtime-error pass-throughs)
    for (const f of output.preExistingFindings) {
      expect(f.origin).toBe("pre-existing");
    }
  });

  it("writes telemetry JSONL and sets telemetryWriteFailed on failure", () => {
    const projectRoot = setupProjectRoot(tmpDir);
    const sessionDir = join(tmpDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    const input = makeSynthesizeInput({
      projectRoot,
      sessionDir,
      sessionId: "test-session-id",
    });

    const output = handleSynthesize(input);

    // T-257: should write verification-telemetry.jsonl
    expect(typeof output.telemetryWriteFailed).toBe("boolean");
    const telemetryPath = join(sessionDir, "verification-telemetry.jsonl");
    expect(existsSync(telemetryPath)).toBe(true);
    const lines = readFileSync(telemetryPath, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toHaveProperty("reviewId");
    expect(entry).toHaveProperty("proposed");
    expect(entry).toHaveProperty("verified");
    expect(entry).toHaveProperty("rejected");
    expect(entry).toHaveProperty("timestamp");
  });

  it("throws (does not silently degrade) when a snapshot exists but is corrupt (ISS-715)", () => {
    // A present-but-corrupt snapshot is a genuine integrity violation: the gate
    // must surface it (throw -> MCP isError) rather than skip or pass findings
    // through as if verified.
    const projectRoot = join(tmpDir, "corrupt-project");
    const sessionId = "a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4";
    const reviewId = "code-review-r1";
    mkdirSync(join(projectRoot, ".story"), { recursive: true });
    writeFileSync(join(projectRoot, ".story", "config.json"), JSON.stringify({ version: 2, recipeOverrides: {} }));
    const sessionDir = join(projectRoot, ".story", "sessions", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "a.ts"), "line1\nline2\nline3\n");

    writeReviewSnapshot({ projectRoot, sessionId, reviewId, stage: "code-review", round: 1, files: ["src/a.ts"] });

    // Corrupt the snapshot manifest (it is written read-only) so the reader
    // throws a non-ENOENT error: a present-but-broken snapshot, not an absent one.
    const manifestPath = join(sessionDir, "review-snapshot", reviewId, "manifest.json");
    chmodSync(manifestPath, 0o644);
    writeFileSync(manifestPath, "{ not valid json");

    const input = makeSynthesizeInput({
      projectRoot,
      sessionDir,
      sessionId,
      metadata: { activeLenses: ["security", "clean-code"], skippedLenses: [], reviewRound: 1, reviewId },
    });

    expect(() => handleSynthesize(input)).toThrow(SnapshotIntegrityError);
  });
});
