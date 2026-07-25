import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolvePack,
  attachedPacksFor,
  attachedKnowledgeFor,
} from "../../src/knowledge/attach.js";
import { loadKnowledgeEntries, nextKnowledgeID } from "../../src/knowledge/pack.js";
import { loadProject } from "../../src/core/project-loader.js";
import { initProject } from "../../src/core/init.js";
import { handleLessonDigest, handleLessonPromote } from "../../src/cli/commands/lesson.js";
import {
  handleKnowledgeCreate,
  handleKnowledgeReinforce,
  handleKnowledgeList,
  handleKnowledgeDigest,
} from "../../src/cli/commands/knowledge.js";
import type { CommandContext } from "../../src/cli/types.js";

const DATE = "2026-07-25";

function lessonJson(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id, title, content: `${title} — content.`, context: "test", source: "manual",
    tags: ["shopify"], reinforcements: 0, lastValidated: DATE,
    createdDate: DATE, updatedDate: DATE, supersedes: null, status: "active",
    ...extra,
  };
}

function knowledgeJson(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id, title, content: `${title} — content.`, context: "pack", source: "manual",
    tags: ["shopify"], reinforcements: 0, lastValidated: DATE,
    createdDate: DATE, updatedDate: DATE, supersedes: null, status: "active",
    ...extra,
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

function writePack(dir: string, name: string, entries: Record<string, unknown>[]) {
  writeConfig(dir, {
    project: name, type: "knowledge",
    features: { tickets: false, issues: false, handovers: false, roadmap: false, reviews: false },
  });
  writeRoadmap(dir);
  mkdirSync(join(dir, ".story", "knowledge"), { recursive: true });
  for (const e of entries) {
    writeFileSync(join(dir, ".story", "knowledge", `${e.id as string}.json`), JSON.stringify(e));
  }
}

async function ctxFor(root: string): Promise<CommandContext> {
  const { state, warnings } = await loadProject(root);
  return { state, warnings, root, handoversDir: join(root, ".story", "handovers"), format: "md" };
}

describe("storyknow knowledge packs", () => {
  let root: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "storyknow-"));
    savedHome = process.env.STORYKNOW_HOME;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.STORYKNOW_HOME;
    else process.env.STORYKNOW_HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves packs by path and by bare name under STORYKNOW_HOME", () => {
    const packDir = join(root, "packs", "shopify");
    mkdirSync(packDir, { recursive: true });
    writePack(packDir, "shopify", []);

    const byPath = resolvePack(packDir, root);
    expect(byPath?.name).toBe("shopify");

    process.env.STORYKNOW_HOME = join(root, "packs");
    const byName = resolvePack("shopify", root);
    expect(byName?.name).toBe("shopify");
    expect(byName?.root).toBe(byPath?.root);

    // A non-pack directory is not a pack
    const notPack = join(root, "plain");
    mkdirSync(notPack, { recursive: true });
    writeConfig(notPack, { project: "plain" });
    expect(resolvePack(notPack, root)).toBeNull();
  });

  it("collects direct refs plus the orchestrator's refs, deduped", () => {
    const packDir = join(root, "packs", "shopify");
    mkdirSync(packDir, { recursive: true });
    writePack(packDir, "shopify", []);
    process.env.STORYKNOW_HOME = join(root, "packs");

    const orch = join(root, "orch");
    const node = join(orch, "child");
    mkdirSync(node, { recursive: true });
    writeConfig(orch, {
      project: "orch", type: "orchestrator",
      nodes: { child: { path: "./child" } },
      knowledge: ["shopify"],
    });
    writeRoadmap(orch);
    // Node also lists the same pack — must dedupe to one
    writeConfig(node, { project: "child", knowledge: ["shopify"] });
    writeRoadmap(node);

    const packs = attachedPacksFor(node, { type: "generic", knowledge: ["shopify"] });
    expect(packs.map((p) => p.name)).toEqual(["shopify"]);
  });

  it("merges attached knowledge into the lesson digest with [pack] marks, three layers deep", async () => {
    const packDir = join(root, "packs", "shopify");
    mkdirSync(packDir, { recursive: true });
    writePack(packDir, "shopify", [
      knowledgeJson("K-001", "Pack wisdom"),
      knowledgeJson("K-002", "Retired wisdom", { status: "superseded" }),
    ]);
    process.env.STORYKNOW_HOME = join(root, "packs");

    const orch = join(root, "orch");
    const node = join(orch, "child");
    mkdirSync(node, { recursive: true });
    writeConfig(orch, {
      project: "orch", type: "orchestrator",
      nodes: { child: { path: "./child" } },
      knowledge: ["shopify"],
    });
    writeRoadmap(orch);
    mkdirSync(join(orch, ".story", "lessons"), { recursive: true });
    writeFileSync(join(orch, ".story", "lessons", "L-001.json"),
      JSON.stringify(lessonJson("L-001", "Root lesson")));

    writeConfig(node, { project: "child" });
    writeRoadmap(node);
    mkdirSync(join(node, ".story", "lessons"), { recursive: true });
    writeFileSync(join(node, ".story", "lessons", "L-001.json"),
      JSON.stringify(lessonJson("L-001", "Local lesson")));

    const digest = handleLessonDigest(await ctxFor(node)).output;
    expect(digest).toContain("Local lesson");
    expect(digest).toContain("[root] Root lesson");
    expect(digest).toContain("[shopify] Pack wisdom");
    expect(digest).not.toContain("Retired wisdom");
  });

  it("projects with no knowledge key and no orchestrator see no attached knowledge", async () => {
    const lone = join(root, "lone");
    mkdirSync(lone, { recursive: true });
    writeConfig(lone, { project: "lone" });
    writeRoadmap(lone);
    expect(attachedKnowledgeFor(lone, { type: "generic" })).toEqual([]);
    const digest = handleLessonDigest(await ctxFor(lone)).output;
    expect(digest).not.toContain("[");
  });

  it("promotes a lesson: pack gains K-entry with origin + carried count, local lesson superseded", async () => {
    const packDir = join(root, "packs", "shopify");
    mkdirSync(packDir, { recursive: true });
    writePack(packDir, "shopify", [knowledgeJson("K-007", "Existing")]);
    process.env.STORYKNOW_HOME = join(root, "packs");

    const proj = join(root, "proj");
    mkdirSync(proj, { recursive: true });
    writeConfig(proj, { project: "proj", knowledge: ["shopify"] });
    writeRoadmap(proj);
    mkdirSync(join(proj, ".story", "lessons"), { recursive: true });
    writeFileSync(join(proj, ".story", "lessons", "L-003.json"),
      JSON.stringify(lessonJson("L-003", "Metafields cache aggressively", { reinforcements: 4 })));

    const result = await handleLessonPromote("L-003", { to: "shopify" }, "md", proj);
    expect(result.output).toContain("Promoted L-003 → shopify:K-008");

    const entries = loadKnowledgeEntries(packDir);
    const entry = entries.find((e) => e.id === "K-008")!;
    expect(entry.title).toBe("Metafields cache aggressively");
    expect(entry.reinforcements).toBe(4);
    expect(entry.origin).toMatchObject({ project: "proj", sourceId: "L-003" });

    const { state } = await loadProject(proj);
    const local = state.lessonByID("L-003")!;
    expect(local.status).toBe("superseded");
    expect(local.context).toContain("Promoted → shopify:K-008");
  });

  it("promote guards: duplicate title conflicts unless --force; unattached pack is not_found", async () => {
    const packDir = join(root, "packs", "shopify");
    mkdirSync(packDir, { recursive: true });
    writePack(packDir, "shopify", [knowledgeJson("K-001", "Same title")]);
    process.env.STORYKNOW_HOME = join(root, "packs");

    const proj = join(root, "proj");
    mkdirSync(proj, { recursive: true });
    writeConfig(proj, { project: "proj", knowledge: ["shopify"] });
    writeRoadmap(proj);
    mkdirSync(join(proj, ".story", "lessons"), { recursive: true });
    writeFileSync(join(proj, ".story", "lessons", "L-001.json"),
      JSON.stringify(lessonJson("L-001", "Same title")));

    await expect(
      handleLessonPromote("L-001", { to: "shopify" }, "md", proj),
    ).rejects.toMatchObject({ code: "conflict" });

    await expect(
      handleLessonPromote("L-001", { to: "nonexistent" }, "md", proj),
    ).rejects.toMatchObject({ code: "not_found" });

    const forced = await handleLessonPromote("L-001", { to: "shopify", force: true }, "md", proj);
    expect(forced.output).toContain("shopify:K-002");
  });

  it("knowledge CRUD works inside a pack and is refused elsewhere", async () => {
    const packDir = join(root, "packs", "shopify");
    mkdirSync(packDir, { recursive: true });
    writePack(packDir, "shopify", []);

    const created = await handleKnowledgeCreate(
      { title: "Webhooks are at-least-once", content: "Dedupe by event id.", context: "prod incident", source: "postmortem", tags: ["webhooks"] },
      "md",
      packDir,
    );
    expect(created.output).toContain("Created knowledge K-001");

    const reinforced = await handleKnowledgeReinforce("K-001", "md", packDir);
    expect(reinforced.output).toContain("(×1)");

    const listed = handleKnowledgeList({}, await ctxFor(packDir));
    expect(listed.output).toContain("K-001: Webhooks are at-least-once (×1)");

    // Not a pack → refused
    const proj = join(root, "proj");
    mkdirSync(proj, { recursive: true });
    writeConfig(proj, { project: "proj" });
    writeRoadmap(proj);
    await expect(
      handleKnowledgeCreate(
        { title: "x", content: "y", context: "z", source: "manual" },
        "md",
        proj,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("knowledge digest is dual-mode: pack's own entries inside, attached knowledge outside", async () => {
    const packDir = join(root, "packs", "shopify");
    mkdirSync(packDir, { recursive: true });
    writePack(packDir, "shopify", [knowledgeJson("K-001", "Pack wisdom")]);
    process.env.STORYKNOW_HOME = join(root, "packs");

    const inPack = handleKnowledgeDigest(await ctxFor(packDir));
    expect(inPack.output).toContain("Pack wisdom");
    expect(inPack.output).not.toContain("[shopify]");

    const proj = join(root, "proj");
    mkdirSync(proj, { recursive: true });
    writeConfig(proj, { project: "proj", knowledge: ["shopify"] });
    writeRoadmap(proj);
    const inProj = handleKnowledgeDigest(await ctxFor(proj));
    expect(inProj.output).toContain("[shopify] Pack wisdom");
  });

  it("nextKnowledgeID never re-mints ids from malformed (skipped) files", () => {
    const packDir = join(root, "packs", "shopify");
    mkdirSync(join(packDir, ".story", "knowledge"), { recursive: true });
    writePack(packDir, "shopify", [knowledgeJson("K-002", "Valid")]);
    writeFileSync(join(packDir, ".story", "knowledge", "K-009.json"), "{ not json");
    const entries = loadKnowledgeEntries(packDir);
    expect(entries).toHaveLength(1);
    expect(nextKnowledgeID(packDir, entries)).toBe("K-010");
  });

  it("init --type knowledge scaffolds a pack (knowledge dir, no ticket dirs, features off)", async () => {
    const packDir = join(root, "newpack");
    mkdirSync(packDir, { recursive: true });
    const result = await initProject(packDir, { name: "shopify", type: "knowledge" });
    expect(result.created).toContain(".story/knowledge/");
    expect(existsSync(join(packDir, ".story", "knowledge"))).toBe(true);
    expect(existsSync(join(packDir, ".story", "tickets"))).toBe(false);
    const { state } = await loadProject(packDir);
    expect(state.config.type).toBe("knowledge");
    expect(state.config.features.tickets).toBe(false);
  });
});
