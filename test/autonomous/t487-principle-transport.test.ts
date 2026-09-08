/**
 * T-487 G-A: `principle` transport for the codex and agent legs.
 *
 * A finding names the principle it violates; the contract evaluator caps a
 * finding that names none. Until this lands, no non-lens backend can carry the
 * field at all, and the seams that would drop it are silent: an
 * `additionalProperties: false` JSON schema drops an unknown key without
 * complaint, and a zod object with no `.passthrough()` strips one. So the
 * measurement would read zero while every layer looked healthy, which is this
 * ticket's declared failure class.
 *
 * These tests go through the REAL registered MCP schema and the REAL exported
 * codex schema rather than reconstructed copies, following
 * `report-findings-schema.test.ts` (ISS-717).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { registerAllTools } from "../../src/mcp/tools.js";
import { toolSchema } from "../mcp/tool-schema-helpers.js";
import { schemaForKind, normalizeFinding, planPrompt, codePrompt } from "../../src/cli/commands/codex-review.js";
import { readFindingPrinciple } from "../../src/autonomous/review-identity.js";
import { loadReviewContract, projectDecision } from "../../src/autonomous/review-contract.js";

// ── harnesses ────────────────────────────────────────────────────

function captureGuideSchema(): z.ZodTypeAny {
  const tools = new Map<string, { inputSchema: unknown }>();
  const server = {
    registerTool: (name: string, config: { inputSchema: unknown }) => {
      tools.set(name, config);
    },
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, "/tmp/t487-principle-transport");
  const guide = tools.get("storybloq_autonomous_guide");
  if (!guide) throw new Error("storybloq_autonomous_guide was not registered");
  return toolSchema(guide.inputSchema);
}

const SCHEMA = captureGuideSchema();
const SID = "a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4";

/** Parse through the real boundary. Throws exactly as the MCP layer would. */
function parseReport(findings: unknown[]): any {
  return SCHEMA.parse({
    sessionId: SID,
    action: "report",
    report: { completedAction: "code_review_round", verdict: "approve", findings },
  });
}

/** The finding item object inside the native codex output schema. */
function findingItemSchema(kind: "plan" | "code"): any {
  const schema = schemaForKind(kind) as any;
  return schema.properties.findings.items;
}

const CONTRACT = [
  "# Review contract",
  "",
  "## Outside this contract",
  "",
  "performance",
  "",
  "## Robustness",
  "",
  "Behaves under the inputs it will meet.",
  "",
  "Blocking: blocking",
  "",
  "## Quality",
  "",
  "Verified to do what it claims.",
  "",
  "Blocking: major",
  "",
].join("\n");

