import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { initProject } from "../../src/core/init.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { registerDegradedTools } from "../../src/mcp/index.js";

/**
 * T-502: `storybloq_health` is in BOTH tool sets, because the no-project case
 * is exactly where a newcomer most needs to be told their tooling is wrong.
 * It is built on the `registerSessionIntelTool` wrapper pattern rather than
 * `runMcpReadTool`, which requires a string root and loads the ledger.
 *
 * The other thing pinned here is `projectDir`. The server captures its LAUNCH
 * directory once and that value is passed explicitly through a
 * RegistrationContext, so two servers in one process can report two different
 * inspected directories and an init cannot change the value.
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

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

async function tempDir(prefix: string): Promise<string> {
  const d = realpathSync(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

const callHealth = async (registry: Registry, args: Record<string, unknown> = {}) => {
  const tool = registry.tools.get("storybloq_health");
  expect(tool).toBeDefined();
  const out = await tool!.handler({ format: "json", ...args });
  // ISS-1223: the tool renders through the same seam as the CLI, so its json
  // is the shared {version, data} envelope every other tool returns.
  const envelope = JSON.parse(out.content[0]!.text) as {
    version: number;
    data: {
      projectDir: string;
      checks: Array<{ id: string; status: string; detail: Record<string, unknown> }>;
      cliVersion: string;
      client: string;
      budgetExhausted: boolean;
    };
  };
  expect(Object.keys(envelope).sort()).toEqual(["data", "version"]);
  expect(envelope.version).toBe(1);
  return envelope.data;
};

describe("storybloq_health registration", () => {
  it("is in the full set and answers with the six checks", async () => {
    const root = await tempDir("health-tool-");
    await initProject(root, { name: "p", type: "npm" });
    const launchDir = await tempDir("health-launch-");
    const { registry, server } = makeRegistry();
    registerAllTools(server, root, { launchDir });
    const result = await callHealth(registry);
    expect(result.checks.map((c) => c.id)).toEqual([
      "usage-window",
      "cli-version",
      "codex-bridge",
      "skill-version",
      "cross-session-inbound",
      "hook-duplicates",
    ]);
    expect(result.projectDir).toBe(launchDir);
  });

  it("is in the degraded set and answers before any project exists", async () => {
    const launchDir = await tempDir("health-degraded-");
    const { registry, server } = makeRegistry();
    registerDegradedTools(server, undefined, { launchDir });
    const result = await callHealth(registry);
    expect(result.checks).toHaveLength(6);
    expect(result.projectDir).toBe(launchDir);
  });

  // Drives the REAL storybloq_init handler rather than removing the degraded
  // tools by hand, so this fails if production ever loses
  // `degradedHealth.remove()` or stops passing the captured launch directory
  // through the swap. init resolves its root from process.cwd(), so the test
  // has to chdir; the launch directory is a DIFFERENT directory on purpose,
  // which is what makes "unchanged by init" observable.
  it("survives the real post-init swap with its launch directory unchanged", { timeout: 30_000 }, async () => {
    const launchDir = await tempDir("health-swap-launch-");
    const initRoot = await tempDir("health-swap-root-");
    const { registry, server } = makeRegistry();
    registerDegradedTools(server, undefined, { launchDir });
    expect(registry.tools.has("storybloq_health")).toBe(true);
    expect((await callHealth(registry)).projectDir).toBe(launchDir);

    const cwd = process.cwd();
    try {
      process.chdir(initRoot);
      const init = registry.tools.get("storybloq_init")!;
      const out = await init.handler({ name: "swapped", type: "npm", language: "typescript" });
      expect(out.isError).toBeUndefined();
      expect(out.content[0]!.text).toContain("Initialized .story/ project");
    } finally {
      process.chdir(cwd);
    }

    // The degraded health tool was removed, and the full set re-registered it
    // without a duplicate error (makeRegistry throws on one).
    expect(registry.removals).toContain("storybloq_health");
    expect(registry.registrations.filter((n) => n === "storybloq_health")).toHaveLength(2);

    const result = await callHealth(registry);
    expect(result.checks).toHaveLength(6);
    // The ledger root is now set; the inspected directory is UNCHANGED, and is
    // not the directory init happened in.
    expect(result.projectDir).toBe(launchDir);
    expect(result.projectDir).not.toBe(initRoot);
  });

  it("two servers in one process report their own injected launch directories", async () => {
    const a = await tempDir("health-launch-a-");
    const b = await tempDir("health-launch-b-");
    const first = makeRegistry();
    const second = makeRegistry();
    registerDegradedTools(first.server, undefined, { launchDir: a });
    registerDegradedTools(second.server, undefined, { launchDir: b });
    expect((await callHealth(first.registry)).projectDir).toBe(a);
    expect((await callHealth(second.registry)).projectDir).toBe(b);
  });

  it("passes only and refresh through", async () => {
    const launchDir = await tempDir("health-only-");
    const { registry, server } = makeRegistry();
    registerDegradedTools(server, undefined, { launchDir });
    const result = await callHealth(registry, { only: ["cli-version"], refresh: false });
    expect(result.checks.map((c) => c.id)).toEqual(["cli-version"]);
  });

  it("renders md by default", async () => {
    const launchDir = await tempDir("health-md-");
    const { registry, server } = makeRegistry();
    registerDegradedTools(server, undefined, { launchDir });
    const out = await registry.tools.get("storybloq_health")!.handler({});
    expect(out.content[0]!.text).toContain("# Health check");
    expect(out.content[0]!.text).toContain(`settings inspected for ${launchDir}`);
    expect(out.isError).toBeUndefined();
  });

  it("declares a schema with format, only and refresh, and no root argument", () => {
    const { registry, server } = makeRegistry();
    registerDegradedTools(server, undefined, { launchDir: "/tmp" });
    // The strict-schema shim replaces the raw shape with a zod object, so read
    // whichever form is present.
    const raw = registry.tools.get("storybloq_health")!.config.inputSchema as Record<string, unknown>;
    const shape = (raw as { shape?: Record<string, unknown> }).shape ?? raw;
    expect(Object.keys(shape).sort()).toEqual(["format", "only", "refresh"]);
  });
});
