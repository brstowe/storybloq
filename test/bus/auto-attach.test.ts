import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import {
  initializeBus,
  isBusHookDeliveryEnabled,
  listEndpoints,
  sendBusMessage,
  setBusHookPolicy,
  __storeTesting,
} from "../../src/bus/index.js";
import { attemptAutoAttach } from "../../src/bus/auto-attach.js";
import { autoAttachOutcomeKey, readAutoAttachOutcome } from "../../src/bus/auto-attach-outcome.js";
import { releaseHardenedLock, tryAcquireHardenedLock } from "../../src/bus/lock.js";
import { resolveBusPaths } from "../../src/bus/paths.js";
import { createBusFixture, type BusFixture } from "./helpers.js";

const roots: string[] = [];
const fixtures: BusFixture[] = [];

afterEach(async () => {
  __storeTesting.setMaterializeFailureHook(null);
  await Promise.all([
    ...roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ...fixtures.splice(0).map((f) => rm(f.root, { recursive: true, force: true })),
  ]);
});

async function fixture(): Promise<BusFixture> {
  const value = await createBusFixture();
  fixtures.push(value);
  await enableAutoAttach(value.root);
  return value;
}

async function bareRuntime(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aa-bare-"));
  roots.push(root);
  await initProject(root, { name: "aa-bare" });
  await initializeBus(root);
  await enableAutoAttach(root);
  return root;
}

async function enableAutoAttach(root: string): Promise<void> {
  const path = join(root, ".story", "config.json");
  const config = JSON.parse(await readFile(path, "utf-8"));
  config.bus = { ...(config.bus ?? {}), autoAttach: true };
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8");
}

async function disableAutoAttach(root: string): Promise<void> {
  const path = join(root, ".story", "config.json");
  const config = JSON.parse(await readFile(path, "utf-8"));
  config.bus = { ...(config.bus ?? {}), autoAttach: false };
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8");
}

async function forgeOffline(root: string, endpointId: string): Promise<void> {
  const path = join(root, ".story", "bus", "endpoints", `${endpointId}.json`);
  const endpoint = JSON.parse(await readFile(path, "utf-8"));
  await writeFile(path, JSON.stringify({
    ...endpoint,
    state: "attached",
    processRef: { pid: 999999999, signature: "darwin:deadbeef", capturedAt: new Date().toISOString() },
  }, null, 2) + "\n", "utf-8");
}

async function activeEndpointIds(root: string): Promise<string[]> {
  const { endpoints } = await listEndpoints(root);
  return endpoints.filter((e) => !e.retiredAt).map((e) => e.endpointId);
}

