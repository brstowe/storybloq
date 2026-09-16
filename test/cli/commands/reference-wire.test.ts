import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { E2ECliFixture, CLI_PATH } from "../../helpers/e2e-cli.js";
import { handleReference } from "../../../src/cli/commands/reference.js";

describe("degraded MCP reference", () => {
  it("matches the actual no-project tools/list surface", async () => {
    const fixture = await E2ECliFixture.create();
    const client = new Client({ name: "reference-parity", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "--mcp"],
      cwd: fixture.root,
      env: Object.fromEntries(Object.entries(fixture.env({ STORYBLOQ_PROJECT_ROOT: "", CLAUDESTORY_PROJECT_ROOT: "" })).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", chunk => { stderr += String(chunk); });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const section = handleReference("md").split("### MCP Tools (degraded mode)")[1]!.split("## Review verdict artifacts")[0]!;
      const entries = [...section.matchAll(/^- \*\*(storybloq_\w+)\*\*(?: \(([^)]+)\))?/gm)];
      expect(entries.map(entry => entry[1]).sort()).toEqual(tools.map(tool => tool.name).sort());
      expect(new Set(entries.map(entry => entry[1])).size).toBe(entries.length);
      for (const tool of tools) {
        const documented = entries.find(entry => entry[1] === tool.name)!;
        const params = Object.keys(tool.inputSchema.properties ?? {}).map(name => name + (tool.inputSchema.required?.includes(name) ? "" : "?"));
        expect(documented[2]?.split(", ").sort() ?? [], tool.name).toEqual(params.sort());
      }
    } finally {
      await client.close();
      await transport.close();
      fixture.recordResult({ stdout: "", stderr });
      try { fixture.assertNoHousekeepingNotices(); } finally { await fixture.cleanup(); }
    }
  }, 15000);
});
