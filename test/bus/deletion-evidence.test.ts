import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import {
  acknowledgeBusMessage,
  assessBusRuntime,
  assertEvidenceIgnored,
  buildEvidence,
  buildTombstone,
  busDoctor,
  busSummary,
  BUS_EVIDENCE_FILENAME,
  busEvidencePath,
  checkBusShip,
  exportBusThread,
  busRuntimeLostAdvisory,
  initializeBus,
  pollBus,
  readBusEvidence,
  sendBusMessage,
  updateBusThread,
  writeBusEvidence,
} from "../../src/bus/index.js";
import { resolveBusPaths } from "../../src/bus/paths.js";
import { readJsonNoFollow, readTextNoFollow } from "../../src/bus/io.js";
import { z } from "zod";
import { handleSessionResumePrompt } from "../../src/cli/commands/session-compact.js";
import { handleHookStatus } from "../../src/cli/commands/hook-status.js";
import { formatStatus } from "../../src/core/output-formatter.js";
import { loadProject } from "../../src/core/project-loader.js";
import { createBusFixture, type BusFixture } from "./helpers.js";
import { runBusCli } from "./cli-harness.js";

const exec = promisify(execFile);
const fixtures: BusFixture[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...fixtures.splice(0).map((f) => rm(f.root, { recursive: true, force: true })),
    ...roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ]);
});

async function fx(): Promise<BusFixture> {
  const value = await createBusFixture("deletion-evidence");
  fixtures.push(value);
  return value;
}

function evidencePathFor(root: string): string {
  return join(root, ".story", BUS_EVIDENCE_FILENAME);
}

async function wipeRuntime(root: string): Promise<void> {
  await rm(join(root, ".story", "bus"), { recursive: true, force: true });
}

async function readEvidenceRaw(root: string): Promise<{
  instanceId?: string;
  instanceCreatedAt?: string;
  tombstones: Array<Record<string, unknown>>;
}> {
  return JSON.parse(await readFile(evidencePathFor(root), "utf-8"));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function git(root: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: root })).stdout;
}

async function initGitRepo(root: string): Promise<void> {
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "bus-test@example.com"]);
  await git(root, ["config", "user.name", "Bus Test"]);
}

// Invoke the real SessionStart hook, capturing both stdout and stderr so the test
// can assert the runtime-lost advisory lands on stderr and never on bare stdout.
async function captureSessionStart(
  options: Parameters<typeof handleSessionResumePrompt>[0],
): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  (process.stdout.write as unknown) = (chunk: string | Uint8Array) => { out.push(String(chunk)); return true; };
  (process.stderr.write as unknown) = (chunk: string | Uint8Array) => { err.push(String(chunk)); return true; };
  try {
    await handleSessionResumePrompt(options);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout: out.join(""), stderr: err.join("") };
}

// handleHookStatus calls process.exit at every return; this sentinel lets the test
// unwind it without killing the vitest process.
class ExitSignal extends Error {
  constructor(readonly code?: number) {
    super("exit");
  }
}

// Invoke the real Stop hook (handleHookStatus) with a mocked stdin payload,
// capturing stdout/stderr and neutralizing its process.exit so the test can assert
// the runtime-lost advisory lands on stderr and never on bare stdout.
async function captureStopHook(
  input: Record<string, unknown>,
  client: "claude" | "codex",
): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const origExit = process.exit;
  const origStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const stream = Readable.from([JSON.stringify(input)]) as unknown as NodeJS.ReadStream;
  (stream as { isTTY?: boolean }).isTTY = false;
  Object.defineProperty(process, "stdin", { value: stream, configurable: true });
  (process.stdout.write as unknown) = (chunk: string | Uint8Array) => { out.push(String(chunk)); return true; };
  (process.stderr.write as unknown) = (chunk: string | Uint8Array) => { err.push(String(chunk)); return true; };
  (process.exit as unknown) = ((code?: number) => { throw new ExitSignal(code); }) as never;
  try {
    await handleHookStatus({ client });
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    (process.exit as unknown) = origExit;
    if (origStdin) Object.defineProperty(process, "stdin", origStdin);
  }
  return { stdout: out.join(""), stderr: err.join("") };
}

// A first send establishes a thread; its id anchors the exportBusThread case.
async function firstThreadId(f: BusFixture): Promise<string> {
  const result = await sendBusMessage(f.root, {
    endpointId: f.a.endpointId,
    clientTaskId: f.aTaskId,
    threadKind: "question",
    messageKind: "question",
    severity: "low",
    body: "opening thread for evidence tests",
    refs: { ciRun: "ci-evidence-1" },
    idempotencyKey: "evidence-open-1",
  });
  return result.threadId;
}

