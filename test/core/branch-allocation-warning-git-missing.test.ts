import { describe, it, expect, vi } from "vitest";

// A hoisted module mock, so it must live in its own file: it replaces
// node:child_process for every test in this file, unlike the real-git
// fixtures in branch-allocation-warning.test.ts.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => {
    const err = new Error("spawn git ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }),
}));

describe("checkBranchAllocationWarning: git binary unavailable", () => {
  it("returns null, never throws, when git itself is not on PATH (ISS-1190 pen pin)", async () => {
    const { checkBranchAllocationWarning } = await import("../../src/core/branch-allocation-warning.js");
    const { makeState, minimalConfig } = await import("./test-factories.js");
    const state = makeState({ config: minimalConfig });
    expect(() => checkBranchAllocationWarning("/nonexistent-root", "ticket", state, "T-042")).not.toThrow();
    expect(checkBranchAllocationWarning("/nonexistent-root", "ticket", state, "T-042")).toBeNull();
  });
});
