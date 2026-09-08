/**
 * ISS-1131: the redeliver wake, through the REAL runner.
 *
 * WHY A SECOND FILE. `wake-wiring.test.ts` mocks `wakeAfterSend` wholesale, so no
 * turn ever starts and no wake entry is ever appended there. Asserting "a marker
 * replay produces no `turn/start` and no wake entry" in THAT harness would be
 * vacuously true: the counts it checks can never be anything but zero, in either
 * direction, whatever the code does. It would read as coverage of the issue's
 * explicit demand while establishing nothing. Codex found it in plan round 2.
 *
 * So this file keeps `wakeAfterSend`, `attemptWake` and `recordOutcome` REAL and
 * fakes only the two things that reach outside the process:
 *
 *  - `connectCodexAppServer`, a module import, replaced with an in-memory client
 *    that COUNTS `turn/start`.
 *  - `node:child_process`'s `spawn`, because `readDaemonVersion` is NOT an
 *    imported dependency: it is defined at `wake-runner.ts:59` and called as a
 *    local binding at :273, so mocking the runner's own export leaves the real
 *    `spawn("codex", ["app-server", "daemon", "version"])` running. Without this
 *    mock, I1 would depend on whichever daemon happens to be installed, and it
 *    would be a live probe of the local Codex install besides. Codex found that
 *    too, in plan round 2.
 *
 * The fake child returns its emitters and `kill` SYNCHRONOUSLY and emits stdout
 * and `close` ASYNCHRONOUSLY, so `runBounded` attaches its listeners and arms its
 * deadline first. Emitting before those handlers exist produces a timeout, and I1
 * would then be a false negative wearing the costume of a gate.
 */

import { rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const turnStarts: { threadId: string; text: string }[] = [];
let loadedThreadIds: string[] = [];
let threadStatus: unknown = { type: "idle" };

vi.mock("../../src/bus/codex-app-server.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    connectCodexAppServer: async () => ({
      request: async (method: string, params: unknown) => {
        if (method === "thread/loaded/list") return { data: loadedThreadIds };
        if (method === "thread/list") {
          return {
            data: loadedThreadIds.map((id) => ({ id, status: threadStatus })),
            nextCursor: null,
          };
        }
        if (method === "turn/start") {
          // `buildTurnStartParams` returns `input` as an ARRAY of items, not an
          // object wrapping one. A first cut read `input.items[0]`, which threw
          // inside the fake, surfaced as `failed:io`, and started no turn: the
          // harness reporting a transport failure it had itself caused.
          const p = params as { threadId: string; input: { text: string }[] };
          turnStarts.push({ threadId: p.threadId, text: p.input[0]?.text ?? "" });
          return {};
        }
        return {};
      },
      close: () => undefined,
    }),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => undefined;
      // ASYNCHRONOUS, so `runBounded` has attached its handlers by now.
      setImmediate(() => {
        child.stdout.emit(
          "data",
          Buffer.from(JSON.stringify({ status: "running", appServerVersion: ACCEPTED[0] })),
        );
        child.emit("close", 0);
      });
      return child;
    },
  };
});

const { ACCEPTED_APP_SERVER_VERSIONS: ACCEPTED } = await import("../../src/bus/wake-runner.js");
const { updateEndpoint, joinEndpoint } = await import("../../src/bus/endpoints.js");
const { foldBusThread } = await import("../../src/bus/index.js");
const { resolveBusPaths } = await import("../../src/bus/paths.js");
const { createBusFixture, createIssue } = await import("./helpers.js");
const { runBusCli } = await import("./cli-harness.js");

let fixture: Awaited<ReturnType<typeof createBusFixture>>;

beforeEach(async () => {
  turnStarts.length = 0;
  loadedThreadIds = [];
  threadStatus = { type: "idle" };
  fixture = await createBusFixture("iss1131-integration");
});

afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
});

function payload(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as { data?: unknown; error?: unknown };
  if (parsed.error !== undefined) throw new Error(`command failed: ${JSON.stringify(parsed.error)}`);
  return parsed.data as Record<string, unknown>;
}

