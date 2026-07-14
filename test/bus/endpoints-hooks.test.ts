import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeCompactionSuccession,
  findEndpointForTask,
  joinEndpoint,
  mintCompactionSuccession,
  pollBus,
  retireEndpoint,
  sendBusMessage,
  setBusHookPolicy,
} from "../../src/bus/index.js";
import { acquireHardenedLock, releaseHardenedLock } from "../../src/bus/lock.js";
import { claimBusStopDelivery } from "../../src/cli/commands/hook-status.js";
import {
  handleSessionCompactPrepare,
  handleSessionResumePrompt,
  readHookStdinContext,
} from "../../src/cli/commands/session-compact.js";
import { enableClaudeBusHooks } from "../../src/cli/commands/setup-skill.js";
import { initProject } from "../../src/core/init.js";
import { PassThrough } from "node:stream";
import { createBusFixture, type BusFixture } from "./helpers.js";

const fixtures: BusFixture[] = [];
const extraDirs: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...fixtures.splice(0).map((fixture) => rm(fixture.root, { recursive: true, force: true })),
    ...extraDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ]);
});

async function fixture(): Promise<BusFixture> {
  const value = await createBusFixture("bus-endpoint-test");
  fixtures.push(value);
  return value;
}

async function sendToImplementer(value: BusFixture, index: number): Promise<void> {
  await sendBusMessage(value.root, {
    endpointId: value.reviewer.endpointId,
    clientTaskId: value.reviewerTaskId,
    threadKind: "question",
    toRole: "implementer",
    messageKind: "question",
    severity: "medium",
    body: `Verify Bus boundary ${index}`,
    refs: { ciRun: `ci-${index}` },
    idempotencyKey: `question-${index}`,
  });
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

describe("Storybloq Bus endpoint succession", () => {
  it("rebinds exactly once after compaction and rejects the old task", async () => {
    const value = await fixture();
    const transcriptPath = "/tmp/codex-transcript-1.jsonl";
    const minted = await mintCompactionSuccession({
      root: value.root,
      client: "codex",
      clientTaskId: value.implementerTaskId,
      transcriptPath,
    });
    expect(minted?.endpointId).toBe(value.implementer.endpointId);

    const rebound = await consumeCompactionSuccession({
      root: value.root,
      client: "codex",
      clientTaskId: "codex-task-after-compact",
      transcriptPath,
    });
    expect(rebound).toMatchObject({
      endpointId: value.implementer.endpointId,
      clientTaskId: "codex-task-after-compact",
    });
    const succession = JSON.parse(await readFile(
      join(value.root, ".story", "bus", "succession", `${minted!.successionId}.json`),
      "utf-8",
    ));
    expect(succession).toMatchObject({
      fromTaskId: value.implementerTaskId,
      toTaskId: "codex-task-after-compact",
    });
    expect(await consumeCompactionSuccession({
      root: value.root,
      client: "codex",
      clientTaskId: "codex-task-after-compact",
      transcriptPath,
    })).toMatchObject({ endpointId: value.implementer.endpointId });
    expect(await consumeCompactionSuccession({
      root: value.root,
      client: "codex",
      clientTaskId: "codex-task-replay",
      transcriptPath,
    })).toBeNull();
    await expect(pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("prefers a fresh succession record over same-task consumed retries", async () => {
    const value = await fixture();
    const transcriptPath = "/tmp/claude-stable-task-transcript.jsonl";
    const first = await mintCompactionSuccession({
      root: value.root,
      client: "claude",
      clientTaskId: value.reviewerTaskId,
      transcriptPath,
    });
    await expect(consumeCompactionSuccession({
      root: value.root,
      client: "claude",
      clientTaskId: value.reviewerTaskId,
      transcriptPath,
    })).resolves.toMatchObject({ endpointId: value.reviewer.endpointId });

    const second = await mintCompactionSuccession({
      root: value.root,
      client: "claude",
      clientTaskId: value.reviewerTaskId,
      transcriptPath,
    });
    expect(second?.successionId).not.toBe(first?.successionId);
    await expect(consumeCompactionSuccession({
      root: value.root,
      client: "claude",
      clientTaskId: value.reviewerTaskId,
      transcriptPath,
    })).resolves.toMatchObject({ endpointId: value.reviewer.endpointId });

    const secondRecord = JSON.parse(await readFile(
      join(value.root, ".story", "bus", "succession", `${second!.successionId}.json`),
      "utf-8",
    ));
    expect(secondRecord.consumedAt).not.toBeNull();
    await expect(consumeCompactionSuccession({
      root: value.root,
      client: "claude",
      clientTaskId: value.reviewerTaskId,
      transcriptPath,
    })).resolves.toMatchObject({ endpointId: value.reviewer.endpointId });
  });

  it("rejects forged and expired succession evidence", async () => {
    const value = await fixture();
    const transcriptPath = "/tmp/claude-transcript-1.jsonl";
    const minted = await mintCompactionSuccession({
      root: value.root,
      client: "claude",
      clientTaskId: value.reviewerTaskId,
      transcriptPath,
    });
    expect(minted).not.toBeNull();
    expect(await consumeCompactionSuccession({
      root: value.root,
      client: "claude",
      clientTaskId: "claude-new-task",
      transcriptPath: "/tmp/forged-transcript.jsonl",
    })).toBeNull();

    const path = join(value.root, ".story", "bus", "succession", `${minted!.successionId}.json`);
    const record = JSON.parse(await readFile(path, "utf-8"));
    record.expiresAt = new Date(0).toISOString();
    await writeFile(path, JSON.stringify(record, null, 2) + "\n", "utf-8");
    expect(await consumeCompactionSuccession({
      root: value.root,
      client: "claude",
      clientTaskId: "claude-new-task",
      transcriptPath,
    })).toBeNull();
    await expect(readFile(path, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes the succession record after a crash between endpoint and record writes", async () => {
    const value = await fixture();
    const transcriptPath = "/tmp/codex-transcript-crash-window.jsonl";
    const nextTaskId = "codex-task-after-crash-window";
    const minted = await mintCompactionSuccession({
      root: value.root,
      client: "codex",
      clientTaskId: value.implementerTaskId,
      transcriptPath,
    });
    const endpointPath = join(value.root, ".story", "bus", "endpoints", `${value.implementer.endpointId}.json`);
    const endpoint = JSON.parse(await readFile(endpointPath, "utf-8"));
    await writeFile(endpointPath, JSON.stringify({
      ...endpoint,
      clientTaskId: nextTaskId,
      resumeHandle: nextTaskId,
    }, null, 2) + "\n", "utf-8");

    await expect(consumeCompactionSuccession({
      root: value.root,
      client: "codex",
      clientTaskId: nextTaskId,
      transcriptPath,
    })).resolves.toMatchObject({ endpointId: value.implementer.endpointId, clientTaskId: nextTaskId });
    const record = JSON.parse(await readFile(
      join(value.root, ".story", "bus", "succession", `${minted!.successionId}.json`),
      "utf-8",
    ));
    expect(record).toMatchObject({ toTaskId: nextTaskId });
    expect(record.consumedAt).not.toBeNull();
  });

  it("does not let another task replace an unknown role owner", async () => {
    const value = await fixture();
    await expect(joinEndpoint(value.root, {
      role: "implementer",
      client: "codex",
      clientTaskId: "foreign-codex-task",
      surface: "codex_desktop",
      replace: true,
    })).rejects.toMatchObject({ code: "conflict" });

    await expect(retireEndpoint(
      value.root,
      value.implementer.endpointId,
      "token sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    )).rejects.toMatchObject({ code: "secret_detected" });
    await expect(retireEndpoint(
      value.root,
      value.implementer.endpointId,
      "unsafe\u000bcontrol",
    )).rejects.toMatchObject({ code: "invalid_input" });

    const retired = await retireEndpoint(value.root, value.implementer.endpointId, "Owner confirmed the Desktop task is irrecoverable");
    expect(retired.retiredAt).not.toBeNull();
  });

  it("does not create runtime files when the feature flag is hand-set", async () => {
    const root = await mkdtemp(join(tmpdir(), "bus-hand-set-"));
    extraDirs.push(root);
    await initProject(root, { name: "bus-hand-set" });
    const configPath = join(root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.features.bus = true;
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    await expect(joinEndpoint(root, {
      role: "implementer",
      client: "codex",
      clientTaskId: "hand-set-task",
      surface: "codex_desktop",
    })).rejects.toMatchObject({
      code: "not_found",
      message: "Bus is not initialized in this checkout. Run `storybloq bus init` first.",
    });
    await expect(setBusHookPolicy(root, ["codex"], true)).rejects.toMatchObject({
      code: "not_found",
      message: "Bus is not initialized in this checkout. Run `storybloq bus init` first.",
    });
    await expect(readdir(join(root, ".story", "bus"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the endpoint acquisition budget above nested protocol-lock waits", async () => {
    const value = await fixture();
    const first = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      toRole: "implementer",
      messageKind: "question",
      severity: "medium",
      body: "Verify nested lock timing",
      refs: { ciRun: "ci-lock-budget" },
      idempotencyKey: "lock-budget-question",
    });
    const locks = join(value.root, ".story", "bus", "locks");
    const threadLock = await acquireHardenedLock(join(locks, `thread-${first.threadId}.lock`));
    const reply = sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Nested lock timing verified",
      refs: { ciRun: "ci-lock-budget-reply" },
      inReplyTo: first.messageId,
      idempotencyKey: "lock-budget-reply",
    });
    const endpointLockPath = join(locks, `endpoint-${value.implementer.endpointId}.lock`);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await access(endpointLockPath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await access(endpointLockPath);
    const concurrentPoll = pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await releaseHardenedLock(threadLock);

    await expect(reply).resolves.toMatchObject({ threadId: first.threadId });
    await expect(concurrentPoll).resolves.toMatchObject({ endpointId: value.implementer.endpointId });
  });
});

describe("Storybloq Bus hooks", () => {
  it("parses full hook context with request-scoped identity", async () => {
    const stream = new PassThrough();
    stream.end(JSON.stringify({
      source: "compact",
      session_id: "codex-task-123",
      cwd: "/tmp/project",
      transcript_path: "/tmp/transcript.jsonl",
    }));
    await expect(readHookStdinContext(stream)).resolves.toEqual({
      source: "compact",
      sessionId: "codex-task-123",
      cwd: "/tmp/project",
      transcriptPath: "/tmp/transcript.jsonl",
    });
  });

  it("rejects hook input above the byte cap", async () => {
    const stream = new PassThrough();
    stream.end(JSON.stringify({
      source: "compact",
      session_id: "codex-task-oversized",
      padding: "x".repeat(70_000),
    }));
    await expect(readHookStdinContext(stream)).resolves.toEqual({});
  });

  it("blocks once per new mailbox cursor and never includes peer payload", async () => {
    const value = await fixture();
    await setBusHookPolicy(value.root, ["codex"], true);
    await sendToImplementer(value, 1);
    const input = { session_id: value.implementerTaskId, cwd: value.root, stop_hook_active: false };
    const first = await claimBusStopDelivery(value.root, input, "codex");
    expect(first).toMatchObject({ decision: "block" });
    expect(first?.reason).not.toContain("Verify Bus boundary 1");
    expect(await claimBusStopDelivery(value.root, input, "codex")).toBeNull();
    expect(await claimBusStopDelivery(value.root, { ...input, stop_hook_active: true }, "codex")).toBeNull();

    await sendToImplementer(value, 2);
    expect(await claimBusStopDelivery(value.root, input, "codex")).toMatchObject({ decision: "block" });
    await sendToImplementer(value, 3);
    await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    });
    expect(await claimBusStopDelivery(value.root, input, "codex")).toBeNull();
  });

  it("lets hook stdin identity override a poisoned ambient task id", async () => {
    const value = await fixture();
    await setBusHookPolicy(value.root, ["codex"], true);
    await sendToImplementer(value, 1);
    const old = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = value.implementerTaskId;
    try {
      expect(await claimBusStopDelivery(value.root, {
        session_id: "foreign-task-id",
        cwd: value.root,
      }, "codex")).toBeNull();
    } finally {
      if (old === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = old;
    }
  });

  it("injects only endpoint metadata and preserves endpoint identity across compact", async () => {
    const value = await fixture();
    await setBusHookPolicy(value.root, ["codex"], true);
    await sendToImplementer(value, 1);
    const transcriptPath = "/tmp/codex-hook-transcript.jsonl";
    await handleSessionCompactPrepare({
      client: "codex",
      clientTaskId: value.implementerTaskId,
      cwd: value.root,
      transcriptPath,
    });
    const output = await captureResumePrompt({
      codexHookJson: true,
      source: "compact",
      clientTaskId: "codex-task-after-hook-compact",
      cwd: value.root,
      transcriptPath,
    });
    const parsed = JSON.parse(output);
    const context = parsed.hookSpecificOutput.additionalContext as string;
    expect(context).toContain("[storybloq-bus-endpoint]");
    expect(context).toContain(`endpoint=${value.implementer.endpointId}`);
    expect(context).toContain("pending=1");
    expect(context).not.toContain("Verify Bus boundary 1");
    expect(await findEndpointForTask(value.root, "codex", "codex-task-after-hook-compact"))
      .toMatchObject({ endpointId: value.implementer.endpointId });
  });

  it("upgrades Claude hooks without duplicating unrelated entries", async () => {
    const value = await fixture();
    const settingsPath = join(value.root, "claude-settings.json");
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "/other/tool" }] }],
      },
    }), "utf-8");
    const first = await enableClaudeBusHooks(settingsPath, "/usr/local/bin/storybloq");
    const second = await enableClaudeBusHooks(settingsPath, "/usr/local/bin/storybloq");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const sessionGroups = settings.hooks.SessionStart as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    const stop = settings.hooks.Stop.flatMap((group: { hooks: Array<Record<string, unknown>> }) => group.hooks);

    expect(first).toEqual({ changed: true, skipped: false });
    expect(second).toEqual({ changed: false, skipped: false });
    expect(sessionGroups.find((group) => group.matcher === "startup")?.hooks).toEqual([{ type: "command", command: "/other/tool" }]);
    expect(sessionGroups.find((group) => group.matcher === "startup|resume|clear|compact")?.hooks)
      .toHaveLength(1);
    expect(stop).toEqual([{ type: "command", command: "/usr/local/bin/storybloq hook-status" }]);
  });
});
