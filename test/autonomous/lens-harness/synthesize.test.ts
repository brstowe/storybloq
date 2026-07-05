/**
 * ISS-823 synthesize harness (pen rulings R2/R4/R6).
 *
 * synthesize collects raw lens outputs, parses them at the LensOutputSchema
 * boundary (mirroring the server's phase classification), builds the exact-set
 * lensCoverage disclosure, and runs the package merger pipeline
 * programmatically with T-026 anchoring. It returns the package ReviewVerdict:
 * no merger prompt, no LLM hop. Consumer add-ons preserved: origin
 * classification for pre-existing filing, anchoring telemetry in the legacy
 * log shapes (R4), and the review-progress.json display projection (R6).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSynthesize } from "../../../src/autonomous/lens-harness/synthesize.js";
import { getFromCache } from "../../../src/autonomous/lens-harness/cache.js";

const DIFF = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 0000000..1111111 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,3 +1,4 @@",
  " export function greet(name: string): string {",
  '+  console.log("debug");',
  '   return "hello " + name;',
  " }",
  "",
].join("\n");

const CORE = ["security", "error-handling", "clean-code", "concurrency"] as const;

function okOutput(findings: unknown[] = []) {
  return { status: "ok", findings, error: null, notes: null };
}

function coreResults(overrides: Record<string, unknown> = {}) {
  return CORE.map((lens) => ({
    lens,
    output: lens in overrides ? overrides[lens] : okOutput(),
  }));
}

const META = {
  activeLenses: [...CORE],
  skippedLenses: ["performance", "api-design", "test-quality", "accessibility", "data-safety"],
  reviewRound: 1,
  reviewId: "lens-test1",
};

let root: string;
let sessionDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lens-harness-synth-"));
  sessionDir = join(root, ".story", "sessions", "sess-1");
  mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("handleSynthesize (programmatic merger pipeline)", () => {
  it("returns a schema-valid ReviewVerdict with exact-set lens coverage", () => {
    const out = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: coreResults({
        "error-handling": okOutput([
          {
            id: "eh-1",
            severity: "major",
            category: "unchecked-error",
            file: "src/example.ts",
            line: 2,
            snippet: { quote: 'console.log("debug");', startLine: 2 },
            description: "debug logging left in",
            suggestion: "remove it",
            confidence: 0.9,
          },
        ]),
      }),
      metadata: META,
      projectRoot: root,
      sessionDir,
      sessionId: "sess-1",
      diff: DIFF,
      changedFiles: ["src/example.ts"],
    });

    expect(out.reviewVerdict.verdict).toBe("revise");
    expect(out.reviewVerdict.major).toBe(1);
    expect(out.reviewVerdict.coverage).toBe("full");
    const covered = out.reviewVerdict.lensCoverage.map((e) => e.lensId).sort();
    expect(covered).toEqual([...CORE].sort());
    expect(out.lensesCompleted.sort()).toEqual([...CORE].sort());
    expect(out.lensesFailed).toEqual([]);

    // R4: anchoring telemetry lands in verification-telemetry.jsonl keyed by
    // reviewId, in the legacy field shape.
    const telemetry = readFileSync(join(sessionDir, "verification-telemetry.jsonl"), "utf-8");
    const entry = JSON.parse(telemetry.trim().split("\n").at(-1)!);
    expect(entry.reviewId).toBe("lens-test1");
    expect(entry.proposed).toBe(1);
    expect(entry.verificationSkipped).toBe(false);
    expect(entry.rejected).toBe(0);

    // R6: review-progress.json display projection with legacy fields.
    const progress = JSON.parse(readFileSync(join(sessionDir, "review-progress.json"), "utf-8"));
    expect(progress.reviewId).toBe("lens-test1");
    expect(progress.verdict).toBe("revise");
    expect(progress.isPartial).toBe(false);
    expect(progress.lensesCompleted.sort()).toEqual([...CORE].sort());
    expect(progress.totalFindings).toBe(1);
  });

  it("defers an unverifiable low-severity finding via T-026 anchoring", () => {
    const out = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: coreResults({
        "clean-code": okOutput([
          {
            id: "cc-1",
            severity: "minor",
            category: "naming",
            file: "src/example.ts",
            line: 2,
            snippet: { quote: "this line is not in the diff at all", startLine: 2 },
            description: "bad name",
            suggestion: "rename",
            confidence: 0.7,
          },
        ]),
      }),
      metadata: META,
      projectRoot: root,
      sessionDir,
      sessionId: "sess-1",
      diff: DIFF,
      changedFiles: ["src/example.ts"],
    });

    expect(out.reviewVerdict.evidenceUnverifiedCount).toBe(1);
    expect(out.reviewVerdict.deferred).toHaveLength(1);
    expect(out.reviewVerdict.deferred[0]!.reason).toBe("evidence_unverified");
    expect(out.reviewVerdict.findings).toHaveLength(0);

    // R4: the deferral is recorded in the legacy rejection log.
    const log = readFileSync(join(sessionDir, "verification.log"), "utf-8");
    const line = JSON.parse(log.trim().split("\n")[0]!);
    expect(line.reasonCode).toBe("evidence_unverified");
    expect(line.lens).toBe("clean-code");
  });

  it("caps the verdict below approve when a core lens is missing", () => {
    const out = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: coreResults().filter((r) => r.lens !== "concurrency"),
      metadata: META,
      projectRoot: root,
      sessionDir,
      sessionId: "sess-1",
      diff: DIFF,
      changedFiles: ["src/example.ts"],
    });
    expect(out.reviewVerdict.verdict).toBe("revise");
    expect(out.reviewVerdict.coverage).toBe("partial");
    const conc = out.reviewVerdict.lensCoverage.find((e) => e.lensId === "concurrency");
    expect(conc?.status).toBe("error");
    expect(out.lensesFailed).toContain("concurrency");
  });

  it("classifies an unparseable lens payload as parse_failed with a parse error", () => {
    const out = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: coreResults({ security: { nonsense: true } }),
      metadata: META,
      projectRoot: root,
      sessionDir,
      sessionId: "sess-1",
      diff: DIFF,
      changedFiles: ["src/example.ts"],
    });
    expect(out.reviewVerdict.parseErrors.length).toBeGreaterThan(0);
    expect(out.reviewVerdict.parseErrors[0]!.lensId).toBe("security");
    const sec = out.reviewVerdict.lensCoverage.find((e) => e.lensId === "security");
    expect(sec?.status).toBe("parse_failed");
    // security is core -> approve capped
    expect(out.reviewVerdict.verdict).toBe("revise");
  });

  it("classifies pre-existing findings for filing without mutating the verdict findings", () => {
    const out = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: coreResults({
        security: okOutput([
          {
            id: "sec-1",
            severity: "major",
            category: "injection-risk",
            file: "src/legacy.ts",
            line: 40,
            description: "pre-existing injection risk in untouched file",
            suggestion: "parameterize",
            confidence: 0.9,
          },
        ]),
      }),
      metadata: META,
      projectRoot: root,
      sessionDir,
      sessionId: "sess-1",
      diff: DIFF,
      changedFiles: ["src/example.ts"],
    });
    expect(out.preExistingCount).toBe(1);
    expect(out.preExistingFindings[0]!.file).toBe("src/legacy.ts");
    // Pre-existing findings still flow through the verdict untouched.
    expect(out.reviewVerdict.findings.some((f) => f.file === "src/legacy.ts")).toBe(true);
  });

  it("injects the secrets meta-finding as a blocking orchestrator finding", () => {
    const out = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: coreResults(),
      metadata: {
        ...META,
        secretsMetaFinding: {
          id: "orchestrator-secrets-gate",
          severity: "blocking",
          category: "hardcoded-secrets",
          file: null,
          line: null,
          description: "Detected potential secrets in the diff.",
          suggestion: "Remove secrets from source control.",
          confidence: 0.9,
        },
      },
      projectRoot: root,
      sessionDir,
      sessionId: "sess-1",
      diff: DIFF,
      changedFiles: ["src/example.ts"],
    });
    expect(out.reviewVerdict.verdict).toBe("reject");
    expect(out.reviewVerdict.blocking).toBe(1);
    expect(
      out.reviewVerdict.findings.some((f) => f.category === "hardcoded-secrets"),
    ).toBe(true);
    // Exact-set contract: the injected finding's lens (security) must carry a
    // coverage entry that reflects its contribution.
    const sec = out.reviewVerdict.lensCoverage.find((e) => e.lensId === "security");
    expect(sec).toBeDefined();
    expect(sec!.status).toBe("ok");
    expect(sec!.contributedFindings).toBeGreaterThanOrEqual(1);
  });

  it("adds a coverage entry for the injected secrets lens even when security is not active", () => {
    // Explicit allow-list style: security is not in the active set. The
    // injected orchestrator finding must still get an exact-set coverage entry
    // so runMergerPipeline never sees a finding with no coverage.
    const activeNoSecurity = ["error-handling", "clean-code", "concurrency"] as const;
    const out = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: activeNoSecurity.map((lens) => ({ lens, output: okOutput() })),
      metadata: {
        activeLenses: [...activeNoSecurity],
        skippedLenses: ["security", "performance", "api-design", "test-quality", "accessibility", "data-safety"],
        reviewRound: 1,
        reviewId: "lens-nosec",
        secretsMetaFinding: {
          id: "orchestrator-secrets-gate",
          severity: "blocking",
          category: "hardcoded-secrets",
          file: null,
          line: null,
          description: "Detected potential secrets in the diff.",
          suggestion: "Remove secrets from source control.",
          confidence: 0.9,
        },
      },
      projectRoot: root,
      sessionDir,
      sessionId: "sess-1",
      diff: DIFF,
      changedFiles: ["src/example.ts"],
    });
    const sec = out.reviewVerdict.lensCoverage.find((e) => e.lensId === "security");
    expect(sec).toBeDefined();
    expect(sec!.status).toBe("ok");
    // Coverage must equal the merger's perLens set exactly (no schema throw).
    expect(out.reviewVerdict.verdict).toBe("reject");
    expect(out.reviewVerdict.blocking).toBe(1);
    // The injected lens is completed, never both completed AND skipped.
    expect(out.lensesCompleted).toContain("security");
    expect(out.lensesSkipped).not.toContain("security");
    const progress = JSON.parse(
      readFileSync(join(sessionDir, "review-progress.json"), "utf-8"),
    ) as { lensesSkipped: string[]; lensesCompleted: string[] };
    expect(progress.lensesSkipped).not.toContain("security");
    expect(progress.lensesCompleted).toContain("security");
  });

  it("never writes the injected secrets meta-finding to the per-lens cache", () => {
    // Emulate prepare's minted cache keys so the write-back path runs.
    const reviewId = "lens-cachewb";
    const securityKey = "sec-cache-key-1";
    writeFileSync(
      join(sessionDir, "lens-harness-meta.json"),
      JSON.stringify({ reviewId, stage: "CODE_REVIEW", cacheKeys: { security: securityKey } }),
    );
    handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: coreResults({
        security: okOutput([
          {
            id: "real-sec-1",
            severity: "major",
            category: "injection-risk",
            file: "src/example.ts",
            line: 2,
            description: "a genuine lens finding",
            suggestion: "fix it",
            confidence: 0.8,
          },
        ]),
      }),
      metadata: {
        ...META,
        reviewId,
        secretsMetaFinding: {
          id: "orchestrator-secrets-gate",
          severity: "blocking",
          category: "hardcoded-secrets",
          file: null,
          line: null,
          description: "Detected potential secrets in the diff.",
          suggestion: "Remove secrets from source control.",
          confidence: 0.9,
        },
      },
      projectRoot: root,
      sessionDir,
      sessionId: "sess-1",
      diff: DIFF,
      changedFiles: ["src/example.ts"],
    });
    const cached = getFromCache(sessionDir, securityKey);
    expect(cached).not.toBeNull();
    // The genuine lens finding is cached; the orchestrator meta is not (it is
    // re-derived fresh from the live secrets gate every round).
    expect(cached!.some((f) => f.id === "real-sec-1")).toBe(true);
    expect(cached!.some((f) => f.id === "orchestrator-secrets-gate")).toBe(false);
  });

  it("drops a stale secrets meta-finding replayed from a polluted cache entry", () => {
    // Simulate a security lens output replayed from a cache written by an
    // older build that had cached the orchestrator meta. This round's live
    // secrets gate found nothing (no secretsMetaFinding in metadata), so the
    // stale meta must not survive into the verdict nor force a false reject.
    const out = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: [
        {
          lens: "security",
          cached: true,
          output: {
            status: "ok",
            findings: [
              {
                // Non-localized so anchoring passes it through untouched: this
                // test isolates the meta strip, not T-026 evidence checking.
                id: "real-sec-2",
                severity: "minor",
                category: "input-validation",
                file: null,
                line: null,
                description: "a genuine cached finding",
                suggestion: "validate input",
                confidence: 0.7,
              },
              {
                id: "orchestrator-secrets-gate",
                severity: "blocking",
                category: "hardcoded-secrets",
                file: null,
                line: null,
                description: "stale meta from an older cache",
                suggestion: "n/a",
                confidence: 0.9,
              },
            ],
            error: null,
            notes: null,
          },
        },
        { lens: "error-handling", output: okOutput() },
        { lens: "clean-code", output: okOutput() },
        { lens: "concurrency", output: okOutput() },
      ],
      metadata: META,
      projectRoot: root,
      sessionDir,
      sessionId: "sess-1",
      diff: DIFF,
      changedFiles: ["src/example.ts"],
    });
    expect(
      out.reviewVerdict.findings.some((f) => f.id === "orchestrator-secrets-gate"),
    ).toBe(false);
    expect(out.reviewVerdict.blocking).toBe(0);
    // The genuine cached finding is unaffected.
    expect(out.reviewVerdict.findings.some((f) => f.id === "real-sec-2")).toBe(true);
  });

  it("marks agent-flagged cached results as cached coverage", () => {
    const out = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: coreResults().map((r) =>
        r.lens === "clean-code" ? { ...r, cached: true } : r,
      ),
      metadata: META,
      projectRoot: root,
      sessionDir,
      sessionId: "sess-1",
      diff: DIFF,
      changedFiles: ["src/example.ts"],
    });
    const cc = out.reviewVerdict.lensCoverage.find((e) => e.lensId === "clean-code");
    expect(cc?.status).toBe("cached");
    expect(out.reviewVerdict.coverage).toBe("full");
    expect(out.reviewVerdict.verdict).toBe("approve");
  });

  it("skips anchoring for PLAN_REVIEW and reports verificationSkipped telemetry", () => {
    const out = handleSynthesize({
      stage: "PLAN_REVIEW",
      lensResults: coreResults(),
      metadata: META,
      projectRoot: root,
      sessionDir,
      sessionId: "sess-1",
    });
    expect(out.reviewVerdict.verdict).toBe("approve");
    const telemetry = readFileSync(join(sessionDir, "verification-telemetry.jsonl"), "utf-8");
    const entry = JSON.parse(telemetry.trim().split("\n").at(-1)!);
    expect(entry.verificationSkipped).toBe(true);
    expect(existsSync(join(sessionDir, "verification.log"))).toBe(false);
  });
});
