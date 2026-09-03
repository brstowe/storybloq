import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { handleIssueCreate, handleIssueUpdate } from "../../src/cli/commands/issue.js";
import {
  initializeBus,
  joinEndpoint,
  type BusEndpoint,
} from "../../src/bus/index.js";

// v2 endpoints are role-free (roles are per-message). The fixture joins two
// endpoints, `a` (a Codex Desktop client) and `b` (a Claude Code client).
// Legacy `implementer`/`reviewer` aliases are kept so existing tests that phrase
// intent in the old role vocabulary still exercise the same endpoints.
export interface BusFixture {
  readonly root: string;
  readonly a: BusEndpoint;
  readonly b: BusEndpoint;
  readonly aTaskId: string;
  readonly bTaskId: string;
  readonly implementer: BusEndpoint;
  readonly reviewer: BusEndpoint;
  readonly implementerTaskId: string;
  readonly reviewerTaskId: string;
}

export async function createBusFixture(name = "bus-test"): Promise<BusFixture> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  await initProject(root, { name });
  await initializeBus(root);
  const aTaskId = "codex-task-implementer";
  const bTaskId = "claude-task-reviewer";
  const a = (await joinEndpoint(root, {
    client: "codex",
    clientTaskId: aTaskId,
    surface: "codex_desktop",
  })).endpoint;
  const b = (await joinEndpoint(root, {
    client: "claude",
    clientTaskId: bTaskId,
    surface: "claude_cli",
  })).endpoint;
  return {
    root,
    a,
    b,
    aTaskId,
    bTaskId,
    implementer: a,
    reviewer: b,
    implementerTaskId: aTaskId,
    reviewerTaskId: bTaskId,
  };
}

export async function createIssue(
  root: string,
  severity: "critical" | "high" | "medium" | "low",
): Promise<string> {
  const result = await handleIssueCreate({
    title: `${severity} Bus finding`,
    severity,
    impact: "Bus integration fixture",
    components: ["bus"],
    relatedTickets: [],
    location: [],
  }, "json", root);
  const parsed = JSON.parse(result.output) as { data?: { id?: string } };
  if (!parsed.data?.id) throw new Error(`Issue creation failed: ${result.output}`);
  return parsed.data.id;
}

export async function resolveIssue(root: string, issueId: string): Promise<void> {
  await handleIssueUpdate(issueId, {
    status: "resolved",
    resolution: "Verified by the Bus test",
  }, "json", root);
}
