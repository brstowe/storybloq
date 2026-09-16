/**
 * ISS-1221: the create now distinguishes an omitted phase (undefined: infer)
 * from an explicitly resolved null (write none). Neither external surface may
 * ever produce the null form on its own, or a plain `storybloq issue create`
 * would stop inferring. Both adapters build a literal with a `phase` key, so
 * the assertion is on the VALUE, never on the key's absence.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yargs from "yargs";

vi.mock("../../../src/cli/commands/issue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/cli/commands/issue.js")>();
  return { ...actual, handleIssueCreate: vi.fn(actual.handleIssueCreate) };
});

import { handleIssueCreate } from "../../../src/cli/commands/issue.js";
import { registerAllTools } from "../../../src/mcp/tools.js";
import { registerIssueCommand } from "../../../src/cli/register.js";

const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "valid", "basic");

function receivedPhase(): unknown {
  const calls = vi.mocked(handleIssueCreate).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return (calls[calls.length - 1]![0] as { phase?: unknown }).phase;
}

describe("external surfaces pass an omitted phase as undefined, never null (ISS-1221)", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    vi.mocked(handleIssueCreate).mockClear();
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  async function setupProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "iss1221-surface-"));
    tmpDirs.push(dir);
    await cp(FIXTURES_DIR, join(dir, ".story"), { recursive: true });
    return dir;
  }

  it("the MCP tool", async () => {
    const root = await setupProject();
    let handler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
    const server = {
      registerTool: (name: string, _config: unknown, h: typeof handler) => { if (name === "storybloq_issue_create") handler = h; },
    } as unknown as Parameters<typeof registerAllTools>[0];
    registerAllTools(server, root);
    expect(handler).not.toBeNull();
    await handler!({ title: "Bug via MCP", severity: "high", impact: "x" });
    const phase = receivedPhase();
    expect(phase).toBeUndefined();
    expect(phase).not.toBeNull();
  });

  it("the yargs command, with no --phase and with --phase \"\"", async () => {
    const root = await setupProject();
    const cwd = process.cwd();
    process.chdir(root);
    try {
      for (const extra of [[], ["--phase", ""]]) {
        vi.mocked(handleIssueCreate).mockClear();
        const parser = registerIssueCommand(yargs(["issue", "create", "--title", "Bug via CLI", "--severity", "high", "--impact", "x", ...extra]))
          .exitProcess(false);
        await parser.parseAsync();
        const phase = receivedPhase();
        expect(phase).toBeUndefined();
        expect(phase).not.toBeNull();
      }
    } finally {
      process.chdir(cwd);
    }
  });
});
