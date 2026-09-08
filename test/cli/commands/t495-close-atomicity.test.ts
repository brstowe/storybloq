/**
 * T-495 READER: closing writes `closedAt` and its observations in ONE atomic
 * replace, and a failed write leaves the open window byte-identical.
 *
 * Its own file because it mocks `project-loader`, and a module mock installed
 * for one test contaminates every other test in the file. The writer commit hit
 * the same constraint with `node:fs`.
 *
 * WHY IT MATTERS. `readContractWindow` refuses a closed window carrying no
 * observations, which is what makes a half-closed window safe rather than
 * silently authoritative. That guarantee is only real if the two land together:
 * an implementation writing `closedAt` first and the observations second would
 * pass every assertion about the FINAL file while exposing a window that reads
 * as absent if it is interrupted between them. Codex found that the original
 * test established the end state and nothing about the write.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const writes: { path: string; content: string }[] = [];
let failNextWrite = false;

vi.mock("../../../src/core/project-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/project-loader.js")>();
  return {
    ...actual,
    atomicWrite: async (path: string, content: string): Promise<void> => {
      writes.push({ path, content });
      if (failNextWrite) throw new Error("injected write failure");
      await actual.atomicWrite(path, content);
    },
  };
});

const { handleReviewStats } = await import("../../../src/cli/commands/review-stats.js");
const { readContractWindow } = await import("../../../src/core/review-stats-window.js");
type CommandContext = import("../../../src/cli/types.js").CommandContext;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  writes.length = 0;
  failNextWrite = false;
});

const CONTRACT = "# Review contract\n\n## Robustness\n\nBehaves.\n\nBlocking: blocking\n";
const CONTRACT_HASH = createHash("sha256").update(Buffer.from(CONTRACT, "utf-8")).digest("hex");
const DAY = 24 * 60 * 60 * 1000;

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "t495-atomic-"));
  dirs.push(root);
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(root, ".story", sub), { recursive: true });
  }
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    contractMeasurement: {
      openedAt: new Date(Date.now() - 8 * DAY).toISOString(),
      closedAt: null, baselineHash: CONTRACT_HASH, roots: [root], closeObservations: null,
    },
  }, null, 2));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-08-21",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }, null, 2));
  writeFileSync(join(root, "REVIEW.md"), CONTRACT, "utf-8");
  return root;
}

function writeRound(root: string, i: number, at: Date): void {
  const sessionDir = join(root, ".story", "sessions", "s1");
  const reviews = join(sessionDir, "telemetry", "reviews");
  mkdirSync(reviews, { recursive: true });
  writeFileSync(join(reviews, `r${i}.json`), JSON.stringify({
    target: "T-1", stage: "code", round: 1, reviewer: "codex", verdict: "approve",
    findingsCount: 0, severityCounts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    startedAt: at.toISOString(), durationMs: 1, summary: "s", findings: [],
    timestamp: at.toISOString(), reviewAttemptId: `ra-${i}`, itemAttemptId: "ia-1",
    generation: 1, _contentHash: `hash-${i}`,
  }));
  writeFileSync(join(sessionDir, "principle-policy.jsonl"), `${JSON.stringify({
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
    findings: [],
    gate: {
      hasCriticalOrMajor: false, hasUnresolvedCritical: false,
      baselineHasCriticalOrMajor: false, baselineHasUnresolvedCritical: false,
      policyBlockedIndices: [], forcedLandingAllowed: false,
    },
    stageNextAction: "IMPLEMENT", floorSuppressedMinorCount: 0, floorSuppressedTotal: 0,
    timestamp: at.toISOString(),
  })}\n`, { flag: "a" });
}

function ctxFor(root: string): CommandContext {
  return { root } as unknown as CommandContext;
}

describe("closing is ONE write carrying both closedAt and the observations", () => {
  it("performs exactly one config replacement, and it holds both", async () => {
    const root = newRoot();
    const at = new Date(Date.now() - 2 * DAY);
    for (let i = 0; i < 20; i++) writeRound(root, i, at);
    const res = await handleReviewStats({ closeWindow: true }, ctxFor(root));
    expect(res.exitCode ?? 0).toBe(0);

    const configWrites = writes.filter((w) => w.path.endsWith(join(".story", "config.json")));
    expect(configWrites).toHaveLength(1);
    const written = JSON.parse(configWrites[0]!.content) as Record<string, unknown>;
    const cm = written.contractMeasurement as Record<string, unknown>;
    expect(typeof cm.closedAt).toBe("string");
    expect(cm.closeObservations).not.toBeNull();
    expect((cm.closeObservations as Record<string, unknown>).reReadHash).toBe(CONTRACT_HASH);
  });

  it("a failed write leaves the OPEN window byte-identical on disk", async () => {
    const root = newRoot();
    const at = new Date(Date.now() - 2 * DAY);
    for (let i = 0; i < 20; i++) writeRound(root, i, at);
    const before = readFileSync(join(root, ".story", "config.json"), "utf-8");
    failNextWrite = true;
    const res = await handleReviewStats({ closeWindow: true }, ctxFor(root));
    expect(res.exitCode).toBe(1);
    expect(res.output).toMatch(/Could not write/);
    expect(readFileSync(join(root, ".story", "config.json"), "utf-8")).toBe(before);
    expect(readContractWindow(root)?.closedAt).toBeNull();
  });
});
