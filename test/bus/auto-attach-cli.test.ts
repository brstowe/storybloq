import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import { initializeBus } from "../../src/bus/index.js";
import { writeAutoAttachOutcome, readAutoAttachOutcome } from "../../src/bus/auto-attach-outcome.js";
import { enableBusAutoAttach } from "../../src/cli/commands/bus.js";
import { runBusCli } from "./cli-harness.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aa-cli-"));
  roots.push(root);
  await initProject(root, { name: "aa-cli" });
  await initializeBus(root);
  return root;
}

async function readAutoAttachFlag(root: string): Promise<unknown> {
  const config = JSON.parse(await readFile(join(root, ".story", "config.json"), "utf-8"));
  return config.bus?.autoAttach;
}

async function setAutoAttachFlagTrue(root: string): Promise<void> {
  const path = join(root, ".story", "config.json");
  const config = JSON.parse(await readFile(path, "utf-8"));
  config.bus = { ...(config.bus ?? {}), autoAttach: true };
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8");
}

// Minimal BusSetupResult stub: enableBusAutoAttach only inspects setupState + completedSteps.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubResult(over: Record<string, unknown>): any {
  return { setupState: "ready", completedSteps: [], remainingSteps: [], nextActions: [], ...over };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ENABLE_ARGS: any = { client: undefined, taskId: undefined, surface: undefined, delivery: "live", replace: undefined, forceArchive: false };

// NOTE: `bus auto-attach on` runs the full live `bus setup`, which mutates the real ~/.claude
// and ~/.codex global hook files -- forbidden in automated tests (see cli-harness). The `on`
// path is exercised by the live two-session dogfood; here we test the safe `off` teardown.
describe("bus auto-attach off (CLI)", () => {
  it("clears the opt-in flag and sweeps this project's outcome records", async () => {
    const root = await project();
    // Simulate a project that had auto-attach on with a lingering degraded record.
    await runBusCli(root, ["bus", "auto-attach", "off"]); // no-op flag write baseline
    await writeAutoAttachOutcome(root, {
      client: "claude",
      clientTaskId: "some-task",
      kind: "degraded",
      reason: "materialization_failed",
      at: new Date().toISOString(),
    });

    const { stdout, exitCode } = await runBusCli(root, ["bus", "auto-attach", "off"]);
    expect(exitCode ?? 0).toBe(0);
    expect(stdout).toContain("OFF");
    expect(await readAutoAttachFlag(root)).toBe(false);
    expect(await readAutoAttachOutcome(root, "claude", "some-task")).toBeNull();
  });

  it("rejects an invalid state argument", async () => {
    const root = await project();
    const { exitCode } = await runBusCli(root, ["bus", "auto-attach", "sideways"]).catch(() => ({ exitCode: 1 }));
    expect(exitCode ?? 1).not.toBe(0);
  });
});

// The `on` enable orchestration is fail-closed: it revokes the flag BEFORE running setup and
// re-arms only on a proven-usable result. Tested via an injected setup so no global hook files
// are touched (the real path installs ~/.claude and ~/.codex hooks).
describe("enableBusAutoAttach fail-closed enable (injected setup)", () => {
  it("REVOKES a previously-true flag when setup throws", async () => {
    const root = await project();
    await setAutoAttachFlagTrue(root);
    await expect(
      enableBusAutoAttach(root, ENABLE_ARGS, async () => { throw new Error("preflight failed"); }),
    ).rejects.toThrow();
    expect(await readAutoAttachFlag(root)).toBe(false);
  });

  it("leaves the flag FALSE for a usable state that never completed enable-hooks", async () => {
    const root = await project();
    await setAutoAttachFlagTrue(root);
    const result = await enableBusAutoAttach(root, ENABLE_ARGS, async () => stubResult({ setupState: "ready", completedSteps: [] }));
    expect(result.setupState).toBe("ready");
    expect(await readAutoAttachFlag(root)).toBe(false);
  });

  it("leaves the flag FALSE for an UNUSABLE state even when enable-hooks completed", async () => {
    const root = await project();
    await setAutoAttachFlagTrue(root);
    await enableBusAutoAttach(root, ENABLE_ARGS, async () => stubResult({ setupState: "runtime_lost", completedSteps: ["enable-hooks"] }));
    expect(await readAutoAttachFlag(root)).toBe(false);
  });

  it("arms the flag TRUE only for a usable result with enable-hooks completed", async () => {
    const root = await project();
    await enableBusAutoAttach(root, ENABLE_ARGS, async () => stubResult({ setupState: "ready", completedSteps: ["enable-hooks"] }));
    expect(await readAutoAttachFlag(root)).toBe(true);
  });
});
