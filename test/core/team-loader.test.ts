import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyFilename } from "../../src/core/project-loader.js";
import { loadProject, writeConfig, writeRoadmap } from "../../src/core/project-loader.js";
import { serializeJSON, sortKeysDeep } from "../../src/core/project-loader.js";

describe("classifyFilename", () => {
  it("recognizes legacy ticket patterns", () => {
    expect(classifyFilename("T-001.json", "ticket")).toBe("legacy");
    expect(classifyFilename("T-077a.json", "ticket")).toBe("legacy");
    expect(classifyFilename("T-1234.json", "ticket")).toBe("legacy");
  });

  it("recognizes legacy issue patterns", () => {
    expect(classifyFilename("ISS-001.json", "issue")).toBe("legacy");
    expect(classifyFilename("ISS-999.json", "issue")).toBe("legacy");
  });

  it("recognizes legacy note patterns", () => {
    expect(classifyFilename("N-001.json", "note")).toBe("legacy");
  });

  it("recognizes legacy lesson patterns", () => {
    expect(classifyFilename("L-001.json", "lesson")).toBe("legacy");
  });

  it("recognizes team-mode ticket patterns", () => {
    expect(classifyFilename("t-k7m2p9x3w4a5b6e8.json", "ticket")).toBe("team");
  });

  it("recognizes team-mode issue patterns", () => {
    expect(classifyFilename("i-k7m2p9x3w4a5b6e8.json", "issue")).toBe("team");
  });

  it("recognizes team-mode note patterns", () => {
    expect(classifyFilename("n-k7m2p9x3w4a5b6e8.json", "note")).toBe("team");
  });

  it("recognizes team-mode lesson patterns", () => {
    expect(classifyFilename("l-k7m2p9x3w4a5b6e8.json", "lesson")).toBe("team");
  });

  it("returns null for unrecognized filenames", () => {
    expect(classifyFilename("random.json", "ticket")).toBeNull();
    expect(classifyFilename(".hidden.json", "ticket")).toBeNull();
    expect(classifyFilename("T-001.txt", "ticket")).toBeNull();
  });

  it("returns null for cross-type filenames", () => {
    expect(classifyFilename("ISS-001.json", "ticket")).toBeNull();
    expect(classifyFilename("T-001.json", "issue")).toBeNull();
  });
});

