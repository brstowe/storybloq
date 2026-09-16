/**
 * T-496: static instruction-contract test over the shipped skill text.
 *
 * This suite checks what a compliant reader is TOLD to do by SKILL.md's
 * actual content -- it is not a runtime simulation of actual LLM tool
 * calls. Every derivation below reads the real, on-disk SKILL.md (and the
 * committed presplit fixture) at test time; none of it is a hand-authored
 * parallel model, so an edit to the shipped text is what each derivation
 * inspects.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const SKILL_PATH = join(PROJECT_ROOT, "src", "skill", "SKILL.md");
const SESSION_GUARD_PATH = join(PROJECT_ROOT, "src", "skill", "session-guard.md");
const PRESPLIT_FIXTURE_PATH = join(__dirname, "fixtures", "t496-guard-section-presplit.txt");

function extractStubSection(skillText: string): string {
  const start = skillText.indexOf("## Step 0.5");
  const end = skillText.indexOf("## How to Handle Arguments");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("stub section markers not found in SKILL.md");
  }
  return skillText.slice(start, end);
}

function extractContinuationSection(skillText: string): string {
  const start = skillText.indexOf("## Continuing in a session that already loaded this skill");
  const end = skillText.indexOf("## Step 0.5");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("continuation section markers not found in SKILL.md");
  }
  return skillText.slice(start, end);
}

/** Does the named verdict's own bullet text mention the reference file? */
function verdictBulletMentionsReference(stub: string, verdictLiteral: string): boolean {
  const marker = `**${verdictLiteral}**`;
  const idx = stub.indexOf(marker);
  if (idx === -1) throw new Error(`verdict bullet not found: ${verdictLiteral}`);
  const nextBulletIdx = stub.indexOf("\n   - **", idx + marker.length);
  const bulletText = nextBulletIdx === -1 ? stub.slice(idx) : stub.slice(idx, nextBulletIdx);
  return bulletText.includes("session-guard.md");
}

/** Does the "before acting on any verdict" second-axis block route to the reference? */
function secondAxisRoutesToReference(stub: string): boolean {
  const idx = stub.indexOf("Before acting on any verdict");
  if (idx === -1) throw new Error("second-axis sentence not found");
  const bulletIdx = stub.indexOf("\n   - **", idx);
  const block = bulletIdx === -1 ? stub.slice(idx) : stub.slice(idx, bulletIdx);
  return block.includes("session-guard.md");
}

/** Collapse whitespace runs (including newlines/indentation from Markdown line-wrap) to a single space, for prose-contract phrase matching only -- never for the byte-exact preservation comparison. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

const WHOLE_SET_DISCOVERY_GUARD_SENTENCE = "Never re-run the whole-set discovery from the guard prelude";

/** Does the continuation section commit to targeted-only tool discovery? */
function continuationToolDiscoveryMode(continuationSection: string): "targeted" | "whole-set" {
  return normalizeWhitespace(continuationSection).includes(WHOLE_SET_DISCOVERY_GUARD_SENTENCE)
    ? "targeted"
    : "whole-set";
}

/** Is there an unconditional (verdict-independent) instruction to load the reference before any verdict is dispatched? */
function hasUnconditionalReferenceLoad(stub: string): boolean {
  const dispatchIdx = stub.indexOf("- **`free`**");
  if (dispatchIdx === -1) throw new Error("dispatch marker not found");
  const block = stub.slice(0, dispatchIdx); // whole stub, from its own "## Step 0.5" heading, through item 2's lead sentence -- everything before the first verdict bullet
  return /\b(?:read|load|open)\b[^.]*session-guard\.md/i.test(block);
}

type Verdict =
  | "`free`"
  | "`continue`"
  | "`auto-resume`"
  | "`monitor-only`"
  | "`offer-recovery`"
  | "`unverifiable`"
  | "`overallAction: null`"
  | "guard confirmed absent";

interface ContinuationScenario {
  readonly ownershipUncertain: boolean;
  readonly missingTool: string | null;
  readonly verdict: Verdict | null; // only meaningful when ownershipUncertain
  readonly scanIncomplete: boolean;
  readonly diagnosticsNonEmpty: boolean;
  readonly collisionsNonEmpty: boolean;
}

interface ContinuationPlan {
  readonly skillFilesRead: readonly string[]; // files read BEYOND the stub already in context
  readonly toolCalls: readonly string[];
}

