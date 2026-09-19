/**
 * T-520 items 1-4: a node board resolving a citation that lives on its
 * orchestrator board.
 *
 * Four issues are one missing capability, and the shape of the fix is set by
 * two facts the ticket did not carry:
 *
 *  - `config.orchestrator` was a DEAD field. Nothing wrote it and nothing read
 *    it, so the upward leg's precondition was satisfied by zero projects and
 *    "no pointer recorded" is the state every existing federation is in. That
 *    case must therefore be byte-identical to today, not merely close.
 *  - `handleRulingSupersede` refuses a target absent from the LOCAL ledger
 *    (cli/commands/ruling.ts:391), in both directions, so cross-board
 *    supersession cannot be produced through the CLI or MCP at all. It is
 *    still reachable by hand-editing a file, which `.story/` supports by
 *    design -- hence the hand-written fixtures at the bottom of this file.
 *
 * The taint rule here is the pen's ruling of 2026-09-18, which overrides the
 * ticket's own text: a RECORDED pointer whose board cannot be read taints
 * local conclusions, because an orchestrator ruling may name a local id in its
 * `supersedes` and that edge is visible only on the orchestrator board. No
 * pointer, no change, ever.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildCitationInputs } from "../../src/core/ruling-loader.js";
import { resolveCitation } from "../../src/core/ruling.js";
import { resolveOrchestratorRoot } from "../../src/mcp/node-resolution.js";
import type { Ruling } from "../../src/models/ruling.js";

const R_X = "r-0123456789abcdef";
const R_Y = "r-fedcba9876543210";
const R_LOCAL = "r-aaaaaaaaaaaaaaaa";

function ruling(overrides: Partial<Ruling> & { id: string }): Ruling {
  return {
    text: "some ruling text",
    attribution: "owner-direct",
    recordedBy: { client: "claude", id: "claude-session-abc" },
    date: "2026-09-18",
    scopeTags: [],
    supersedes: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  } as Ruling;
}

function makeBoard(root: string, type: "orchestrator" | "npm"): void {
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "rulings"]) {
    mkdirSync(join(root, ".story", sub), { recursive: true });
  }
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type, language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-09-18", phases: [], blockers: [],
  }));
}

function writeRuling(root: string, r: Ruling): void {
  writeFileSync(join(root, ".story", "rulings", `${r.id}.json`), JSON.stringify(r));
}

/** Records the back-pointer the way `node link` will: on the NODE's own config. */
function linkToOrchestrator(nodeRoot: string, orchRoot: string): void {
  const path = join(nodeRoot, ".story", "config.json");
  const config = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...config, orchestrator: orchRoot }));
}

