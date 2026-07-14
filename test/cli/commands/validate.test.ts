import { describe, it, expect } from "vitest";
import { handleValidate, handleValidateWithSourceRefs } from "../../../src/cli/commands/validate.js";
import { ExitCode } from "../../../src/core/output-formatter.js";
import { makeIssue, makeState, makeTicket, makeRoadmap, makePhase } from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/run.js";

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    state: makeState(),
    warnings: [],
    root: "/tmp/test",
    handoversDir: "/tmp/test/.story/handovers",
    format: "md",
    ...overrides,
  };
}

describe("handleValidate", () => {
  it("returns OK when validation passes", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = handleValidate(ctx);
    expect(result.exitCode).toBe(ExitCode.OK);
    expect(result.output).toContain("passed");
  });

  it("returns VALIDATION_ERROR when validation fails", () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [makeTicket({ id: "T-001", phase: "nonexistent" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = handleValidate(ctx);
    expect(result.exitCode).toBe(ExitCode.VALIDATION_ERROR);
    expect(result.output).toContain("failed");
  });

  it("merges loader warnings into findings", () => {
    const ctx = makeCtx({
      warnings: [
        { file: "tickets/bad.json", message: "parse error", type: "parse_error" },
      ],
    });
    const result = handleValidate(ctx);
    expect(result.output).toContain("parse error");
  });

  it("returns valid JSON", () => {
    const ctx = makeCtx({ format: "json" });
    const result = handleValidate(ctx);
    expect(() => JSON.parse(result.output)).not.toThrow();
  });

  it("cosmetic-only warnings do not cause VALIDATION_ERROR", () => {
    const ctx = makeCtx({
      warnings: [
        { file: "handovers/readme.md", message: "no date prefix", type: "naming_convention" },
      ],
    });
    const result = handleValidate(ctx);
    // naming_convention is info level in mergeValidation, valid stays true
    expect(result.exitCode).toBe(ExitCode.OK);
  });

  it("does not validate source provenance on deleted issues", async () => {
    const ctx = makeCtx({
      format: "json",
      state: makeState({
        issues: [makeIssue({
          id: "ISS-001",
          lifecycle: "deleted",
          sourceRefs: [{
            path: "missing.ts",
            startLine: 1,
            revision: "deadbeef",
            contentHash: "a".repeat(64),
          }],
        })],
      }),
    });

    const result = await handleValidateWithSourceRefs(ctx);
    const parsed = JSON.parse(result.output);

    expect(result.exitCode).toBe(ExitCode.OK);
    expect(parsed.data.findings).not.toContainEqual(
      expect.objectContaining({ code: expect.stringMatching(/^source_ref_/) }),
    );
  });
});