function planContinuation(
  stub: string,
  continuationSection: string,
  scenario: ContinuationScenario,
): ContinuationPlan {
  const skillFilesRead: string[] = [];
  const toolCalls: string[] = [];
  if (scenario.missingTool) {
    const mode = continuationToolDiscoveryMode(continuationSection);
    toolCalls.push(mode === "targeted" ? `ToolSearch:${scenario.missingTool}` : "ToolSearch:whole-set");
  }
  if (scenario.ownershipUncertain) {
    toolCalls.push("storybloq_session_guard");
    const secondAxisTrips = scenario.scanIncomplete || scenario.diagnosticsNonEmpty || scenario.collisionsNonEmpty;
    if (secondAxisTrips && secondAxisRoutesToReference(stub)) {
      skillFilesRead.push("session-guard.md");
    } else if (scenario.verdict && verdictBulletMentionsReference(stub, scenario.verdict)) {
      skillFilesRead.push("session-guard.md");
    }
  }
  if (hasUnconditionalReferenceLoad(stub) && !skillFilesRead.includes("session-guard.md")) {
    skillFilesRead.push("session-guard.md");
  }
  return { skillFilesRead, toolCalls };
}

describe("story skill continuation procedure (T-496)", () => {
  const skillText = readFileSync(SKILL_PATH, "utf-8");
  const stub = extractStubSection(skillText);
  const continuationSection = extractContinuationSection(skillText);

  it("unchanged ownership: no guard call, no whole-set discovery, no reference read", () => {
    const plan = planContinuation(stub, continuationSection, {
      ownershipUncertain: false,
      missingTool: null,
      verdict: null,
      scanIncomplete: false,
      diagnosticsNonEmpty: false,
      collisionsNonEmpty: false,
    });
    expect(plan).toEqual({ skillFilesRead: [], toolCalls: [] });
  });

  it("missing tool: targeted ToolSearch only, no reference read", () => {
    const plan = planContinuation(stub, continuationSection, {
      ownershipUncertain: false,
      missingTool: "storybloq_ticket_get",
      verdict: null,
      scanIncomplete: false,
      diagnosticsNonEmpty: false,
      collisionsNonEmpty: false,
    });
    expect(plan).toEqual({ skillFilesRead: [], toolCalls: ["ToolSearch:storybloq_ticket_get"] });
  });

  it("resumed after blocked, same-owner verdict on a complete scan: guard call only, reference NOT read", () => {
    const plan = planContinuation(stub, continuationSection, {
      ownershipUncertain: true,
      missingTool: null,
      verdict: "`continue`",
      scanIncomplete: false,
      diagnosticsNonEmpty: false,
      collisionsNonEmpty: false,
    });
    expect(plan).toEqual({ skillFilesRead: [], toolCalls: ["storybloq_session_guard"] });
  });

  it("foreign verdict: guard call, reference read", () => {
    const plan = planContinuation(stub, continuationSection, {
      ownershipUncertain: true,
      missingTool: null,
      verdict: "`monitor-only`",
      scanIncomplete: false,
      diagnosticsNonEmpty: false,
      collisionsNonEmpty: false,
    });
    expect(plan).toEqual({ skillFilesRead: ["session-guard.md"], toolCalls: ["storybloq_session_guard"] });
  });

  it("same-owner verdict but scan INCOMPLETE (ISS-897 second axis): reference read despite the ordinary verdict", () => {
    const plan = planContinuation(stub, continuationSection, {
      ownershipUncertain: true,
      missingTool: null,
      verdict: "`continue`",
      scanIncomplete: true,
      diagnosticsNonEmpty: false,
      collisionsNonEmpty: false,
    });
    expect(plan).toEqual({ skillFilesRead: ["session-guard.md"], toolCalls: ["storybloq_session_guard"] });
  });

  it("same-owner verdict but diagnostics non-empty alone: reference read (second axis, componentwise)", () => {
    const plan = planContinuation(stub, continuationSection, {
      ownershipUncertain: true,
      missingTool: null,
      verdict: "`continue`",
      scanIncomplete: false,
      diagnosticsNonEmpty: true,
      collisionsNonEmpty: false,
    });
    expect(plan).toEqual({ skillFilesRead: ["session-guard.md"], toolCalls: ["storybloq_session_guard"] });
  });

  it("same-owner verdict but collisions non-empty alone: reference read (second axis, componentwise)", () => {
    const plan = planContinuation(stub, continuationSection, {
      ownershipUncertain: true,
      missingTool: null,
      verdict: "`continue`",
      scanIncomplete: false,
      diagnosticsNonEmpty: false,
      collisionsNonEmpty: true,
    });
    expect(plan).toEqual({ skillFilesRead: ["session-guard.md"], toolCalls: ["storybloq_session_guard"] });
  });

  describe("static document-contract assertions", () => {
    it("continuation section commits to targeted-only tool discovery, not whole-set re-discovery", () => {
      const normalized = normalizeWhitespace(continuationSection);
      expect(normalized).toContain("discover only that tool by exact name");
      expect(normalized).toContain(WHOLE_SET_DISCOVERY_GUARD_SENTENCE);
    });

    it("dispatch order is pinned: guard call, then second-axis check, then verdict branch", () => {
      const guardCallIdx = stub.indexOf("1. Call `storybloq_session_guard`");
      const secondAxisIdx = stub.indexOf("Before acting on any verdict");
      const firstBulletIdx = stub.indexOf("- **`free`**");
      expect(guardCallIdx).toBeGreaterThan(-1);
      expect(secondAxisIdx).toBeGreaterThan(-1);
      expect(firstBulletIdx).toBeGreaterThan(-1);
      expect(guardCallIdx).toBeLessThan(secondAxisIdx);
      expect(secondAxisIdx).toBeLessThan(firstBulletIdx);
    });
  });

  describe("preservation proof (byte-exact, no normalization)", () => {
    it("session-guard.md is byte-for-byte identical to the pre-split fixture", () => {
      const sessionGuard = readFileSync(SESSION_GUARD_PATH);
      const fixture = readFileSync(PRESPLIT_FIXTURE_PATH);
      expect(sessionGuard.equals(fixture)).toBe(true);
    });

    it("every ordinary-path item the stub keeps pointer-only is still findable in the moved text", () => {
      const fixtureText = readFileSync(PRESPLIT_FIXTURE_PATH, "utf-8");
      const distinguishingPhrases = [
        "Codex owner-response relay",
        "Re-trigger rule for the Step 2 reconciliation",
        "Re-trigger rule for start",
      ];
      for (const phrase of distinguishingPhrases) {
        expect(fixtureText, `"${phrase}" missing from the preserved fixture`).toContain(phrase);
      }
      // Round 1's gap: these three items existed in the original text but had
      // no live pointer left in the stub after the split. Pin that each has
      // one -- items 4 and 5 both say "re-trigger rule", so a shared substring
      // check cannot tell "item 5 deleted" from "item 5 intact"; each item is
      // sliced out and checked for its OWN distinguishing trigger phrase.
      expect(stub).toContain("Codex owner-response relay");
      const item4 = stub.slice(stub.indexOf("\n4. If Step 2"), stub.indexOf("\n5. Any later"));
      const item5 = stub.slice(stub.indexOf("\n5. Any later"));
      expect(item4.length, "item 4 (Step 2 reconciliation re-trigger) not found").toBeGreaterThan(0);
      expect(item4).toMatch(/classification fingerprint/i);
      expect(item4).toContain("session-guard.md");
      expect(item4).toMatch(/re-trigger rule/i);
      expect(item5.length, "item 5 (action: start re-trigger) not found").toBeGreaterThan(0);
      expect(item5).toMatch(/action: "start"/i);
      expect(item5).toContain("session-guard.md");
      expect(item5).toMatch(/re-trigger rule/i);
    });
  });

  describe("byte-size assertions (real files, not estimates)", () => {
    it("SKILL.md stays at or under 65,000 bytes", () => {
      // 65,000 is the actual post-split measured size (64,399 bytes) rounded
      // up to the next 1,000 -- the plan's 64,000 projection undercounted the
      // verbatim continuation section and stub by a few dozen bytes each,
      // plus the Support Files inventory line, none of which were in the
      // original byte-budget table. Measured, not estimated; see
      // skill-mode-budget.test.ts for the same ceiling.
      const size = readFileSync(SKILL_PATH).length;
      expect(size).toBeLessThanOrEqual(65000);
    });

    it("SKILL.md dropped by at least 34,000 bytes from the pre-ticket baseline", () => {
      // ISS-1186 added three legitimate Support Files inventory lines after
      // T-496 shipped, narrowing the drop from 35,271 to 34,888 bytes -- this
      // floor is rounded DOWN to the nearest 1,000 below that measured value
      // (the ceiling above rounds up; a floor rounds down), so it still proves
      // a large reduction from the 99,670-byte pre-ticket baseline without
      // blocking future accurate inventory content. Measured, not estimated.
      const PRE_TICKET_BASELINE_BYTES = 99670; // measured on main before T-496's split, see plan-t496.md
      const size = readFileSync(SKILL_PATH).length;
      expect(PRE_TICKET_BASELINE_BYTES - size).toBeGreaterThanOrEqual(34000);
    });

    it("session-guard.md is exactly 40,939 bytes (the untouched, relocated guard body)", () => {
      const size = readFileSync(SESSION_GUARD_PATH).length;
      expect(size).toBe(40939);
    });
  });
});
