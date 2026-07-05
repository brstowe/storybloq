/**
 * ISS-823 prepare harness (pen ruling R2).
 *
 * prepare = carry-over consumer harness (context packaging, secrets gate,
 * path safety, caching) + package activate() + per-activation
 * buildLensPrompt(). It returns complete lens prompts for the agent to spawn
 * and discloses per-lens activation statuses.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePrepare } from "../../../src/autonomous/lens-harness/prepare.js";
import { writeToCache } from "../../../src/autonomous/lens-harness/cache.js";

const DIFF = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 0000000..1111111 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -0,0 +1,2 @@",
  "+export function greet(name: string): string {",
  '+  return "hello " + name;',
  "",
].join("\n");

let root: string;
let sessionDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lens-harness-prepare-"));
  sessionDir = join(root, ".story", "sessions", "sess-1");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "example.ts"), "export function greet() {}\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("handlePrepare (package-backed)", () => {
  it("activates the four core lenses for a TS diff and discloses statuses", () => {
    const out = handlePrepare({
      stage: "CODE_REVIEW",
      diff: DIFF,
      changedFiles: ["src/example.ts"],
      ticketDescription: "test ticket",
      reviewRound: 1,
      projectRoot: root,
      sessionDir,
      sessionId: "sess-1",
    });

    for (const core of ["security", "error-handling", "clean-code", "concurrency"]) {
      expect(out.metadata.activeLenses).toContain(core);
      expect(out.metadata.activationReasons[core]).toBeTruthy();
    }
    // data-safety has no .sql surface in this diff -> skipped
    expect(out.metadata.skippedLenses).toContain("data-safety");
    expect(out.metadata.reviewId).toMatch(/^lens-/);

    // Every non-cached prompt is complete: embeds the diff and output rules.
    for (const p of out.lensPrompts) {
      expect(p.cached).toBe(false);
      expect(p.promptTruncated).toBe(false);
      expect(p.prompt).toContain("hello ");
      expect(p.prompt).toContain("## Output rules");
      expect(["opus", "sonnet"]).toContain(p.model);
    }
  });

  it("returns no prompts for a CODE_REVIEW with no changed files", () => {
    const out = handlePrepare({
      stage: "CODE_REVIEW",
      diff: "",
      changedFiles: [],
      projectRoot: root,
    });
    expect(out.lensPrompts).toEqual([]);
    expect(out.metadata.activeLenses).toEqual([]);
  });

  it("activates all lenses for PLAN_REVIEW and embeds the plan text", () => {
    const out = handlePrepare({
      stage: "PLAN_REVIEW",
      diff: "# Plan\n\nRefactor the greeter module.",
      changedFiles: [],
      ticketDescription: "plan ticket",
      projectRoot: root,
    });
    expect(out.metadata.activeLenses.length).toBe(9);
    expect(out.lensPrompts[0]!.prompt).toContain("Refactor the greeter module.");
  });

  it("persists harness meta and serves cached findings on the next round", () => {
    const first = handlePrepare({
      stage: "CODE_REVIEW",
      diff: DIFF,
      changedFiles: ["src/example.ts"],
      ticketDescription: "test ticket",
      projectRoot: root,
      sessionDir,
      sessionId: "sess-1",
    });

    const metaPath = join(sessionDir, "lens-harness-meta.json");
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.reviewId).toBe(first.metadata.reviewId);
    expect(Object.keys(meta.cacheKeys)).toEqual([...first.metadata.activeLenses]);

    // Simulate a completed clean-code lens: write its findings to the cache
    // under the key prepare minted, then re-run prepare with identical inputs.
    const cached = [
      {
        id: "cc-1",
        severity: "minor" as const,
        category: "naming",
        file: "src/example.ts",
        line: 1,
        description: "cached finding",
        suggestion: "rename",
        confidence: 0.8,
      },
    ];
    writeToCache(sessionDir, meta.cacheKeys["clean-code"], cached);

    const second = handlePrepare({
      stage: "CODE_REVIEW",
      diff: DIFF,
      changedFiles: ["src/example.ts"],
      ticketDescription: "test ticket",
      projectRoot: root,
      sessionDir,
      sessionId: "sess-1",
    });
    const entry = second.lensPrompts.find((p) => p.lens === "clean-code");
    expect(entry?.cached).toBe(true);
    expect(entry?.cachedFindings).toHaveLength(1);
    expect(entry?.prompt).toBe("");
    // Fresh lenses still get full prompts.
    const fresh = second.lensPrompts.find((p) => p.lens === "security");
    expect(fresh?.cached).toBe(false);
    expect(fresh?.prompt).toContain("## Output rules");
  });
});
