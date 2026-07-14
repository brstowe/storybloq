/**
 * T-183: Resume marker file tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeResumeMarker, removeResumeMarker } from "../../src/autonomous/resume-marker.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "marker-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("writeResumeMarker", () => {
  it("writes marker file with correct content", () => {
    writeResumeMarker(root, "test-session-id", {
      ticket: { id: "T-042", title: "Build the thing" },
      completedTickets: [{ id: "T-001" }, { id: "T-002" }],
      resolvedIssues: ["ISS-001"],
      preCompactState: "IMPLEMENT",
    });

    const path = join(root, ".claude", "rules", "autonomous-resume.md");
    expect(existsSync(path)).toBe(true);

    const content = readFileSync(path, "utf-8");
    expect(content).toContain("CRITICAL");
    expect(content).toContain("test-session-id");
    expect(content).toContain("T-042");
    expect(content).toContain("Build the thing");
    expect(content).toContain("2 tickets completed");
    expect(content).toContain("1 issues resolved");
    expect(content).toContain("IMPLEMENT");
    expect(content).toContain("run `/story`");
    expect(content).toContain("verify task ownership");
    expect(content).not.toContain('"action": "resume"');
    expect(content).not.toContain("takeover");
  });

  it("creates intermediate directories if missing", () => {
    writeResumeMarker(root, "s1", {
      completedTickets: [],
    });

    expect(existsSync(join(root, ".claude", "rules", "autonomous-resume.md"))).toBe(true);
  });

  it("shows 'Between tickets' when no ticket is active", () => {
    writeResumeMarker(root, "s1", {
      ticket: null,
      completedTickets: [],
    });

    const content = readFileSync(join(root, ".claude", "rules", "autonomous-resume.md"), "utf-8");
    expect(content).toContain("Between tickets");
  });

  it("overwrites existing marker", () => {
    writeResumeMarker(root, "first", { completedTickets: [] });
    writeResumeMarker(root, "second", { completedTickets: [] });

    const content = readFileSync(join(root, ".claude", "rules", "autonomous-resume.md"), "utf-8");
    expect(content).toContain("second");
    expect(content).not.toContain("first");
  });
});

describe("removeResumeMarker", () => {
  it("removes the marker file", () => {
    writeResumeMarker(root, "s1", { completedTickets: [] });
    const path = join(root, ".claude", "rules", "autonomous-resume.md");
    expect(existsSync(path)).toBe(true);

    removeResumeMarker(root);
    expect(existsSync(path)).toBe(false);
  });

  it("does not error if file does not exist", () => {
    expect(() => removeResumeMarker(root)).not.toThrow();
  });

  it("does not error if directory does not exist", () => {
    const noDir = join(root, "nonexistent");
    expect(() => removeResumeMarker(noDir)).not.toThrow();
  });
});