/**
 * Arm the codex endpoint so every gate in `attemptWake` can be reached.
 *
 * Set EXPLICITLY, never inherited: the fixture registers the codex endpoint on
 * the `codex_desktop` surface, which gate 3 refuses outright, so a test that took
 * the fixture default would report `skipped:surface-unreachable` and I1 would be
 * a no-attempt dressed as a control.
 *
 * The thread the wake targets is the recipient's OWN `clientTaskId`
 * (`wake-runner.ts:328`), not a separate stored field, so the fake app-server
 * must advertise exactly that id as loaded. A first cut advertised a UUID of its
 * own and every gate passed until ownership, which reported
 * `skipped:ownership-unproven` and started no turn: a harness that could never
 * have produced the outcome its own control asserts.
 */
async function armForRealWake(): Promise<void> {
  await updateEndpoint(fixture.root, fixture.a.endpointId, (current) => ({
    ...current,
    wakePolicy: "idle",
    surface: "codex_cli",
  }));
  loadedThreadIds = [fixture.aTaskId];
}

async function countWakeEntries(threadId: string): Promise<number> {
  const paths = await resolveBusPaths(fixture.root);
  const folded = await foldBusThread(paths.projectRoot, threadId);
  return folded.entries.filter((entry) => entry.type === "wake").length;
}

