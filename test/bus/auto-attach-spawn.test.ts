import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initProject } from "../../src/core/init.js";
import { initializeBus } from "../../src/bus/index.js";
import {
  spawnAutoAttachBestEffort,
  type SpawnAutoAttachDeps,
  type SpawnedChildLike,
} from "../../src/bus/auto-attach-spawn.js";
import { writeAutoAttachOutcome } from "../../src/bus/auto-attach-outcome.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function bareRuntime(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aa-spawn-"));
  roots.push(root);
  await initProject(root, { name: "aa-spawn" });
  await initializeBus(root);
  return root;
}

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown>;
}

// A spawn spy that NEVER launches a real process: records the call (incl. options) and returns
// an inert child that records the order of on()/unref() so the crash-safe contract is checked.
function spySpawn(): { deps: SpawnAutoAttachDeps; calls: SpawnCall[]; childOps: string[] } {
  const calls: SpawnCall[] = [];
  const childOps: string[] = [];
  const child: SpawnedChildLike = {
    on: (event: string) => { childOps.push(`on:${event}`); return child; },
    unref: () => { childOps.push("unref"); return child; },
  };
  const spawn = vi.fn((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    return child;
  });
  return { deps: { spawn: spawn as unknown as SpawnAutoAttachDeps["spawn"], cliEntry: "/fake/cli.js" }, calls, childOps };
}

describe("spawnAutoAttachBestEffort (constant-time parent hint)", () => {
  it("spawns a crash-safe detached child with the exact argv and options", async () => {
    const root = await bareRuntime();
    const { deps, calls, childOps } = spySpawn();
    const result = await spawnAutoAttachBestEffort({
      root, client: "claude", clientTaskId: "t", surface: "claude_cli", nowMs: Date.now(),
    }, deps);
    expect(result).toBe("spawned");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(process.execPath);
    expect(calls[0]!.args).toEqual([
      "/fake/cli.js", "bus", "__session-attach",
      "--client", "claude", "--task-id", "t", "--surface", "claude_cli", "--root", root,
    ]);
    // Detached + fully decoupled stdio so the child outlives the hook and never touches its I/O.
    expect(calls[0]!.options).toMatchObject({ cwd: root, detached: true, stdio: "ignore" });
    // The error listener MUST be registered before unref (an async spawn error can never crash
    // the hook), so on("error") strictly precedes unref().
    expect(childOps).toEqual(["on:error", "unref"]);
  });

  it("suppresses the spawn while a fresh running record is present", async () => {
    const root = await bareRuntime();
    const at = new Date().toISOString();
    await writeAutoAttachOutcome(root, { client: "claude", clientTaskId: "t", kind: "running", at });
    const { deps, calls } = spySpawn();
    const result = await spawnAutoAttachBestEffort({
      root, client: "claude", clientTaskId: "t", surface: "claude_cli", nowMs: Date.parse(at) + 1000,
    }, deps);
    expect(result).toBe("suppressed");
    expect(calls).toHaveLength(0);
  });

  it("spawns again once a running record is stale (child presumed dead)", async () => {
    const root = await bareRuntime();
    const at = new Date().toISOString();
    await writeAutoAttachOutcome(root, { client: "claude", clientTaskId: "t", kind: "running", at });
    const { deps, calls } = spySpawn();
    const result = await spawnAutoAttachBestEffort({
      root, client: "claude", clientTaskId: "t", surface: "claude_cli", nowMs: Date.parse(at) + 60_000,
    }, deps);
    expect(result).toBe("spawned");
    expect(calls).toHaveLength(1);
  });

  it("backs off spawning right after a terminal record, then spawns after the interval", async () => {
    const root = await bareRuntime();
    const at = new Date().toISOString();
    await writeAutoAttachOutcome(root, { client: "claude", clientTaskId: "t", kind: "failed", reason: "internal_failure", at });
    const { deps: deps1 } = spySpawn();
    const suppressed = await spawnAutoAttachBestEffort({
      root, client: "claude", clientTaskId: "t", surface: "claude_cli", nowMs: Date.parse(at) + 1000,
    }, deps1);
    expect(suppressed).toBe("suppressed");
    const { deps: deps2, calls } = spySpawn();
    const spawned = await spawnAutoAttachBestEffort({
      root, client: "claude", clientTaskId: "t", surface: "claude_cli", nowMs: Date.parse(at) + 60_000,
    }, deps2);
    expect(spawned).toBe("spawned");
    expect(calls).toHaveLength(1);
  });
});
