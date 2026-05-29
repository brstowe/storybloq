/**
 * ISS-717: the storybloq_autonomous_guide report.findings[] MCP schema must
 * accept synthesized lens-shaped findings (which carry severity/category/
 * description but no id and no disposition) instead of rejecting them with
 * -32602 before the contradiction guard in the review stage can run. These
 * tests parse payloads through the REAL registered inputSchema (captured via a
 * mock server) rather than a reconstructed copy.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { registerAllTools } from "../../src/mcp/tools.js";

function captureGuideSchema(): z.ZodTypeAny {
  const tools = new Map<string, { inputSchema: z.ZodRawShape }>();
  const server = {
    registerTool: (name: string, config: { inputSchema: z.ZodRawShape }) => {
      tools.set(name, config);
    },
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, "/tmp/iss717-test-root");
  const guide = tools.get("storybloq_autonomous_guide");
  if (!guide) throw new Error("storybloq_autonomous_guide was not registered");
  return z.object(guide.inputSchema);
}

const SCHEMA = captureGuideSchema();
const SID = "a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4";

function parseReport(findings: unknown[], verdict = "approve"): any {
  return SCHEMA.parse({
    sessionId: SID,
    action: "report",
    report: { completedAction: "code_review_round", verdict, findings },
  });
}

describe("autonomous_guide report.findings schema (ISS-717)", () => {
  it("accepts a lens-shaped finding with no id or disposition and defaults disposition to open", () => {
    const parsed = parseReport([
      { severity: "major", category: "logic", description: "missing null check" },
    ]);
    const f = parsed.report.findings[0];
    expect(f.disposition).toBe("open");
    expect(f.id).toBeUndefined();
    expect(f.severity).toBe("major");
  });

  it("strips lens-only fields rather than rejecting the payload", () => {
    const parsed = parseReport([
      {
        lens: "security",
        lensVersion: "security-v2",
        severity: "critical",
        category: "injection",
        description: "sql injection",
        recommendedImpact: "blocker",
        evidence: [{ file: "a.ts", startLine: 1, endLine: 2, code: "x" }],
        confidence: 0.9,
        issueKey: "security:a.ts:1:injection",
      },
    ], "request_changes");
    const f = parsed.report.findings[0];
    expect(f.severity).toBe("critical");
    expect(f.disposition).toBe("open");
    expect(f.lens).toBeUndefined();
    expect(f.evidence).toBeUndefined();
    expect(f.issueKey).toBeUndefined();
  });

  it("accepts recommendedNextState, which used to be stripped (PLAN-redirect guard was dead)", () => {
    const parsed = parseReport([
      { severity: "major", category: "design", description: "wrong approach", recommendedNextState: "PLAN" },
    ], "revise");
    expect(parsed.report.findings[0].recommendedNextState).toBe("PLAN");
  });

  it("still honors an explicitly supplied id and disposition", () => {
    const parsed = parseReport([
      { id: "F-1", severity: "minor", category: "style", description: "nit", disposition: "addressed" },
    ]);
    const f = parsed.report.findings[0];
    expect(f.id).toBe("F-1");
    expect(f.disposition).toBe("addressed");
  });

  it("still rejects an out-of-vocabulary disposition", () => {
    expect(() =>
      parseReport([{ severity: "major", category: "x", description: "y", disposition: "bogus" }]),
    ).toThrow();
  });
});
