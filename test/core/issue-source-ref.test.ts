import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashSourceRange,
  IssueSourceRefError,
  normalizeIssueSourceRefs,
  validateIssueSourceRefs,
} from "../../src/core/issue-source-ref.js";
import { makeIssue } from "./test-factories.js";

const tempDirs: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function makeRepo(content: string): Promise<{ root: string; revision: string }> {
  const root = await mkdtemp(join(tmpdir(), "story-source-ref-"));
  tempDirs.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Storybloq Test");
  git(root, "config", "user.email", "storybloq@example.test");
  await writeFile(join(root, "example.ts"), content, "utf8");
  git(root, "add", "example.ts");
  git(root, "commit", "-qm", "fixture");
  return { root, revision: git(root, "rev-parse", "HEAD") };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("issue source provenance", () => {
  it("hashes only the normalized referenced line range", () => {
    expect(hashSourceRange("one\r\ntwo\r\nthree\r\n", 2)).toBe(
      hashSourceRange("zero\ntwo\nfour\n", 2),
    );
  });

  it("captures HEAD when the reviewed range is committed", async () => {
    const { root, revision } = await makeRepo("one\ntwo\nthree\n");
    const [ref] = await normalizeIssueSourceRefs(root, [{
      path: "example.ts",
      startLine: 2,
      reviewId: "review-1",
    }]);

    expect(ref).toMatchObject({
      path: "example.ts",
      startLine: 2,
      revision,
      reviewId: "review-1",
    });
    expect(ref?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps hash-only provenance when the working range differs from HEAD", async () => {
    const { root } = await makeRepo("one\ntwo\nthree\n");
    await writeFile(join(root, "example.ts"), "import x from 'x';\none\ntwo\nthree\n", "utf8");

    const [ref] = await normalizeIssueSourceRefs(root, [{
      path: "example.ts",
      startLine: 3,
      snapshotId: "review-snapshot-1",
    }]);

    expect(ref?.revision).toBeUndefined();
    expect(ref?.snapshotId).toBe("review-snapshot-1");
    expect(ref?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a supplied hash that does not match the source", async () => {
    const { root } = await makeRepo("one\ntwo\nthree\n");
    await expect(normalizeIssueSourceRefs(root, [{
      path: "example.ts",
      startLine: 2,
      contentHash: "0".repeat(64),
    }])).rejects.toBeInstanceOf(IssueSourceRefError);
  });

  it("rejects working-tree paths that escape through an intermediate symlink", async () => {
    const { root } = await makeRepo("one\ntwo\nthree\n");
    const outside = await mkdtemp(join(tmpdir(), "story-source-ref-outside-"));
    tempDirs.push(outside);
    await writeFile(join(outside, "secret.ts"), "secret\n", "utf8");
    await symlink(outside, join(root, "linked"));

    await expect(normalizeIssueSourceRefs(root, [{
      path: "linked/secret.ts",
      startLine: 1,
    }])).rejects.toThrow("must not traverse a symbolic link");
  });

  it("returns no finding when the recorded evidence still matches HEAD", async () => {
    const { root } = await makeRepo("one\ntwo\nthree\n");
    const [ref] = await normalizeIssueSourceRefs(root, [{
      path: "example.ts",
      startLine: 2,
    }]);

    const findings = await validateIssueSourceRefs(root, [
      makeIssue({ id: "ISS-001", sourceRefs: [ref!] }),
    ]);

    expect(findings).toEqual([]);
  });

  it("warns when historically valid content moved at HEAD", async () => {
    const { root, revision } = await makeRepo("one\ntwo\nthree\n");
    const [ref] = await normalizeIssueSourceRefs(root, [{
      path: "example.ts",
      startLine: 2,
      revision,
    }]);
    await writeFile(join(root, "example.ts"), "zero\none\ntwo\nthree\n", "utf8");
    git(root, "add", "example.ts");
    git(root, "commit", "-qm", "move line");

    const findings = await validateIssueSourceRefs(root, [
      makeIssue({ id: "ISS-001", sourceRefs: [ref!] }),
    ]);

    expect(findings).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "source_ref_moved_at_head",
        entity: "ISS-001",
      }),
    ]);
    expect(findings[0]?.message).toContain("example.ts:3-3");
  });

  it("warns when an unavailable revision still matches HEAD by content hash", async () => {
    const { root } = await makeRepo("one\ntwo\nthree\n");
    const findings = await validateIssueSourceRefs(root, [
      makeIssue({
        id: "ISS-001",
        sourceRefs: [{
          path: "example.ts",
          startLine: 2,
          revision: "deadbeef",
          contentHash: hashSourceRange("one\ntwo\nthree\n", 2),
        }],
      }),
    ]);

    expect(findings).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "source_ref_revision_unavailable",
      }),
    ]);
  });

  it("errors when neither an unavailable revision nor HEAD verifies the hash", async () => {
    const { root } = await makeRepo("one\ntwo\nthree\n");
    const findings = await validateIssueSourceRefs(root, [
      makeIssue({
        id: "ISS-001",
        sourceRefs: [{
          path: "example.ts",
          startLine: 2,
          revision: "deadbeef",
          contentHash: hashSourceRange("one\ndifferent\nthree\n", 2),
        }],
      }),
    ]);

    expect(findings).toEqual([
      expect.objectContaining({
        level: "error",
        code: "source_ref_original_unresolvable",
      }),
    ]);
  });

  it("does not use the hash fallback for an invalid path at a reachable revision", async () => {
    const { root, revision } = await makeRepo("one\ntwo\nthree\n");
    await writeFile(join(root, "later.ts"), "matching\n", "utf8");
    git(root, "add", "later.ts");
    git(root, "commit", "-qm", "add later source");

    const findings = await validateIssueSourceRefs(root, [
      makeIssue({
        id: "ISS-001",
        sourceRefs: [{
          path: "later.ts",
          startLine: 1,
          revision,
          contentHash: hashSourceRange("matching\n", 1),
        }],
      }),
    ]);

    expect(findings).toEqual([
      expect.objectContaining({
        level: "error",
        code: "source_ref_original_unresolvable",
      }),
    ]);
  });
});
