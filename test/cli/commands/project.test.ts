import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleProjectList,
  handleProjectCreate,
  handleProjectUpdate,
  handleProjectDelete,
  handleProjectMigrateSidecar,
} from "../../../src/cli/commands/project.js";
import { handlePhaseCreate, handlePhaseRename } from "../../../src/cli/commands/phase.js";
import { handleTicketCreate, handleTicketUpdate } from "../../../src/cli/commands/ticket.js";
import { initProject } from "../../../src/core/init.js";
import { loadProject } from "../../../src/core/project-loader.js";
import { makeState, makeRoadmap, makePhase, makeTicket } from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/types.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "project-cmd-"));
  tmpDirs.push(dir);
  await initProject(dir, { name: "test" });
  await handlePhaseCreate(
    { id: "ops", name: "Operations", label: "OPS", description: "d", atStart: true },
    "md",
    dir,
  );
  return dir;
}

async function readRoadmap(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, ".story", "roadmap.json"), "utf-8"));
}

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

describe("handleProjectCreate", () => {
  it("creates a project in a phase", async () => {
    const dir = await makeProject();
    const result = await handleProjectCreate(
      { id: "docusign", name: "Docusign", phase: "ops", color: "#4f7cff" },
      "md",
      dir,
    );
    expect(result.output).toContain("Created project docusign");
    const roadmap = await readRoadmap(dir);
    expect(roadmap.projects).toEqual([
      { id: "docusign", name: "Docusign", phase: "ops", color: "#4f7cff" },
    ]);
  });

  it("rejects unknown phases and duplicate ids", async () => {
    const dir = await makeProject();
    await expect(
      handleProjectCreate({ id: "x", name: "X", phase: "ghost" }, "md", dir),
    ).rejects.toThrow(/Phase "ghost" not found/);
    await handleProjectCreate({ id: "x", name: "X", phase: "ops" }, "md", dir);
    await expect(
      handleProjectCreate({ id: "x", name: "X2", phase: "ops" }, "md", dir),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects malformed ids", async () => {
    const dir = await makeProject();
    await expect(
      handleProjectCreate({ id: "Bad Id", name: "X", phase: "ops" }, "md", dir),
    ).rejects.toThrow(/lowercase alphanumeric/);
  });
});

describe("handleProjectUpdate / handleProjectDelete", () => {
  it("updates name and color", async () => {
    const dir = await makeProject();
    await handleProjectCreate({ id: "x", name: "X", phase: "ops" }, "md", dir);
    await handleProjectUpdate("x", { name: "X Prime", color: "#000000" }, "md", dir);
    const roadmap = await readRoadmap(dir);
    const proj = (roadmap.projects as Record<string, unknown>[])[0]!;
    expect(proj.name).toBe("X Prime");
    expect(proj.color).toBe("#000000");
  });

  it("refuses to delete a project with assignments unless cleared", async () => {
    const dir = await makeProject();
    await handleProjectCreate({ id: "x", name: "X", phase: "ops" }, "md", dir);
    await handleTicketCreate(
      { title: "T", type: "task", phase: "ops", description: "", blockedBy: [], parentTicket: null, project: "x" },
      "md",
      dir,
    );
    await expect(handleProjectDelete("x", false, "md", dir)).rejects.toThrow(/--clear-assignments/);

    const result = await handleProjectDelete("x", true, "md", dir);
    expect(result.output).toContain("1 assignment(s) cleared");
    const { state } = await loadProject(dir);
    expect(state.tickets[0]!.project).toBeNull();
    expect(state.roadmap.projects ?? []).toHaveLength(0);
  });
});

describe("ticket project assignment", () => {
  it("assigns and clears via ticket update", async () => {
    const dir = await makeProject();
    await handleProjectCreate({ id: "x", name: "X", phase: "ops" }, "md", dir);
    await handleTicketCreate(
      { title: "T", type: "task", phase: "ops", description: "", blockedBy: [], parentTicket: null },
      "md",
      dir,
    );
    await handleTicketUpdate("T-001", { project: "x" }, "md", dir);
    let { state } = await loadProject(dir);
    expect(state.tickets[0]!.project).toBe("x");

    await handleTicketUpdate("T-001", { project: null }, "md", dir);
    ({ state } = await loadProject(dir));
    expect(state.tickets[0]!.project).toBeNull();
  });

  it("rejects assignment to a project in another phase", async () => {
    const dir = await makeProject();
    await handlePhaseCreate(
      { id: "later", name: "Later", label: "LATER", description: "d", after: "ops", atStart: false },
      "md",
      dir,
    );
    await handleProjectCreate({ id: "x", name: "X", phase: "later" }, "md", dir);
    await handleTicketCreate(
      { title: "T", type: "task", phase: "ops", description: "", blockedBy: [], parentTicket: null },
      "md",
      dir,
    );
    await expect(handleTicketUpdate("T-001", { project: "x" }, "md", dir)).rejects.toThrow(
      /belongs to phase "later"/,
    );
  });

  it("clears a stale assignment when the ticket moves phase", async () => {
    const dir = await makeProject();
    await handlePhaseCreate(
      { id: "later", name: "Later", label: "LATER", description: "d", after: "ops", atStart: false },
      "md",
      dir,
    );
    await handleProjectCreate({ id: "x", name: "X", phase: "ops" }, "md", dir);
    await handleTicketCreate(
      { title: "T", type: "task", phase: "ops", description: "", blockedBy: [], parentTicket: null, project: "x" },
      "md",
      dir,
    );
    await handleTicketUpdate("T-001", { phase: "later" }, "md", dir);
    const { state } = await loadProject(dir);
    expect(state.tickets[0]!.project).toBeNull();
  });
});

describe("phase state via handlers", () => {
  it("sets and clears state through handlePhaseRename", async () => {
    const dir = await makeProject();
    await handlePhaseRename("ops", { state: "pending" }, "md", dir);
    let roadmap = await readRoadmap(dir);
    expect((roadmap.phases as Record<string, unknown>[])[0]!.state).toBe("pending");

    await handlePhaseRename("ops", { state: "active" }, "md", dir);
    roadmap = await readRoadmap(dir);
    expect((roadmap.phases as Record<string, unknown>[])[0]!).not.toHaveProperty("state");
  });
});

describe("handleProjectList", () => {
  it("lists projects with assignment counts", () => {
    const roadmap = {
      ...makeRoadmap([makePhase({ id: "ops" })]),
      projects: [{ id: "x", name: "X", phase: "ops" }],
    };
    const state = makeState({
      roadmap,
      tickets: [
        makeTicket({ id: "T-001", phase: "ops", project: "x" }),
        makeTicket({ id: "T-002", phase: "ops" }),
      ],
    });
    const result = handleProjectList(makeCtx({ state }));
    expect(result.output).toContain("**X** (x)");
    expect(result.output).toContain("1 tickets");
  });

  it("filters by phase", () => {
    const roadmap = {
      ...makeRoadmap([makePhase({ id: "ops" }), makePhase({ id: "later" })]),
      projects: [
        { id: "x", name: "X", phase: "ops" },
        { id: "y", name: "Y", phase: "later" },
      ],
    };
    const result = handleProjectList(makeCtx({ state: makeState({ roadmap }) }), "later");
    expect(result.output).toContain("Y");
    expect(result.output).not.toContain("X");
  });
});

describe("handleProjectMigrateSidecar", () => {
  it("imports definitions and phase-matching assignments, then parks the sidecar", async () => {
    const dir = await makeProject();
    await handlePhaseCreate(
      { id: "later", name: "Later", label: "LATER", description: "d", after: "ops", atStart: false },
      "md",
      dir,
    );
    await handleTicketCreate(
      { title: "A", type: "task", phase: "ops", description: "", blockedBy: [], parentTicket: null },
      "md",
      dir,
    );
    await handleTicketCreate(
      { title: "B", type: "task", phase: "later", description: "", blockedBy: [], parentTicket: null },
      "md",
      dir,
    );
    await writeFile(
      join(dir, ".story", "projects.json"),
      JSON.stringify({
        version: 1,
        projects: [{ id: "x", name: "X", phase: "ops", color: "#123456" }],
        assignments: { "T-001": "x", "T-002": "x", "T-999": "x" },
      }),
    );

    const result = await handleProjectMigrateSidecar("json", dir);
    const summary = JSON.parse(result.output).data;
    expect(summary.projectsImported).toBe(1);
    expect(summary.assignmentsApplied).toBe(1); // T-001 only
    expect(summary.assignmentsSkipped.length).toBe(2); // T-002 phase mismatch, T-999 missing

    const { state } = await loadProject(dir);
    expect(state.roadmap.projects).toEqual([{ id: "x", name: "X", phase: "ops", color: "#123456" }]);
    expect(state.ticketByID("T-001")!.project).toBe("x");
    expect(state.ticketByID("T-002")!.project).toBeUndefined();

    await expect(access(join(dir, ".story", "projects.json"))).rejects.toThrow();
    await access(join(dir, ".story", "projects.json.migrated.bak"));
  });

  it("errors cleanly when no sidecar exists", async () => {
    const dir = await makeProject();
    const result = await handleProjectMigrateSidecar("md", dir);
    expect(result.errorCode).toBe("not_found");
  });
});
