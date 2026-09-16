/**
 * ISS-1203 (GitHub #34): issues filed with no phase are invisible on the
 * Mac app's phase-grouped board. `storybloq_issue_create` must default the
 * phase from the first related ticket when the caller omits it, the same
 * way the CLI path does (both route through the shared handleIssueCreate),
 * so this exercises the REAL registered MCP tool closure rather than calling
 * handleIssueCreate directly.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAllTools } from "../../src/mcp/tools.js";

const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures", "valid", "basic");

interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>;
}

function captureTools(root: string): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: RegisteredTool["handler"]) => {
      tools.set(name, { handler });
    },
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return tools;
}

describe("storybloq_issue_create phase inference through the registered MCP tool (ISS-1203)", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  // The basic fixture ships T-001 in phase "alpha".
  async function setupProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "iss1203-mcp-"));
    tmpDirs.push(dir);
    await cp(FIXTURES_DIR, join(dir, ".story"), { recursive: true });
    return dir;
  }

  function issueCreateTool(root: string): RegisteredTool {
    const tool = captureTools(root).get("storybloq_issue_create");
    if (!tool) throw new Error("storybloq_issue_create was not registered");
    return tool;
  }

  // The MCP write-tool pipeline always renders "md" text ("Created issue
  // ISS-XXX: ..."), never JSON -- read the written file back to check phase.
  async function readCreatedPhase(root: string, text: string): Promise<string | null> {
    const match = /Created issue (ISS-\d+):/.exec(text);
    if (!match) throw new Error(`Unexpected create response: ${text}`);
    const raw = await readFile(join(root, ".story", "issues", `${match[1]}.json`), "utf-8");
    return JSON.parse(raw).phase;
  }

  it("infers phase from the first related ticket when phase is omitted", async () => {
    const root = await setupProject();
    const result = await issueCreateTool(root).handler({
      title: "Bug via MCP",
      severity: "high",
      impact: "x",
      relatedTickets: ["T-001"],
    });
    expect(result.isError).toBeUndefined();
    expect(await readCreatedPhase(root, result.content[0].text)).toBe("alpha");
  });

  it("stays phase-less with no related tickets and no active session", async () => {
    const root = await setupProject();
    const result = await issueCreateTool(root).handler({
      title: "Bug via MCP",
      severity: "high",
      impact: "x",
    });
    expect(result.isError).toBeUndefined();
    expect(await readCreatedPhase(root, result.content[0].text)).toBeNull();
  });

  it("does not override an explicit phase argument", async () => {
    const root = await setupProject();
    const result = await issueCreateTool(root).handler({
      title: "Bug via MCP",
      severity: "high",
      impact: "x",
      relatedTickets: ["T-001"],
      phase: "p5b",
    });
    expect(result.isError).toBeUndefined();
    expect(await readCreatedPhase(root, result.content[0].text)).toBe("p5b");
  });
});
