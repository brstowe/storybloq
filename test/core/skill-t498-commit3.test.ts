/**
 * T-498 Commit 3: RED-first doc-anchor tests over the shipped skill text.
 *
 * Like skill-continuation-procedure.test.ts, this checks what a compliant
 * reader is TOLD by SKILL.md's actual content -- every assertion reads the
 * real, on-disk SKILL.md at test time. Written before the Commit 3 edit
 * lands, so every test in this file is expected to FAIL against the
 * pre-Commit-3 text and PASS once the edit is made.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const SKILL_PATH = join(PROJECT_ROOT, "src", "skill", "SKILL.md");

const RULE_1 =
  "The recommend table is the ranking and carries actionability. Do not open ticket or issue bodies to rank them; open the item you are about to work on.";

const RULE_2 =
  "If the latest actionable continuation and the ranking disagree, the continuation wins. If the continuation's item is no longer actionable, say so and take the next actionable one. You may read an older handover to confirm; say which one and why.";

const RECONCILIATION_PARAGRAPH =
  "Before finalizing line one's candidate, check the older handovers (index 1-9) already loaded in the count: 10, brief: true response, across every disposition, not only continuation, for a decision or abandoned-approach record bearing on it. Adopt a correction only if nothing newer than the cited handover has revisited or reversed it, and say which handover and why nothing later supersedes it. An alternative item resolves through the same actionability check as any candidate; an alternative decision is accepted on the citation alone. Recover missing evidence the same way as line one's own candidate.";

describe("T-498 Commit 3: SKILL.md live text flip", () => {
  const skillText = readFileSync(SKILL_PATH, "utf-8");

  describe("verbatim rules (pen-confirmed, byte-exact)", () => {
    it("contains Rule 1 verbatim (recommend table carries actionability, do not open bodies to rank)", () => {
      expect(skillText).toContain(RULE_1);
    });

    it("contains Rule 2 verbatim (latest actionable continuation beats the ranking)", () => {
      expect(skillText).toContain(RULE_2);
    });
  });

  describe("reconciliation instruction (pen-trimmed, byte-exact, under 700 bytes)", () => {
    it("contains the final trimmed reconciliation paragraph verbatim", () => {
      expect(skillText).toContain(RECONCILIATION_PARAGRAPH);
    });

    it("the paragraph itself stays under 700 bytes (pen's Edit 2 budget)", () => {
      expect(Buffer.byteLength(RECONCILIATION_PARAGRAPH, "utf-8")).toBeLessThan(700);
    });

    it("carries no internal code identifiers (pen's Edit 1: no harness function names)", () => {
      expect(RECONCILIATION_PARAGRAPH).not.toContain("recoverHandoverEvidence");
      expect(RECONCILIATION_PARAGRAPH).not.toMatch(/\b[a-z]+[A-Z][a-zA-Z]*\(/); // no camelCase(...) call shapes
    });
  });

  describe("Step 2: two-call priming/brief shape replaces the single count: 3 call", () => {
    it("the new priming call shape is present", () => {
      expect(skillText).toContain("count: 1, priming: true");
    });

    it("the new brief call shape is present", () => {
      expect(skillText).toContain("count: 10, brief: true");
    });

    it("the old single-call count: 3 handover_latest line is gone", () => {
      expect(skillText).not.toContain("`storybloq_handover_latest` MCP tool with `count: 3`");
    });
  });

  describe("Step 3: Continuation block retired, Trajectory block added", () => {
    it("the standalone '## Continuation from <handover file or slug>' block is retired", () => {
      expect(skillText).not.toContain("## Continuation from <handover file or slug>");
    });

    it("a new '## Trajectory (last 10 handovers)' block exists", () => {
      expect(skillText).toContain("## Trajectory (last 10 handovers)");
    });
  });

  describe("Ready to Work table: actionability column", () => {
    it("the Ready to Work table header carries an actionability column", () => {
      const idx = skillText.indexOf("## Ready to Work (ranking)");
      expect(idx).toBeGreaterThan(-1);
      const tableSlice = skillText.slice(idx, idx + 400);
      expect(tableSlice.toLowerCase()).toContain("actionab");
    });
  });

  describe("byte budget", () => {
    it("SKILL.md stays at or under the 56,000-byte ceiling (see skill-mode-budget.test.ts)", () => {
      const size = readFileSync(SKILL_PATH).length;
      expect(size).toBeLessThanOrEqual(56000);
    });
  });
});
