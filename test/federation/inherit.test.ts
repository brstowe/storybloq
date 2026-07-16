import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findOrchestratorLink,
  inheritedLessonsFor,
  inheritedNotesFor,
} from "../../src/federation/inherit.js";
import { loadProject } from "../../src/core/project-loader.js";
import { handleLessonDigest } from "../../src/cli/commands/lesson.js";
import { handleNoteList, handleNoteGet } from "../../src/cli/commands/note.js";
import type { CommandContext } from "../../src/cli/types.js";

const DATE = "2026-07-16";
const TS = "2026-07-16T12:00:00.000Z";

function lessonJson(id: string, title: string, status = "active") {
  return {
    id, title, content: `${title} — content.`, context: "test", source: "manual",
    tags: ["shopify"], reinforcements: 0, lastValidated: DATE,
    createdDate: DATE, updatedDate: DATE, updatedAt: TS, supersedes: null, status,
  };
}

function noteJson(id: string, title: string | null) {
  return {
    id, title, content: `${title ?? id} — note content.`, tags: ["ref"],
    status: "active", createdDate: DATE, updatedDate: DATE, updatedAt: TS,
  };
}

function writeConfig(dir: string, config: Record<string, unknown>) {
  mkdirSync(join(dir, ".story"), { recursive: true });
  writeFileSync(join(dir, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "p", type: "generic", language: "unknown",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    ...config,
  }));
}

function writeRoadmap(dir: string) {
  writeFileSync(join(dir, ".story", "roadmap.json"), JSON.stringify({
    title: "p", date: DATE, blockers: [],
    phases: [{ id: "p0", name: "Setup", label: "PHASE 0", description: "d" }],
  }));
}

describe("federation inheritance", () => {
  let root: string;
  let orch: string;
  let node: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fed-inherit-"));
    orch = root;
    node = join(root, "child");
    mkdirSync(node, { recursive: true });

    writeConfig(orch, {
      project: "orch", type: "orchestrator",
      nodes: { child: { path: "./child", stack: "npm" } },
    });
    writeRoadmap(orch);
    mkdirSync(join(orch, ".story", "lessons"), { recursive: true });
    mkdirSync(join(orch, ".story", "notes"), { recursive: true });
    writeFileSync(join(orch, ".story", "lessons", "L-001.json"),
      JSON.stringify(lessonJson("L-001", "Root lesson one")));
    writeFileSync(join(orch, ".story", "lessons", "L-002.json"),
      JSON.stringify(lessonJson("L-002", "Superseded root lesson", "superseded")));
    writeFileSync(join(orch, ".story", "notes", "N-001.json"),
      JSON.stringify(noteJson("N-001", "Root note")));

    writeConfig(node, { project: "child" });
    writeRoadmap(node);
    mkdirSync(join(node, ".story", "lessons"), { recursive: true });
    writeFileSync(join(node, ".story", "lessons", "L-001.json"),
      JSON.stringify(lessonJson("L-001", "Local lesson")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("auto-discovers the orchestrator that claims this root", () => {
    const link = findOrchestratorLink(node, { type: "generic" });
    expect(link).not.toBeNull();
    expect(link!.nodeName).toBe("child");
    expect(link!.storyDir).toBe(join(link!.orchestratorRoot, ".story"));
  });

  it("returns null for the orchestrator itself and for unclaimed projects", () => {
    expect(findOrchestratorLink(orch, { type: "orchestrator" })).toBeNull();
    const stranger = join(root, "stranger");
    mkdirSync(stranger, { recursive: true });
    expect(findOrchestratorLink(stranger, { type: "generic" })).toBeNull();
  });

  it("honors federationRoot: false opt-out and explicit federationRoot path", () => {
    expect(findOrchestratorLink(node, { type: "generic", federationRoot: false })).toBeNull();
    // sibling layout: node outside the orchestrator tree, linked explicitly
    const sibling = mkdtempSync(join(tmpdir(), "fed-sibling-"));
    try {
      writeConfig(sibling, { project: "sib" });
      writeConfig(orch, {
        project: "orch", type: "orchestrator",
        nodes: { child: { path: "./child" }, sib: { path: sibling } },
      });
      const link = findOrchestratorLink(sibling, { type: "generic", federationRoot: orch });
      expect(link).not.toBeNull();
      expect(link!.nodeName).toBe("sib");
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("inherits only ACTIVE root lessons, titles marked [root]", () => {
    const lessons = inheritedLessonsFor(node, { type: "generic" });
    expect(lessons.map((l) => l.title)).toEqual(["[root] Root lesson one"]);
  });

  it("inherits root notes with marked titles", () => {
    const notes = inheritedNotesFor(node, { type: "generic" });
    expect(notes.map((n) => n.title)).toEqual(["[root] Root note"]);
  });

  it("merges root lessons into the node lesson digest", async () => {
    const { state, warnings } = await loadProject(node);
    const ctx: CommandContext = { state, warnings, root: node, handoversDir: join(node, ".story", "handovers"), format: "md" };
    const digest = handleLessonDigest(ctx).output;
    expect(digest).toContain("Local lesson");
    expect(digest).toContain("[root] Root lesson one");
    expect(digest).not.toContain("Superseded root lesson");
  });

  it("lists and gets root notes from the node, local ids winning", async () => {
    const { state, warnings } = await loadProject(node);
    const ctx: CommandContext = { state, warnings, root: node, handoversDir: join(node, ".story", "handovers"), format: "md" };
    expect(handleNoteList({}, ctx).output).toContain("[root] Root note");
    const got = handleNoteGet("N-001", ctx);
    expect(got.exitCode ?? 0).toBe(0);
    expect(got.output).toContain("Root note");
    expect(handleNoteGet("N-999", ctx).errorCode).toBe("not_found");
  });

  it("standalone projects (no orchestrator anywhere) are untouched", async () => {
    const lone = mkdtempSync(join(tmpdir(), "fed-lone-"));
    try {
      writeConfig(lone, { project: "lone" });
      writeRoadmap(lone);
      const { state, warnings } = await loadProject(lone);
      const ctx: CommandContext = { state, warnings, root: lone, handoversDir: join(lone, ".story", "handovers"), format: "md" };
      expect(handleLessonDigest(ctx).output).not.toContain("[root]");
      expect(inheritedNotesFor(lone, { type: "generic" })).toEqual([]);
    } finally {
      rmSync(lone, { recursive: true, force: true });
    }
  });
});
