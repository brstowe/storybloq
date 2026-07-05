/**
 * Issue key generation tests (ISS-823 migration of the fork's
 * issue-key.test.ts to the package MergedFinding shape).
 */

import { describe, it, expect } from "vitest";
import type { MergedFinding } from "@storybloq/lenses";
import { generateIssueKey } from "../../../src/autonomous/lens-harness/issue-key.js";

const baseFinding: MergedFinding = {
  id: "sec-1",
  severity: "blocking",
  category: "injection",
  description: "SQL injection via unparameterized query",
  file: "src/api/users.ts",
  line: 87,
  suggestion: "parameterize the query",
  confidence: 0.95,
  contributingLenses: ["security"],
};

describe("issue key generation", () => {
  it("generates deterministic key with file and line", () => {
    const key = generateIssueKey(baseFinding);
    expect(key).toBe("security:src/api/users.ts:87:injection");
  });

  it("same inputs produce same key", () => {
    expect(generateIssueKey(baseFinding)).toBe(generateIssueKey(baseFinding));
  });

  it("different files produce different keys", () => {
    const other = { ...baseFinding, file: "src/api/posts.ts" };
    expect(generateIssueKey(baseFinding)).not.toBe(generateIssueKey(other));
  });

  it("uses description hash for findings without file/line", () => {
    const planFinding = { ...baseFinding, file: null, line: null };
    const key = generateIssueKey(planFinding);
    expect(key).toMatch(/^security:injection:[a-f0-9]+$/);
  });

  it("unlocated keys are deterministic", () => {
    const planFinding = { ...baseFinding, file: null, line: null };
    expect(generateIssueKey(planFinding)).toBe(generateIssueKey(planFinding));
  });

  it("different descriptions produce different unlocated keys", () => {
    const a = { ...baseFinding, file: null, line: null, description: "Missing auth on endpoint" };
    const b = { ...baseFinding, file: null, line: null, description: "No input validation strategy" };
    expect(generateIssueKey(a)).not.toBe(generateIssueKey(b));
  });

  it("uses the first contributing lens as the key prefix", () => {
    const merged = { ...baseFinding, contributingLenses: ["error-handling", "security"] };
    expect(generateIssueKey(merged)).toBe("error-handling:src/api/users.ts:87:injection");
  });
});
