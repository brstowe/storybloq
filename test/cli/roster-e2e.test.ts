/**
 * T-507 commit B: `storybloq roster start|heartbeat|end` at the process
 * boundary the Mod uses (`$.process.run` with `--stdin --format json`).
 * Runs the BUILT bundle (dist/cli.js, `npm run build` first) under the
 * isolated E2E fixture: stdin body over flags over environment identity, one
 * JSON envelope on stdout, the real exit status, `no_project` writes nothing,
 * an unreadable .story/ is `io_error` (never a cached no_project), and the
 * body ceiling answers invalid_input.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2ECliFixture, runE2ECli, parseE2EJson } from "../helpers/e2e-cli.js";
import { initProject } from "../../src/core/init.js";
import { readRoster } from "../../src/core/roster.js";

let fixture: E2ECliFixture;
beforeAll(async () => {
  fixture = await E2ECliFixture.create();
});
afterAll(async () => {
  fixture.assertNoHousekeepingNotices();
  await fixture.cleanup();
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { chmodSync(join(d, ".story"), 0o755); } catch { /* not every dir has one */ }
    rmSync(d, { recursive: true, force: true });
  }
});

async function project(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "roster-e2e-"));
  dirs.push(root);
  await initProject(root, { name: "roster-e2e" });
  return root;
}

function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      out.push(rel + name);
      if (statSync(full).isDirectory()) walk(full, rel + name + "/");
    }
  };
  walk(dir, "");
  return out.sort();
}

type Envelope = { version: number; data?: Record<string, unknown>; error?: { code: string; message: string } };

// The project-root overrides are cleared so discovery walks from the spawned
// cwd: an inherited STORYBLOQ_PROJECT_ROOT would point every write at some
// other checkout and make the no-project case meaningless. An empty value
// falls through to the walk (project-root-shared.ts tests the value's truth).
const IDENTITY = { CLAUDE_CODE_SESSION_ID: "env-task", STORYBLOQ_CLIENT: "claude", STORYBLOQ_PROJECT_ROOT: "", CLAUDESTORY_PROJECT_ROOT: "" };

describe("storybloq roster (spawned CLI)", () => {
  it("start: the stdin body wins over the flag, the flag over the environment; exactly one JSON envelope on stdout; exit 0", async () => {
    const root = await project();
    const r = runE2ECli(fixture, ["roster", "start", "--stdin", "--client-task-id", "flag-task", "--description", "from flag", "--format", "json"], {
      cwd: root,
      env: IDENTITY,
      input: JSON.stringify({ clientTaskId: "body-task", sessionId: "sess-body" }),
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n").filter((l) => l.startsWith("{"))).toHaveLength(1);
    const env = parseE2EJson<Envelope>(r);
    expect(env.data).toMatchObject({ ok: true, seatId: "claude:body-task", generation: 1 });
    expect(env.data!.seat).toMatchObject({ sessionId: "sess-body", description: "from flag" });
    expect(readRoster(root, Date.now()).seats.map((s) => s.seatId)).toEqual(["claude:body-task"]);
  });

  it("heartbeat and end: flags alone with environment identity; a stale generation is refused_transition with a non-zero exit", async () => {
    const root = await project();
    const started = parseE2EJson<Envelope>(runE2ECli(fixture, ["roster", "start"], { cwd: root, env: IDENTITY }));
    expect(started.data).toMatchObject({ seatId: "claude:env-task", generation: 1 });
    const beat = runE2ECli(fixture, ["roster", "heartbeat", "--generation", "1"], { cwd: root, env: IDENTITY });
    expect(beat.status).toBe(0);
    expect(parseE2EJson<Envelope>(beat).data).toMatchObject({ ok: true, generation: 1 });
    const end = runE2ECli(fixture, ["roster", "end", "--generation", "1", "--state", "completed"], { cwd: root, env: IDENTITY });
    expect(end.status).toBe(0);
    expect(parseE2EJson<Envelope>(end).data).toMatchObject({ ok: true, state: "completed" });
    const late = runE2ECli(fixture, ["roster", "heartbeat", "--generation", "1"], { cwd: root, env: IDENTITY });
    expect(late.status).not.toBe(0);
    expect(parseE2EJson<Envelope>(late).error).toMatchObject({ code: "refused_transition" });
  });

  it("a flag the operation does not take is refused by yargs before any write (start has no --generation)", async () => {
    const root = await project();
    const r = runE2ECli(fixture, ["roster", "start", "--generation", "1"], { cwd: root, env: IDENTITY });
    expect(r.status).not.toBe(0);
    expect(existsSync(join(root, ".story", "telemetry", "roster"))).toBe(false);
  });

  it("no project: no_project on stdout, non-zero exit, and nothing written in the cwd or the isolated HOME", () => {
    const cwd = mkdtempSync(join(tmpdir(), "roster-e2e-noproj-"));
    dirs.push(cwd);
    const before = { cwd: listing(cwd), home: listing(fixture.root) };
    const r = runE2ECli(fixture, ["roster", "start", "--stdin"], { cwd, env: IDENTITY, input: "{}" });
    expect(r.status).not.toBe(0);
    expect(parseE2EJson<Envelope>(r).error).toMatchObject({ code: "no_project" });
    expect(listing(cwd)).toEqual(before.cwd);
    expect(listing(fixture.root)).toEqual(before.home);
  });

  it("an unreadable .story/ is io_error, not no_project, so a Mod never caches a permissions failure as absence", async () => {
    if (process.getuid?.() === 0) return; // root ignores mode bits
    const root = await project();
    chmodSync(join(root, ".story"), 0o000);
    const r = runE2ECli(fixture, ["roster", "start"], { cwd: root, env: IDENTITY });
    chmodSync(join(root, ".story"), 0o755);
    expect(r.status).not.toBe(0);
    expect(parseE2EJson<Envelope>(r).error).toMatchObject({ code: "io_error" });
  });

  it("a body past the ceiling is invalid_input and writes nothing", async () => {
    const root = await project();
    const r = runE2ECli(fixture, ["roster", "start", "--stdin"], { cwd: root, env: IDENTITY, input: JSON.stringify({ description: "x".repeat(5000) }) });
    expect(r.status).not.toBe(0);
    expect(parseE2EJson<Envelope>(r).error).toMatchObject({ code: "invalid_input" });
    expect(parseE2EJson<Envelope>(r).error!.message).toMatch(/exceeds 4096 bytes/);
    expect(existsSync(join(root, ".story", "telemetry", "roster"))).toBe(false);
  });
});
