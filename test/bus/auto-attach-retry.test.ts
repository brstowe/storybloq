import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import {
  initializeBus,
  joinEndpoint,
  setBusHookPolicy,
} from "../../src/bus/index.js";
import { autoAttachRetryNeeded } from "../../src/cli/commands/hook-status.js";
import { writeAutoAttachOutcome } from "../../src/bus/auto-attach-outcome.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runtimeWithClaude(taskId: string): Promise<{ root: string; endpointId: string }> {
  const root = await mkdtemp(join(tmpdir(), "aa-retry-"));
  roots.push(root);
  await initProject(root, { name: "aa-retry" });
  await initializeBus(root);
  const joined = await joinEndpoint(root, { client: "claude", clientTaskId: taskId, surface: "claude_cli" });
  return { root, endpointId: joined.endpoint.endpointId };
}

describe("autoAttachRetryNeeded (in-session retry predicate)", () => {
  it("returns true when the task has no endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "aa-retry-"));
    roots.push(root);
    await initProject(root, { name: "aa-retry" });
    await initializeBus(root);
    expect(await autoAttachRetryNeeded(root, "claude", "no-endpoint-task")).toBe(true);
  });

  it("returns true when an endpoint exists but delivery policy did not converge", async () => {
    const { root } = await runtimeWithClaude("owner-task");
    await setBusHookPolicy(root, ["claude"], false);
    expect(await autoAttachRetryNeeded(root, "claude", "owner-task")).toBe(true);
  });

  it("returns false in steady state (endpoint + delivery on + no degraded record)", async () => {
    const { root } = await runtimeWithClaude("owner-task");
    await setBusHookPolicy(root, ["claude"], true);
    expect(await autoAttachRetryNeeded(root, "claude", "owner-task")).toBe(false);
  });

  it("returns true when an unresolved degraded outcome is recorded for the active endpoint", async () => {
    const { root, endpointId } = await runtimeWithClaude("owner-task");
    await setBusHookPolicy(root, ["claude"], true);
    await writeAutoAttachOutcome(root, {
      client: "claude",
      clientTaskId: "owner-task",
      kind: "degraded",
      endpointId,
      reason: "materialization_failed",
      at: new Date().toISOString(),
    });
    expect(await autoAttachRetryNeeded(root, "claude", "owner-task")).toBe(true);
  });

  it("ignores a degraded record whose endpointId no longer matches the active endpoint", async () => {
    const { root } = await runtimeWithClaude("owner-task");
    await setBusHookPolicy(root, ["claude"], true);
    await writeAutoAttachOutcome(root, {
      client: "claude",
      clientTaskId: "owner-task",
      kind: "degraded",
      endpointId: "00000000-0000-4000-8000-000000000000",
      reason: "materialization_failed",
      at: new Date().toISOString(),
    });
    expect(await autoAttachRetryNeeded(root, "claude", "owner-task")).toBe(false);
  });
});
