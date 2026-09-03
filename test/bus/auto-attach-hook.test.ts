import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initProject } from "../../src/core/init.js";
import {
  initializeBus,
  isBusAutoAttachEnabledFromDisk,
  joinEndpoint,
  setBusHookPolicy,
} from "../../src/bus/index.js";

// Mock the spawner so the hook wiring can be exercised WITHOUT launching a real detached
// process (the test runner's argv[1] would otherwise be executed). Hoisted above the import
// of session-compact so its `spawnAutoAttachBestEffort` binding resolves to this spy.
const { spawnSpy } = vi.hoisted(() => ({ spawnSpy: vi.fn(async () => "spawned" as const) }));
vi.mock("../../src/bus/auto-attach-spawn.js", () => ({ spawnAutoAttachBestEffort: spawnSpy }));

import { handleSessionResumePrompt } from "../../src/cli/commands/session-compact.js";
import { writeAutoAttachOutcome } from "../../src/bus/auto-attach-outcome.js";

const roots: string[] = [];

beforeEach(() => {
  spawnSpy.mockClear();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aa-hook-"));
  roots.push(root);
  await initProject(root, { name: "aa-hook" });
  await initializeBus(root);
  return root;
}

async function setAutoAttach(root: string, enabled: boolean): Promise<void> {
  const path = join(root, ".story", "config.json");
  const config = JSON.parse(await readFile(path, "utf-8"));
  config.bus = { ...(config.bus ?? {}), autoAttach: enabled };
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8");
}

async function captureResumePrompt(options: Parameters<typeof handleSessionResumePrompt>[0]): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await handleSessionResumePrompt(options);
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

describe("isBusAutoAttachEnabledFromDisk", () => {
  it("is true only when features.bus AND bus.autoAttach are both set", async () => {
    const root = await project();
    expect(await isBusAutoAttachEnabledFromDisk(root)).toBe(false); // flag not set yet
    await setAutoAttach(root, true);
    expect(await isBusAutoAttachEnabledFromDisk(root)).toBe(true);
    await setAutoAttach(root, false);
    expect(await isBusAutoAttachEnabledFromDisk(root)).toBe(false);
  });

  it("is false (never throws) when there is no config file", async () => {
    const root = await mkdtemp(join(tmpdir(), "aa-hook-noconfig-"));
    roots.push(root);
    expect(await isBusAutoAttachEnabledFromDisk(root)).toBe(false);
  });

  it("fails closed (false) for an oversized, symlinked, malformed, or non-regular config", async () => {
    const configPath = (root: string) => join(root, ".story", "config.json");

    // Oversized: valid-looking JSON over the 256 KiB cap must be rejected by the read bound.
    const big = await project();
    await setAutoAttach(big, true);
    const padded = JSON.stringify({ features: { bus: true }, bus: { autoAttach: true }, pad: "x".repeat(300 * 1024) });
    await writeFile(configPath(big), padded, "utf-8");
    expect(await isBusAutoAttachEnabledFromDisk(big)).toBe(false);

    // Symlinked config: the no-follow reader must refuse to follow it.
    const linked = await project();
    await setAutoAttach(linked, true);
    const realCfg = await readFile(configPath(linked), "utf-8");
    await rm(configPath(linked));
    const target = join(linked, ".story", "real-config.json");
    await writeFile(target, realCfg, "utf-8");
    await symlink(target, configPath(linked));
    expect(await isBusAutoAttachEnabledFromDisk(linked)).toBe(false);

    // Malformed JSON: parse failure fails open to false.
    const bad = await project();
    await writeFile(configPath(bad), "{ not json", "utf-8");
    expect(await isBusAutoAttachEnabledFromDisk(bad)).toBe(false);

    // Non-regular (a directory where the config file belongs): rejected as not a regular file.
    const dir = await project();
    await rm(configPath(dir));
    await mkdir(configPath(dir));
    expect(await isBusAutoAttachEnabledFromDisk(dir)).toBe(false);
  });
});

describe("handleSessionResumePrompt auto-attach wiring (fail-open)", () => {
  it("stays fail-open and emits valid output on a compaction start (never spawns on compact)", async () => {
    const root = await project();
    await setAutoAttach(root, true);
    // source=compact is explicitly excluded from the auto-attach spawn path; the hook must
    // still complete cleanly with a valid resume prompt and no thrown error.
    const output = await captureResumePrompt({
      source: "compact",
      clientTaskId: "claude-compact-task",
      cwd: root,
    });
    expect(typeof output).toBe("string");
  });

  it("does not throw when auto-attach is disabled (today's behavior preserved)", async () => {
    const root = await project();
    await setAutoAttach(root, false);
    await expect(captureResumePrompt({
      source: "startup",
      clientTaskId: "claude-startup-task",
      cwd: root,
    })).resolves.toBeTypeOf("string");
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("spawns exactly once with the claude_cli surface when enabled and this task has no endpoint", async () => {
    const root = await project();
    await setAutoAttach(root, true);
    const output = await captureResumePrompt({
      source: "startup",
      clientTaskId: "claude-fresh-task",
      cwd: root,
    });
    expect(typeof output).toBe("string");
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.calls[0]![0]).toMatchObject({
      root, client: "claude", clientTaskId: "claude-fresh-task", surface: "claude_cli",
    });
  });

  it("spawns the recovery child when an endpoint exists but delivery has NOT converged", async () => {
    const root = await project();
    await setAutoAttach(root, true);
    await joinEndpoint(root, { client: "claude", clientTaskId: "owner-task", surface: "claude_cli" });
    await setBusHookPolicy(root, ["claude"], false); // delivery off -> no marker -> recovery spawn
    await captureResumePrompt({ source: "startup", clientTaskId: "owner-task", cwd: root });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT spawn in steady state (endpoint present AND delivery converged -> marker emitted)", async () => {
    const root = await project();
    await setAutoAttach(root, true);
    await joinEndpoint(root, { client: "claude", clientTaskId: "owner-task", surface: "claude_cli" });
    await setBusHookPolicy(root, ["claude"], true); // delivery on -> marker emitted -> suppressed
    const output = await captureResumePrompt({ source: "startup", clientTaskId: "owner-task", cwd: root });
    expect(output).toContain("[storybloq-bus-endpoint]");
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("STILL spawns recovery when delivery is on (marker emitted) but a matching degraded outcome exists", async () => {
    const root = await project();
    await setAutoAttach(root, true);
    const joined = await joinEndpoint(root, { client: "claude", clientTaskId: "owner-task", surface: "claude_cli" });
    await setBusHookPolicy(root, ["claude"], true); // delivery on -> a marker WILL be emitted
    // A materialization-degraded outcome bound to this active endpoint: a marker-only gate would
    // wrongly suppress the recovery child and strand the endpoint (critical for Codex, no Stop retry).
    await writeAutoAttachOutcome(root, {
      client: "claude",
      clientTaskId: "owner-task",
      kind: "degraded",
      endpointId: joined.endpoint.endpointId,
      reason: "materialization_failed",
      at: new Date().toISOString(),
    });
    const output = await captureResumePrompt({ source: "startup", clientTaskId: "owner-task", cwd: root });
    expect(output).toContain("[storybloq-bus-endpoint]"); // marker present ...
    expect(spawnSpy).toHaveBeenCalledTimes(1);              // ... yet recovery still spawns
  });

  it("does NOT spawn (and stays valid) when the config exceeds the read bound", async () => {
    const root = await project();
    await setAutoAttach(root, true);
    const padded = JSON.stringify({ features: { bus: true }, bus: { autoAttach: true }, pad: "x".repeat(300 * 1024) });
    await writeFile(join(root, ".story", "config.json"), padded, "utf-8");
    const output = await captureResumePrompt({ source: "startup", clientTaskId: "claude-fresh-task", cwd: root });
    expect(typeof output).toBe("string");
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("fails OPEN: still spawns (valid output) when the convergence read errors on a broken registry", async () => {
    const root = await project();
    await setAutoAttach(root, true);
    // Replace the endpoints registry dir with a regular file so the convergence read errors.
    // The predicate must fail open so the child still runs and records the real terminal.
    const endpointsDir = join(root, ".story", "bus", "endpoints");
    await rm(endpointsDir, { recursive: true, force: true });
    await writeFile(endpointsDir, "not a directory", "utf-8");
    const output = await captureResumePrompt({ source: "startup", clientTaskId: "claude-fresh-task", cwd: root });
    expect(typeof output).toBe("string");
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
});
