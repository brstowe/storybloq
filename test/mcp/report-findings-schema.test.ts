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
import { buildLensHistoryUpdate } from "../../src/autonomous/stages/types.js";
import { toolSchema } from "./tool-schema-helpers.js";
import { schemaForKind } from "../../src/cli/commands/codex-review.js";

function captureGuideSchema(): z.ZodTypeAny {
  const tools = new Map<string, { inputSchema: unknown }>();
  const server = {
    registerTool: (name: string, config: { inputSchema: unknown }) => {
      tools.set(name, config);
    },
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, "/tmp/iss717-test-root");
  const guide = tools.get("storybloq_autonomous_guide");
  if (!guide) throw new Error("storybloq_autonomous_guide was not registered");
  return toolSchema(guide.inputSchema);
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

  it("preserves the lens field (ISS-724) but strips the other lens-only fields", () => {
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
    // ISS-724: lens now survives the boundary so lensReviewHistory records a
    // real per-lens entry instead of collapsing to lens:'unknown'.
    expect(f.lens).toBe("security");
    // The remaining lens-only fields are unused downstream and stay stripped.
    expect(f.lensVersion).toBeUndefined();
    expect(f.recommendedImpact).toBeUndefined();
    expect(f.evidence).toBeUndefined();
    expect(f.confidence).toBeUndefined();
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

  /**
   * ISS-598: a 4th instance of the recurring MCP-schema-stripping pattern
   * (ISS-717, ISS-724, ISS-988) -- `file` is read defensively off the raw
   * finding by plan-review.ts, which builds the `DriftFinding` the PLAN_REVIEW
   * scope-drift classifier (plan-review-drift.ts) actually runs against, but
   * `file` was never declared on the schema, so a reviewer that cited a file
   * would have it silently dropped before either ever saw it.
   */
  it("accepts a file field on a finding, for the scope-drift detector", () => {
    const parsed = parseReport([
      { severity: "major", category: "design", description: "unbounded chain", file: "src/nav/reducer.ts" },
    ], "revise");
    expect(parsed.report.findings[0].file).toBe("src/nav/reducer.ts");
  });

  it("omits file rather than defaulting it, so a reviewer that cites none leaves the detector to fall back on description text alone", () => {
    const parsed = parseReport([
      { severity: "major", category: "design", description: "unbounded chain" },
    ], "revise");
    expect(parsed.report.findings[0].file).toBeUndefined();
  });

  it("accepts exactly the 1024-character boundary and rejects one character past it", () => {
    const boundary = "a".repeat(1024);
    const ok = parseReport([
      { severity: "major", category: "design", description: "x", file: boundary },
    ], "revise");
    expect(ok.report.findings[0].file).toBe(boundary);
    expect(() => parseReport([
      { severity: "major", category: "design", description: "x", file: "a".repeat(1025) },
    ], "revise")).toThrow();
  });
});

describe("lens fidelity through the report boundary (ISS-724)", () => {
  it("a lens-shaped finding parsed through the real schema records its true lens in history", () => {
    const parsed = parseReport([
      { lens: "security", severity: "critical", category: "injection", description: "sql injection" },
      { lens: "error-handling", severity: "major", category: "swallowed-error", description: "empty catch" },
    ], "request_changes");

    const history = buildLensHistoryUpdate(parsed.report.findings, [], "T-001", "CODE_REVIEW");
    expect(history).not.toBeNull();
    expect(history!.map((e) => e.lens).sort()).toEqual(["error-handling", "security"]);
    // Distinct lenses no longer collapse onto lens:'unknown'.
    expect(history!.some((e) => e.lens === "unknown")).toBe(false);
  });

  it("a finding with no lens still falls back to 'unknown' (e.g. a non-lens reviewer)", () => {
    const parsed = parseReport([
      { severity: "major", category: "logic", description: "missing null check" },
    ]);
    const history = buildLensHistoryUpdate(parsed.report.findings, [], "T-001", "CODE_REVIEW");
    expect(history).not.toBeNull();
    expect(history![0].lens).toBe("unknown");
  });
});

/**
 * ISS-1202 (GitHub #36): OpenAI structured outputs in strict mode (what
 * `codex exec --output-schema` uses) require every key in an object node's
 * `properties` to also appear in that node's `required` array -- optional
 * fields are expressed as required-plus-nullable via `anyOf` with a `null`
 * branch, not by omission from `required`. The native codex review schema
 * (`schemaForKind` in codex-review.ts) is handed straight to `codex exec`, so
 * a single object node that violates this (declares a property but does not
 * require it) makes Codex reject the schema outright with a 400 before it
 * ever produces a review -- the whole codex review backend goes silently
 * dark. This walks every object node in the schema and proves none of them
 * violate the invariant, rather than pinning only the one field (
 * `recommendedNextState`) the GitHub report happened to name.
 */
interface SchemaNode {
  readonly type?: string;
  readonly properties?: Record<string, SchemaNode>;
  readonly required?: readonly string[];
  readonly items?: SchemaNode;
  readonly anyOf?: readonly SchemaNode[];
}

function collectStrictModeViolations(node: SchemaNode, path: string, violations: string[]): void {
  if (node.type === "object" && node.properties) {
    const required = new Set(node.required ?? []);
    for (const key of Object.keys(node.properties)) {
      if (!required.has(key)) {
        violations.push(`${path}.properties.${key} is declared but missing from ${path}.required`);
      }
    }
    for (const [key, child] of Object.entries(node.properties)) {
      collectStrictModeViolations(child, `${path}.properties.${key}`, violations);
    }
  }
  if (node.items) collectStrictModeViolations(node.items, `${path}.items`, violations);
  if (node.anyOf) {
    node.anyOf.forEach((branch, i) => collectStrictModeViolations(branch, `${path}.anyOf[${i}]`, violations));
  }
}

describe("ISS-1202: native codex review schema satisfies OpenAI strict-mode structured outputs", () => {
  for (const kind of ["plan", "code"] as const) {
    it(`every object node's properties all appear in required, for kind "${kind}"`, () => {
      const schema = schemaForKind(kind) as SchemaNode;
      const violations: string[] = [];
      collectStrictModeViolations(schema, "schema", violations);
      expect(violations).toEqual([]);
    });
  }
});
