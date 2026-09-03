import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import { initializeBus, isBusHookDeliveryEnabled } from "../../src/bus/index.js";
import { convergeProjectDelivery } from "../../src/bus/delivery.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function bareRuntime(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aa-delivery-"));
  roots.push(root);
  await initProject(root, { name: "aa-delivery" });
  await initializeBus(root);
  return root;
}

describe("convergeProjectDelivery", () => {
  it("sets the Stop policy for claude and reports the on-tool hook as applicable", async () => {
    const root = await bareRuntime();
    const result = await convergeProjectDelivery(root, "claude");
    expect(result.policy.ok).toBe(true);
    expect(result.toolHook.applicable).toBe(true);
    expect(await isBusHookDeliveryEnabled(root, "claude")).toBe(true);
  });

  it("sets the Stop policy for codex with NO applicable on-tool hook", async () => {
    const root = await bareRuntime();
    const result = await convergeProjectDelivery(root, "codex");
    expect(result.policy.ok).toBe(true);
    expect(result.toolHook.applicable).toBe(false);
    expect(result.toolHook.ok).toBe(true);
    expect(await isBusHookDeliveryEnabled(root, "codex")).toBe(true);
  });

  it("reports a structured policy failure (does not throw) when the Bus is disabled", async () => {
    // A directory that is not a bus runtime: setBusHookPolicy's assertBusEnabled throws,
    // and convergeProjectDelivery must capture it as a structured degraded outcome.
    const root = await mkdtemp(join(tmpdir(), "aa-nobus-"));
    roots.push(root);
    await initProject(root, { name: "aa-nobus" });
    const result = await convergeProjectDelivery(root, "claude");
    expect(result.policy.ok).toBe(false);
    expect(result.policy.error).toBeTruthy();
  });
});
