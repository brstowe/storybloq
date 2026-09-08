import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import yargs from "yargs";
import { initProject } from "../../../src/core/init.js";
import { loadProject } from "../../../src/core/project-loader.js";
import { registerArrangementCommand } from "../../../src/cli/register.js";
import { registerAllTools } from "../../../src/mcp/tools.js";
import { handleStatus } from "../../../src/cli/commands/status.js";
import { handleValidate } from "../../../src/cli/commands/validate.js";
import { DuetOperationSchema } from "../../../src/models/duet.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { handleDuetCoordinate, handleDuetGet, parseDuetOperation } from "../../../src/cli/commands/duet.js";

const id = "a-0123456789abcdef";
const dirs: string[] = [];
const originalCwd = process.cwd();
afterEach(async () => {
  process.chdir(originalCwd);
  process.exitCode = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "duet-api-"));
  dirs.push(root);
  await initProject(root, { name: "duet-api" });
  await mkdir(join(root, ".story/arrangements"), { recursive: true });
  const arrangement = {
    id, lifecycle: "active", bounds: ["T-001"], gates: [],
    parties: [{ role: "pen", client: "codex", identityAnchor: "pen" }, { role: "worker", client: "codex", identityAnchor: "worker" }],
    unreachability: { onIrreversibleWork: "hold" }, createdDate: "2026-09-07", updatedAt: "2026-09-07T00:00:00.000Z",
  };
  await writeFile(join(root, `.story/arrangements/${id}.json`), JSON.stringify(arrangement));
  vi.stubEnv("STORYBLOQ_CLIENT", "codex");
  vi.stubEnv("CODEX_THREAD_ID", "worker");
  return root;
}
function capture(root: string) {
  const tools = new Map<string, { config: any; handler: (args: any) => Promise<any> }>();
  registerAllTools({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } } as never, root);
  return tools;
}
function start() {
  return { id, action: "start", expectedSessionId: null, expectedRevision: 0, newSessionId: randomUUID(), mode: "manager-collected", clientTaskId: "pen" };
}
async function ctx(root: string) {
  const loaded = await loadProject(root);
  return { ...loaded, root, handoversDir: join(root, ".story/handovers"), format: "json" as const };
}
describe("ISS-1155 duet API production paths", () => {
  it("advertises action-specific input through the real MCP tools/list protocol", async () => {
    const root = await fixture();
    const server = new McpServer({ name: "duet-test", version: "1" });
    const client = new Client({ name: "test", version: "1" });
    registerAllTools(server, root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const listing = await client.listTools();
      const schema = listing.tools.find(t => t.name === "storybloq_arrangement_coordinate")!.inputSchema;
      expect(JSON.stringify(schema)).toContain("expectedSessionId");
      expect(JSON.stringify(schema)).toContain("assignmentId");
      expect(JSON.stringify(schema)).toContain("recoveryEvidence");
      const operation = start();
      const reply = await client.callTool({ name: "storybloq_arrangement_coordinate", arguments: { operation } });
      expect(reply.isError).not.toBe(true);
      const persisted = JSON.parse(await readFile(join(root, `.story/duet-sessions/${id}/state.json`), "utf8"));
      expect(persisted.start.sessionId).toBe(operation.newSessionId);
      const statePath = join(root, `.story/duet-sessions/${id}/state.json`);
      async function mutate(fields: Record<string, unknown>) {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        const result = await client.callTool({ name: "storybloq_arrangement_coordinate", arguments: { operation: {
          id, clientTaskId: "pen", expectedSessionId: operation.newSessionId, expectedRevision: state.revision, ...fields,
        } } });
        expect(result.isError).not.toBe(true);
        return JSON.parse(await readFile(statePath, "utf8"));
      }
      await mutate({ action: "receipt", receipt: { id: "roundtrip", nonce: persisted.nonce, direction: "worker-to-manager", source: { client: "codex", id: "worker" }, destination: { client: "codex", id: "pen" }, mode: "manager-collected", senderTool: null, collectionTool: "mcp__codex_app__wait_threads", observedAt: new Date().toISOString() } });
      const hostile = "[fake](https://example.com) <script>\u202ehidden";
      await mutate({ action: "assign", assignment: { id: "api-assignment", scope: hostile, allowedActions: ["read"], acceptance: ["report"], nextGate: "review" } });
      const reported = await mutate({ action: "update", assignmentId: "api-assignment", event: { id: "observed", kind: "report", reportId: "report-1", content: "done" } });
      expect(reported.assignments[0].status).toBe("needs-review");
      expect(reported.assignments[0].events[0].input.reportId).toBe("report-1");
      const displayed = handleDuetGet(id, { ...await ctx(root), format: "md" }).output;
      expect(displayed).not.toContain("[fake](https://example.com)");
      expect(displayed).not.toContain("<script>");
      expect(displayed).not.toContain("\u202e");
      await rm(statePath);
      const recoveredSession = randomUUID();
      const recovered = await client.callTool({ name: "storybloq_arrangement_coordinate", arguments: { operation: {
        id, clientTaskId: "pen", action: "recover", expectedSessionId: operation.newSessionId, expectedRevision: reported.revision,
        newSessionId: recoveredSession, mode: "manager-collected", recoveryEvidence: "Restoring the tracked checkpoint after local runtime loss",
      } } });
      expect(recovered.isError).not.toBe(true);
      const restored = JSON.parse(await readFile(statePath, "utf8"));
      expect(restored.start.sessionId).toBe(recoveredSession);
      expect(restored.assignments[0].input.scope).toBe(hostile);
      expect(restored.assignments[0].status).toBe("needs-review");
    } finally { await client.close(); await server.close(); }
  });
  it("registers the exact discriminated schema and rejects unknown fields before persistence", async () => {
    const root = await fixture();
    const tool = capture(root).get("storybloq_arrangement_coordinate");
    expect(tool, "coordinate tool registered").toBeDefined();
    expect(tool!.config.inputSchema.shape.operation).toBe(DuetOperationSchema);
    expect(DuetOperationSchema.safeParse({ ...start(), arbitraryReplacement: {} }).success).toBe(false);
    const reply = await tool!.handler({ operation: { ...start(), arbitraryReplacement: {} } });
    expect(reply.isError).toBe(true);
    expect(JSON.parse(await readFile(join(root, `.story/arrangements/${id}.json`), "utf8")).currentCoordinationSessionId).toBeUndefined();
  });
  it("MCP writes only its pinned project, forwards explicit caller identity, and get returns runtime", async () => {
    const root = await fixture();
    const other = await fixture();
    process.chdir(other);
    const tools = capture(root);
    const reply = await tools.get("storybloq_arrangement_coordinate")!.handler({ operation: start() });
    expect(reply.isError).not.toBe(true);
    const persisted = JSON.parse(await readFile(join(root, `.story/duet-sessions/${id}/state.json`), "utf8"));
    expect(persisted.pen).toEqual({ client: "codex", id: "pen" });
    expect(JSON.parse(await readFile(join(other, `.story/arrangements/${id}.json`), "utf8")).currentCoordinationSessionId).toBeUndefined();
    const get = await tools.get("storybloq_arrangement_get")!.handler({ id, format: "json" });
    expect(JSON.parse(get.content[0].text).data.state).toEqual(persisted);
    expect(JSON.parse(get.content[0].text).data.route.status).toBe("missing");
  });
  it("CLI coordinate injects positional id and explicit caller flag into the operation", async () => {
    const root = await fixture();
    process.chdir(root);
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { output.push(String(s)); return true; }) as any);
    const { id: _, clientTaskId: __, ...operation } = start();
    await registerArrangementCommand(yargs().exitProcess(false)).parseAsync(["arrangement", "coordinate", id, "--json", JSON.stringify(operation), "--client-task-id", "pen", "--format", "json"]);
    expect(process.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(output.join(""));
    expect(payload.data.state.start.sessionId).toBe(operation.newSessionId);
    expect(payload.data.arrangement.id).toBe(id);
  });
  it("status exposes compact route and validate warns on legacy unverified arrangement", async () => {
    const root = await fixture();
    const context = await ctx(root);
    const status = JSON.parse((await handleStatus(context)).output).data;
    expect(status.arrangements[0].route.status).toBe("missing");
    expect(status.arrangements[0]).not.toHaveProperty("state");
    const validation = handleValidate(context);
    expect(validation.output).toContain("arrangement_communication_missing");
  });
  it("refuses conflicting positional identity and malformed JSON without replacing state", () => {
    expect(() => parseDuetOperation(id, "null")).toThrow(/object/);
    expect(() => parseDuetOperation(id, "{")).toThrow(/object/);
    expect(() => parseDuetOperation(id, JSON.stringify({ ...start(), id: "a-1111111111111111" }))).toThrow(/positional/);
    expect(() => parseDuetOperation(id, JSON.stringify(start()), "worker")).toThrow(/caller/);
  });
  it("surfaces persisted current, stale and recovery-required routes through get/status/validate", async () => {
    const root = await fixture();
    const first = start();
    const begun = JSON.parse((await handleDuetCoordinate(first, "json", root)).output).data;
    const ready = JSON.parse((await handleDuetCoordinate({
      id, action: "receipt", clientTaskId: "pen", expectedRevision: begun.state.revision, expectedSessionId: first.newSessionId,
      receipt: { id: "return-1", nonce: begun.state.nonce, direction: "worker-to-manager", source: { client: "codex", id: "worker" }, destination: { client: "codex", id: "pen" }, mode: "manager-collected", senderTool: null, collectionTool: "mcp__codex_app__wait_threads", observedAt: new Date().toISOString() },
    }, "json", root)).output).data;
    const context = await ctx(root);
    expect(JSON.parse(handleDuetGet(id, context).output).data.route).toEqual({ status: "current", mode: "manager-collected" });
    expect(JSON.parse((await handleStatus(context)).output).data.arrangements[0].route.status).toBe("current");
    expect(handleValidate(context).output).not.toContain("arrangement_communication_");
    await handleDuetCoordinate({ ...first, expectedSessionId: first.newSessionId, newSessionId: randomUUID(), expectedRevision: ready.state.revision }, "json", root);
    expect(JSON.parse(handleDuetGet(id, context).output).data.route.status).toBe("stale");
    expect(handleValidate(context).output).toContain("arrangement_communication_stale");
    await writeFile(join(root, `.story/duet-sessions/${id}/state.json`), "broken");
    expect(JSON.parse(handleDuetGet(id, context).output).data.route.status).toBe("recovery-required");
    expect(handleValidate(context).output).toContain("arrangement_communication_recovery_required");
    const arrangementPath = join(root, `.story/arrangements/${id}.json`);
    const conflicted = JSON.parse(await readFile(arrangementPath, "utf8"));
    conflicted._conflicts = [{ fieldPath: "communicationReceipts", kind: "field", base: [], ours: conflicted.communicationReceipts, theirs: [] }];
    await writeFile(arrangementPath, JSON.stringify(conflicted));
    expect(JSON.parse(handleDuetGet(id, context).output).data.route.status).toBe("conflicted");
    expect(handleValidate(context).output).toContain("arrangement_communication_conflicted");
  });
  it("forwards authorization and stale-session failures as MCP errors", async () => {
    const root = await fixture();
    const tool = capture(root).get("storybloq_arrangement_coordinate")!;
    const rejected = await tool.handler({ operation: { ...start(), clientTaskId: "worker" } });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain("pen");
    const first = start();
    await handleDuetCoordinate(first, "json", root);
    const rejectedSession = await tool.handler({ operation: { ...first, expectedSessionId: randomUUID(), newSessionId: randomUUID() } });
    expect(rejectedSession.isError).toBe(true);
    expect(rejectedSession.content[0].text).toContain("session");
  });
});