describe("loader displayId derivation", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "team-loader-"));
    await mkdir(join(root, ".story", "tickets"), { recursive: true });
    await mkdir(join(root, ".story", "issues"), { recursive: true });
    await mkdir(join(root, ".story", "handovers"), { recursive: true });

    const config = {
      version: 2,
      schemaVersion: 1,
      project: "test",
      type: "npm",
      language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: false },
    };
    await writeFile(
      join(root, ".story", "config.json"),
      JSON.stringify(sortKeysDeep(config), null, 2) + "\n",
    );

    const roadmap = {
      title: "Test",
      date: "2026-01-01",
      phases: [{ id: "p0", label: "P0", name: "Test", description: "test" }],
      blockers: [],
    };
    await writeFile(
      join(root, ".story", "roadmap.json"),
      JSON.stringify(sortKeysDeep(roadmap), null, 2) + "\n",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("derives displayId = id for legacy tickets without displayId", async () => {
    const ticket = {
      id: "T-001",
      title: "Test ticket",
      type: "task",
      status: "open",
      phase: "p0",
      order: 10,
      description: "",
      createdDate: "2026-01-01",
      completedDate: null,
      blockedBy: [],
      parentTicket: null,
    };
    await writeFile(
      join(root, ".story", "tickets", "T-001.json"),
      JSON.stringify(sortKeysDeep(ticket), null, 2) + "\n",
    );

    const result = await loadProject(root);
    const t = result.state.tickets[0];
    expect(t).toBeDefined();
    expect(t!.displayId).toBe("T-001");
  });

  it("does not overwrite existing displayId on legacy tickets", async () => {
    const ticket = {
      id: "T-001",
      title: "Test ticket",
      type: "task",
      status: "open",
      phase: "p0",
      order: 10,
      description: "",
      createdDate: "2026-01-01",
      completedDate: null,
      blockedBy: [],
      parentTicket: null,
      displayId: "T-CUSTOM",
    };
    await writeFile(
      join(root, ".story", "tickets", "T-001.json"),
      JSON.stringify(sortKeysDeep(ticket), null, 2) + "\n",
    );

    const result = await loadProject(root);
    const t = result.state.tickets[0];
    expect(t!.displayId).toBe("T-CUSTOM");
  });

  it("loads team-mode ticket files correctly", async () => {
    const ticket = {
      id: "t-k7m2p9x3w4a5b6e8",
      title: "Team ticket",
      type: "task",
      status: "open",
      phase: "p0",
      order: 10,
      description: "",
      createdDate: "2026-01-01",
      completedDate: null,
      blockedBy: [],
      parentTicket: null,
      displayId: "T-001",
    };
    await writeFile(
      join(root, ".story", "tickets", "t-k7m2p9x3w4a5b6e8.json"),
      JSON.stringify(sortKeysDeep(ticket), null, 2) + "\n",
    );

    const result = await loadProject(root);
    const t = result.state.tickets[0];
    expect(t).toBeDefined();
    expect(t!.id).toBe("t-k7m2p9x3w4a5b6e8");
    expect(t!.displayId).toBe("T-001");
  });

  it("returns fileClassifications with entity-dir-relative paths", async () => {
    const ticket = {
      id: "T-001",
      title: "Legacy",
      type: "task",
      status: "open",
      phase: "p0",
      order: 10,
      description: "",
      createdDate: "2026-01-01",
      completedDate: null,
      blockedBy: [],
      parentTicket: null,
    };
    await writeFile(
      join(root, ".story", "tickets", "T-001.json"),
      JSON.stringify(sortKeysDeep(ticket), null, 2) + "\n",
    );

    const result = await loadProject(root);
    expect(result.fileClassifications).toBeDefined();
    expect(result.fileClassifications.get("tickets/T-001.json")).toBe("legacy");
  });

  it("emits filename_id_mismatch when legacy filename contains canonical id", async () => {
    const ticket = {
      id: "t-k7m2p9x3w4a5b6e8",
      title: "Mismatched",
      type: "task",
      status: "open",
      phase: "p0",
      order: 10,
      description: "",
      createdDate: "2026-01-01",
      completedDate: null,
      blockedBy: [],
      parentTicket: null,
      displayId: "T-001",
    };
    await writeFile(
      join(root, ".story", "tickets", "T-001.json"),
      JSON.stringify(sortKeysDeep(ticket), null, 2) + "\n",
    );

    const result = await loadProject(root);
    const mismatchWarnings = result.warnings.filter(
      (w: { type: string }) => w.type === "filename_id_mismatch",
    );
    expect(mismatchWarnings.length).toBe(1);
    expect(result.fileClassifications.has("tickets/T-001.json")).toBe(false);
  });

  it("mixed legacy and team-mode files in same directory", async () => {
    const legacy = {
      id: "T-001",
      title: "Legacy",
      type: "task",
      status: "open",
      phase: "p0",
      order: 10,
      description: "",
      createdDate: "2026-01-01",
      completedDate: null,
      blockedBy: [],
      parentTicket: null,
    };
    const team = {
      id: "t-k7m2p9x3w4a5b6e8",
      title: "Team",
      type: "task",
      status: "open",
      phase: "p0",
      order: 20,
      description: "",
      createdDate: "2026-01-01",
      completedDate: null,
      blockedBy: [],
      parentTicket: null,
      displayId: "T-002",
    };
    await writeFile(
      join(root, ".story", "tickets", "T-001.json"),
      JSON.stringify(sortKeysDeep(legacy), null, 2) + "\n",
    );
    await writeFile(
      join(root, ".story", "tickets", "t-k7m2p9x3w4a5b6e8.json"),
      JSON.stringify(sortKeysDeep(team), null, 2) + "\n",
    );

    const result = await loadProject(root);
    expect(result.state.tickets.length).toBe(2);
    const legacyT = result.state.tickets.find((t: { id: string }) => t.id === "T-001");
    const teamT = result.state.tickets.find((t: { id: string }) => t.id === "t-k7m2p9x3w4a5b6e8");
    expect(legacyT!.displayId).toBe("T-001");
    expect(teamT!.displayId).toBe("T-002");
  });
});