describe("Storybloq Bus deletion-evidence (T-428)", () => {
  // 1. Evidence written on setup; matches instance.json; gitignore entry present.
  it("writes evidence at .story/.bus-evidence.json matching the live instance", async () => {
    const f = await fx();
    const paths = await resolveBusPaths(f.root, false);
    // paths.storyRoot is canonicalized (realpath), so compare against it rather
    // than the raw fixture root (which differs by macOS's /var -> /private/var).
    expect(busEvidencePath(paths)).toBe(join(paths.storyRoot, BUS_EVIDENCE_FILENAME));

    const evidence = await readEvidenceRaw(f.root);
    const instance = JSON.parse(await readFile(join(f.root, ".story", "bus", "instance.json"), "utf-8"));
    expect(evidence.instanceId).toBe(instance.instanceId);
    expect(evidence.instanceCreatedAt).toBe(instance.createdAt);
    expect(evidence.tombstones).toEqual([]);

    const gitignore = await readFile(join(f.root, ".story", ".gitignore"), "utf-8");
    expect(gitignore.split(/\r?\n/).map((l) => l.trim())).toContain("/.bus-evidence.json*");

    const assessment = await assessBusRuntime(f.root);
    expect(assessment.kind).toBe("ok");
  });

  // 2. runtime_lost thrown at BOTH chokepoints (op resolvers + CLI resolveOwnedEndpoint).
  it("throws runtime_lost at op resolvers and the CLI chokepoint after a runtime wipe", async () => {
    const f = await fx();
    await wipeRuntime(f.root);

    await expect(pollBus(f.root, { endpointId: f.b.endpointId, clientTaskId: f.bTaskId }))
      .rejects.toMatchObject({ code: "runtime_lost" });
    await expect(sendBusMessage(f.root, {
      endpointId: f.a.endpointId,
      clientTaskId: f.aTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "low",
      body: "should fail",
      idempotencyKey: "evidence-send-fail",
    })).rejects.toMatchObject({ code: "runtime_lost" });
    await expect(acknowledgeBusMessage(f.root, {
      endpointId: f.b.endpointId,
      clientTaskId: f.bTaskId,
      messageId: "00000000-0000-4000-8000-000000000000",
      disposition: "accepted",
    })).rejects.toMatchObject({ code: "runtime_lost" });
    await expect(updateBusThread(f.root, {
      endpointId: f.b.endpointId,
      clientTaskId: f.bTaskId,
      threadId: "00000000-0000-4000-8000-000000000000",
      action: "park",
      reason: "x",
    })).rejects.toMatchObject({ code: "runtime_lost" });

    // CLI poll WITHOUT --endpoint resolves through resolveOwnedEndpoint.
    const cli = await runBusCli(f.root, ["bus", "poll", "--client", "claude", "--task-id", f.bTaskId, "--format", "json"]);
    const payload = JSON.parse(cli.stdout);
    expect(payload.error?.code).toBe("runtime_lost");
    expect(cli.exitCode).toBe(2);
  });

  // 3. runtime_lost reported (non-throwing surfaces) + exportBusThread throws.
  it("reports runtime_lost through summary, doctor, ship, CLI, and export", async () => {
    const f = await fx();
    const threadId = await firstThreadId(f);
    const lostId = (await readEvidenceRaw(f.root)).instanceId!;
    await wipeRuntime(f.root);

    const summary = await busSummary(f.root);
    expect(summary.setupState).toBe("runtime_lost");
    expect(summary.enabled).toBe(true);

    const doctor = await busDoctor(f.root);
    expect(doctor.healthy).toBe(false);
    expect(doctor.findings.join("\n")).toContain(lostId);

    const ship = await checkBusShip(f.root);
    expect(ship.clear).toBe(false);
    expect(ship.blockers.length).toBeGreaterThan(0);

    const statusCli = await runBusCli(f.root, ["bus", "status", "--format", "md"]);
    expect(statusCli.stdout.toLowerCase()).toContain("lost");
    const doctorCli = await runBusCli(f.root, ["bus", "doctor", "--format", "md"]);
    expect(doctorCli.stdout).toContain(lostId);
    expect(doctorCli.exitCode).toBe(2);

    await expect(exportBusThread(f.root, threadId, "json")).rejects.toMatchObject({ code: "runtime_lost" });
  });

  // 4a. L-031: init-only (no bus setup, no evidence) -> fresh / not_initialized / clear.
  it("classifies an init-only checkout (no evidence) as fresh, not lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-freshinit-"));
    roots.push(root);
    await initProject(root, { name: "fresh-init" });

    const assessment = await assessBusRuntime(root);
    expect(assessment.kind).toBe("fresh");
    expect(await exists(evidencePathFor(root))).toBe(false);
  });

  // 4b + 4c + 4d. Real git clone stays fresh; same-path reclone stays fresh;
  // a sibling checkout with its own runtime+evidence is ok, never a mismatch.
  it("keeps a real fresh clone L-031-clean and isolates sibling checkouts", async () => {
    const source = await mkdtemp(join(tmpdir(), "evidence-src-"));
    roots.push(source);
    await initGitRepo(source);
    await initProject(source, { name: "clone-src" });
    await initializeBus(source);
    await git(source, ["add", "-A"]);
    await git(source, ["commit", "-m", "enable bus"]);

    // The gitignored evidence is never tracked.
    const tracked = await git(source, ["ls-files"]);
    expect(tracked).not.toContain(".bus-evidence.json");
    expect(tracked).toContain(".story/.gitignore");

    // 4b: real clone -> has the ignore rule, no evidence, no runtime, fresh + clear.
    const cloneParent = await mkdtemp(join(tmpdir(), "evidence-clone-"));
    roots.push(cloneParent);
    const clone = join(cloneParent, "checkout");
    await git(cloneParent, ["clone", source, clone]);
    const cloneGitignore = await readFile(join(clone, ".story", ".gitignore"), "utf-8");
    expect(cloneGitignore).toContain("/.bus-evidence.json*");
    expect(await exists(evidencePathFor(clone))).toBe(false);
    expect(await exists(join(clone, ".story", "bus"))).toBe(false);
    expect((await assessBusRuntime(clone)).kind).toBe("fresh");
    expect((await busSummary(clone)).setupState).toBe("not_initialized");
    expect((await checkBusShip(clone)).clear).toBe(true);
    expect((await busDoctor(clone)).healthy).toBe(true);

    // 4c: same-path reclone stays fresh (gitignored evidence died with the tree).
    await rm(clone, { recursive: true, force: true });
    await git(cloneParent, ["clone", source, clone]);
    expect((await assessBusRuntime(clone)).kind).toBe("fresh");

    // 4d: sibling checkout stands up its own runtime+evidence -> ok, not mismatch.
    await initializeBus(clone);
    const cloneInstance = (await readEvidenceRaw(clone)).instanceId;
    const sourceInstance = (await readEvidenceRaw(source)).instanceId;
    expect(cloneInstance).not.toBe(sourceInstance);
    expect((await assessBusRuntime(clone)).kind).toBe("ok");
    expect((await assessBusRuntime(source)).kind).toBe("ok");
  });

  // 5. Tombstone on re-setup over a lost runtime; not silent.
  it("records an absent tombstone when setup re-mints over a wiped runtime", async () => {
    const f = await fx();
    const idA = (await readEvidenceRaw(f.root)).instanceId!;
    await wipeRuntime(f.root);

    await initializeBus(f.root);
    const evidence = await readEvidenceRaw(f.root);
    const idB = evidence.instanceId!;
    expect(idB).not.toBe(idA);
    expect(evidence.tombstones).toHaveLength(1);
    expect(evidence.tombstones[0]).toMatchObject({
      lostInstanceId: idA,
      replacedByInstanceId: idB,
      reason: "absent",
    });
  });

  // 6. Precedence: present-runtime validation outranks evidence interpretation.
  it("distinguishes mismatch, corrupt-instance, future-protocol, and future-over-corrupt-evidence", async () => {
    // 6a: different valid v2 instanceId present -> lost/mismatch.
    const f1 = await fx();
    const instancePath1 = join(f1.root, ".story", "bus", "instance.json");
    const instance1 = JSON.parse(await readFile(instancePath1, "utf-8"));
    await writeFile(instancePath1, JSON.stringify({
      ...instance1,
      instanceId: "11111111-1111-4111-8111-111111111111",
    }, null, 2) + "\n", "utf-8");
    const a1 = await assessBusRuntime(f1.root);
    expect(a1.kind).toBe("lost");
    if (a1.kind === "lost") expect(a1.reason).toBe("mismatch");

    // 6b: garbage instance.json with dir present -> corrupt (NOT runtime_lost).
    const f2 = await fx();
    await writeFile(join(f2.root, ".story", "bus", "instance.json"), "{ not json", "utf-8");
    await expect(assessBusRuntime(f2.root)).rejects.toMatchObject({ code: "corrupt" });

    // 6c: future-protocol instance -> upgrade_required.
    const f3 = await fx();
    const instancePath3 = join(f3.root, ".story", "bus", "instance.json");
    const instance3 = JSON.parse(await readFile(instancePath3, "utf-8"));
    await writeFile(instancePath3, JSON.stringify({
      ...instance3,
      protocolVersion: 3,
      minCliVersion: "99.0.0",
    }, null, 2) + "\n", "utf-8");
    await expect(assessBusRuntime(f3.root)).rejects.toMatchObject({ code: "upgrade_required" });

    // 6d: corrupt evidence + future-protocol runtime -> upgrade_required wins.
    const f4 = await fx();
    const instancePath4 = join(f4.root, ".story", "bus", "instance.json");
    const instance4 = JSON.parse(await readFile(instancePath4, "utf-8"));
    await writeFile(instancePath4, JSON.stringify({
      ...instance4,
      protocolVersion: 3,
      minCliVersion: "99.0.0",
    }, null, 2) + "\n", "utf-8");
    await writeFile(evidencePathFor(f4.root), "}} corrupt evidence", "utf-8");
    await expect(assessBusRuntime(f4.root)).rejects.toMatchObject({ code: "upgrade_required" });
  });

  // 7. Tombstone bound: newest 10, unique eventIds.
  it("bounds tombstones at 10, keeping the newest with unique eventIds", async () => {
    const f = await fx();
    const lostIds: string[] = [];
    for (let i = 0; i < 13; i++) {
      lostIds.push((await readEvidenceRaw(f.root)).instanceId!);
      await wipeRuntime(f.root);
      await initializeBus(f.root);
    }
    const evidence = await readEvidenceRaw(f.root);
    expect(evidence.tombstones).toHaveLength(10);
    const eventIds = new Set(evidence.tombstones.map((t) => t.eventId));
    expect(eventIds.size).toBe(10);
    // Newest kept: the last recorded loss is the most recent minted id.
    const newest = evidence.tombstones[evidence.tombstones.length - 1];
    expect(newest.lostInstanceId).toBe(lostIds[lostIds.length - 1]);
  });

  // 8. evidence_corrupt with a present valid runtime; ENOENT evidence never crashes.
  it("classifies corrupt evidence over a valid runtime as evidence_corrupt", async () => {
    const f = await fx();
    await writeFile(evidencePathFor(f.root), "not valid json at all", "utf-8");

    const assessment = await assessBusRuntime(f.root);
    expect(assessment.kind).toBe("evidence_corrupt");

    await expect(pollBus(f.root, { endpointId: f.b.endpointId, clientTaskId: f.bTaskId }))
      .rejects.toMatchObject({ code: "corrupt" });
    const doctor = await busDoctor(f.root);
    expect(doctor.healthy).toBe(false);
    expect(await checkBusShip(f.root)).toMatchObject({ clear: false });

    // ENOENT evidence read -> none, no crash.
    const paths = await resolveBusPaths(f.root, false);
    await rm(evidencePathFor(f.root), { force: true });
    expect(await readBusEvidence(paths)).toEqual({ kind: "none" });
  });

  // 9. Adoption is setup-only: read paths never write evidence for a legacy runtime.
  it("adopts a pre-T-428 runtime only on setup, never on read", async () => {
    const f = await fx();
    // Simulate a pre-T-428 runtime: valid v2 runtime with NO evidence file.
    await rm(evidencePathFor(f.root), { force: true });
    const gitignoreBefore = await readFile(join(f.root, ".story", ".gitignore"), "utf-8");

    expect((await assessBusRuntime(f.root)).kind).toBe("legacy_unmirrored");
    // Read surfaces must not write evidence.
    await busSummary(f.root);
    await busDoctor(f.root);
    await pollBus(f.root, { endpointId: f.b.endpointId, clientTaskId: f.bTaskId });
    expect(await exists(evidencePathFor(f.root))).toBe(false);
    expect(await readFile(join(f.root, ".story", ".gitignore"), "utf-8")).toBe(gitignoreBefore);

    // Setup adopts: writes evidence naming the live instance.
    await initializeBus(f.root);
    const instance = JSON.parse(await readFile(join(f.root, ".story", "bus", "instance.json"), "utf-8"));
    const evidence = await readEvidenceRaw(f.root);
    expect(evidence.instanceId).toBe(instance.instanceId);
    expect(evidence.tombstones).toEqual([]);

    // Now a wipe is a detected loss.
    await wipeRuntime(f.root);
    expect((await assessBusRuntime(f.root)).kind).toBe("lost");
  });

  // 10. Crash recovery: mint-before-evidence with and without prior evidence.
  it("recovers from a mint-before-evidence crash both with and without prior evidence", async () => {
    // 10a: no prior evidence, runtime minted -> adopt, NO tombstone.
    const f1 = await fx();
    await rm(evidencePathFor(f1.root), { force: true }); // simulate crash before evidence
    await initializeBus(f1.root);
    const e1 = await readEvidenceRaw(f1.root);
    const instance1 = JSON.parse(await readFile(join(f1.root, ".story", "bus", "instance.json"), "utf-8"));
    expect(e1.instanceId).toBe(instance1.instanceId);
    expect(e1.tombstones).toEqual([]);

    // 10b: prior evidence A, runtime already re-minted as B, crash before evidence
    // update -> next assessment records an A->B mismatch tombstone, then sets B.
    const f2 = await fx();
    const idA = (await readEvidenceRaw(f2.root)).instanceId!;
    const instancePath2 = join(f2.root, ".story", "bus", "instance.json");
    const instance2 = JSON.parse(await readFile(instancePath2, "utf-8"));
    const idB = "22222222-2222-4222-8222-222222222222";
    await writeFile(instancePath2, JSON.stringify({ ...instance2, instanceId: idB }, null, 2) + "\n", "utf-8");
    // Evidence still names A (stale) -> mismatch present.
    await initializeBus(f2.root);
    const e2 = await readEvidenceRaw(f2.root);
    expect(e2.instanceId).toBe(idB);
    expect(e2.tombstones).toHaveLength(1);
    expect(e2.tombstones[0]).toMatchObject({
      lostInstanceId: idA,
      replacedByInstanceId: idB,
      reason: "mismatch",
      foundInstanceId: idB,
    });
  });

  // 11. config-revert diagnostic: doctor/status loud; ops still bus_disabled.
  it("surfaces a config-revert note when features.bus is off but evidence exists", async () => {
    const f = await fx();
    const idA = (await readEvidenceRaw(f.root)).instanceId!;
    await wipeRuntime(f.root);
    // Flip features.bus off directly in config.json.
    const configPath = join(f.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.features = { ...(config.features ?? {}), bus: false };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const summary = await busSummary(f.root);
    expect(summary.setupState).toBe("disabled");
    expect(summary.nextActions.join("\n")).toContain(idA);

    // Markdown must surface the diagnostic too (not only JSON): bus doctor, bus
    // status, and the general `storybloq status` view.
    const doctorCli = await runBusCli(f.root, ["bus", "doctor", "--format", "md"]);
    expect(doctorCli.stdout).toContain(idA);
    const statusCli = await runBusCli(f.root, ["bus", "status", "--format", "md"]);
    expect(statusCli.stdout).toContain(idA);
    const state = (await loadProject(f.root)).state;
    const generalStatus = formatStatus(state, "md", [], [], summary);
    expect(generalStatus).toContain(idA);

    // Ops still fail closed with bus_disabled (unchanged).
    await expect(pollBus(f.root, { endpointId: f.b.endpointId, clientTaskId: f.bTaskId }))
      .rejects.toMatchObject({ code: "bus_disabled" });
  });

  // Codex R1: setup must NOT silently overwrite corrupt evidence (that would erase
  // loss history the ops/doctor/ship gate correctly treat as corrupt). Fail closed,
  // leaving both runtime and evidence untouched, for present AND absent runtimes.
  it("refuses setup over corrupt evidence, leaving runtime and evidence untouched", async () => {
    const f = await fx();
    const corrupt = "}} not valid evidence at all";
    await writeFile(evidencePathFor(f.root), corrupt, "utf-8");
    const instanceBefore = await readFile(join(f.root, ".story", "bus", "instance.json"), "utf-8");

    // Present runtime + corrupt evidence -> throw corrupt; nothing overwritten.
    await expect(initializeBus(f.root)).rejects.toMatchObject({ code: "corrupt" });
    expect(await readFile(evidencePathFor(f.root), "utf-8")).toBe(corrupt);
    expect(await readFile(join(f.root, ".story", "bus", "instance.json"), "utf-8")).toBe(instanceBefore);

    // Absent runtime + corrupt evidence -> throw corrupt; runtime not minted.
    await wipeRuntime(f.root);
    await expect(initializeBus(f.root)).rejects.toMatchObject({ code: "corrupt" });
    expect(await exists(join(f.root, ".story", "bus", "instance.json"))).toBe(false);
  });

  // 12. Hook safety: the real SessionStart hook emits the runtime-lost advisory on
  // STDERR only (never bare stdout), for both Codex and Claude, and stdout stays a
  // valid protocol. config.json is not modified by the feature.
  it("emits the runtime-lost advisory on stderr, never stdout, for both clients", async () => {
    const f = await fx();
    const lostId = (await readEvidenceRaw(f.root)).instanceId!;
    await wipeRuntime(f.root);

    // config.json is NOT modified by the feature: features.bus + schemaVersion intact.
    const config = JSON.parse(await readFile(join(f.root, ".story", "config.json"), "utf-8"));
    expect(config.features.bus).toBe(true);
    expect(config.schemaVersion).toBeDefined();

    // Codex SessionStart: stdout must parse as the structured hook JSON; the
    // advisory must be on stderr, absent from stdout.
    const codex = await captureSessionStart({
      codexHookJson: true,
      source: "compact",
      clientTaskId: "codex-lost-task",
      cwd: f.root,
    });
    // A source=compact Codex start deterministically emits the breadcrumb, so
    // stdout must be non-empty AND a valid SessionStart hook envelope -- proving
    // the advisory is genuinely absent from a real protocol payload, not an empty one.
    expect(codex.stdout.trim().length).toBeGreaterThan(0);
    const codexEnvelope = JSON.parse(codex.stdout);
    expect(codexEnvelope.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(codex.stdout).not.toContain("runtime lost");
    expect(codex.stderr).toContain("runtime lost");
    expect(codex.stderr).toContain(lostId);

    // Claude SessionStart: plaintext stdout, advisory on stderr only.
    const claude = await captureSessionStart({
      source: "compact",
      clientTaskId: "claude-lost-task",
      cwd: f.root,
    });
    expect(claude.stdout).not.toContain("runtime lost");
    expect(claude.stderr).toContain("runtime lost");

    // A healthy checkout produces no advisory (the shared helper both hooks use).
    const healthy = await fx();
    expect(await busRuntimeLostAdvisory(healthy.root)).toBeNull();
  });

  // 13. fs hardening: mode 0600, symlink rejected, .story dir mode untouched.
  it("writes evidence 0600, rejects a symlinked evidence path, and leaves .story mode", async () => {
    const f = await fx();
    const mode = (await stat(evidencePathFor(f.root))).mode & 0o777;
    expect(mode).toBe(0o600);

    const storyModeBefore = (await stat(join(f.root, ".story"))).mode & 0o777;

    // A symlinked evidence path is rejected on read and on the next setup write.
    await rm(evidencePathFor(f.root), { force: true });
    await symlink("/etc/hosts", evidencePathFor(f.root));
    const paths = await resolveBusPaths(f.root, false);
    expect((await readBusEvidence(paths)).kind).toBe("corrupt");

    const storyModeAfter = (await stat(join(f.root, ".story"))).mode & 0o777;
    expect(storyModeAfter).toBe(storyModeBefore);
  });

  // 14. temp-file ignore: a crash-left temp sibling stays git-clean and ignored.
  it("gitignores both the evidence file and a crash-left temp sibling", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-tempignore-"));
    roots.push(root);
    await initGitRepo(root);
    await initProject(root, { name: "temp-ignore" });
    await initializeBus(root);
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "enable bus"]);

    // Simulate a crash that left a durable-write temp sibling behind.
    const tempSibling = evidencePathFor(root) + ".tmp.99999.abcd";
    await writeFile(tempSibling, "partial", "utf-8");

    const status = await git(root, ["status", "--porcelain"]);
    expect(status.trim()).toBe("");
    // check-ignore matches both the file and the temp sibling.
    await expect(git(root, ["check-ignore", evidencePathFor(root)])).resolves.toContain(BUS_EVIDENCE_FILENAME);
    await expect(git(root, ["check-ignore", tempSibling])).resolves.toContain(BUS_EVIDENCE_FILENAME);
    await chmod(tempSibling, 0o600).catch(() => undefined);
  });

  // 15. The real Stop hook (handleHookStatus) emits the runtime-lost advisory on
  // STDERR only. The Bus delivery claim's own gate closes after a wipe (its policy
  // file lived under the deleted bus/), so the advisory is the only Stop surface.
  it("emits the runtime-lost advisory from the real Stop hook on stderr, never stdout", async () => {
    const f = await fx();
    const lostId = (await readEvidenceRaw(f.root)).instanceId!;
    await wipeRuntime(f.root);

    const { stdout, stderr } = await captureStopHook(
      { cwd: f.root, session_id: "claude-stop-task", hook_event_name: "Stop" },
      "claude",
    );
    expect(stderr).toContain("runtime lost");
    expect(stderr).toContain(lostId);
    expect(stdout).not.toContain("runtime lost");

    // A healthy checkout's Stop hook stays silent on the advisory.
    const healthy = await fx();
    const clean = await captureStopHook(
      { cwd: healthy.root, session_id: "claude-ok-task", hook_event_name: "Stop" },
      "claude",
    );
    expect(clean.stderr).not.toContain("runtime lost");
  });

  // 16. L-031 partial deletion: a busRoot present but a base directory removed is a
  // PARTIAL runtime. Setup must fail closed (corrupt) and NEVER silently re-create it.
  it("refuses setup over a partial runtime with a missing base directory, never re-creating it", async () => {
    const f = await fx();
    const threads = join(f.root, ".story", "bus", "threads");
    await rm(threads, { recursive: true, force: true });

    await expect(initializeBus(f.root)).rejects.toMatchObject({ code: "corrupt" });
    // The missing structural directory was NOT silently recreated.
    expect(await exists(threads)).toBe(false);
  });

  // 17. An evidence file with no instanceId can only be tampering; it must read back
  // corrupt (not legacy-unmirrored), which would otherwise silently mask a loss.
  it("classifies an id-less evidence file as corrupt, not legacy-unmirrored", async () => {
    const f = await fx();
    await writeFile(evidencePathFor(f.root), JSON.stringify({
      schema: "storybloq-bus-evidence/v1",
      tombstones: [],
    }, null, 2) + "\n", "utf-8");

    const paths = await resolveBusPaths(f.root, false);
    expect((await readBusEvidence(paths)).kind).toBe("corrupt");
    expect((await assessBusRuntime(f.root)).kind).toBe("evidence_corrupt");
  });

  // 18. assertEvidenceIgnored models gitignore last-match-wins: a LATER negation
  // that re-includes the file fails closed (including real-git constructs the simple
  // matcher cannot evaluate), while an EARLIER negation overridden by the positive
  // glob passes. Fail-closed on any unmodellable construct; never under-match.
  it("enforces last-match-wins and fails closed on any re-including negation", async () => {
    const f = await fx();
    const paths = await resolveBusPaths(f.root, false);
    const gitignorePath = join(paths.storyRoot, ".gitignore");
    const reject = async (body: string) => {
      await writeFile(gitignorePath, body, "utf-8");
      await expect(assertEvidenceIgnored(paths)).rejects.toMatchObject({ code: "io_error" });
    };
    const pass = async (body: string) => {
      await writeFile(gitignorePath, body, "utf-8");
      await expect(assertEvidenceIgnored(paths)).resolves.toBeUndefined();
    };

    // Later negations that re-include the file -> reject.
    await reject("/.bus-evidence.json*\n!.bus-evidence.json\n");   // exact
    await reject("/.bus-evidence.json*\n!*.json\n");               // broad glob
    await reject("/.bus-evidence.json*\n![.]bus-evidence.json\n"); // character class (unmodelled)
    await reject("/.bus-evidence.json*\n!\\.bus-evidence.json\n"); // escaped dot (unmodelled)
    await reject("/.bus-evidence.json*\n!**/.bus-evidence.json\n"); // ** (unmodelled)

    // EARLIER negation overridden by the later positive glob -> pass (last wins).
    await pass("!*.json\n/.bus-evidence.json*\n");
    await pass("!.bus-evidence.json\nbus/\n/.bus-evidence.json*\n");

    // Positive glob alone passes; a temp-less positive rule does NOT (temps uncovered).
    await pass("bus/\n/.bus-evidence.json*\n");
    await reject("bus/\n/.bus-evidence.json\n");
    // Missing the glob entirely fails closed.
    await reject("bus/\n");
  });

  // 18b. Real-git cross-check: prove `git check-ignore` actually re-includes the file
  // for a character-class negation (which the simple matcher cannot evaluate), so the
  // fail-closed guard is protecting against a genuine exposure, not a phantom one.
  it("matches real git for a character-class negation that re-includes the evidence file", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-negation-git-"));
    roots.push(root);
    await initGitRepo(root);
    await initProject(root, { name: "negation-git" });
    await initializeBus(root);

    const gitignorePath = join(root, ".story", ".gitignore");
    await writeFile(gitignorePath, "bus/\n/.bus-evidence.json*\n![.]bus-evidence.json\n", "utf-8");

    // Git confirms the negation re-includes the file: check-ignore exits non-zero.
    await expect(git(root, ["check-ignore", evidencePathFor(root)])).rejects.toMatchObject({ code: 1 });

    // Our guard rejects the write for exactly this state.
    const paths = await resolveBusPaths(root, false);
    await expect(assertEvidenceIgnored(paths)).rejects.toMatchObject({ code: "io_error" });
  });

  // 18c. Real-git cross-check for a TEMP-SUBSET negation: `!*.tmp.<pid>.*` re-includes
  // a real atomic-write temp for that pid even though it matches neither the base
  // filename nor any fixed sample. The sample-free matcher must fail closed on it.
  it("fails closed on a PID-specific temp negation that real git would expose", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-tempneg-git-"));
    roots.push(root);
    await initGitRepo(root);
    await initProject(root, { name: "tempneg-git" });
    await initializeBus(root);

    const gitignorePath = join(root, ".story", ".gitignore");
    await writeFile(gitignorePath, `bus/\n/.bus-evidence.json*\n!*.tmp.${process.pid}.*\n`, "utf-8");

    // A real evidence temp with this pid: git does NOT ignore it (the negation wins).
    const tempPath = `${evidencePathFor(root)}.tmp.${process.pid}.deadbeef`;
    await writeFile(tempPath, "partial", "utf-8");
    await expect(git(root, ["check-ignore", tempPath])).rejects.toMatchObject({ code: 1 });

    // Our guard rejects the write for this state (no single sample could prove it safe).
    const paths = await resolveBusPaths(root, false);
    await expect(assertEvidenceIgnored(paths)).rejects.toMatchObject({ code: "io_error" });
    await chmod(tempPath, 0o600).catch(() => undefined);
  });

  // 18d. Leading whitespace is SIGNIFICANT in gitignore: ` /.bus-evidence.json*`
  // does not protect the file in git, so the guard (which must not trim leading
  // whitespace) fails closed rather than accept the trimmed-to-installed rule.
  it("fails closed on a leading-whitespace positive rule that real git does not apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-leadws-git-"));
    roots.push(root);
    await initGitRepo(root);
    await initProject(root, { name: "leadws-git" });
    await initializeBus(root);

    const gitignorePath = join(root, ".story", ".gitignore");
    await writeFile(gitignorePath, "bus/\n /.bus-evidence.json*\n", "utf-8");
    await expect(git(root, ["check-ignore", evidencePathFor(root)])).rejects.toMatchObject({ code: 1 });

    const paths = await resolveBusPaths(root, false);
    await expect(assertEvidenceIgnored(paths)).rejects.toMatchObject({ code: "io_error" });
  });

  // 18e. Git does not honor a symlinked working-tree `.gitignore`. A symlink whose
  // target carries the evidence glob leaves the file exposed, so the no-follow guard
  // (and the write path through it) must reject it.
  it("fails closed when .story/.gitignore is a symlink git would not honor", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-symlinkignore-git-"));
    roots.push(root);
    await initGitRepo(root);
    await initProject(root, { name: "symlink-ignore-git" });
    await initializeBus(root);

    const gitignorePath = join(root, ".story", ".gitignore");
    const target = join(root, ".story", "gitignore-target");
    await writeFile(target, "bus/\n/.bus-evidence.json*\n", "utf-8");
    await rm(gitignorePath, { force: true });
    await symlink("gitignore-target", gitignorePath);

    // Git ignores the symlinked .gitignore entirely, so the evidence file is exposed.
    await expect(git(root, ["check-ignore", evidencePathFor(root)])).rejects.toMatchObject({ code: 1 });

    // Both the guard and the write path fail closed on the symlinked ignore file.
    const paths = await resolveBusPaths(root, false);
    await expect(assertEvidenceIgnored(paths)).rejects.toMatchObject({ code: "io_error" });
    await expect(writeBusEvidence(paths, buildEvidence({
      instanceId: "55555555-5555-4555-8555-555555555555",
      tombstones: [],
    }))).rejects.toMatchObject({ code: "io_error" });
  });

  // 18f. Portability: even when O_NOFOLLOW is UNAVAILABLE (forced here by injecting
  // flag 0), the no-follow reader must still refuse a symlink via the lstat floor,
  // never silently degrade to a following open. A regular file still reads fine.
  it("refuses a symlink through the no-follow reader even without O_NOFOLLOW", async () => {
    const f = await fx();
    const paths = await resolveBusPaths(f.root, false);
    const target = join(paths.storyRoot, "nofollow-target");
    await writeFile(target, "bus/\n/.bus-evidence.json*\n", "utf-8");
    const link = join(paths.storyRoot, "nofollow-symlink");
    await symlink("nofollow-target", link);

    // Degraded branch (noFollowFlag = 0): the lstat floor still rejects the symlink.
    await expect(readTextNoFollow(link, undefined, 0)).rejects.toMatchObject({ code: "corrupt" });
    // A regular file reads normally through the same degraded branch.
    await expect(readTextNoFollow(target, undefined, 0)).resolves.toContain("bus/");
  });

  // 18g. TOCTOU: a regular file swapped for a symlink AFTER the pre-open lstat but
  // BEFORE open would be followed on the degraded (no-O_NOFOLLOW) path; the dev/ino
  // identity check must reject the followed target even though it is a regular file.
  it("rejects a file swapped to a symlink between inspection and open (degraded path)", async () => {
    const f = await fx();
    const paths = await resolveBusPaths(f.root, false);
    const real = join(paths.storyRoot, "swap-real");
    await writeFile(real, "bus/\n/.bus-evidence.json*\n", "utf-8");
    const other = join(paths.storyRoot, "swap-other");
    await writeFile(other, "bus/\n/.bus-evidence.json*\n", "utf-8");

    // Force flag 0 (degraded) and inject the swap in the lstat->open window. The
    // opened inode (swap-other) differs from the lstat'd inode (swap-real) -> corrupt.
    await expect(readTextNoFollow(real, undefined, 0, async () => {
      await rm(real, { force: true });
      await symlink("swap-other", real);
    })).rejects.toMatchObject({ code: "corrupt" });
  });

  // 18h. The SAME swap defense guards readJsonNoFollow (the bus-store / evidence JSON
  // reader), which shares openReadNoFollow: a regular JSON file swapped for a symlink
  // in the degraded lstat->open window is rejected, never parsed from its target.
  it("rejects a JSON file swapped to a symlink between inspection and open (degraded path)", async () => {
    const f = await fx();
    const paths = await resolveBusPaths(f.root, false);
    const real = join(paths.storyRoot, "swap-real.json");
    await writeFile(real, JSON.stringify({ x: 1 }), "utf-8");
    const other = join(paths.storyRoot, "swap-other.json");
    await writeFile(other, JSON.stringify({ x: 2 }), "utf-8");
    const schema = z.object({ x: z.number() }).passthrough();

    await expect(readJsonNoFollow(real, schema, undefined, 0, async () => {
      await rm(real, { force: true });
      await symlink("swap-other.json", real);
    })).rejects.toMatchObject({ code: "corrupt" });
  });

  // 18i. A benign concurrent atomic rename (regular -> regular) is NOT a swap: the
  // reader must succeed on RETRY, reading the NEW inode's content, never false-corrupt.
  // This proves the identity check does not break concurrently-rewritten reads.
  it("reads the new inode after a benign atomic rename in the inspection window", async () => {
    const f = await fx();
    const paths = await resolveBusPaths(f.root, false);
    const real = join(paths.storyRoot, "rename-real.json");
    await writeFile(real, JSON.stringify({ x: 1 }), "utf-8");
    const replacement = join(paths.storyRoot, "rename-new.json");
    await writeFile(replacement, JSON.stringify({ x: 2 }), "utf-8");
    const schema = z.object({ x: z.number() }).passthrough();

    let renamed = false;
    // Attempt 1 lstat sees inode A, then a benign atomic rename replaces `real` with a
    // regular file (inode B); open sees B -> mismatch -> retry. Attempt 2 (window now
    // clean) lstat+open both see B -> reads the new content instead of false-corrupt.
    const result = await readJsonNoFollow(real, schema, undefined, 0, async () => {
      if (renamed) return;
      renamed = true;
      await rename(replacement, real);
    });
    expect(result).toMatchObject({ x: 2 });
  });

  // 19. buildEvidence enforces the retention cap defensively at the serialization
  // chokepoint, even when handed more tombstones than the bound directly.
  it("caps tombstones at the retention bound in buildEvidence, keeping the newest", async () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      buildTombstone({
        lostInstanceId: `00000000-0000-4000-8000-00000000000${i % 10}`,
        reason: "absent",
        replacedByInstanceId: "11111111-1111-4111-8111-111111111111",
      }));
    const evidence = buildEvidence({
      instanceId: "22222222-2222-4222-8222-222222222222",
      tombstones: many,
    });
    expect(evidence.tombstones).toHaveLength(10);
    // Newest (last-appended) retained.
    expect(evidence.tombstones[9]!.eventId).toBe(many[14]!.eventId);
  });

  // 20. The runtime-lost advisory is gated on features.bus: a disabled checkout gets
  // the config-revert diagnostic (status/doctor), never the fail-open hook advisory.
  it("suppresses the runtime-lost advisory when features.bus is disabled", async () => {
    const f = await fx();
    await wipeRuntime(f.root);
    // Enabled: the advisory fires.
    expect(await busRuntimeLostAdvisory(f.root)).toContain("runtime lost");

    // Disable features.bus directly in config.json.
    const configPath = join(f.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.features = { ...(config.features ?? {}), bus: false };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    expect(await busRuntimeLostAdvisory(f.root)).toBeNull();
  });

  // 21. The evidence WRITE path rejects a symlinked target (defense in depth beyond
  // the read-side rejection), so setup can never write through a planted symlink.
  it("refuses to write evidence through a symlinked target", async () => {
    const f = await fx();
    const paths = await resolveBusPaths(f.root, false);
    await rm(busEvidencePath(paths), { force: true });
    await symlink("/etc/hosts", busEvidencePath(paths));

    await expect(writeBusEvidence(paths, buildEvidence({
      instanceId: "33333333-3333-4333-8333-333333333333",
      tombstones: [],
    }))).rejects.toMatchObject({ code: "corrupt" });
    // The planted symlink was not written through.
    expect((await lstat(busEvidencePath(paths))).isSymbolicLink()).toBe(true);
  });

  // 22. A mismatch loss (present runtime with a swapped instance id) is diagnosed
  // accurately -- "no longer matches", never "was deleted" -- naming both instances.
  it("diagnoses a mismatch loss accurately in the advisory, naming both instances", async () => {
    const f = await fx();
    const expectedId = (await readEvidenceRaw(f.root)).instanceId!;
    const instancePath = join(f.root, ".story", "bus", "instance.json");
    const instance = JSON.parse(await readFile(instancePath, "utf-8"));
    const foundId = "44444444-4444-4444-8444-444444444444";
    await writeFile(instancePath, JSON.stringify({ ...instance, instanceId: foundId }, null, 2) + "\n", "utf-8");

    const advisory = await busRuntimeLostAdvisory(f.root);
    expect(advisory).toContain("runtime lost");
    expect(advisory).toContain("no longer matches");
    expect(advisory).toContain(expectedId);
    expect(advisory).toContain(foundId);
    expect(advisory).not.toContain("was deleted");

    // The CLI status + doctor readiness renderers use the same neutral wording, never
    // asserting deletion for a present-but-mismatched runtime.
    const statusCli = await runBusCli(f.root, ["bus", "status", "--format", "md"]);
    expect(statusCli.stdout).toContain("no longer matches");
    expect(statusCli.stdout).not.toContain("was deleted");
    const doctorCli = await runBusCli(f.root, ["bus", "doctor", "--format", "md"]);
    expect(doctorCli.stdout).toContain("no longer matches");
    expect(doctorCli.stdout).not.toContain("was deleted");
  });

  // 23. Concurrent setup against an absent runtime serializes on the project lock:
  // exactly one instance is minted, evidence matches it, no tombstone, no temp leftover.
  it("serializes concurrent setup into one instance with no tombstones or temp leftovers", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-concurrent-"));
    roots.push(root);
    await initProject(root, { name: "concurrent-setup" });

    const results = await Promise.all([initializeBus(root), initializeBus(root)]);
    const ids = new Set(results.map((r) => r.instanceId));
    expect(ids.size).toBe(1);

    const instance = JSON.parse(await readFile(join(root, ".story", "bus", "instance.json"), "utf-8"));
    const evidence = await readEvidenceRaw(root);
    expect([...ids][0]).toBe(instance.instanceId);
    expect(evidence.instanceId).toBe(instance.instanceId);
    expect(evidence.tombstones).toEqual([]);

    // No leftover atomic-write temp siblings from the losing racer.
    const entries = await readdir(join(root, ".story"));
    expect(entries.filter((e) => e.startsWith(`${BUS_EVIDENCE_FILENAME}.tmp`))).toEqual([]);
  });
});
