import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/mcp/tools.js";
import { initProject } from "../../src/core/init.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";
import { ArrangementPartySchema } from "../../src/models/arrangement.js";
import { IDENTITY_ANCHOR_FORMAT_MESSAGE } from "../../src/models/types.js";

interface RegisteredTool {
  // `registerAllTools` wraps every registration through `withStrictToolSchemas`
  // (mcp/strict-schemas.ts, ISS-892) before it reaches this fake `registerTool`,
  // which converts the raw shape into a built `z.object(shape).strict()` -- so
  // the `inputSchema` captured here at runtime is a ZodObject instance, not a
  // raw shape literal (confirmed by direct inspection; see the identityAnchor
  // format tests below).
  config: { inputSchema?: z.ZodObject<z.ZodRawShape> };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>;
}

function captureTools(root: string): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (
      name: string,
      config: RegisteredTool["config"],
      handler: RegisteredTool["handler"],
    ) => tools.set(name, { config, handler }),
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return tools;
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const PARTIES = [
  { role: "pen", client: "claude", identityAnchor: "pen-session" },
  { role: "worker", client: "claude", identityAnchor: "worker-session" },
];

describe("arrangement MCP tools (T-473, amendment A3)", () => {
  it("registers storybloq_arrangement_get, _create, and _update", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-arrangement-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);
    expect(tools.has("storybloq_arrangement_get")).toBe(true);
    expect(tools.has("storybloq_arrangement_create")).toBe(true);
    expect(tools.has("storybloq_arrangement_update")).toBe(true);
  });

  it("does NOT register storybloq_arrangement_list (amendment A3: status covers discovery)", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-arrangement-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);
    expect(tools.has("storybloq_arrangement_list")).toBe(false);
  });

  it("create -> get -> update round-trips through the registered handlers", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-arrangement-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    await handleTicketCreate(
      { title: "Duet ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md",
      root,
    );
    const tools = captureTools(root);

    const createResult = await tools.get("storybloq_arrangement_create")!.handler({
      bounds: ["T-001"],
      parties: PARTIES,
      onIrreversibleWork: "hold",
    });
    expect(createResult.isError).toBeFalsy();
    // MCP write tools always render "md" (runMcpWriteTool pins format to
    // "md"), so the id is extracted from the sentence, not parsed as JSON.
    const createdMatch = createResult.content[0]!.text.match(/Created arrangement (a-[0-9a-z]+)\./);
    expect(createdMatch).not.toBeNull();
    const id = createdMatch![1]!;

    const getResult = await tools.get("storybloq_arrangement_get")!.handler({ id });
    expect(getResult.isError).toBeFalsy();
    expect(getResult.content[0]!.text).toContain(id);

    const updateResult = await tools.get("storybloq_arrangement_update")!.handler({ id, lifecycle: "closed" });
    expect(updateResult.isError).toBeFalsy();
    expect(updateResult.content[0]!.text).toContain("[closed]");
  });

  it("create rejects a party topology that is not exactly one pen and one worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-arrangement-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    await handleTicketCreate(
      { title: "Duet ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md",
      root,
    );
    const tools = captureTools(root);
    const result = await tools.get("storybloq_arrangement_create")!.handler({
      bounds: ["T-001"],
      parties: [
        { role: "worker", client: "claude", identityAnchor: "a" },
        { role: "worker", client: "claude", identityAnchor: "b" },
      ],
      onIrreversibleWork: "hold",
    });
    expect(result.isError).toBe(true);
  });

  describe("identityAnchor format (ISS-1117)", () => {
    it("create rejects a session name with a bracketed ref, naming the client-task-id requirement", async () => {
      const root = await mkdtemp(join(tmpdir(), "mcp-arrangement-"));
      tempDirs.push(root);
      await initProject(root, { name: "test" });
      await handleTicketCreate(
        { title: "Duet ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
        "md",
        root,
      );
      const tools = captureTools(root);
      const result = await tools.get("storybloq_arrangement_create")!.handler({
        bounds: ["T-001"],
        parties: [
          { role: "pen", client: "claude", identityAnchor: "agentkit-platform-7b [abbe56]" },
          { role: "worker", client: "claude", identityAnchor: "worker-session" },
        ],
        onIrreversibleWork: "hold",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(IDENTITY_ANCHOR_FORMAT_MESSAGE);
    });

    it("the registered tool's parties element schema is the imported ArrangementPartySchema (no hand-duplicated copy)", async () => {
      const root = await mkdtemp(join(tmpdir(), "mcp-arrangement-"));
      tempDirs.push(root);
      await initProject(root, { name: "test" });
      const tools = captureTools(root);
      // Navigate via `.shape`, the real ZodObject accessor (see the
      // `RegisteredTool.config.inputSchema` doc comment above for why this is
      // a built ZodObject rather than a raw shape literal).
      const registeredSchema = tools.get("storybloq_arrangement_create")!.config.inputSchema!;
      const partiesSchema = registeredSchema.shape.parties as z.ZodArray<z.ZodTypeAny>;
      expect(partiesSchema.element).toBe(ArrangementPartySchema);
    });

    it("an extra unrecognized party field survives through the registered schema and is persisted (passthrough, ISS-1117 0.1 finding 3 / 0.2 finding 1)", async () => {
      const root = await mkdtemp(join(tmpdir(), "mcp-arrangement-"));
      tempDirs.push(root);
      await initProject(root, { name: "test" });
      await handleTicketCreate(
        { title: "Duet ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
        "md",
        root,
      );
      const tools = captureTools(root);
      const tool = tools.get("storybloq_arrangement_create")!;
      // `config.inputSchema` is already a built `z.object(shape).strict()`
      // -- parse against it directly rather than re-wrapping it in another
      // `z.object(...)`, which would treat its own instance properties as
      // shape entries and throw.
      const registeredInputSchema = tool.config.inputSchema!;
      const payload = {
        bounds: ["T-001"],
        parties: [
          { role: "pen", client: "claude", identityAnchor: "pen-session", note: "x" },
          { role: "worker", client: "claude", identityAnchor: "worker-session" },
        ],
        onIrreversibleWork: "hold",
      };
      const parsed = await registeredInputSchema.parseAsync(payload);
      const createResult = await tool.handler(parsed as Record<string, unknown>);
      expect(createResult.isError).toBeFalsy();
      const createdMatch = createResult.content[0]!.text.match(/Created arrangement (a-[0-9a-z]+)\./);
      expect(createdMatch).not.toBeNull();
      const id = createdMatch![1]!;
      const persisted = JSON.parse(
        await readFile(join(root, ".story", "arrangements", `${id}.json`), "utf8"),
      ) as { parties: Array<Record<string, unknown>> };
      const pen = persisted.parties.find((p) => p.role === "pen");
      expect(pen?.note).toBe("x");
    });

    it("create warns (does not reject) a non-uuid-shaped anchor and names the party's role", async () => {
      const root = await mkdtemp(join(tmpdir(), "mcp-arrangement-"));
      tempDirs.push(root);
      await initProject(root, { name: "test" });
      await handleTicketCreate(
        { title: "Duet ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
        "md",
        root,
      );
      const tools = captureTools(root);
      const result = await tools.get("storybloq_arrangement_create")!.handler({
        bounds: ["T-001"],
        parties: [
          { role: "pen", client: "claude", identityAnchor: "pen-session" },
          { role: "worker", client: "claude", identityAnchor: "worker-session" },
        ],
        onIrreversibleWork: "hold",
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toMatch(/Warning:.*pen/);
    });

    it("create with real uuid-shaped anchors for both parties produces no warning", async () => {
      const root = await mkdtemp(join(tmpdir(), "mcp-arrangement-"));
      tempDirs.push(root);
      await initProject(root, { name: "test" });
      await handleTicketCreate(
        { title: "Duet ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
        "md",
        root,
      );
      const tools = captureTools(root);
      const result = await tools.get("storybloq_arrangement_create")!.handler({
        bounds: ["T-001"],
        parties: [
          { role: "pen", client: "claude", identityAnchor: "b8df203d-d3f5-4520-8057-96babf59612c" },
          { role: "worker", client: "codex", identityAnchor: "01a07f63-e16d-7783-9ee3-61d9aaaf941c" },
        ],
        onIrreversibleWork: "hold",
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).not.toContain("Warning:");
    });
  });
});