describe("attemptAutoAttach (child)", () => {
  it("attaches into a free slot on an empty Bus and converges Claude delivery", async () => {
    const root = await bareRuntime();
    const result = await attemptAutoAttach({ root, client: "claude", clientTaskId: "fresh-task", surface: "claude_cli" });
    // The endpoint is minted and the reliable Stop policy converges. The best-effort on-tool
    // hook install is environment-dependent (resolveStorybloqBin), so the terminal kind is
    // "attached", or "degraded/tool_hook_failed" if only the on-tool hook could not install --
    // the Stop tier (isBusHookDeliveryEnabled) is on either way.
    expect(["attached", "degraded"]).toContain(result.kind);
    if (result.kind === "degraded") expect(result.reason).toBe("tool_hook_failed");
    const active = await activeEndpointIds(root);
    expect(active).toHaveLength(1);
    expect(await isBusHookDeliveryEnabled(root, "claude")).toBe(true);
    expect((await readAutoAttachOutcome(root, "claude", "fresh-task"))?.kind).toBe(result.kind);
  });

  it("removes its record and mutates nothing when auto-attach is disabled", async () => {
    const root = await bareRuntime();
    await disableAutoAttach(root);
    const result = await attemptAutoAttach({ root, client: "claude", clientTaskId: "fresh-task", surface: "claude_cli" });
    expect(result.kind).toBe("removed");
    expect(await activeEndpointIds(root)).toHaveLength(0);
    expect(await readAutoAttachOutcome(root, "claude", "fresh-task")).toBeNull();
  });

  it("fails with runtime_absent and mutates nothing when the Bus is not bootstrapped", async () => {
    const root = await mkdtemp(join(tmpdir(), "aa-noruntime-"));
    roots.push(root);
    await initProject(root, { name: "aa-noruntime" });
    // No bus runtime: the create:false try-lock refuses to re-materialize the lock dir -> removed.
    const result = await attemptAutoAttach({ root, client: "claude", clientTaskId: "t", surface: "claude_cli" });
    expect(result.kind).toBe("removed");
    // The attempt must NOT have resurrected any part of the runtime.
    expect(await readdir(join(root, ".story")).then((e) => e.includes("bus"))).toBe(false);
  });

  it("fails with registry_corrupt and mutates nothing on a corrupt endpoint registry", async () => {
    const root = await bareRuntime();
    const bad = join(root, ".story", "bus", "endpoints", `${randomUUID()}.json`);
    await writeFile(bad, "not-json", "utf-8");
    const result = await attemptAutoAttach({ root, client: "claude", clientTaskId: "t", surface: "claude_cli" });
    expect(result).toMatchObject({ kind: "failed", reason: "registry_corrupt" });
    expect(await activeEndpointIds(root)).toHaveLength(0);
  });

  it("replaces a proven-dead peer, inheriting its mail (predecessorEndpointId + materialized)", async () => {
    const value = await fixture();
    // a (codex) -> b (claude), then forge b dead and leave the message unacked.
    await sendBusMessage(value.root, {
      endpointId: value.a.endpointId,
      clientTaskId: value.aTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "high",
      body: "for the successor",
      refs: { ciRun: "ci-inherited" },
      idempotencyKey: "inherited-1",
    });
    await forgeOffline(value.root, value.b.endpointId);

    const result = await attemptAutoAttach({ root: value.root, client: "claude", clientTaskId: "successor-task", surface: "claude_cli" });
    // The replace + materialization succeed; the terminal kind is "replaced", or
    // "degraded/tool_hook_failed" if only the env-dependent on-tool hook could not install
    // (the Stop tier and the replace/materialize side effects below hold either way).
    expect(["replaced", "degraded"]).toContain(result.kind);
    if (result.kind === "degraded") expect(result.reason).toBe("tool_hook_failed");

    const { endpoints } = await listEndpoints(value.root);
    const successor = endpoints.find((e) => !e.retiredAt && e.clientTaskId === "successor-task");
    expect(successor?.predecessorEndpointId).toBe(value.b.endpointId);
    // The inherited pointer is physically present in the successor's mailbox (materialized).
    const mailboxDir = join(value.root, ".story", "bus", "mailboxes", successor!.endpointId);
    const pointerFiles = (await readdir(mailboxDir).catch(() => [])).filter((f) => f.endsWith(".json"));
    expect(pointerFiles.length).toBeGreaterThan(0);
  });

  it("stays successful-but-degraded (mail left, no overclaim) when materialization fails on replace", async () => {
    const value = await fixture();
    await sendBusMessage(value.root, {
      endpointId: value.a.endpointId,
      clientTaskId: value.aTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "high",
      body: "for the successor",
      refs: { ciRun: "ci-inherited" },
      idempotencyKey: "inherited-1",
    });
    await forgeOffline(value.root, value.b.endpointId);
    __storeTesting.setMaterializeFailureHook(async () => { throw new Error("forced materialize failure"); });

    const result = await attemptAutoAttach({ root: value.root, client: "claude", clientTaskId: "successor-task", surface: "claude_cli" });
    expect(result).toMatchObject({ kind: "degraded", reason: "materialization_failed" });
    // The replace still happened (endpoint minted); the record is degraded, not attached.
    const { endpoints } = await listEndpoints(value.root);
    expect(endpoints.some((e) => !e.retiredAt && e.clientTaskId === "successor-task")).toBe(true);
    expect((await readAutoAttachOutcome(value.root, "claude", "successor-task"))?.reason).toBe("materialization_failed");
  });

  it("recovers a degraded successor on a later run: re-materializes, mints no endpoint, overwrites the degraded record", async () => {
    const value = await fixture();
    await sendBusMessage(value.root, {
      endpointId: value.a.endpointId,
      clientTaskId: value.aTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "high",
      body: "for the successor",
      refs: { ciRun: "ci-inherited" },
      idempotencyKey: "inherited-1",
    });
    await forgeOffline(value.root, value.b.endpointId);
    // First attempt: replace succeeds, materialization is forced to fail -> degraded.
    __storeTesting.setMaterializeFailureHook(async () => { throw new Error("forced materialize failure"); });
    const degraded = await attemptAutoAttach({ root: value.root, client: "claude", clientTaskId: "successor-task", surface: "claude_cli" });
    expect(degraded).toMatchObject({ kind: "degraded", reason: "materialization_failed" });
    const activeAfterDegraded = await activeEndpointIds(value.root);

    // Second attempt (recovery branch): the task now OWNS the successor endpoint (with a
    // predecessor link). With materialization healed, it re-materializes and converges in place.
    __storeTesting.setMaterializeFailureHook(null);
    const recovered = await attemptAutoAttach({ root: value.root, client: "claude", clientTaskId: "successor-task", surface: "claude_cli" });
    expect(["converged", "degraded"]).toContain(recovered.kind);
    if (recovered.kind === "degraded") expect(recovered.reason).toBe("tool_hook_failed");
    // No NEW endpoint was minted (recovery, not re-attach).
    expect((await activeEndpointIds(value.root)).sort()).toEqual(activeAfterDegraded.sort());
    // The stale materialization_failed record was overwritten; the inherited mail is now present.
    const outcome = await readAutoAttachOutcome(value.root, "claude", "successor-task");
    expect(outcome?.reason).not.toBe("materialization_failed");
    const successor = (await listEndpoints(value.root)).endpoints.find((e) => !e.retiredAt && e.clientTaskId === "successor-task");
    const mailboxDir = join(value.root, ".story", "bus", "mailboxes", successor!.endpointId);
    const pointerFiles = (await readdir(mailboxDir).catch(() => [])).filter((f) => f.endsWith(".json"));
    expect(pointerFiles.length).toBeGreaterThan(0);
  });

  it("skips (skipped_full) when both slots are held by non-offline peers", async () => {
    const value = await fixture(); // a codex_desktop (unknown) + b claude_cli (unknown, no live process)
    const result = await attemptAutoAttach({ root: value.root, client: "claude", clientTaskId: "third-task", surface: "claude_cli" });
    expect(result.kind).toBe("skipped_full");
    expect(await activeEndpointIds(value.root)).toHaveLength(2);
  });

  it("recovers an already-owned endpoint by converging project delivery only (no re-attach)", async () => {
    const value = await fixture();
    // Turn delivery off, then let the owning task's child re-converge it.
    await setBusHookPolicy(value.root, ["claude"], false);
    expect(await isBusHookDeliveryEnabled(value.root, "claude")).toBe(false);
    const before = (await activeEndpointIds(value.root)).length;

    const result = await attemptAutoAttach({ root: value.root, client: "claude", clientTaskId: value.bTaskId, surface: "claude_cli" });
    // Recovery converges project delivery in place. Terminal kind is "converged", or
    // "degraded/tool_hook_failed" when only the env-dependent on-tool hook cannot install -- the
    // reliable Stop policy (asserted below) converges regardless, and no new endpoint is minted.
    expect(["converged", "degraded"]).toContain(result.kind);
    if (result.kind === "degraded") expect(result.reason).toBe("tool_hook_failed");
    expect(await isBusHookDeliveryEnabled(value.root, "claude")).toBe(true);
    expect(await activeEndpointIds(value.root)).toHaveLength(before); // no new endpoint
  });

  it("is single-flighted: a child yields busy while the task lock is held, and mutates nothing", async () => {
    const root = await bareRuntime();
    // Deterministically hold this task's hardened lock (as a live holder = this test process),
    // then prove the child self-gates to "busy" instead of racing.
    const paths = await resolveBusPaths(root, false);
    const lockPath = join(paths.locks, `auto-attach-${autoAttachOutcomeKey("claude", "same-task")}.lock`);
    const held = await tryAcquireHardenedLock(lockPath, { create: false });
    expect(held).not.toBeNull();
    try {
      const result = await attemptAutoAttach({ root, client: "claude", clientTaskId: "same-task", surface: "claude_cli" });
      expect(result.kind).toBe("busy");
      // Busy child must never mint an endpoint nor leave an outcome record behind.
      expect(await activeEndpointIds(root)).toHaveLength(0);
      expect(await readAutoAttachOutcome(root, "claude", "same-task")).toBeNull();
    } finally {
      await releaseHardenedLock(held!);
    }
  });
});
