import { describe, it, expect } from "vitest";
import { parseDiffScope, classifyOrigin } from "../../../src/autonomous/lens-harness/diff-scope.js";

// ── parseDiffScope ───────────────────────────────────────────

describe("parseDiffScope", () => {
  it("parses standard unified diff with one file", () => {
    const diff = `--- a/src/api.ts
+++ b/src/api.ts
@@ -1,3 +1,5 @@
+import { db } from "./db";
+
 export function handler(req) {
-  return "ok";
+  return db.query(req.params.id);
 }
`;
    const scope = parseDiffScope(diff);

    expect(scope.changedFiles.has("src/api.ts")).toBe(true);
    expect(scope.changedFiles.size).toBe(1);

    const lines = scope.addedLines.get("src/api.ts")!;
    expect(lines.has(1)).toBe(true);  // import line
    expect(lines.has(2)).toBe(true);  // blank line
    expect(lines.has(4)).toBe(true);  // db.query line
    expect(lines.has(3)).toBe(false); // context line (export function)
    expect(lines.has(5)).toBe(false); // context line (closing brace)
  });

  it("parses diff with multiple files", () => {
    const diff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 export { x };
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -5,3 +5,4 @@
 function bar() {
+  console.log("added");
   return true;
 }
`;
    const scope = parseDiffScope(diff);

    expect(scope.changedFiles.size).toBe(2);
    expect(scope.changedFiles.has("src/foo.ts")).toBe(true);
    expect(scope.changedFiles.has("src/bar.ts")).toBe(true);

    expect(scope.addedLines.get("src/foo.ts")!.has(2)).toBe(true);
    expect(scope.addedLines.get("src/bar.ts")!.has(6)).toBe(true);
  });

  it("parses diff with multiple hunks per file", () => {
    const diff = `--- a/src/big.ts
+++ b/src/big.ts
@@ -1,3 +1,4 @@
 line1
+added_at_2
 line3
 line4
@@ -10,3 +11,4 @@
 line11
+added_at_12
 line13
 line14
`;
    const scope = parseDiffScope(diff);

    const lines = scope.addedLines.get("src/big.ts")!;
    expect(lines.has(2)).toBe(true);   // first hunk addition
    expect(lines.has(12)).toBe(true);  // second hunk addition
    expect(lines.has(1)).toBe(false);  // context
    expect(lines.has(11)).toBe(false); // context
  });

  it("handles new file (--- /dev/null)", () => {
    const diff = `--- /dev/null
+++ b/src/new-file.ts
@@ -0,0 +1,3 @@
+export const VERSION = "1.0";
+export const NAME = "test";
+export default { VERSION, NAME };
`;
    const scope = parseDiffScope(diff);

    expect(scope.changedFiles.has("src/new-file.ts")).toBe(true);
    const lines = scope.addedLines.get("src/new-file.ts")!;
    expect(lines.has(1)).toBe(true);
    expect(lines.has(2)).toBe(true);
    expect(lines.has(3)).toBe(true);
  });

  it("handles deleted file (+++ /dev/null)", () => {
    const diff = `--- a/src/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export const OLD = true;
-export const LEGACY = true;
-export default { OLD, LEGACY };
`;
    const scope = parseDiffScope(diff);

    // Deleted file should not appear in changedFiles
    expect(scope.changedFiles.has("src/old.ts")).toBe(false);
    expect(scope.changedFiles.size).toBe(0);
  });

  it("returns empty scope for empty diff", () => {
    const scope = parseDiffScope("");
    expect(scope.changedFiles.size).toBe(0);
    expect(scope.addedLines.size).toBe(0);
  });

  it("handles only deletions in a hunk", () => {
    const diff = `--- a/src/cleanup.ts
+++ b/src/cleanup.ts
@@ -5,5 +5,3 @@
 function foo() {
-  console.log("removed1");
-  console.log("removed2");
   return true;
 }
`;
    const scope = parseDiffScope(diff);

    expect(scope.changedFiles.has("src/cleanup.ts")).toBe(true);
    const lines = scope.addedLines.get("src/cleanup.ts")!;
    // No added lines, only deletions and context
    expect(lines.size).toBe(0);
  });
});

// ── classifyOrigin ───────────────────────────────────────────

describe("classifyOrigin", () => {
  const scope = parseDiffScope(`--- a/src/api.ts
+++ b/src/api.ts
@@ -1,3 +1,5 @@
+import { db } from "./db";
+
 export function handler(req) {
-  return "ok";
+  return db.query(req.params.id);
 }
`);

  it("classifies finding in added line as introduced", () => {
    expect(classifyOrigin({ file: "src/api.ts", line: 1 }, scope, "CODE_REVIEW")).toBe("introduced");
    expect(classifyOrigin({ file: "src/api.ts", line: 4 }, scope, "CODE_REVIEW")).toBe("introduced");
  });

  it("classifies finding in context line of changed file as pre-existing", () => {
    // Line 3 is "export function handler(req)" -- context, not added
    expect(classifyOrigin({ file: "src/api.ts", line: 3 }, scope, "CODE_REVIEW")).toBe("pre-existing");
    // Line 5 is "}" -- context
    expect(classifyOrigin({ file: "src/api.ts", line: 5 }, scope, "CODE_REVIEW")).toBe("pre-existing");
  });

  it("classifies finding in file not in diff as pre-existing", () => {
    expect(classifyOrigin({ file: "src/unrelated.ts", line: 10 }, scope, "CODE_REVIEW")).toBe("pre-existing");
  });

  it("classifies finding with no file as introduced", () => {
    expect(classifyOrigin({ file: null, line: null }, scope, "CODE_REVIEW")).toBe("introduced");
  });

  it("classifies finding in changed file with no line as introduced", () => {
    expect(classifyOrigin({ file: "src/api.ts", line: null }, scope, "CODE_REVIEW")).toBe("introduced");
  });

  it("PLAN_REVIEW always returns introduced", () => {
    expect(classifyOrigin({ file: "src/api.ts", line: 3 }, scope, "PLAN_REVIEW")).toBe("introduced");
    expect(classifyOrigin({ file: "src/unrelated.ts", line: 10 }, scope, "PLAN_REVIEW")).toBe("introduced");
    expect(classifyOrigin({ file: null, line: null }, scope, "PLAN_REVIEW")).toBe("introduced");
  });

  it("handles finding at line beyond hunk range as pre-existing", () => {
    // Line 100 is way beyond the diff hunk
    expect(classifyOrigin({ file: "src/api.ts", line: 100 }, scope, "CODE_REVIEW")).toBe("pre-existing");
  });

  it("normalizes paths with leading ./ for comparison", () => {
    // Finding uses ./src/api.ts but diff uses src/api.ts
    expect(classifyOrigin({ file: "./src/api.ts", line: 1 }, scope, "CODE_REVIEW")).toBe("introduced");
    expect(classifyOrigin({ file: "./src/api.ts", line: 3 }, scope, "CODE_REVIEW")).toBe("pre-existing");
    expect(classifyOrigin({ file: "./src/unrelated.ts", line: 10 }, scope, "CODE_REVIEW")).toBe("pre-existing");
  });
});
