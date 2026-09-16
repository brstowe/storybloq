import { mkdtemp, rm, mkdir, realpath } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { registerDegradedTools } from "../../src/mcp/index.js";
import { processEra } from "../../src/core/session-intel/process-era.js";
import { SID, assistantRecord, writeTranscript } from "../core/session-intel-fixtures.js";

/**
 * T-499: `storybloq_session_intel` must exist in BOTH tool sets (it answers
 * without a project) and be swapped out cleanly on init, the T-446 pattern.
 */

interface RegisteredTool {
  config: { inputSchema?: unknown; description?: string };
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
}
interface Registry { tools: Map<string, RegisteredTool>; registrations: string[]; removals: string[] }

function makeRegistry(): { registry: Registry; server: never } {
  const registry: Registry = { tools: new Map(), registrations: [], removals: [] };
  const server = {
    registerTool: (name: string, config: RegisteredTool["config"], handler: RegisteredTool["handler"]) => {
      if (registry.tools.has(name)) throw new Error(`Tool ${name} is already registered`);
      registry.registrations.push(name);
      registry.tools.set(name, { config, handler });
      return { remove: () => { registry.removals.push(name); registry.tools.delete(name); } };
    },
    sendToolListChanged: () => {},
  } as unknown as never;
  return { registry, server };
}

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

describe("storybloq_session_intel registration", () => {
  it("is in the full set", async () => {
    const root = await mkdtemp(join(tmpdir(), "si-tool-"));
    roots.push(root);
    await initProject(root, { name: "p", type: "npm" });
    const { registry, server } = makeRegistry();
    (registerAllTools as (s: never, root: string) => void)(server, root);
    expect(registry.tools.has("storybloq_session_intel")).toBe(true);
  });

  it("is in the degraded set and answers without a project", async () => {
    const bare = await mkdtemp(join(tmpdir(), "si-tool-degraded-"));
    roots.push(bare);
    const { registry, server } = makeRegistry();
    (registerDegradedTools as (s: never, root: string) => void)(server, bare);
    expect(registry.tools.has("storybloq_session_intel")).toBe(true);
    const saved = process.env.STORYBLOQ_CLIENT;
    process.env.STORYBLOQ_CLIENT = "codex";
    try {
      const out = await registry.tools.get("storybloq_session_intel")!.handler({ format: "json" });
      const parsed = JSON.parse(out.content[0]!.text) as { ok: boolean; data: { client: string; usable: boolean } };
      expect(parsed.data.client).toBe("codex");
      expect(parsed.data.usable).toBe(false);
      expect(out.isError).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.STORYBLOQ_CLIENT; else process.env.STORYBLOQ_CLIENT = saved;
    }
  });

  it("degraded, Claude client: reads the caller's transcript without a project; a handler-reported lookup failure is isError with its diagnostic", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "si-tool-claude-")));
    roots.push(base);
    const cwd = join(base, "work");
    await mkdir(cwd);
    const projects = join(base, "home", ".claude", "projects");
    await mkdir(projects, { recursive: true });
    writeTranscript(projects, cwd.replace(/[^A-Za-z0-9]/g, "-"), SID, [assistantRecord({ ts: "2026-09-09T12:00:00.000Z", read: 266_709 })]);
    const { registry, server } = makeRegistry();
    (registerDegradedTools as (s: never, root: string) => void)(server, cwd);
    const saved = { HOME: process.env.HOME, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID, STORYBLOQ_CLIENT: process.env.STORYBLOQ_CLIENT, CLAUDE_PID: process.env.CLAUDE_PID };
    const origCwd = process.cwd();
    process.env.HOME = join(base, "home"); // os.homedir() resolves ~/.claude/projects from HOME
    process.env.CLAUDE_CODE_SESSION_ID = SID;
    delete process.env.STORYBLOQ_CLIENT;
    delete process.env.CLAUDE_PID;
    processEra.reset();
    process.chdir(cwd);
    try {
      const out = await registry.tools.get("storybloq_session_intel")!.handler({ format: "json" });
      expect(out.isError).toBeUndefined();
      const parsed = JSON.parse(out.content[0]!.text) as { ok: boolean; data: { client: string; usable: boolean; presence: string; binding: string; pressure: { contextTokens: number } | null } };
      expect(parsed.data).toMatchObject({ client: "claude", binding: "read-only", presence: "no-project", usable: true });
      expect(parsed.data.pressure?.contextTokens).toBe(266_711);
      process.env.CLAUDE_CODE_SESSION_ID = "no-such-session-0000";
      const missing = await registry.tools.get("storybloq_session_intel")!.handler({ format: "json" });
      expect(missing.isError).toBe(true);
      expect(JSON.parse(missing.content[0]!.text)).toMatchObject({ ok: true, data: { usable: false, unusableReason: expect.stringMatching(/not found/) } });
      delete process.env.CLAUDE_CODE_SESSION_ID;
      const noId = await registry.tools.get("storybloq_session_intel")!.handler({ format: "md" });
      expect(noId.isError).toBe(true);
      expect(noId.content[0]!.text).toMatch(/no caller session id/);
    } finally {
      process.chdir(origCwd);
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      processEra.reset();
    }
  });

  it("survives the degraded -> full swap with exactly one registration live", async () => {
    const bare = await mkdtemp(join(tmpdir(), "si-tool-swap-"));
    roots.push(bare);
    const { registry, server } = makeRegistry();
    (registerDegradedTools as (s: never, root: string) => void)(server, bare);
    const origCwd = process.cwd();
    process.chdir(bare);
    try {
      await registry.tools.get("storybloq_init")!.handler({ name: "swap", type: "npm" });
    } finally {
      process.chdir(origCwd);
    }
    const live = registry.registrations.filter((n) => n === "storybloq_session_intel").length - registry.removals.filter((n) => n === "storybloq_session_intel").length;
    expect(live).toBe(1);
    expect(registry.tools.has("storybloq_session_intel")).toBe(true);
  });
});
