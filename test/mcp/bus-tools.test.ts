import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { initProject } from "../../src/core/init.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAllTools } from "../../src/mcp/tools.js";
import { createBusFixture, type BusFixture } from "../bus/helpers.js";

interface RegisteredTool {
  config: { inputSchema?: z.ZodRawShape };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
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

function parsedArgs(tool: RegisteredTool, input: Record<string, unknown>): Record<string, unknown> {
  return tool.config.inputSchema ? z.object(tool.config.inputSchema).parse(input) : input;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("feature-gated Storybloq Bus MCP tools", () => {
  it("does not change the tool inventory for a project where Bus is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-bus-disabled-"));
    roots.push(root);
    await initProject(root, { name: "disabled" });
    const names = [...captureTools(root).keys()];
    expect(names.filter((name) => name.startsWith("storybloq_bus_"))).toEqual([]);
  });

  it("registers exactly five task-bound tools when Bus is enabled", async () => {
    const fixture: BusFixture = await createBusFixture("mcp-bus-enabled");
    roots.push(fixture.root);
    const tools = captureTools(fixture.root);
    expect([...tools.keys()].filter((name) => name.startsWith("storybloq_bus_")).sort()).toEqual([
      "storybloq_bus_ack",
      "storybloq_bus_poll",
      "storybloq_bus_send",
      "storybloq_bus_thread_get",
      "storybloq_bus_thread_update",
    ]);

    const send = tools.get("storybloq_bus_send")!;
    const sentResult = await send.handler(parsedArgs(send, {
      endpointId: fixture.reviewer.endpointId,
      clientTaskId: fixture.reviewerTaskId,
      threadKind: "question",
      toRole: "implementer",
      messageKind: "question",
      severity: "medium",
      body: "Verify the MCP boundary",
      refs: { ciRun: "ci-mcp-1" },
      idempotencyKey: "mcp-question-1",
    }));
    const sent = JSON.parse(sentResult.content[0]!.text).data;
    expect(sentResult.isError).not.toBe(true);
    expect(sent.messageId).toMatch(/^[0-9a-f-]{36}$/);

    const poll = tools.get("storybloq_bus_poll")!;
    const polledResult = await poll.handler(parsedArgs(poll, {
      endpointId: fixture.implementer.endpointId,
      clientTaskId: fixture.implementerTaskId,
    }));
    const polled = JSON.parse(polledResult.content[0]!.text).data;
    expect(polled.messages[0]).toMatchObject({
      source: "storybloq_bus",
      authority: "peer_agent",
      sender: { role: "reviewer", client: "claude" },
      message: { body: "Verify the MCP boundary" },
    });

    const denied = await poll.handler(parsedArgs(poll, {
      endpointId: fixture.implementer.endpointId,
      clientTaskId: "foreign-task",
    }));
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0]!.text).error.code).toBe("unauthorized");
  });

  it("adds concise Bus state to existing status JSON", async () => {
    const fixture = await createBusFixture("mcp-bus-status");
    roots.push(fixture.root);
    const status = captureTools(fixture.root).get("storybloq_status")!;
    const result = await status.handler(parsedArgs(status, { format: "json" }));
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.data.bus).toMatchObject({
      enabled: true,
      endpoints: 2,
      pendingMessages: 0,
      daemonState: "stopped",
    });
  });
});
