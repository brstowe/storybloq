/**
 * T-520 acceptance: the four issues, end to end, from a node board.
 *
 * ISS-1183 (validate red on every cross-board citation), ISS-1180 (the
 * plan-pin gate refusing a node plan that names a root ruling, whose
 * workaround was minting a local COPY of the ruling), and the write path,
 * which refused the citation before either of them could be reached.
 *
 * ONE DEVIATION FROM THE TICKET'S ACCEPTANCE, deliberate and reported:
 * the ticket asks for `citation_unresolved_upward` "on a node whose
 * orchestrator is unrecorded OR unreadable", and tests it by REMOVING the
 * pointer. That case cannot exist. A node's only node-side marker IS the
 * pointer (`config.type` is the stack string, and root discovery is
 * registry-based from the orchestrator down), so a node with the pointer
 * removed is byte-identically a plain project -- which the same acceptance
 * bullet requires to keep today's `dangling_ruling_citation` ERROR. The two
 * clauses contradict each other. The warning therefore fires for a RECORDED
 * pointer whose board cannot be read, which is the case that is both
 * detectable and worth warning about, and the removed-pointer case is
 * asserted to keep the error.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { validateProject, citingEntitiesOf } from "../../src/core/validation.js";
import { loadUpwardBoardFor } from "../../src/core/ruling-loader.js";
import { loadRulingsSafe } from "../../src/core/ruling-loader.js";
import { loadProject } from "../../src/core/project-loader.js";
import { guardPlanNamesCitedRulings } from "../../src/autonomous/plan-pin-guard.js";
import { handleNodeLink, resolveOrchestratorArg } from "../../src/cli/commands/node.js";
import { resolveOrchestratorRoot } from "../../src/mcp/node-resolution.js";
import type { Ruling } from "../../src/models/ruling.js";

const R_X = "r-0123456789abcdef";
const R_Y = "r-fedcba9876543210";

function ruling(overrides: Partial<Ruling> & { id: string }): Ruling {
  return {
    text: "the owner's decision",
    attribution: "owner-direct",
    recordedBy: { client: "claude", id: "claude-session-abc" },
    date: "2026-09-18",
    scopeTags: [],
    supersedes: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  } as Ruling;
}

function makeBoard(root: string, type: string): void {
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "rulings"]) {
    mkdirSync(join(root, ".story", sub), { recursive: true });
  }
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type, language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-09-18",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "t" }], blockers: [],
  }));
}

function writeTicket(root: string, id: string, citesRulings: string[]): void {
  writeFileSync(join(root, ".story", "tickets", `${id}.json`), JSON.stringify({
    id, title: "A node ticket", description: "does something", type: "task",
    status: "inprogress", phase: "p1", order: 10, createdDate: "2026-09-18",
    completedDate: null, blockedBy: [], citesRulings,
  }));
}

/** Every file under the board's `.story/`, with its bytes, for an exact no-write assertion. */
function snapshotBoard(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}/`);
      else out[rel] = readFileSync(join(dir, entry.name), "utf-8");
    }
  };
  walk(join(root, ".story"), "");
  return out;
}

function writeIssue(root: string, id: string, citesRulings: string[]): void {
  writeFileSync(join(root, ".story", "issues", `${id}.json`), JSON.stringify({
    id, title: "A node issue", status: "open", severity: "medium", components: [],
    impact: "test", resolution: null, location: [], discoveredDate: "2026-09-18",
    resolvedDate: null, relatedTickets: [], citesRulings,
  }));
}

describe("T-520 acceptance: a node board citing its orchestrator's rulings", () => {
  let base: string;
  let orch: string;
  let node: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "t520-acc-"));
    orch = join(base, "orchestrator");
    node = join(base, "node");
    mkdirSync(orch, { recursive: true });
    mkdirSync(node, { recursive: true });
    makeBoard(orch, "orchestrator");
    makeBoard(node, "npm");
    writeFileSync(join(orch, ".story", "rulings", `${R_X}.json`), JSON.stringify(ruling({ id: R_X })));
    writeTicket(node, "T-001", [R_X]);
  });

  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  async function link(): Promise<void> {
    const result = await handleNodeLink({ orchestrator: orch }, "json", node);
    expect(result.exitCode ?? 0).toBe(0);
  }

  async function validateNode() {
    const { state } = await loadProject(node);
    const scan = loadRulingsSafe(node);
    return validateProject(state, undefined, {
      upwardBoard: loadUpwardBoardFor(node, [...state.tickets, ...state.issues]),
      rulings: scan.rulings,
      unavailableRulingIds: scan.unavailableIds,
      rulingScanCompleteness: scan.scanCompleteness,
      rulingHasUnrecoverableEntries: scan.hasUnrecoverableEntries,
      citingEntityLoadComplete: true,
    });
  }

  // -------------------------------------------------------------------------
  // node link: the backfill, and the field going live
  // -------------------------------------------------------------------------

  it("records the back-pointer on the node's own config", async () => {
    await link();
    const config = JSON.parse(readFileSync(join(node, ".story", "config.json"), "utf-8")) as Record<string, unknown>;
    expect(typeof config.orchestrator).toBe("string");
  });

  it("refuses to link a project to itself", async () => {
    const result = await handleNodeLink({ orchestrator: node }, "json", node);
    expect(result.exitCode).not.toBe(0);
  });

  it("refuses a path that is not a board", async () => {
    const result = await handleNodeLink({ orchestrator: join(base, "nowhere") }, "json", node);
    expect(result.exitCode).not.toBe(0);
  });

  it("is idempotent", async () => {
    await link();
    const again = await handleNodeLink({}, "json", node);
    expect(again.exitCode ?? 0).toBe(0);
    expect(again.output).toContain("unchanged");
  });

  /**
   * The argument is a path typed at a shell, so it is relative to the shell,
   * not to the project the shell happens to be standing in. The fixture puts
   * the orchestrator a sibling of the node, so from a subdirectory two levels
   * down the two readings name two different places -- which is the only way
   * to tell them apart.
   */
  it("resolves a relative argument against the shell's directory, not the node root", () => {
    const deep = join(node, "packages", "api");
    mkdirSync(deep, { recursive: true });
    expect(resolveOrchestratorArg("../../../orchestrator", deep)).toBe(orch);
    // The same string read against the node root, which is what a naive
    // implementation would do, lands outside `base` entirely.
    expect(resolveOrchestratorArg("../../../orchestrator", node)).not.toBe(orch);
  });

  it("links from a subdirectory of the node", async () => {
    const deep = join(node, "packages", "api");
    mkdirSync(deep, { recursive: true });
    const result = await handleNodeLink(
      { orchestrator: resolveOrchestratorArg("../../../orchestrator", deep) },
      "json",
      node,
    );
    expect(result.exitCode ?? 0).toBe(0);
    const config = JSON.parse(readFileSync(join(node, ".story", "config.json"), "utf-8")) as Record<string, unknown>;
    expect(typeof config.orchestrator).toBe("string");
  });

  it("passes an absolute argument through unchanged", () => {
    expect(resolveOrchestratorArg(orch, join(base, "somewhere-else"))).toBe(orch);
  });

  /**
   * Tilde is deliberately NOT expanded here -- `resolve()` would make
   * `<cwd>/~/orch` out of it, and the expansion that works lives in
   * `resolveNodePath`. This pins the pass-through so nobody "fixes" it by
   * adding a second expansion.
   */
  it("leaves a tilde path for the resolver to expand", () => {
    expect(resolveOrchestratorArg("~/orchestrator", node)).toBe("~/orchestrator");
    expect(resolveOrchestratorArg("~", node)).toBe("~");
  });

  /**
   * Absent, blank, and non-string all collapse to `undefined` so the handler
   * reaches its "revalidate what is recorded" branch rather than being handed
   * the current directory. An empty string resolves to the cwd, which is the
   * node itself, and would come back as a self-reference error naming a path
   * the user never typed.
   */
  it("treats an absent or blank argument as no argument", () => {
    expect(resolveOrchestratorArg(undefined, node)).toBeUndefined();
    expect(resolveOrchestratorArg("", node)).toBeUndefined();
    expect(resolveOrchestratorArg("   ", node)).toBeUndefined();
    expect(resolveOrchestratorArg(42, node)).toBeUndefined();
  });

  /**
   * The gate that keeps every other project out of this feature's cost.
   *
   * `validateProject` runs on a lot of paths, and `loadUpwardBoardFor` is what
   * decides whether any of them read a second board. It must say no when
   * nothing cites a ruling, even on a properly linked node. Found by a mutant:
   * removing this gate passed every other test, because the sibling gate in
   * `buildCitationInputs` was the only one with a test on it.
   */
  it("reads no other board when nothing on this one cites a ruling", async () => {
    await link();
    expect(loadUpwardBoardFor(node, [{ id: "T-002" } as never])).toBeUndefined();
    expect(loadUpwardBoardFor(node, [{ citesRulings: [] } as never])).toBeUndefined();
    expect(loadUpwardBoardFor(node, [])).toBeUndefined();
    // ...and yes when something does, so the assertions above are about the
    // citations and not about the link being broken.
    expect(loadUpwardBoardFor(node, [{ citesRulings: [R_X] } as never])).toMatchObject({ kind: "board" });
  });

  it("reads no other board on a project that records no orchestrator", () => {
    expect(loadUpwardBoardFor(node, [{ citesRulings: [R_X] } as never])).toBeUndefined();
  });

  /**
   * `writeOrchestratorPointer` round-trips the config through the schema
   * parser. `ConfigSchema` ends in `.passthrough()`, so unknown keys survive
   * -- but that is exactly the kind of claim that should be pinned rather than
   * asserted from reading a schema, because the cost of being wrong is
   * silently eating a field some other writer owns.
   */
  it("keeps config fields it knows nothing about", async () => {
    const path = join(node, ".story", "config.json");
    const before = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...before, macApp: { pinned: true }, somethingElse: [1, 2] }));

    await link();

    const after = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(after.macApp).toEqual({ pinned: true });
    expect(after.somethingElse).toEqual([1, 2]);
    expect(typeof after.orchestrator).toBe("string");
  });

  it("treats an unreadable config as unverifiable, not as 'no orchestrator'", async () => {
    await link();
    writeFileSync(join(node, ".story", "config.json"), "{ not json");
    const pointer = resolveOrchestratorRoot(node);
    expect(pointer).toMatchObject({ ok: false, code: "unreadable" });
  });

  it("treats a missing config as simply not a project here", () => {
    const empty = mkdtempSync(join(tmpdir(), "t520-empty-"));
    try {
      expect(resolveOrchestratorRoot(empty)).toMatchObject({ ok: false, code: "no-pointer" });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // ISS-1183: validate
  // -------------------------------------------------------------------------

  it("is clean on a linked node citing a root ruling", async () => {
    await link();
    const result = await validateNode();
    expect(result.findings.filter((f) => f.level === "error")).toEqual([]);
  });

  it("keeps today's ERROR on a project that records no orchestrator", async () => {
    const result = await validateNode();
    const errors = result.findings.filter((f) => f.level === "error");
    expect(errors.map((f) => f.code)).toContain("dangling_ruling_citation");
    // The exact code and message other tooling greps for, unchanged.
    expect(errors[0]?.message).toBe("T-001 cites " + R_X + ", which does not exist.");
  });

  it("warns rather than errors when a RECORDED orchestrator cannot be read", async () => {
    await link();
    chmodSync(join(orch, ".story", "rulings"), 0o000);
    try {
      const result = await validateNode();
      expect(result.findings.filter((f) => f.level === "error")).toEqual([]);
      expect(result.findings.map((f) => f.code)).toContain("citation_unresolved_upward");
    } finally {
      chmodSync(join(orch, ".story", "rulings"), 0o755);
    }
  });

  /**
   * Two different failures produce `citation_unresolved_upward`: a recorded
   * orchestrator whose ledger could not be read, and this project's own config
   * failing to parse so we cannot tell whether it records one at all. A fixed
   * message saying "this project records an orchestrator" is a confident false
   * claim in the second case -- on a project that may have no federation at
   * all -- so the message carries the reason the board actually gave.
   *
   * Driven directly rather than through a fixture: every caller loads the
   * project before resolving citations, so a project whose own config will not
   * parse does not reach here today. The message still must not assert
   * something it does not know.
   */
  it("never claims an orchestrator exists when it does not know that", async () => {
    const { state } = await loadProject(node);
    const scan = loadRulingsSafe(node);
    const result = validateProject(state, undefined, {
      upwardBoard: { kind: "unreadable", reason: "node config could not be read (bad JSON)" },
      rulings: scan.rulings,
      unavailableRulingIds: scan.unavailableIds,
      rulingScanCompleteness: scan.scanCompleteness,
      rulingHasUnrecoverableEntries: scan.hasUnrecoverableEntries,
      citingEntityLoadComplete: true,
    });
    const finding = result.findings.find((f) => f.code === "citation_unresolved_upward");
    expect(finding?.message).toContain("node config could not be read");
    expect(finding?.message).not.toContain("records an orchestrator");
  });

  it("still says so plainly when the ORCHESTRATOR's ledger is the thing that failed", async () => {
    await link();
    chmodSync(join(orch, ".story", "rulings"), 0o000);
    try {
      const result = await validateNode();
      const finding = result.findings.find((f) => f.code === "citation_unresolved_upward");
      expect(finding?.message).toContain("ruling ledger could not be read");
    } finally {
      chmodSync(join(orch, ".story", "rulings"), 0o755);
    }
  });

  it("names the board when a root ruling has been superseded", async () => {
    await link();
    writeFileSync(join(orch, ".story", "rulings", `${R_Y}.json`), JSON.stringify(ruling({ id: R_Y, supersedes: R_X })));
    const result = await validateNode();
    const finding = result.findings.find((f) => f.code === "superseded_ruling_citation");
    expect(finding?.level).toBe("warning");
    expect(finding?.board).toBe("orchestrator");
    expect(finding?.message).toContain("on the orchestrator board");
    expect(result.findings.filter((f) => f.level === "error")).toEqual([]);
  });

  it("reports cross-board supersession rather than picking a board", async () => {
    await link();
    // Hand-written: `ruling supersede` refuses a target absent locally.
    writeFileSync(
      join(node, ".story", "rulings", "r-cccccccccccccccc.json"),
      JSON.stringify(ruling({ id: "r-cccccccccccccccc", supersedes: R_X })),
    );
    const result = await validateNode();
    expect(result.findings.map((f) => f.code)).toContain("cross_board_supersession");
  });

  // -------------------------------------------------------------------------
  // The write path does NOT validate citations, and this pins that
  // -------------------------------------------------------------------------

  /**
   * I planned to wire the upward board into the pre/post-write validations in
   * `ticket.ts` and `issue.ts`, on the reasoning that they refuse a write which
   * introduces a new error and a cross-board citation would be one. That
   * reasoning was WRONG, and this pair of tests is what proved it:
   * `validateProject` only runs `validateRulings` when the caller passes
   * `aux.rulings`, and the write path passes no aux at all. Citations are
   * therefore not checked at write time, by any project, and never were.
   *
   * These stay as a standing record, because the wrong conclusion is an easy
   * one to reach from reading those call sites: the write path LOOKS like it
   * validates everything.
   */
  it("accepts a ticket citing a root ruling, because writes do not check citations", async () => {
    await link();
    const { handleTicketCreate } = await import("../../src/cli/commands/ticket.js");
    const result = await handleTicketCreate(
      {
        title: "Cites the root board", description: "A node ticket that honours a root ruling.",
        type: "task", phase: "p1", blockedBy: [], citesRuling: [R_X],
      } as never,
      "json",
      node,
    );
    expect(result.exitCode ?? 0).toBe(0);
  });

  it("also accepts a ticket citing a ruling on NEITHER board, for the same reason", async () => {
    await link();
    const { handleTicketCreate } = await import("../../src/cli/commands/ticket.js");
    const result = await handleTicketCreate(
      {
        title: "Cites nothing real", description: "A node ticket citing a ruling that does not exist.",
        type: "task", phase: "p1", blockedBy: [], citesRuling: ["r-9999999999999999"],
      } as never,
      "json",
      node,
    );
    expect(result.exitCode ?? 0).toBe(0);
    // `validate` is where it is caught, which is exactly where this ticket
    // fixes the cross-board case and leaves the genuinely-dangling case alone.
    const after = await validateNode();
    expect(after.findings.filter((f) => f.code === "dangling_ruling_citation")).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // The leg is READ-ONLY
  // -------------------------------------------------------------------------

  it("writes nothing to the orchestrator board while resolving upward", async () => {
    await link();
    const before = snapshotBoard(orch);
    await validateNode();
    await guardPlanNamesCitedRulings(node, "T-001", `The plan honours ${R_X} throughout.`);
    expect(snapshotBoard(orch)).toEqual(before);
  });

  /**
   * ISSUES cite rulings too, and the read-gate asks `citingEntitiesOf` the same
   * question the citation loop iterates. A mutant narrowing that helper to
   * tickets alone passed everything, because no fixture had an issue citing
   * anything -- so the gate and the loop were only ever tested on one half of
   * their shared population.
   */
  it("resolves an ISSUE's citation upward, not just a ticket's", async () => {
    await link();
    rmSync(join(node, ".story", "tickets", "T-001.json"));
    writeIssue(node, "ISS-001", [R_X]);
    const result = await validateNode();
    expect(result.findings.filter((f) => f.level === "error")).toEqual([]);
    // And the gate itself sees the issue when nothing else cites anything.
    expect(loadUpwardBoardFor(node, citingEntitiesOf((await loadProject(node)).state)))
      .toMatchObject({ kind: "board" });
  });

  /**
   * A branched or cyclic chain is normally reported once from the ruling GRAPH
   * rather than per citation -- but nothing validates the ORCHESTRATOR's graph
   * from a node, so without a per-citation branch these were swallowed
   * entirely and the node was told nothing at all about a broken root chain.
   */
  it("reports a BRANCHED chain on the orchestrator, which nothing else would catch", async () => {
    await link();
    // Two root rulings both claiming to supersede r-X.
    for (const id of ["r-aaaa111111111111", "r-bbbb222222222222"]) {
      writeFileSync(join(orch, ".story", "rulings", `${id}.json`), JSON.stringify(ruling({ id, supersedes: R_X })));
    }
    const result = await validateNode();
    const finding = result.findings.find((f) => f.code === "cross_board_branch_citation");
    expect(finding?.board).toBe("orchestrator");
    expect(finding?.message).toContain("branches on the orchestrator board");
    expect(result.findings.filter((f) => f.level === "error")).toEqual([]);
  });

  it("reports a CYCLIC chain on the orchestrator", async () => {
    await link();
    const other = "r-cccc333333333333";
    writeFileSync(join(orch, ".story", "rulings", `${other}.json`), JSON.stringify(ruling({ id: other, supersedes: R_X })));
    writeFileSync(join(orch, ".story", "rulings", `${R_X}.json`), JSON.stringify(ruling({ id: R_X, supersedes: other })));
    const result = await validateNode();
    expect(result.findings.map((f) => f.code)).toContain("cross_board_cycle_citation");
  });

  it("does NOT double-report a branched chain on this project's own board", async () => {
    // No link: the local graph finding is the only one, exactly as today.
    writeFileSync(join(node, ".story", "rulings", `${R_X}.json`), JSON.stringify(ruling({ id: R_X })));
    for (const id of ["r-dddd444444444444", "r-eeee555555555555"]) {
      writeFileSync(join(node, ".story", "rulings", `${id}.json`), JSON.stringify(ruling({ id, supersedes: R_X })));
    }
    const result = await validateNode();
    expect(result.findings.map((f) => f.code)).toContain("ruling_supersedes_branch");
    expect(result.findings.map((f) => f.code)).not.toContain("cross_board_branch_citation");
  });

  it("says WHOSE ledger is unverifiable when the fault is the orchestrator's", async () => {
    await link();
    // A ruling file on the ROOT board whose id survives in its name but whose
    // content does not parse: that board's own taint, reached through the leg.
    writeFileSync(join(orch, ".story", "rulings", "r-7777777777777777.json"), "{ not json");
    const result = await validateNode();
    const finding = result.findings.find((f) => f.code === "ruling_indeterminate_citation");
    expect(finding?.board).toBe("orchestrator");
    expect(finding?.message).toContain("on the orchestrator board");
  });

  it("says nothing about a board when the fault is this project's own", async () => {
    // No link at all, so there is no other board to blame.
    writeFileSync(join(node, ".story", "rulings", `${R_X}.json`), JSON.stringify(ruling({ id: R_X })));
    writeFileSync(join(node, ".story", "rulings", "r-8888888888888888.json"), "{ not json");
    const result = await validateNode();
    const finding = result.findings.find((f) => f.code === "ruling_indeterminate_citation");
    expect(finding).toBeDefined();
    expect(finding?.board).toBeUndefined();
    expect(finding?.message).not.toContain("orchestrator");
  });

  // -------------------------------------------------------------------------
  // ISS-1180: the plan-pin gate
  // -------------------------------------------------------------------------

  it("passes a node plan that names the root ruling's id", async () => {
    await link();
    const verdict = await guardPlanNamesCitedRulings(node, "T-001", `The plan honours ${R_X} throughout.`);
    expect(verdict.ok).toBe(true);
  });

  it("still refuses the same plan when it does not name the id", async () => {
    await link();
    const verdict = await guardPlanNamesCitedRulings(node, "T-001", "The plan mentions no rulings at all.");
    expect(verdict.ok).toBe(false);
  });

  it("requires the SUCCESSOR's id once the root ruling is superseded", async () => {
    await link();
    writeFileSync(join(orch, ".story", "rulings", `${R_Y}.json`), JSON.stringify(ruling({ id: R_Y, supersedes: R_X })));
    const stale = await guardPlanNamesCitedRulings(node, "T-001", `The plan honours ${R_X} throughout.`);
    expect(stale.ok).toBe(false);
    const current = await guardPlanNamesCitedRulings(node, "T-001", `The plan honours ${R_Y} throughout.`);
    expect(current.ok).toBe(true);
  });
});
