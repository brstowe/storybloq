/**
 * T-507 commit B: `storybloq roster start|heartbeat|end|list [--all]`.
 *
 * The write commands are what the Claude Code Mod runs through
 * `$.process.run`, so their contract is machine-first: one JSON envelope on
 * stdout, `no_project` when the cwd is not inside a ledger (the Mod caches
 * that per cwd and stops calling), `invalid_input` for a bad body, and the
 * core's own refusal reasons passed through verbatim.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initProject } from "../../../src/core/init.js";
import { loadProject } from "../../../src/core/project-loader.js";
import { handleRosterWrite, handleRosterList, parseRosterBody } from "../../../src/cli/commands/roster.js";
import { readRoster, ROSTER_STALE_MS } from "../../../src/core/roster.js";
import type { CommandContext } from "../../../src/cli/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "roster-cli-"));
  roots.push(root);
  await initProject(root, { name: "roster" });
  return root;
}

async function ctxAt(root: string, format: "json" | "md" = "json"): Promise<CommandContext> {
  const { state, warnings } = await loadProject(root);
  return { state, warnings, root, handoversDir: join(root, ".story", "handovers"), format };
}

const T0 = Date.parse("2026-09-15T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const identity = { client: "claude" as const, clientTaskId: "sess-1" };
const parse = (r: { output: string }) => JSON.parse(r.output) as { version: number; data?: Record<string, unknown>; error?: { code: string; message: string } };

describe("handleRosterWrite", () => {
  it("start: identity from the environment fallback, sessionId defaults to the task id, envelope carries the seat and its generation", async () => {
    const root = await project();
    const r = handleRosterWrite(root, "start", {}, identity, iso(T0));
    expect(r.exitCode).toBe(0);
    const env = parse(r);
    expect(env.version).toBe(1);
    expect(env.data).toMatchObject({ ok: true, seatId: "claude:sess-1", generation: 1 });
    expect((env.data!.seat as { sessionId: string }).sessionId).toBe("sess-1");
    expect(readRoster(root, T0).seats.map((s) => s.seatId)).toEqual(["claude:sess-1"]);
  });

  it("start for a subagent seat takes agentId, description and the parent's sessionId from the body; the body wins over the fallback", async () => {
    const root = await project();
    const body = { clientTaskId: "sess-9", agentId: "ag-1", sessionId: "sess-9", description: "reads README" };
    const r = handleRosterWrite(root, "start", body, identity, iso(T0));
    expect(parse(r).data).toMatchObject({ ok: true, seatId: "claude:sess-9/ag-1" });
  });

  it("heartbeat and end require the generation and pass the core's refusal through as refused_transition", async () => {
    const root = await project();
    handleRosterWrite(root, "start", {}, identity, iso(T0));
    const beat = handleRosterWrite(root, "heartbeat", { generation: 1 }, identity, iso(T0 + 5));
    expect(parse(beat).data).toMatchObject({ ok: true, generation: 1 });
    const missing = handleRosterWrite(root, "heartbeat", {}, identity, iso(T0 + 6));
    expect(missing.exitCode).not.toBe(0);
    expect(parse(missing).error!.code).toBe("invalid_input");
    const end = handleRosterWrite(root, "end", { generation: 1, state: "completed" }, identity, iso(T0 + 7));
    expect(parse(end).data).toMatchObject({ ok: true, state: "completed" });
    const late = handleRosterWrite(root, "heartbeat", { generation: 1 }, identity, iso(T0 + 8));
    expect(late.exitCode).not.toBe(0);
    expect(parse(late).error).toMatchObject({ code: "refused_transition" });
  });

  it("end without a state, or with a state outside the terminal set, is invalid_input", async () => {
    const root = await project();
    handleRosterWrite(root, "start", {}, identity, iso(T0));
    expect(parse(handleRosterWrite(root, "end", { generation: 1 }, identity, iso(T0 + 1))).error!.code).toBe("invalid_input");
    expect(parse(handleRosterWrite(root, "end", { generation: 1, state: "running" }, identity, iso(T0 + 1))).error!.code).toBe("invalid_input");
  });

  it("no project: a structured no_project error and a non-zero exit code (the spawn suite proves nothing is written)", () => {
    const r = handleRosterWrite(null, "start", {}, identity, iso(T0));
    expect(r.exitCode).not.toBe(0);
    expect(parse(r).error).toMatchObject({ code: "no_project" });
  });

  it("no identity at all (no body, no environment) is invalid_input naming clientTaskId", async () => {
    const root = await project();
    const r = handleRosterWrite(root, "start", {}, null, iso(T0));
    expect(parse(r).error!.code).toBe("invalid_input");
    expect(parse(r).error!.message).toMatch(/clientTaskId/);
  });

  it("a restart of the same identity under a new session id advances the generation in place", async () => {
    const root = await project();
    handleRosterWrite(root, "start", {}, identity, iso(T0));
    handleRosterWrite(root, "end", { generation: 1, state: "detached" }, identity, iso(T0 + 1));
    const again = handleRosterWrite(root, "start", { sessionId: "sess-1-b" }, identity, iso(T0 + 2));
    expect(parse(again).data).toMatchObject({ ok: true, seatId: "claude:sess-1", generation: 2 });
    expect(readRoster(root, T0 + 2).seats).toHaveLength(1);
  });
});

describe("parseRosterBody", () => {
  it("accepts a JSON object, refuses anything else with a message", () => {
    expect(parseRosterBody('{"generation":1}')).toEqual({ ok: true, body: { generation: 1 } });
    expect(parseRosterBody("[1]")).toMatchObject({ ok: false });
    expect(parseRosterBody("nope")).toMatchObject({ ok: false });
    expect(parseRosterBody("")).toEqual({ ok: true, body: {} });
  });
});

describe("handleRosterList", () => {
  it("hides terminal seats by default and shows them with --all; JSON carries the counts and both truncation flags", async () => {
    const root = await project();
    handleRosterWrite(root, "start", { clientTaskId: "live" }, identity, iso(T0 + ROSTER_STALE_MS));
    handleRosterWrite(root, "start", { clientTaskId: "stale" }, identity, iso(T0));
    handleRosterWrite(root, "start", { clientTaskId: "done" }, identity, iso(T0 + ROSTER_STALE_MS));
    handleRosterWrite(root, "end", { clientTaskId: "done", generation: 1, state: "killed" }, identity, iso(T0 + ROSTER_STALE_MS));
    const now = T0 + ROSTER_STALE_MS + 1;
    const some = JSON.parse((await handleRosterList(await ctxAt(root), { all: false }, now)).output).data;
    expect(some.seats.map((s: { seatId: string }) => s.seatId).sort()).toEqual(["claude:live", "claude:stale"]);
    expect(some).toMatchObject({ live: 1, stale: 1, terminal: 1, includesTerminal: false, scanTruncated: false, resultTruncated: false });
    const all = JSON.parse((await handleRosterList(await ctxAt(root), { all: true }, now)).output).data;
    expect(all.seats.map((s: { seatId: string }) => s.seatId).sort()).toEqual(["claude:done", "claude:live", "claude:stale"]);
    expect(all.includesTerminal).toBe(true);
  });

  it("markdown renders exactly one table row per seat with the seat's columns in order", async () => {
    const root = await project();
    handleRosterWrite(root, "start", { clientTaskId: "live", agentId: "ag-1", description: "greps the tree" }, identity, iso(T0));
    handleRosterWrite(root, "start", { clientTaskId: "old" }, identity, iso(T0 - ROSTER_STALE_MS - 1));
    const md = (await handleRosterList(await ctxAt(root, "md"), { all: false }, T0 + 1)).output;
    const rows = md.split("\n").filter((l) => l.startsWith("| claude:"));
    expect(rows).toHaveLength(2);
    const cells = (row: string) => row.split("|").slice(1, -1).map((c) => c.trim());
    const byId = new Map(rows.map((r) => [cells(r)[0], cells(r)]));
    expect(byId.get("claude:live/ag-1")).toEqual(["claude:live/ag-1", "running", "no", "mod", "1", iso(T0), "greps the tree"]);
    expect(byId.get("claude:old")).toEqual(["claude:old", "running", "yes", "mod", "1", iso(T0 - ROSTER_STALE_MS - 1), ""]);
    expect(md.split("\n").filter((l) => l.startsWith("Seats:"))).toEqual(["Seats: 1 live, 1 stale, 0 terminal (hidden; pass --all)"]);
  });
});
