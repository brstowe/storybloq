import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("codex-review helpers", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-codex-review-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Storybloq Test"]);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function git(args: string[]): string {
    return execFileSync("git", args, {
      cwd: tempDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
  }

  it("builds a code-review diff artifact with tracked and untracked file contents", async () => {
    await writeFile(join(tempDir, "tracked.txt"), "old\n", "utf-8");
    git(["add", "tracked.txt"]);
    git(["commit", "-m", "initial"]);

    await writeFile(join(tempDir, "tracked.txt"), "old\nchanged\n", "utf-8");
    await writeFile(join(tempDir, "new-file.txt"), "new\n", "utf-8");

    const { buildCodeReviewDiffArtifact } = await import("../../../src/cli/commands/codex-review.js");
    const artifact = buildCodeReviewDiffArtifact(tempDir, "HEAD");

    expect(artifact).toContain("tracked.txt");
    expect(artifact).toContain("+changed");
    expect(artifact).toContain("new-file.txt");
    expect(artifact).toContain("+new");
  });

  it("rejects code review when there is no diff to review", async () => {
    await writeFile(join(tempDir, "tracked.txt"), "old\n", "utf-8");
    git(["add", "tracked.txt"]);
    git(["commit", "-m", "initial"]);

    const { buildCodeReviewDiffArtifact } = await import("../../../src/cli/commands/codex-review.js");

    expect(() => buildCodeReviewDiffArtifact(tempDir, "HEAD")).toThrow("No code diff found");
  });

  it("uses distinct verdict contracts for plan and code review", async () => {
    const { codePrompt, planPrompt, schemaForKind, verdictsForKind } = await import("../../../src/cli/commands/codex-review.js");

    expect(verdictsForKind("plan")).toEqual(["approve", "revise", "reject"]);
    expect(verdictsForKind("code")).toEqual(["approve", "request_changes", "reject"]);

    expect(planPrompt("s-1")).toContain("Use verdict approve, revise, or reject.");
    expect(planPrompt("s-1")).not.toContain("request_changes");
    expect(codePrompt("s-1")).toContain("Use verdict approve, request_changes, or reject.");
    expect(codePrompt("s-1")).not.toContain("revise");

    expect(JSON.stringify(schemaForKind("plan"))).toContain('"revise"');
    expect(JSON.stringify(schemaForKind("plan"))).not.toContain('"request_changes"');
    expect(JSON.stringify(schemaForKind("code"))).toContain('"request_changes"');
    expect(JSON.stringify(schemaForKind("code"))).not.toContain('"revise"');
  });
});
