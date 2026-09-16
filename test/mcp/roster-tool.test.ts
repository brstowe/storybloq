/**
 * T-507 commit B: `storybloq_roster_get`, read-only, through a real McpServer
 * over an in-memory transport, so the registration, the input schema and the
 * dispatch are the production ones.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { initProject } from "../../src/core/init.js";
import { upsertSeat } from "../../src/core/roster.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mcp-roster-"));
  tempDirs.push(root);
  await initProject(root, { name: "test" });
  return root;
}

async function connect(root: string): Promise<Client> {
  const server = new McpServer({ name: "storybloq-test", version: "0.0.0" });
  registerAllTools(server, root);
  const client = new Client({ name: "roster-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client: Client, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
  const result = await client.callTool({ name: "storybloq_roster_get", arguments: args });
  const content = result.content as { text: string }[];
  return { isError: result.isError as boolean | undefined, text: content[0]!.text };
}

const now = new Date().toISOString();
const start = (clientTaskId: string) => ({ kind: "start" as const, client: "claude" as const, clientTaskId, agentId: null, sessionId: clientTaskId, description: null });

describe("storybloq_roster_get MCP tool", () => {
  it("reads the roster as JSON through the real server, hiding terminal seats unless all is set", async () => {
    const root = await newProject();
    upsertSeat(root, start("live"), now);
    upsertSeat(root, start("done"), now);
    upsertSeat(root, { kind: "end", state: "completed", generation: 1, client: "claude", clientTaskId: "done", agentId: null }, now);
    const client = await connect(root);
    try {
      const some = await call(client, { format: "json" });
      expect(some.isError).toBeUndefined();
      const data = JSON.parse(some.text).data;
      expect(data.seats.map((s: { seatId: string }) => s.seatId)).toEqual(["claude:live"]);
      expect(data).toMatchObject({ live: 1, stale: 0, terminal: 1, includesTerminal: false, busScanTruncated: false });
      const all = JSON.parse((await call(client, { format: "json", all: true })).text).data;
      expect(all.seats.map((s: { seatId: string }) => s.seatId).sort()).toEqual(["claude:done", "claude:live"]);
      expect(all.includesTerminal).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("defaults to markdown, rejects an argument outside the schema, and is the only roster tool listed", async () => {
    const root = await newProject();
    upsertSeat(root, start("live"), now);
    const client = await connect(root);
    try {
      const md = await call(client, {});
      expect(md.isError).toBeUndefined();
      expect(md.text.split("\n").filter((l) => l.startsWith("| claude:live"))).toHaveLength(1);
      // The SDK answers a schema miss as an isError result naming the argument.
      const badFormat = await call(client, { format: "xml" });
      expect(badFormat.isError).toBe(true);
      expect(badFormat.text).toMatch(/Invalid arguments for tool storybloq_roster_get: .*format/);
      const badAll = await call(client, { all: "yes" });
      expect(badAll.isError).toBe(true);
      expect(badAll.text).toMatch(/Invalid arguments for tool storybloq_roster_get: .*all/);
      const names = (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("storybloq_roster_"));
      expect(names).toEqual(["storybloq_roster_get"]);
    } finally {
      await client.close();
    }
  });
});