async function parkOneMessage(): Promise<{ predecessorThreadId: string; refusedEntryHash: string }> {
  const issueId = await createIssue(fixture.root, "medium");
  const configPath = join(fixture.root, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
  config["bus"] = { maxHops: 2 };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

  const first = payload((await runBusCli(fixture.root, [
    "bus", "send", "--format", "json",
    "--endpoint", fixture.b.endpointId, "--task-id", fixture.bTaskId,
    "--thread-kind", "issue_notice", "--kind", "issue_notice", "--severity", "medium",
    "--body", "Opening the finding.", "--issue", issueId,
    "--idempotency-key", randomUUID(),
  ])).stdout);
  const predecessorThreadId = first["threadId"] as string;

  await runBusCli(fixture.root, [
    "bus", "send", "--format", "json",
    "--endpoint", fixture.a.endpointId, "--task-id", fixture.aTaskId,
    "--thread", predecessorThreadId, "--kind", "reply", "--severity", "medium",
    "--body", "Acknowledged, investigating.",
    "--idempotency-key", randomUUID(),
  ]);

  const { stdout: parkedMd } = await runBusCli(fixture.root, [
    "bus", "send", "--format", "md",
    "--endpoint", fixture.b.endpointId, "--task-id", fixture.bTaskId,
    "--thread", predecessorThreadId, "--kind", "reply", "--severity", "medium",
    "--body", "One more check needed before this can close.",
    "--idempotency-key", randomUUID(),
  ]);
  const hashMatch = parkedMd.match(/--refused-entry-hash ([0-9a-f]{64})/);
  if (!hashMatch) throw new Error(`no park in CLI output: ${parkedMd}`);
  return { predecessorThreadId, refusedEntryHash: hashMatch[1]! };
}

function redeliverArgs(
  park: { predecessorThreadId: string; refusedEntryHash: string },
  as: { endpointId: string; taskId: string } = { endpointId: fixture.b.endpointId, taskId: fixture.bTaskId },
): string[] {
  return [
    "bus", "redeliver", "--format", "json",
    "--endpoint", as.endpointId, "--task-id", as.taskId,
    "--predecessor-thread", park.predecessorThreadId,
    "--refused-entry-hash", park.refusedEntryHash,
  ];
}

/**
 * Replace the redelivering endpoint with a fresh successor.
 *
 * The MARKER branch is only reachable by an endpoint that does NOT hold its own
 * receipt for this redelivery. Repeating the redelivery as the SAME identity
 * replays from that identity's receipt instead, which is a different branch of
 * `redeliverBusMessage` and leaves the marker path untested.
 */
async function succeedTheRedeliverer(taskId: string): Promise<{ endpointId: string; taskId: string }> {
  // `--replace` demands POSITIVE offline proof, so the incumbent is forged dead
  // first: a processRef naming a pid that does not exist reads as dead. Same
  // mechanism `succession-redelivery.test.ts` uses, and it works here because the
  // redelivering endpoint is `claude_cli` (a `codex_desktop` one always reads
  // "unknown" and could never be replaced).
  const endpointPath = join(fixture.root, ".story", "bus", "endpoints", `${fixture.b.endpointId}.json`);
  const incumbent = JSON.parse(await readFile(endpointPath, "utf-8")) as Record<string, unknown>;
  await writeFile(endpointPath, `${JSON.stringify({
    ...incumbent,
    state: "attached",
    processRef: { pid: 999999999, signature: "darwin:deadbeef", capturedAt: new Date().toISOString() },
  }, null, 2)}\n`, "utf-8");

  const successor = (await joinEndpoint(fixture.root, {
    client: "claude",
    clientTaskId: taskId,
    surface: "claude_cli",
    replace: fixture.b.endpointId,
  })).endpoint;
  return { endpointId: successor.endpointId, taskId };
}

describe("ISS-1131 a redelivery starts a real turn and records a real entry", () => {
  it("I1: a FRESH redelivery starts exactly one turn and appends exactly one wake entry", async () => {
    const park = await parkOneMessage();
    await armForRealWake();
    turnStarts.length = 0;

    const result = payload((await runBusCli(fixture.root, redeliverArgs(park))).stdout);
    expect(result["replaySource"]).toBe("none");
    expect(result["wake"]).toBe("requested");
    expect(turnStarts).toHaveLength(1);
    expect(turnStarts[0]!.threadId).toBe(fixture.aTaskId);
    expect(await countWakeEntries(result["threadId"] as string)).toBe(1);
  });

  it("I2: a RECEIPT replay changes neither count", async () => {
    // I1's assertions are the positive control for this one. Without them, both
    // counts staying at their starting value would be indistinguishable from a
    // harness that can never move them, which is the whole reason this file exists.
    const park = await parkOneMessage();
    await armForRealWake();
    turnStarts.length = 0;

    const first = payload((await runBusCli(fixture.root, redeliverArgs(park))).stdout);
    const successorThreadId = first["threadId"] as string;
    expect(turnStarts).toHaveLength(1);
    expect(await countWakeEntries(successorThreadId)).toBe(1);

    const second = payload((await runBusCli(fixture.root, redeliverArgs(park))).stdout);
    // NAMED, not merely `replayed: true`. The boolean is true for BOTH replay
    // branches, so asserting it alone would let this test pass while claiming to
    // cover a branch it never reached. Codex found exactly that here.
    expect(second["replaySource"]).toBe("receipt");
    expect(second).not.toHaveProperty("wake");
    expect(turnStarts).toHaveLength(1);
    expect(await countWakeEntries(successorThreadId)).toBe(1);
  });

  it("I3: a MARKER replay, by a SUCCESSOR endpoint, changes neither count", async () => {
    // The branch the issue explicitly names. It is only reachable by an endpoint
    // that holds no receipt of its own for this redelivery, so repeating as the
    // same identity (I2) takes the receipt branch instead and leaves this one
    // untested. Codex found that the original I2 claimed this coverage and did
    // not have it.
    const park = await parkOneMessage();
    await armForRealWake();
    turnStarts.length = 0;

    const first = payload((await runBusCli(fixture.root, redeliverArgs(park))).stdout);
    const successorThreadId = first["threadId"] as string;
    expect(first["replaySource"]).toBe("none");
    expect(turnStarts).toHaveLength(1);
    expect(await countWakeEntries(successorThreadId)).toBe(1);

    const heir = await succeedTheRedeliverer("claude-successor-iss1131");
    const replayed = payload((await runBusCli(fixture.root, redeliverArgs(park, heir))).stdout);

    expect(replayed["replaySource"]).toBe("marker");
    expect(replayed["threadId"]).toBe(successorThreadId);
    expect(replayed["messageId"]).toBe(first["messageId"]);
    expect(replayed).not.toHaveProperty("wake");
    // No SECOND turn on the peer, and no SECOND entry on the thread.
    expect(turnStarts).toHaveLength(1);
    expect(await countWakeEntries(successorThreadId)).toBe(1);
  });
});
