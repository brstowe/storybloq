import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import { canonicalHash } from "../../src/bus/canonical.js";
import { busSummary, classifyBusRuntime, initializeBus, joinEndpoint, mailboxHasPointerCandidate, readMailboxHighwater, sendBusMessage, setBusHookPolicy, __storeTesting } from "../../src/bus/index.js";
import { resolveBusPaths } from "../../src/bus/paths.js";
import { __testing as projectSettingsTesting, hasBusToolHook, installProjectBusToolHook, readProjectSettingsNoFollow } from "../../src/core/project-settings.js";
import { runBusCli } from "./cli-harness.js";

// D4 guided setup: idempotent, resumable, one command per task. All setup tests
// use --delivery poll: the live path mutates the real ~/.claude and ~/.codex hook
// files, which a test must never touch. Poll delivery skips GLOBAL client hook
// mutation (it only clears the project-local hook policy + on-tool hook in the temp
// root; T-427).

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  roots.push(root);
  await initProject(root, { name });
  return root;
}

async function busEnabled(root: string): Promise<boolean> {
  const config = JSON.parse(await readFile(join(root, ".story", "config.json"), "utf-8"));
  return config.features?.bus === true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function setup(root: string, extra: string[] = []): Promise<{ data: Record<string, unknown>; error?: { code: string; message: string } }> {
  const { stdout } = await runBusCli(root, [
    "bus", "setup", "--format", "json", "--client", "claude", "--delivery", "poll", ...extra,
  ]);
  return JSON.parse(stdout);
}

// Recursively lists a directory's entries as sorted relative paths (directories
// suffixed with `/`), used to prove a runtime tree is byte-for-byte unchanged. Each
// regular file carries a content hash so an IN-PLACE mutation of an existing file (an
// endpoint record, a counter) that preserves the tree SHAPE is still detected by a
// before/after comparison, not just added/removed paths. Symlinks/special entries are
// tagged by kind and never traversed.
async function walkTree(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      out.push(`${prefix}${entry.name}/`);
      out.push(...(await walkTree(join(dir, entry.name), `${prefix}${entry.name}/`)));
    } else if (entry.isFile() && !entry.isSymbolicLink()) {
      const bytes = await readFile(join(dir, entry.name));
      out.push(`${prefix}${entry.name}@${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`);
    } else {
      out.push(`${prefix}${entry.name}#${entry.isSymbolicLink() ? "symlink" : "special"}`);
    }
  }
  return out.sort();
}