function withContract<T>(fn: (contract: ReturnType<typeof loadReviewContract>) => T): T {
  const root = mkdtempSync(join(tmpdir(), "t487-principle-"));
  try {
    writeFileSync(join(root, "REVIEW.md"), CONTRACT, "utf-8");
    return fn(loadReviewContract(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── G-T1 ─────────────────────────────────────────────────────────

describe("G-T1: the native codex schema declares principle", () => {
  // This is the seam that fails silently. `additionalProperties: false` means a
  // reviewer following the prompt has its answer dropped BY THE SCHEMA, and
  // nothing in the suite notices today.
  for (const kind of ["plan", "code"] as const) {
    it(`declares principle on the finding item for kind "${kind}"`, () => {
      const item = findingItemSchema(kind);
      expect(item.additionalProperties).toBe(false);
      expect(item.properties.principle).toBeDefined();
      expect(item.properties.principle.type).toBe("string");
      // Constrains what the REVIEWER is asked for. Absent is the only way to
      // say "names no principle", so an empty string must not be offered as a
      // second way to say it.
      expect(item.properties.principle.minLength).toBe(1);
    });

    it(`does not require principle for kind "${kind}"`, () => {
      const item = findingItemSchema(kind);
      expect(item.required).not.toContain("principle");
    });
  }

  it("does not put principle on the envelope, which has no consumer", () => {
    const schema = schemaForKind("code") as any;
    expect(schema.properties.principle).toBeUndefined();
  });
});

// ── G-T2 ─────────────────────────────────────────────────────────

describe("G-T2: principle survives the codex normalizer", () => {
  it("carries a named principle through, lowercased", () => {
    const out = normalizeFinding(
      {
        severity: "major",
        category: "logic",
        description: "d",
        principle: "Robustness",
      } as any,
      0,
    );
    expect(out.principle).toBe("robustness");
  });

  it("leaves an absent principle absent rather than inventing one", () => {
    const out = normalizeFinding(
      { severity: "major", category: "logic", description: "d" } as any,
      0,
    );
    expect("principle" in out).toBe(false);
  });
});

// ── G-T3 ─────────────────────────────────────────────────────────

describe("G-T3: principle and contributingLenses survive the MCP boundary", () => {
  const LENS_FINDING = {
    severity: "major",
    category: "perf-regression",
    description: "n^2 scan",
    principle: "quality",
    contributingLenses: ["performance"],
  };

  it("preserves the principle value verbatim", () => {
    const f = parseReport([LENS_FINDING]).report.findings[0];
    expect(f.principle).toBe("quality");
  });

  it("preserves contributingLenses, which coverage is keyed on", () => {
    const f = parseReport([LENS_FINDING]).report.findings[0];
    expect(f.contributingLenses).toEqual(["performance"]);
  });

  it("classifies the finding OUTSIDE, which is only reachable via the lens ids", () => {
    // The category `perf-regression` matches nothing on the Outside line; the
    // lens id `performance` does. With the array stripped at the boundary this
    // comes back `inside` and the finding is capped, so this assertion is what
    // makes the field's survival matter rather than merely being observed.
    const f = parseReport([LENS_FINDING]).report.findings[0];
    const projection = withContract((contract) =>
      projectDecision({
        finding: f,
        index: 0,
        baseline: { severity: "major", blocking: true },
        contract,
        isRoundBlocker: () => true,
      }),
    );
    expect(projection.coverage).toBe("outside");
  });
});

// ── G-T4 ─────────────────────────────────────────────────────────

describe("G-T4: blank is not a second way to say absent", () => {
  // Four seams, three different rules, stated per seam because the layer that
  // may safely REJECT is not the layer that must ABSORB. A validation error at
  // the MCP boundary fails a whole review round.

  it("seam 1, reviewer schema: an empty principle is not offered as valid", () => {
    expect(findingItemSchema("code").properties.principle.minLength).toBe(1);
  });

  for (const blank of ["", "   ", "\t\n"]) {
    it(`seam 2, normalizer: ${JSON.stringify(blank)} is omitted, not passed as ""`, () => {
      const out = normalizeFinding(
        { severity: "minor", category: "c", description: "d", principle: blank } as any,
        0,
      );
      expect("principle" in out).toBe(false);
    });
  }

  it("seam 2, normalizer: a padded value is trimmed and lowercased", () => {
    const out = normalizeFinding(
      { severity: "minor", category: "c", description: "d", principle: " Robustness " } as any,
      0,
    );
    expect(out.principle).toBe("robustness");
  });

  // The round-failing shape. A strict `.min(1)` or a bare `.transform` on a
  // string schema throws here, and the MCP layer turns that into -32602 for the
  // WHOLE report: a cosmetic reviewer slip would cost a review round.
  for (const junk of ["", "   ", 42, null, {}, []] as unknown[]) {
    it(`seam 3, MCP boundary: ${JSON.stringify(junk)} is accepted and read as absent`, () => {
      let parsed: any;
      expect(() => {
        parsed = parseReport([
          { severity: "minor", category: "c", description: "d", principle: junk },
        ]);
      }).not.toThrow();
      expect(parsed.report.findings[0].principle).toBeUndefined();
    });
  }

  it("seam 3, MCP boundary: a padded value is trimmed and lowercased", () => {
    const f = parseReport([
      { severity: "minor", category: "c", description: "d", principle: " Robustness " },
    ]).report.findings[0];
    expect(f.principle).toBe("robustness");
  });

  it("seam 4, persisted reader: blanks and non-strings read as undefined", () => {
    for (const junk of ["", "   ", 42, null, undefined, {}, []]) {
      expect(readFindingPrinciple(junk)).toBeUndefined();
    }
  });

  it("seam 4, persisted reader: a padded value is trimmed and lowercased", () => {
    expect(readFindingPrinciple(" Robustness ")).toBe("robustness");
  });

  it("the three seams agree on the normalized value, so one principle is one bucket", () => {
    // The consequence each seam's own assertion cannot reach. A principle can
    // arrive by any of these routes, and a consumer that groups findings by
    // the value it reads gets ONE bucket only if the routes agree. Two seams
    // disagreeing on case or padding splits a single principle in two while
    // every individual seam still looks correct, which is this ticket's
    // failure class pointed at its own transport.
    //
    // Note what does NOT pin this, measured rather than assumed: the evaluator
    // is no help here. `projectDecision` reads the field through `fieldOf`,
    // which lowercases whatever it receives, so a finding carrying "Quality"
    // resolves to the declared principle even when no seam lowercased at all.
    // A test routed through the evaluator therefore passes with the reader's
    // normalization deleted. The seams have to pin each other.
    const raw = " Robustness ";
    const viaNormalizer = normalizeFinding(
      { severity: "minor", category: "c", description: "d", principle: raw } as any,
      0,
    ).principle;
    const viaMcp = parseReport([
      { severity: "minor", category: "c", description: "d", principle: raw },
    ]).report.findings[0].principle;
    const viaReader = readFindingPrinciple(raw);

    expect([viaNormalizer, viaMcp, viaReader]).toEqual(["robustness", "robustness", "robustness"]);
  });
});

// ── G-T5: the instruction reaches all four reviewer legs ─────────

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/** The load-bearing half of the instruction: what a reviewer is asked to do. */
const ASK = "Name the principle this finding violates in `principle`";
/** The half that keeps the measurement honest. */
const NO_GUESS = "guessing is not";

describe("G-T5: every non-lens reviewer leg is asked for the principle", () => {
  // Asked on all four legs or the measurement is partial in a way its own
  // number cannot show: a leg that was never asked reports the same zero as a
  // leg that was asked and declined.

  it("the native codex plan prompt asks for it", () => {
    const prompt = planPrompt("s1");
    expect(prompt).toContain(ASK);
    expect(prompt).toContain(NO_GUESS);
  });

  it("the native codex code prompt asks for it", () => {
    const prompt = codePrompt("s1");
    expect(prompt).toContain(ASK);
    expect(prompt).toContain(NO_GUESS);
  });

  // The two stage instructions are built inside handlers that need a full
  // session context to run, so these assert on the source the way
  // setup-skill.test.ts and session-guard-fallback.test.ts do for skill text.
  // A weaker assertion than the two above, and it is the one that catches a
  // silent deletion, which is the failure that actually happens.
  for (const stage of ["code-review", "plan-review"] as const) {
    it(`the agent-leg ${stage.replace("-", " ")} instruction asks for it`, () => {
      const source = readFileSync(join(SRC, "autonomous", "stages", `${stage}.ts`), "utf-8");
      expect(source).toContain(ASK);
      expect(source).toContain(NO_GUESS);
    });
  }
});