describe("T-520: upward citation resolution from a node board", () => {
  let orch: string;
  let node: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "t520-"));
    orch = join(base, "orchestrator");
    node = join(base, "node");
    mkdirSync(orch, { recursive: true });
    mkdirSync(node, { recursive: true });
    makeBoard(orch, "orchestrator");
    makeBoard(node, "npm");
    // r-X on the ROOT board, superseded there by r-Y.
    writeRuling(orch, ruling({ id: R_X }));
    writeRuling(orch, ruling({ id: R_Y, supersedes: R_X }));
  });

  afterEach(() => {
    rmSync(join(orch, ".."), { recursive: true, force: true });
  });

  /** The temp dir both boards live under. */
  function base(): string {
    return join(orch, "..");
  }

  function resolveFromNode(citedId: string) {
    const ctx = buildCitationInputs(node, [citedId]);
    return resolveCitation(citedId, ctx);
  }

  // -------------------------------------------------------------------------
  // The pointer itself
  // -------------------------------------------------------------------------

  it("reports no pointer on a node that has not been linked", () => {
    expect(resolveOrchestratorRoot(node)).toMatchObject({ ok: false, code: "no-pointer" });
  });

  it("resolves a recorded pointer to the orchestrator root", () => {
    linkToOrchestrator(node, orch);
    const result = resolveOrchestratorRoot(node);
    expect(result.ok).toBe(true);
    expect(result.ok && result.root).toBe(realpathSync(orch));
  });

  it("refuses a pointer at a path that is not a board", () => {
    linkToOrchestrator(node, join(orch, "..", "nowhere"));
    expect(resolveOrchestratorRoot(node)).toMatchObject({ ok: false, code: "unreadable" });
  });

  it("refuses a pointer at the node itself", () => {
    linkToOrchestrator(node, node);
    expect(resolveOrchestratorRoot(node)).toMatchObject({ ok: false, code: "unreadable" });
  });

  // -------------------------------------------------------------------------
  // An unlinked node is today's behaviour, exactly
  // -------------------------------------------------------------------------

  it("returns missing for a root ruling when no pointer is recorded", () => {
    expect(resolveFromNode(R_X)).toMatchObject({ status: "missing", citedId: R_X });
  });

  it("does no orchestrator read at all when nothing is cited", () => {
    linkToOrchestrator(node, orch);
    const ctx = buildCitationInputs(node, []);
    expect(ctx.upward).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // The leg
  // -------------------------------------------------------------------------

  it("resolves a root ruling from the node and names the board", () => {
    linkToOrchestrator(node, orch);
    const result = resolveFromNode(R_X);
    expect(result.status).toBe("resolved");
    expect(result).toMatchObject({ board: "orchestrator", stale: true });
    expect(result.status === "resolved" && result.current.id).toBe(R_Y);
  });

  it("follows the supersedes chain on the board the ruling lives on", () => {
    linkToOrchestrator(node, orch);
    const result = resolveFromNode(R_Y);
    expect(result).toMatchObject({ status: "resolved", board: "orchestrator", stale: false });
  });

  it("still returns missing for an id on neither board", () => {
    linkToOrchestrator(node, orch);
    expect(resolveFromNode("r-1111111111111111")).toMatchObject({ status: "missing" });
  });

  it("never consults the orchestrator for an id that resolves locally", () => {
    linkToOrchestrator(node, orch);
    writeRuling(node, ruling({ id: R_LOCAL }));
    const result = resolveFromNode(R_LOCAL);
    expect(result).toMatchObject({ status: "resolved", stale: false });
    expect("board" in result).toBe(false);
  });

  /**
   * The SAME id on both boards. Not a hypothetical: ISS-1180 reports node
   * seats minting local COPIES of root rulings to get past the plan-pin gate,
   * and a copy made by hand keeps the id it was copied from. So one id in two
   * places is the exact wreckage this ticket is cleaning up.
   *
   * Both cases below were found by a mutant -- consulting the orchestrator
   * BEFORE the local ledger passed every other test in this file, because no
   * other test puts an id on both boards.
   */
  it("prefers the LOCAL ruling when the same id exists on both boards", () => {
    linkToOrchestrator(node, orch);
    // A copy of a root ruling that nothing has superseded anywhere.
    const shared = "r-4444444444444444";
    writeRuling(orch, ruling({ id: shared, text: "the root's original" }));
    writeRuling(node, ruling({ id: shared, text: "the node's copy" }));
    const result = resolveFromNode(shared);
    expect(result.status).toBe("resolved");
    // No board marker: this resolution never left the project. The upward leg
    // is a FALLBACK for an id this board does not have, never an override of
    // one it does.
    expect("board" in result).toBe(false);
    expect(result.status === "resolved" && result.cited.text).toBe("the node's copy");
  });

  it("refuses a local copy whose original the root board has since superseded", () => {
    linkToOrchestrator(node, orch);
    // The copy looks current locally; the root board says it is not. Returning
    // the copy as `current` would be the staleness ISS-1180 is about, so this
    // reports rather than resolves.
    writeRuling(node, ruling({ id: R_X, text: "the node's stale copy" }));
    expect(resolveFromNode(R_X)).toMatchObject({
      status: "indeterminate",
      reason: "cross-board-supersession",
    });
  });

  // -------------------------------------------------------------------------
  // C3: the taint, which is the pen's ruling over the ticket's text
  // -------------------------------------------------------------------------

  it("taints local conclusions when a RECORDED orchestrator cannot be read", () => {
    linkToOrchestrator(node, orch);
    writeRuling(node, ruling({ id: R_LOCAL }));
    chmodSync(join(orch, ".story", "rulings"), 0o000);
    try {
      expect(resolveFromNode(R_LOCAL)).toMatchObject({
        status: "indeterminate",
        reason: "unreadable-orchestrator",
      });
    } finally {
      chmodSync(join(orch, ".story", "rulings"), 0o755);
    }
  });

  it("leaves local conclusions alone when no pointer is recorded, whatever the root board is doing", () => {
    writeRuling(node, ruling({ id: R_LOCAL }));
    chmodSync(join(orch, ".story", "rulings"), 0o000);
    try {
      expect(resolveFromNode(R_LOCAL)).toMatchObject({ status: "resolved", stale: false });
    } finally {
      chmodSync(join(orch, ".story", "rulings"), 0o755);
    }
  });

  it("reports an unreadable recorded orchestrator rather than missing, for an id it cannot check", () => {
    linkToOrchestrator(node, orch);
    chmodSync(join(orch, ".story", "rulings"), 0o000);
    try {
      expect(resolveFromNode(R_X)).toMatchObject({
        status: "indeterminate",
        reason: "unreadable-orchestrator",
      });
    } finally {
      chmodSync(join(orch, ".story", "rulings"), 0o755);
    }
  });

  // -------------------------------------------------------------------------
  // Whose ledger is broken: an orchestrator-side fault says so
  // -------------------------------------------------------------------------

  /**
   * A node reader told "chain state unverifiable" with no board goes looking
   * through its OWN `.story/rulings/`, which is the one directory that is
   * definitely fine. Every non-resolved status that is a statement about the
   * ORCHESTRATOR's ledger carries the board -- except `missing`, which is a
   * statement about both boards at once and belongs to neither.
   */
  it("names the orchestrator when the fault is on the orchestrator's ledger", () => {
    linkToOrchestrator(node, orch);
    // A ruling file whose id is recoverable from its NAME but whose content is
    // not readable: the root board's own `unavailableIds` taint.
    writeFileSync(join(orch, ".story", "rulings", "r-5555555555555555.json"), "{ not json");
    const result = resolveFromNode(R_X);
    expect(result).toMatchObject({
      status: "indeterminate",
      reason: "unreadable-successor",
      board: "orchestrator",
    });
  });

  it("does not name a board when the id is on neither", () => {
    linkToOrchestrator(node, orch);
    const result = resolveFromNode("r-1111111111111111");
    expect(result.status).toBe("missing");
    expect("board" in result).toBe(false);
  });

  it("does not name a board for a fault on the node's OWN ledger", () => {
    linkToOrchestrator(node, orch);
    writeRuling(node, ruling({ id: R_LOCAL }));
    writeFileSync(join(node, ".story", "rulings", "r-6666666666666666.json"), "{ not json");
    const result = resolveFromNode(R_LOCAL);
    expect(result).toMatchObject({ status: "indeterminate", reason: "unreadable-successor" });
    expect("board" in result).toBe(false);
  });

  it("reports the path it TRIED when a recorded pointer cannot be followed", () => {
    linkToOrchestrator(node, join(base(), "nowhere"));
    const ctx = buildCitationInputs(node, [R_X]);
    expect(ctx.upward).toMatchObject({ kind: "unreadable" });
    const upward = ctx.upward as { attemptedPath?: string };
    // Whatever it names, it must not be the node itself.
    expect(upward.attemptedPath).not.toBe(node);
    expect(upward.attemptedPath).toContain("nowhere");
  });

  // -------------------------------------------------------------------------
  // C5: cross-board supersession, detected and refused, never merged
  // -------------------------------------------------------------------------

  it("refuses to pick a side when a LOCAL ruling supersedes a root ruling", () => {
    linkToOrchestrator(node, orch);
    // Hand-written: `ruling supersede` refuses a target absent locally.
    writeRuling(node, ruling({ id: R_LOCAL, supersedes: R_X }));
    expect(resolveFromNode(R_X)).toMatchObject({
      status: "indeterminate",
      reason: "cross-board-supersession",
    });
  });

  it("refuses to pick a side when a ROOT ruling supersedes a local ruling", () => {
    linkToOrchestrator(node, orch);
    writeRuling(node, ruling({ id: R_LOCAL }));
    // The symmetric case, and the one only a check against the ORCHESTRATOR's
    // successor index on a LOCAL HIT can ever see.
    writeRuling(orch, ruling({ id: "r-2222222222222222", supersedes: R_LOCAL }));
    expect(resolveFromNode(R_LOCAL)).toMatchObject({
      status: "indeterminate",
      reason: "cross-board-supersession",
    });
  });

  it("does not report cross-board supersession for an ordinary same-board chain", () => {
    linkToOrchestrator(node, orch);
    writeRuling(node, ruling({ id: R_LOCAL }));
    writeRuling(node, ruling({ id: "r-3333333333333333", supersedes: R_LOCAL }));
    expect(resolveFromNode(R_LOCAL)).toMatchObject({ status: "resolved", stale: true });
  });
});