// Hand-builds a single-endpoint, caller-owned, thread-free v1 runtime that drains
// cleanly (the caller's own endpoint is exempt from the migration offline proof and
// there is no pending mail), so `bus setup` upgrades it to v2 with migrated:true.
async function createDrainableV1(name: string, taskId: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  roots.push(root);
  await initProject(root, { name });
  const canonical = await realpath(root);
  const configPath = join(root, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.features = { ...(config.features ?? {}), bus: true };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await writeFile(join(root, ".story", ".gitignore"), "bus/\nbus-migration/\n", "utf-8");

  const busRoot = join(root, ".story", "bus");
  for (const dir of [
    "threads", "endpoints", "succession", "locks",
    "mailboxes/implementer", "mailboxes/implementer/pending",
    "mailboxes/reviewer", "mailboxes/reviewer/pending",
  ]) {
    await mkdir(join(busRoot, dir), { recursive: true, mode: 0o700 });
  }
  const now = new Date().toISOString();
  await writeFile(join(busRoot, "instance.json"), JSON.stringify({
    schema: "storybloq-bus-instance/v1",
    instanceId: randomUUID(),
    projectRootHash: canonicalHash(canonical),
    createdAt: now,
  }, null, 2) + "\n", "utf-8");
  const endpointId = randomUUID();
  await writeFile(join(busRoot, "endpoints", `${endpointId}.json`), JSON.stringify({
    schema: "storybloq-bus-endpoint/v1",
    endpointId,
    role: "implementer",
    client: "codex",
    surface: "codex_desktop",
    clientTaskId: taskId,
    processRef: null,
    state: "unknown",
    joinedAt: now,
    lastSeenAt: now,
    wakePolicy: "never",
    lastPolledMailboxSeq: 0,
    lastBlockedMailboxSeq: 0,
    retiredAt: null,
    retiredReason: null,
  }, null, 2) + "\n", "utf-8");
  return root;
}

describe("Storybloq Bus guided setup (D4)", () => {
  it("takes a disabled project to waiting_for_peer with the handoff line", async () => {
    const root = await project("bus-setup-fresh");
    const parsed = await setup(root, ["--task-id", "claude-solo"]);
    expect(parsed.data).toMatchObject({
      setupState: "waiting_for_peer",
      deliveryMode: "poll",
      endpoints: 1,
    });
    expect(parsed.data.handoff).toContain('Connect this task to Storybloq Bus.');
    expect(parsed.data.completedSteps).toContain("join-endpoint");
    expect(parsed.data.completedSteps).toContain("poll-delivery (hooks disabled)");
    expect(parsed.data.trackedChanges).toEqual(
      expect.arrayContaining([".story/config.json", ".story/.gitignore"]),
    );
  });

  it("is idempotent: a rerun refreshes the existing endpoint and reports no tracked changes", async () => {
    const root = await project("bus-setup-idempotent");
    await setup(root, ["--task-id", "claude-solo"]);
    const rerun = await setup(root, ["--task-id", "claude-solo"]);
    expect(rerun.data).toMatchObject({ setupState: "waiting_for_peer", endpoints: 1 });
    expect(rerun.data.completedSteps).toContain("refresh-endpoint");
    // The first run already enabled features.bus and completed the .gitignore, so
    // the idempotent rerun changes nothing tracked (no config/gitignore churn).
    expect(rerun.data.trackedChanges).toEqual([]);
  });

  it("fails a live preflight and mutates nothing when the base Claude hooks are absent", async () => {
    const root = await project("bus-setup-live-preflight");
    // Isolate HOME so the live preflight inspects a settings.json that is missing
    // its base SessionStart/Stop hooks, and so nothing can touch the real ~/.claude.
    const isolatedHome = await mkdtemp(join(tmpdir(), "bus-setup-home-"));
    roots.push(isolatedHome);
    const originalHome = process.env.HOME;
    try {
      process.env.HOME = isolatedHome;
      const { stdout } = await runBusCli(root, [
        "bus", "setup", "--format", "json", "--client", "claude",
        "--delivery", "live", "--task-id", "claude-solo",
      ]);
      const parsed = JSON.parse(stdout);
      // Preflight fails read-only with setup guidance.
      expect(parsed.error?.code).toBe("io_error");
      expect(parsed.error?.message).toContain("setup --client claude");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
    // Zero mutation: the feature never flipped and no runtime was created.
    expect(await busEnabled(root)).toBe(false);
    expect(await pathExists(join(root, ".story", "bus"))).toBe(false);
  });

  it("resumes from an initialized-but-not-joined runtime", async () => {
    const root = await project("bus-setup-resume-init");
    await initializeBus(root); // runtime exists, no endpoint yet
    const parsed = await setup(root, ["--task-id", "claude-solo"]);
    expect(parsed.data).toMatchObject({ setupState: "waiting_for_peer", endpoints: 1 });
    expect(parsed.data.completedSteps).toContain("join-endpoint");
  });

  it("skips hook mutation under --delivery poll", async () => {
    const root = await project("bus-setup-poll");
    await setup(root, ["--task-id", "claude-solo"]);
    const summary = await busSummary(root);
    expect(summary.deliveryMode).toBe("poll");
    expect(summary.hookDelivery).toEqual({ claude: false, codex: false });
  });

  it("disables an already-enabled on-tool tier when re-run with --delivery poll", async () => {
    const root = await project("bus-setup-poll-disable");
    await setup(root, ["--task-id", "claude-solo"]); // join endpoint, enable bus (poll)
    // Simulate a prior live setup: hook policy on + project-local on-tool hook installed.
    await setBusHookPolicy(root, ["claude"], true);
    await installProjectBusToolHook(root, "/x/storybloq");
    expect(hasBusToolHook(await readProjectSettingsNoFollow(root), "/x/storybloq hook-bus-tool")).toBe(true);

    // Re-running setup with --delivery poll must turn the tier back off end-to-end.
    await setup(root, ["--task-id", "claude-solo"]);
    const summary = await busSummary(root);
    expect(summary.hookDelivery.claude).toBe(false);
    expect(summary.deliveryCapabilities.onTool).toBe("none");
    expect(hasBusToolHook(await readProjectSettingsNoFollow(root), "/x/storybloq hook-bus-tool")).toBe(false);
  });

  it("surfaces a remaining cleanup step when the on-tool hook file cannot be removed under --delivery poll", async () => {
    const root = await project("bus-setup-poll-disable-fail");
    await setup(root, ["--task-id", "claude-solo"]);
    await setBusHookPolicy(root, ["claude"], true);
    await installProjectBusToolHook(root, "/x/storybloq");

    // Make the on-tool hook REMOVAL write fail (a simulated fsync/write error) so the inert
    // hook file survives. The policy is still disabled first, so delivery IS off; the
    // leftover file must surface as a `remove-on-tool-hook` remaining step rather than the
    // disable being reported as fully clean.
    projectSettingsTesting.setAfterTempOpenHook(async () => { throw new Error("simulated removal write failure"); });
    let parsed: Awaited<ReturnType<typeof setup>>;
    try {
      parsed = await setup(root, ["--task-id", "claude-solo"]);
    } finally {
      projectSettingsTesting.setAfterTempOpenHook(null);
    }

    expect((await busSummary(root)).hookDelivery.claude).toBe(false); // policy disabled -> delivery off
    const remaining = (parsed.data.remainingSteps as string[]) ?? [];
    expect(remaining.some((step) => step.startsWith("remove-on-tool-hook"))).toBe(true);
    // The inert hook file is still present (removal failed), consistent with the warning.
    expect(hasBusToolHook(await readProjectSettingsNoFollow(root), "/x/storybloq hook-bus-tool")).toBe(true);
  });

  it("fails preflight and mutates nothing when identity is missing", async () => {
    const root = await project("bus-setup-no-identity");
    // No --task-id and no ambient session id (test setup clears the env).
    const { stdout } = await runBusCli(root, ["bus", "setup", "--format", "json", "--client", "claude", "--delivery", "poll"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.error?.code).toBe("invalid_input");
    // Preflight ran before any persistent mutation.
    expect(await busEnabled(root)).toBe(false);
  });

  it("fails preflight and mutates nothing when the surface is incompatible with the client", async () => {
    const root = await project("bus-setup-surface");
    // codex_desktop is a Codex surface; the default claude client cannot use it, so
    // the preflight rejects it as invalid_input BEFORE any mutation, regardless of
    // whether a client process is detectable in this environment.
    const parsed = await setup(root, ["--task-id", "claude-solo", "--surface", "codex_desktop"]);
    expect(parsed.error?.code).toBe("invalid_input");
    expect(await busEnabled(root)).toBe(false);
  });

  it("fails preflight and mutates nothing when a Codex surface cannot be resolved", async () => {
    const root = await project("bus-setup-codex-nosurface");
    const gitignorePath = join(root, ".story", ".gitignore");
    const gitignoreBefore = await readFile(gitignorePath, "utf-8").catch(() => null);

    // A Codex client with an explicit task identity but NO --surface: process
    // ancestry detection returns null here (the test runner is not a codex process),
    // so the surface is unresolved and the preflight must reject BEFORE any mutation
    // rather than fall through with an undetermined surface. This exercises the same
    // no-codex-process seam the other surface tests rely on.
    const { stdout } = await runBusCli(root, [
      "bus", "setup", "--format", "json", "--client", "codex", "--delivery", "poll", "--task-id", "codex-solo",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.error?.code).toBe("invalid_input");
    expect(parsed.error?.message).toContain("Cannot determine the client surface safely");

    // Zero mutation: the feature never flipped, no runtime was created, and the
    // gitignore is byte-identical (or still absent) to its pre-call state.
    expect(await busEnabled(root)).toBe(false);
    expect(await pathExists(join(root, ".story", "bus"))).toBe(false);
    expect(await readFile(gitignorePath, "utf-8").catch(() => null)).toBe(gitignoreBefore);
  });

  it("reaches ready once a second participant runs setup", async () => {
    const root = await project("bus-setup-ready");
    await setup(root, ["--task-id", "claude-first"]);
    const second = await setup(root, ["--task-id", "claude-second"]);
    expect(second.data).toMatchObject({ setupState: "ready", endpoints: 2 });
    expect(second.data.handoff).toBeNull();
  });

  it("rejects a THIRD-task setup with conflict and mutates nothing before the capacity rejection (F8)", async () => {
    const root = await project("bus-setup-capacity");
    await setup(root, ["--task-id", "claude-first"]);
    expect((await setup(root, ["--task-id", "claude-second"])).data).toMatchObject({ setupState: "ready" });

    // Snapshot config, .gitignore, and the full runtime tree at the ready state.
    const configBefore = await readFile(join(root, ".story", "config.json"), "utf-8");
    const gitignoreBefore = await readFile(join(root, ".story", ".gitignore"), "utf-8");
    const treeBefore = await walkTree(join(root, ".story", "bus"));

    // A third task cannot join two active endpoints; setup rejects with conflict.
    const endpointsBefore = (await readdir(join(root, ".story", "bus", "endpoints"))).sort();
    expect(endpointsBefore).toHaveLength(2);
    const third = await setup(root, ["--task-id", "claude-third"]);
    expect(third.error?.code).toBe("conflict");

    // config.json/.gitignore are unchanged, but on an already-ready runtime those
    // writes are idempotent, so their invariance alone cannot prove the capacity rule
    // fired before any mutation. The concrete, non-idempotent mutation the capacity
    // rule exists to prevent is minting a THIRD endpoint record + mailbox; assert that
    // never happened (the endpoints dir still holds exactly the two originals, and the
    // full runtime tree is byte-identical), which no third endpoint could satisfy.
    expect(await readFile(join(root, ".story", "config.json"), "utf-8")).toBe(configBefore);
    expect(await readFile(join(root, ".story", ".gitignore"), "utf-8")).toBe(gitignoreBefore);
    expect((await readdir(join(root, ".story", "bus", "endpoints"))).sort()).toEqual(endpointsBefore);
    expect(await walkTree(join(root, ".story", "bus"))).toEqual(treeBefore);

    // Same-task reruns of the two existing endpoints still succeed (no over-rejection).
    expect((await setup(root, ["--task-id", "claude-first"])).data).toMatchObject({ setupState: "ready" });
    expect((await setup(root, ["--task-id", "claude-second"])).data).toMatchObject({ setupState: "ready" });
  });

  it("heals a missing pending directory on a same-task rejoin (#4)", async () => {
    const root = await project("bus-rejoin-heal");
    await initializeBus(root);
    const first = await joinEndpoint(root, { client: "claude", clientTaskId: "claude-solo", surface: "claude_cli" });
    expect(first.existing).toBe(false);

    // A crash dropped this endpoint's mailbox/pending child. The strict layout
    // assertion would otherwise brick every endpoint-scoped op; join resolves the
    // base layout so the heal below is reachable.
    const pendingDir = join(root, ".story", "bus", "mailboxes", first.endpoint.endpointId, "pending");
    await rm(pendingDir, { recursive: true, force: true });

    // The same-task rejoin succeeds (does not throw corrupt), keeps the same
    // endpointId, and recreates pending as a real directory.
    const rejoin = await joinEndpoint(root, { client: "claude", clientTaskId: "claude-solo", surface: "claude_cli" });
    expect(rejoin.existing).toBe(true);
    expect(rejoin.endpoint.endpointId).toBe(first.endpoint.endpointId);
    expect((await stat(pendingDir)).isDirectory()).toBe(true);

    // The full layout is whole again; readiness reflects the sole endpoint.
    expect((await busSummary(root)).setupState).toBe("waiting_for_peer");
  });

  it("heals a missing pending directory through a rerun of the bus setup CLI (#R6-I)", async () => {
    const root = await project("bus-setup-rejoin-heal");
    const first = await setup(root, ["--task-id", "claude-solo"]);
    expect(first.error).toBeUndefined();
    const endpointId = first.data.endpointId as string;
    expect(first.data).toMatchObject({ setupState: "waiting_for_peer" });

    // A crash dropped this endpoint's mailbox/pending child. The strict layout
    // assertion would otherwise brick every endpoint-scoped op.
    const pendingDir = join(root, ".story", "bus", "mailboxes", endpointId, "pending");
    await rm(pendingDir, { recursive: true, force: true });
    expect(await pathExists(pendingDir)).toBe(false);

    // Rerunning the SAME setup CLI heals the layout: setup always routes through
    // joinEndpoint first (its relaxed resolver recreates the missing pending dir),
    // then refreshes the existing endpoint. It must not throw corrupt, must keep the
    // same endpoint id, and must report the refresh-endpoint completed step.
    const rerun = await setup(root, ["--task-id", "claude-solo"]);
    expect(rerun.error).toBeUndefined();
    expect(rerun.data).toMatchObject({ setupState: "waiting_for_peer", endpoints: 1 });
    expect(rerun.data.endpointId).toBe(endpointId);
    expect(rerun.data.completedSteps).toContain("refresh-endpoint");
    // The pending directory is a real directory again.
    expect((await stat(pendingDir)).isDirectory()).toBe(true);
  });

  it("fails closed without traversal when a same-task rejoin finds a symlinked mailbox (#R7)", async () => {
    const root = await project("bus-rejoin-symlink-mailbox");
    await initializeBus(root);
    const first = await joinEndpoint(root, { client: "claude", clientTaskId: "claude-solo", surface: "claude_cli" });

    // Replace this endpoint's mailbox dir with a symlink to an external directory. A
    // recursive mkdir of mailbox/pending would follow it and create/write OUTSIDE
    // .story/bus; the heal must reject the symlink before any mkdir runs.
    const mailbox = join(root, ".story", "bus", "mailboxes", first.endpoint.endpointId);
    const external = await mkdtemp(join(tmpdir(), "bus-symlink-target-"));
    roots.push(external);
    await rm(mailbox, { recursive: true, force: true });
    await symlink(external, mailbox);

    await expect(joinEndpoint(root, { client: "claude", clientTaskId: "claude-solo", surface: "claude_cli" }))
      .rejects.toMatchObject({ code: "corrupt" });
    // The external symlink target is untouched: no pending dir was created through it.
    expect(await readdir(external)).toHaveLength(0);
  });

  it("fails closed when a same-task rejoin finds a symlinked pending child (#R7)", async () => {
    const root = await project("bus-rejoin-symlink-pending");
    await initializeBus(root);
    const first = await joinEndpoint(root, { client: "claude", clientTaskId: "claude-solo", surface: "claude_cli" });

    const pending = join(root, ".story", "bus", "mailboxes", first.endpoint.endpointId, "pending");
    const external = await mkdtemp(join(tmpdir(), "bus-symlink-target-"));
    roots.push(external);
    await rm(pending, { recursive: true, force: true });
    await symlink(external, pending);

    await expect(joinEndpoint(root, { client: "claude", clientTaskId: "claude-solo", surface: "claude_cli" }))
      .rejects.toMatchObject({ code: "corrupt" });
    expect(await readdir(external)).toHaveLength(0);
  });

  it("fails closed through the bus setup CLI when the endpoint mailbox is a symlink (#R7)", async () => {
    const root = await project("bus-setup-symlink-mailbox");
    const first = await setup(root, ["--task-id", "claude-solo"]);
    const endpointId = first.data.endpointId as string;

    const mailbox = join(root, ".story", "bus", "mailboxes", endpointId);
    const external = await mkdtemp(join(tmpdir(), "bus-symlink-target-"));
    roots.push(external);
    await rm(mailbox, { recursive: true, force: true });
    await symlink(external, mailbox);

    const rerun = await setup(root, ["--task-id", "claude-solo"]);
    expect(rerun.error?.code).toBe("corrupt");
    expect(await readdir(external)).toHaveLength(0);
  });

  it("fails closed through the bus setup CLI when the endpoint pending child is a symlink (#R7)", async () => {
    const root = await project("bus-setup-symlink-pending");
    const first = await setup(root, ["--task-id", "claude-solo"]);
    const endpointId = first.data.endpointId as string;

    const pending = join(root, ".story", "bus", "mailboxes", endpointId, "pending");
    const external = await mkdtemp(join(tmpdir(), "bus-symlink-target-"));
    roots.push(external);
    await rm(pending, { recursive: true, force: true });
    await symlink(external, pending);

    const rerun = await setup(root, ["--task-id", "claude-solo"]);
    expect(rerun.error?.code).toBe("corrupt");
    expect(await readdir(external)).toHaveLength(0);
  });

  it("reports migrated:false when joining an already-initialized v2 runtime through setup", async () => {
    // A second participant runs setup against an already-initialized v2 runtime; no
    // migration occurs, so migrated is false and it simply joins to reach ready.
    const root = await project("bus-setup-no-migrate");
    await initializeBus(root);
    await joinEndpoint(root, { client: "codex", clientTaskId: "codex-peer", surface: "codex_desktop" });
    const parsed = await setup(root, ["--task-id", "claude-second"]);
    expect(parsed.data).toMatchObject({ migrated: false, setupState: "ready" });
  });

  it("reports migrated:true when upgrading a drainable v1 runtime through setup", async () => {
    // A genuine v1 runtime (caller-owned, drainable) upgraded through setup migrates to
    // v2 and reports migrated:true.
    const root = await createDrainableV1("bus-setup-v1-migrate", "codex-drain");
    expect(await classifyBusRuntime(root)).toBe("v1");
    const { stdout } = await runBusCli(root, [
      "bus", "setup", "--format", "json", "--client", "codex", "--task-id", "codex-drain",
      "--surface", "codex_desktop", "--delivery", "poll",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toMatchObject({ migrated: true });
    expect(await classifyBusRuntime(root)).toBe("v2");
  });

  // ISS-871/ISS-872: `bus setup --replace` end to end.
  async function endpointIdForTask(root: string, taskId: string): Promise<string> {
    const dir = join(root, ".story", "bus", "endpoints");
    for (const name of await readdir(dir)) {
      const record = JSON.parse(await readFile(join(dir, name), "utf-8"));
      if (record.clientTaskId === taskId && !record.retiredAt) return record.endpointId;
    }
    throw new Error(`No active endpoint for task ${taskId}`);
  }

  async function forgeOffline(root: string, endpointId: string): Promise<void> {
    const path = join(root, ".story", "bus", "endpoints", `${endpointId}.json`);
    const record = JSON.parse(await readFile(path, "utf-8"));
    await writeFile(path, JSON.stringify({
      ...record,
      state: "attached",
      processRef: { pid: 999999999, signature: "darwin:deadbeef", capturedAt: new Date().toISOString() },
    }, null, 2) + "\n", "utf-8");
  }

  async function activeEndpointCount(root: string): Promise<number> {
    const dir = join(root, ".story", "bus", "endpoints");
    let count = 0;
    for (const name of await readdir(dir)) {
      const record = JSON.parse(await readFile(join(dir, name), "utf-8"));
      if (!record.retiredAt) count += 1;
    }
    return count;
  }

  it("replaces a proven-offline incumbent and reports succession (setup --replace)", async () => {
    const root = await project("bus-setup-replace");
    await setup(root, ["--task-id", "claude-first"]);
    await setup(root, ["--task-id", "claude-second"]);
    const firstId = await endpointIdForTask(root, "claude-first");
    // Second sends an undelivered message to first, then first goes offline.
    await sendBusMessage(root, {
      endpointId: await endpointIdForTask(root, "claude-second"),
      clientTaskId: "claude-second",
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "Undelivered before the incumbent went offline",
      refs: { ciRun: "ci-replace-1" },
      idempotencyKey: "replace-undelivered-1",
    });
    await forgeOffline(root, firstId);

    const replaced = await setup(root, ["--task-id", "claude-third", "--replace", firstId]);
    expect(replaced.error).toBeUndefined();
    expect(replaced.data).toMatchObject({
      setupState: "ready",
      endpoints: 2,
      newlyReplaced: true,
      replaced: { endpointId: firstId, undeliveredMessages: 1 },
    });
    expect(replaced.data.completedSteps).toContain("replace-endpoint");
  });

  it("refuses --replace without positive offline proof and mutates nothing", async () => {
    const root = await project("bus-setup-replace-liveness");
    await setup(root, ["--task-id", "claude-first"]);
    await setup(root, ["--task-id", "claude-second"]);
    const firstId = await endpointIdForTask(root, "claude-first");
    // No forge: the incumbent's liveness is unknown (no detectable process), not offline.
    const treeBefore = await walkTree(join(root, ".story", "bus"));

    const rejected = await setup(root, ["--task-id", "claude-third", "--replace", firstId]);
    expect(rejected.error?.code).toBe("conflict");
    expect(await walkTree(join(root, ".story", "bus"))).toEqual(treeBefore);
  });

  it("fails --replace validation pre-mutation for a bad uuid and an unknown id", async () => {
    const root = await project("bus-setup-replace-validate");
    await setup(root, ["--task-id", "claude-first"]);
    await setup(root, ["--task-id", "claude-second"]);
    const treeBefore = await walkTree(join(root, ".story", "bus"));

    const badUuid = await setup(root, ["--task-id", "claude-third", "--replace", "not-a-uuid"]);
    expect(badUuid.error?.code).toBe("invalid_input");
    const unknown = await setup(root, ["--task-id", "claude-third", "--replace", randomUUID()]);
    expect(unknown.error?.code).toBe("not_found");
    expect(await walkTree(join(root, ".story", "bus"))).toEqual(treeBefore);
  });

  it("fails --replace on an uninitialized checkout before any mutation", async () => {
    const root = await project("bus-setup-replace-fresh");
    const parsed = await setup(root, ["--task-id", "claude-first", "--replace", randomUUID()]);
    expect(parsed.error?.code).toBe("not_found");
    expect(await busEnabled(root)).toBe(false);
    expect(await pathExists(join(root, ".story", "bus"))).toBe(false);
  });

  it("is resumable: an identical --replace rerun after a full success stays idempotent", async () => {
    const root = await project("bus-setup-replace-resume");
    await setup(root, ["--task-id", "claude-first"]);
    await setup(root, ["--task-id", "claude-second"]);
    const firstId = await endpointIdForTask(root, "claude-first");
    await forgeOffline(root, firstId);
    const firstRun = await setup(root, ["--task-id", "claude-third", "--replace", firstId]);
    expect(firstRun.data).toMatchObject({ newlyReplaced: true });
    const activeAfterFirst = await activeEndpointCount(root);

    const rerun = await setup(root, ["--task-id", "claude-third", "--replace", firstId]);
    expect(rerun.error).toBeUndefined();
    expect(rerun.data).toMatchObject({
      setupState: "ready",
      newlyReplaced: false,
      replaced: { endpointId: firstId },
    });
    expect(await activeEndpointCount(root)).toBe(activeAfterFirst);
  });

  it("fails --replace at a retired endpoint with no same-task successor before any mutation", async () => {
    const root = await project("bus-setup-replace-retired");
    await setup(root, ["--task-id", "claude-first"]);
    await setup(root, ["--task-id", "claude-second"]);
    const firstId = await endpointIdForTask(root, "claude-first");
    await forgeOffline(root, firstId);
    await setup(root, ["--task-id", "claude-third", "--replace", firstId]); // first -> third
    const treeBefore = await walkTree(join(root, ".story", "bus"));

    // A DIFFERENT task cannot --replace the already-retired incumbent.
    const rejected = await setup(root, ["--task-id", "claude-fourth", "--replace", firstId]);
    expect(rejected.error?.code).toBe("not_found");
    expect(rejected.error?.message).toMatch(/without --replace/);
    // Zero mutation: the full runtime tree is byte-identical (no fourth endpoint minted).
    expect(await walkTree(join(root, ".story", "bus"))).toEqual(treeBefore);
  });

  it("names `storybloq bus setup --replace` in the two-endpoint capacity conflict (F8)", async () => {
    const root = await project("bus-setup-replace-f8");
    await setup(root, ["--task-id", "claude-first"]);
    await setup(root, ["--task-id", "claude-second"]);
    const third = await setup(root, ["--task-id", "claude-third"]);
    expect(third.error?.code).toBe("conflict");
    expect(third.error?.message).toMatch(/storybloq bus setup --replace/);
  });

  it("surfaces a poll step when eager materialization fails but setup still succeeds", async () => {
    const root = await project("bus-setup-replace-degraded");
    await setup(root, ["--task-id", "claude-first"]);
    await setup(root, ["--task-id", "claude-second"]);
    const firstId = await endpointIdForTask(root, "claude-first");
    // Deliverable mail exists on the incumbent, so a poll instruction is legitimate.
    await sendBusMessage(root, {
      endpointId: await endpointIdForTask(root, "claude-second"),
      clientTaskId: "claude-second",
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "Undelivered before the incumbent went offline",
      refs: { ciRun: "ci-degraded-1" },
      idempotencyKey: "degraded-undelivered-1",
    });
    await forgeOffline(root, firstId);

    __storeTesting.setMaterializeFailureHook(async () => { throw new Error("transient unreadable mailbox"); });
    try {
      const parsed = await setup(root, ["--task-id", "claude-third", "--replace", firstId]);
      expect(parsed.error).toBeUndefined();
      expect(parsed.data).toMatchObject({ setupState: "ready", newlyReplaced: true });
      expect((parsed.data.remainingSteps as string[]).join("\n")).toMatch(/storybloq bus poll/);
      // Materialization failed, so the deliverable mail still sits on the predecessor: the
      // count must be UNKNOWN (null), never a misleading zero from the empty successor.
      expect(parsed.data.replaced).toMatchObject({ materialized: false, undeliveredMessages: null });

      // The degraded poll instruction must also render in Markdown, and it must NOT also
      // claim "no deliverable mail" (the contradictory summary the empty-successor count
      // would otherwise produce).
      const { stdout } = await runBusCli(root, [
        "bus", "setup", "--format", "md", "--client", "claude", "--delivery", "poll",
        "--task-id", "claude-third", "--replace", firstId,
      ]);
      expect(stdout).toMatch(/storybloq bus poll/);
      expect(stdout).not.toMatch(/no deliverable mail/);
      expect(stdout).toMatch(/not yet surfaced/);
    } finally {
      __storeTesting.setMaterializeFailureHook(null);
    }
  });

  it("returns a resumable result (never throws) when the post-replacement count read fails", async () => {
    const root = await project("bus-setup-replace-count-fail");
    await setup(root, ["--task-id", "claude-first"]);
    await setup(root, ["--task-id", "claude-second"]);
    const firstId = await endpointIdForTask(root, "claude-first");
    await sendBusMessage(root, {
      endpointId: await endpointIdForTask(root, "claude-second"),
      clientTaskId: "claude-second",
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "Undelivered before the incumbent went offline",
      refs: { ciRun: "ci-count-fail-1" },
      idempotencyKey: "count-fail-undelivered-1",
    });
    await forgeOffline(root, firstId);

    // joinEndpoint has already retired + created irreversibly by the time the count runs, so
    // a transient count-read fault must NOT abort setup as a plain error. Materialization
    // succeeds; only the follow-up count read fails.
    __storeTesting.setCountFailureHook(async () => { throw new Error("transient count read fault"); });
    try {
      const parsed = await setup(root, ["--task-id", "claude-third", "--replace", firstId]);
      expect(parsed.error).toBeUndefined();
      expect(parsed.data).toMatchObject({ setupState: "ready", newlyReplaced: true });
      expect(parsed.data.replaced).toMatchObject({ materialized: true, undeliveredMessages: null });
      expect((parsed.data.remainingSteps as string[]).join("\n")).toMatch(/confirm the inherited mail count/);

      // The materialized-true + count-null Markdown branch must say the mail IS surfaced and
      // point at the count-confirmation step, never "no deliverable mail" or "not yet
      // surfaced" (a same-task rerun with the hook still active re-materializes idempotently).
      const { stdout } = await runBusCli(root, [
        "bus", "setup", "--format", "md", "--client", "claude", "--delivery", "poll",
        "--task-id", "claude-third", "--replace", firstId,
      ]);
      expect(stdout).toMatch(/inherited mail is surfaced/);
      expect(stdout).toMatch(/confirm the count/);
      expect(stdout).not.toMatch(/no deliverable mail/);
      expect(stdout).not.toMatch(/not yet surfaced/);
    } finally {
      __storeTesting.setCountFailureHook(null);
    }
  });

  it("always runs materialization after replacement, even with no pre-existing mail", async () => {
    const root = await project("bus-setup-replace-always-materialize");
    await setup(root, ["--task-id", "claude-first"]);
    await setup(root, ["--task-id", "claude-second"]);
    const firstId = await endpointIdForTask(root, "claude-first");
    await forgeOffline(root, firstId);

    // Regression guard for the stale-zero skip: a peer can send to the still-active incumbent
    // AFTER any pre-mutation count but BEFORE the retire, so materialization must ALWAYS run
    // rather than being gated on a count that could be a stale zero. With no pre-existing mail
    // the old code skipped materialization; forcing it to fail proves it now executes
    // regardless (the failure surfaces a poll step). A skip would leave no poll step.
    __storeTesting.setMaterializeFailureHook(async () => { throw new Error("materialization ran"); });
    try {
      const parsed = await setup(root, ["--task-id", "claude-third", "--replace", firstId]);
      expect(parsed.error).toBeUndefined();
      expect(parsed.data).toMatchObject({ setupState: "ready", newlyReplaced: true });
      expect((parsed.data.remainingSteps as string[]).join("\n")).toMatch(/storybloq bus poll/);
    } finally {
      __storeTesting.setMaterializeFailureHook(null);
    }
  });

  it("reports no deliverable mail and emits no poll step when the incumbent has none", async () => {
    const root = await project("bus-setup-replace-zero");
    await setup(root, ["--task-id", "claude-first"]);
    await setup(root, ["--task-id", "claude-second"]);
    const firstId = await endpointIdForTask(root, "claude-first");
    await forgeOffline(root, firstId);

    // Materialization runs (a no-op with nothing to inherit) and succeeds, so the summary
    // honestly reports no deliverable mail and no poll instruction.
    const { stdout } = await runBusCli(root, [
      "bus", "setup", "--format", "md", "--client", "claude", "--delivery", "poll",
      "--task-id", "claude-third", "--replace", firstId,
    ]);
    expect(stdout).toMatch(/no deliverable mail/);
    expect(stdout).not.toMatch(/storybloq bus poll/);
  });

  it("materializes replacement-window mail into the successor's physical mailbox before any poll", async () => {
    const root = await project("bus-setup-replace-window");
    await setup(root, ["--task-id", "claude-first"]);
    await setup(root, ["--task-id", "claude-second"]);
    const firstId = await endpointIdForTask(root, "claude-first");
    // Mail present on the still-active incumbent at replacement time (the replacement-window
    // arrival the stale-zero skip used to strand on the retired mailbox).
    await sendBusMessage(root, {
      endpointId: await endpointIdForTask(root, "claude-second"),
      clientTaskId: "claude-second",
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "Arrived at the incumbent just before replacement",
      refs: { ciRun: "ci-window-1" },
      idempotencyKey: "replace-window-1",
    });
    await forgeOffline(root, firstId);

    const replaced = await setup(root, ["--task-id", "claude-third", "--replace", firstId]);
    expect(replaced.error).toBeUndefined();
    expect(replaced.data).toMatchObject({
      setupState: "ready",
      replaced: { endpointId: firstId, undeliveredMessages: 1, materialized: true },
    });
    const successorId = replaced.data.endpointId as string;

    // The successor's PHYSICAL mailbox holds the inherited pointer BEFORE any explicit poll,
    // and the live delivery hooks (which gate on the physical mailbox) can detect it.
    const paths = await resolveBusPaths(root, false);
    expect(await mailboxHasPointerCandidate(paths, successorId)).toBe(true);
    expect(await readMailboxHighwater(paths, successorId)).toMatchObject({ known: true });
  });

  // Corrupt the incumbent's own predecessor link so the SUCCESSOR's chain is corrupt
  // (successor -> incumbent -> <missing>), forcing materializeSuccessorMailbox to RETURN
  // a succession-chain finding (not throw).
  async function corruptIncumbentChain(root: string, incumbentId: string): Promise<void> {
    const path = join(root, ".story", "bus", "endpoints", `${incumbentId}.json`);
    const record = JSON.parse(await readFile(path, "utf-8"));
    await writeFile(path, JSON.stringify({
      ...record,
      predecessorEndpointId: randomUUID(),
    }, null, 2) + "\n", "utf-8");
  }

  it("surfaces a doctor step (not a completed materialization) on a succession-chain finding", async () => {
    const root = await project("bus-setup-chain-finding");
    await setup(root, ["--task-id", "claude-first"]);
    await setup(root, ["--task-id", "claude-second"]);
    const firstId = await endpointIdForTask(root, "claude-first");
    // Deliverable mail so materialization runs (and surfaces the chain finding).
    await sendBusMessage(root, {
      endpointId: await endpointIdForTask(root, "claude-second"),
      clientTaskId: "claude-second",
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "Undelivered before the chain was corrupted",
      refs: { ciRun: "ci-chain-1" },
      idempotencyKey: "chain-undelivered-1",
    });
    await corruptIncumbentChain(root, firstId);
    await forgeOffline(root, firstId);

    const parsed = await setup(root, ["--task-id", "claude-third", "--replace", firstId]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toMatchObject({ setupState: "ready", newlyReplaced: true });
    expect((parsed.data.remainingSteps as string[]).join("\n")).toMatch(/storybloq bus doctor/);
    expect(parsed.data.completedSteps as string[]).not.toContain("materialize-succession");

    // The doctor step also renders in Markdown.
    const { stdout } = await runBusCli(root, [
      "bus", "setup", "--format", "md", "--client", "claude", "--delivery", "poll",
      "--task-id", "claude-third", "--replace", firstId,
    ]);
    expect(stdout).toMatch(/storybloq bus doctor/);
  });

  it("surfaces a materialization warning on the deprecated join --replace path", async () => {
    const root = await project("bus-join-chain-finding");
    await setup(root, ["--task-id", "claude-first"]);
    await setup(root, ["--task-id", "claude-second"]);
    const firstId = await endpointIdForTask(root, "claude-first");
    await corruptIncumbentChain(root, firstId);
    await forgeOffline(root, firstId);

    const { stdout } = await runBusCli(root, [
      "bus", "join", "--client", "claude", "--surface", "claude_cli",
      "--task-id", "claude-third", "--replace", firstId,
    ]);
    expect(stdout).toMatch(/storybloq bus doctor/);
  });
});
