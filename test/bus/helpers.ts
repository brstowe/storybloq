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

export interface BusFixture {
  readonly root: string;
  readonly implementer: BusEndpoint;
  readonly reviewer: BusEndpoint;
  readonly implementerTaskId: string;
  readonly reviewerTaskId: string;
}

export async function createBusFixture(name = "bus-test"): Promise<BusFixture> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  await initProject(root, { name });
  await initializeBus(root);
  const implementerTaskId = "codex-task-implementer";
  const reviewerTaskId = "claude-task-reviewer";
  const implementer = (await joinEndpoint(root, {
    role: "implementer",
    client: "codex",
    clientTaskId: implementerTaskId,
    surface: "codex_desktop",
  })).endpoint;
  const reviewer = (await joinEndpoint(root, {
    role: "reviewer",
    client: "claude",
    clientTaskId: reviewerTaskId,
    surface: "claude_cli",
  })).endpoint;
  return { root, implementer, reviewer, implementerTaskId, reviewerTaskId };
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
