/**
 * T-489 wake wiring: the tier must run on the USER-FACING send path.
 *
 * The defect these exist to prevent is not subtle and it is not hypothetical: the
 * whole tier shipped once as a function with zero call sites, behind a green suite
 * and four review rounds. Every test here therefore drives a REAL send surface (the
 * yargs command tree, or the registered MCP tool handler) rather than the helper
 * they share, and asserts on what a sender actually observes.
 */

import { rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wakeCalls: { root: string; threadId: string; recipientId: string; wakeText: string }[] = [];
let wakeResult: (() => Promise<unknown>) | null = null;

/**
 * ISS-1131 R6: what the recipient's mailbox held AT THE MOMENT the wake ran.
 *
 * Three separate facts, never collapsed: whether the callback ran at all,
 * whether the read errored, and what it saw. A callback that never ran and a
 * callback whose read failed are different failures.
 */
let observeAtWake: (() => Promise<void>) | null = null;
const observation: { ran: boolean; error: string | null; messageIds: string[] } = {
  ran: false,
  error: null,
  messageIds: [],
};

vi.mock("../../src/bus/wake-runner.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    wakeAfterSend: async (input: {
      root: string;
      threadId: string;
      recipient: { endpointId: string };
      wakeText: string;
    }) => {
      wakeCalls.push({
        root: input.root,
        threadId: input.threadId,
        recipientId: input.recipient.endpointId,
        wakeText: input.wakeText,
      });
      // ISS-1131 R6 RECORDS, IT DOES NOT ASSERT. An expect() or a read error
      // thrown here is caught by `wakeForSend`'s own catch and converted into an
      // absent `wake` field, so an ordering VIOLATION would be swallowed and the
      // named test would never reach vitest's FAILED set: the very catch this
      // tier documents would eat the test that checks it. Codex found it in plan
      // round 2. The observation is asserted OUTSIDE the CLI invocation.
      if (observeAtWake) {
        try {
          await observeAtWake();
        } catch (err) {
          observation.error = err instanceof Error ? err.message : String(err);
        }
      }
      if (wakeResult) return await wakeResult();
      return { kind: "requested", wakeId: "wake-1" };
    },
  };
});

const { BUS_WAKE_TEXT } = await import("../../src/bus/wake.js");
const { updateEndpoint } = await import("../../src/bus/endpoints.js");
const { pollBus } = await import("../../src/bus/index.js");
const { registerBusTools } = await import("../../src/mcp/bus-tools.js");
const { createBusFixture, createIssue } = await import("./helpers.js");
const { runBusCli } = await import("./cli-harness.js");
const { wakeForSend } = await import("../../src/bus/send-with-wake.js");

let fixture: Awaited<ReturnType<typeof createBusFixture>>;

beforeEach(async () => {
  wakeCalls.length = 0;
  wakeResult = null;
  observeAtWake = null;
  observation.ran = false;
  observation.error = null;
  observation.messageIds = [];
  fixture = await createBusFixture("t489-wiring");
});

afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
});

/** Both surfaces answer in a `{version, data}` envelope; the send result is `data`. */
function payload(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as { data?: unknown; error?: unknown };
  if (parsed.error !== undefined) throw new Error(`send failed: ${JSON.stringify(parsed.error)}`);
  return parsed.data as Record<string, unknown>;
}

/** The CODEX endpoint is the recipient, so a Claude sender wakes it. */
async function armCodexRecipient(policy: "idle" | "never"): Promise<void> {
  await updateEndpoint(fixture.root, fixture.a.endpointId, (current) => ({
    ...current,
    wakePolicy: policy,
  }));
}

function sendArgs(format: "md" | "json"): string[] {
  return [
    "bus", "send",
    "--endpoint", fixture.b.endpointId,
    "--task-id", fixture.bTaskId,
    "--thread-kind", "question",
    "--kind", "question",
    "--severity", "info",
    "--body", "does the wake tier actually run",
    "--idempotency-key", randomUUID(),
    // A new thread needs a ref; the Bus refuses one without.
    "--ci-run", "ci-t489-wiring",
    "--format", format,
  ];
}

describe("T-489 the CLI send path runs the wake tier", () => {
  it("invokes the wake ONCE, with the recipient endpoint and the shared text", async () => {
    await armCodexRecipient("idle");
    const { stdout } = await runBusCli(fixture.root, sendArgs("json"));
    const result = payload(stdout) as unknown as { threadId: string; messageId: string; wake?: string };

    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0]!.recipientId).toBe(fixture.a.endpointId);
    expect(wakeCalls[0]!.threadId).toBe(result.threadId);
    // realpath: the CLI harness chdirs into the root and the command rediscovers
    // it, so /var and /private/var are the same directory by two names.
    expect(realpathSync(wakeCalls[0]!.root)).toBe(realpathSync(fixture.root));
    // Not "some string": the exact text, defined once, that the peer's agent reads.
    expect(wakeCalls[0]!.wakeText).toBe(BUS_WAKE_TEXT);
  });

  it("surfaces the outcome in the JSON result", async () => {
    await armCodexRecipient("idle");
    const { stdout } = await runBusCli(fixture.root, sendArgs("json"));
    expect(payload(stdout)["wake"]).toBe("requested");
  });

  it("surfaces the outcome in the human summary", async () => {
    await armCodexRecipient("idle");
    const { stdout } = await runBusCli(fixture.root, sendArgs("md"));
    expect(stdout).toContain("Wake: requested");
    // The send sentence stays intact: the two facts are reported separately.
    expect(stdout).toContain("in thread");
  });

  it("does NOT invoke the wake for an endpoint that never opted in", async () => {
    await armCodexRecipient("never");
    const { stdout } = await runBusCli(fixture.root, sendArgs("json"));
    expect(wakeCalls).toHaveLength(0);
    // ABSENT, not null: no attempt is a different fact from a recorded outcome.
    expect(payload(stdout)).not.toHaveProperty("wake");
  });

  it("does not report a wake when the tier declines the attempt", async () => {
    await armCodexRecipient("idle");
    wakeResult = async () => ({ kind: "no-attempt" });
    const { stdout } = await runBusCli(fixture.root, sendArgs("json"));
    expect(payload(stdout)).not.toHaveProperty("wake");
  });

  it("reports a skip as telemetry rather than hiding it", async () => {
    await armCodexRecipient("idle");
    wakeResult = async () => ({ kind: "skipped", reason: "active-turn" });
    const { stdout } = await runBusCli(fixture.root, sendArgs("json"));
    expect(payload(stdout)["wake"]).toBe("skipped:active-turn");
  });

  it("a REPLAYED send wakes nobody a second time", async () => {
    // Retrying an idempotency key commits nothing new. Waking again would start a
    // second turn on the peer and append a second wake entry for one message, which
    // is the retry the plan ruled out arriving through the back door.
    await armCodexRecipient("idle");
    const args = sendArgs("json");
    const first = payload((await runBusCli(fixture.root, args)).stdout);
    expect(wakeCalls).toHaveLength(1);

    const second = payload((await runBusCli(fixture.root, args)).stdout);
    expect(second["replayed"]).toBe(true);
    expect(second["messageId"]).toBe(first["messageId"]);
    expect(second).not.toHaveProperty("wake");
    expect(wakeCalls).toHaveLength(1);
  });

  it("a THROWING wake never fails the send, and the mail is still committed", async () => {
    // The tier is advisory. A send that reported failure because a wake blew up
    // would be strictly worse than having no wake tier at all.
    await armCodexRecipient("idle");
    wakeResult = async () => {
      throw new Error("app-server exploded");
    };
    const { stdout, exitCode } = await runBusCli(fixture.root, sendArgs("json"));
    const result = payload(stdout) as unknown as { messageId: string | null; wake?: string };
    expect(exitCode ?? 0).toBe(0);
    expect(result.messageId).not.toBeNull();
    expect(result).not.toHaveProperty("wake");

    // Committed means READABLE by the recipient, not merely reported.
    const polled = await pollBus(fixture.root, {
      endpointId: fixture.a.endpointId,
      clientTaskId: fixture.aTaskId,
    });
    expect(polled.messages.map((envelope) => envelope.message.messageId)).toContain(result.messageId);
  });
});

describe("T-489 the MCP send tool runs the same wake tier", () => {
  interface Registered {
    handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
  }

  function registerAndFind(): Registered {
    const tools = new Map<string, Registered["handler"]>();
    const server = {
      registerTool: (name: string, _schema: unknown, handler: Registered["handler"]) => {
        tools.set(name, handler);
      },
    };
    registerBusTools(server as never, fixture.root);
    const handler = tools.get("storybloq_bus_send");
    if (!handler) throw new Error("storybloq_bus_send was never registered");
    return { handler };
  }

  async function send(idempotencyKey = randomUUID()): Promise<Record<string, unknown>> {
    const { handler } = registerAndFind();
    const out = await handler({
      endpointId: fixture.b.endpointId,
      clientTaskId: fixture.bTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "info",
      body: "does the MCP path wake too",
      refs: { ciRun: "ci-t489-wiring" },
      idempotencyKey,
    });
    return payload(out.content[0]!.text);
  }

  it("invokes the wake ONCE and reports the outcome", async () => {
    await armCodexRecipient("idle");
    const result = await send();
    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0]!.recipientId).toBe(fixture.a.endpointId);
    expect(wakeCalls[0]!.wakeText).toBe(BUS_WAKE_TEXT);
    expect(result["wake"]).toBe("requested");
  });

  it("does NOT invoke the wake for an endpoint that never opted in", async () => {
    await armCodexRecipient("never");
    const result = await send();
    expect(wakeCalls).toHaveLength(0);
    expect(result).not.toHaveProperty("wake");
  });

  it("a REPLAYED send wakes nobody a second time", async () => {
    await armCodexRecipient("idle");
    const key = randomUUID();
    const first = await send(key);
    expect(wakeCalls).toHaveLength(1);

    const second = await send(key);
    expect(second["replayed"]).toBe(true);
    expect(second["messageId"]).toBe(first["messageId"]);
    expect(second).not.toHaveProperty("wake");
    expect(wakeCalls).toHaveLength(1);
  });

  it("a THROWING wake never fails the send", async () => {
    await armCodexRecipient("idle");
    wakeResult = async () => {
      throw new Error("app-server exploded");
    };
    const result = await send();
    expect(result["messageId"]).not.toBeNull();
    expect(result).not.toHaveProperty("wake");
  });
});

describe("T-489 the wake identifies itself with the REAL version", () => {
  it("sends storybloq's package version, not a literal", async () => {
    // A fabricated identity string in the daemon's userAgent makes a wake
    // unattributable, which is the one thing the field is for.
    const { __wakeRunnerTesting } = await import("../../src/bus/wake-runner.js");
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version: string };
    expect(__wakeRunnerTesting.clientVersion()).toBe(pkg.version);
    expect(__wakeRunnerTesting.clientVersion()).not.toBe("1.0.0");
  });
});

describe("T-489 a send that committed no mail wakes nobody", () => {
  function sendResult(over: Record<string, unknown>): never {
    return {
      threadId: "00000000-0000-4000-8000-000000000000",
      messageId: "11111111-1111-4111-8111-111111111111",
      toEndpoint: "",
      state: "open",
      hopCount: 1,
      hopsRemaining: 5,
      replayed: false,
      replaySource: "none",
      parked: false,
      nextAction: null,
      ...over,
    } as never;
  }

  it("does not wake for a PARKED send", async () => {
    // A hop-capped send was refused. The peer has nothing new to poll, so waking
    // it would send an agent to look at an empty inbox.
    await armCodexRecipient("idle");
    const out = await wakeForSend(
      fixture.root,
      sendResult({ toEndpoint: fixture.a.endpointId, parked: true }),
    );
    expect(out).toBeNull();
    expect(wakeCalls).toHaveLength(0);
  });

  it("does not wake when no message id was minted", async () => {
    await armCodexRecipient("idle");
    const out = await wakeForSend(
      fixture.root,
      sendResult({ toEndpoint: fixture.a.endpointId, messageId: null }),
    );
    expect(out).toBeNull();
    expect(wakeCalls).toHaveLength(0);
  });

  it("does not wake for a REPLAYED send", async () => {
    await armCodexRecipient("idle");
    const out = await wakeForSend(
      fixture.root,
      sendResult({ toEndpoint: fixture.a.endpointId, replayed: true, replaySource: "receipt" }),
    );
    expect(out).toBeNull();
    expect(wakeCalls).toHaveLength(0);
  });

  it("does not wake a recipient it cannot read", async () => {
    // Without the endpoint there is no policy to honour and no thread to wake.
    // Guessing one would be the same fabrication the gates exist to prevent.
    const out = await wakeForSend(
      fixture.root,
      sendResult({ toEndpoint: "22222222-2222-4222-8222-222222222222" }),
    );
    expect(out).toBeNull();
    expect(wakeCalls).toHaveLength(0);
  });

  it("DOES wake an ordinary committed send (negative control)", async () => {
    // Without this, gating everything out would pass all three tests above.
    await armCodexRecipient("idle");
    const out = await wakeForSend(fixture.root, sendResult({ toEndpoint: fixture.a.endpointId }));
    expect(out).toBe("requested");
    expect(wakeCalls).toHaveLength(1);
  });
});

// ── ISS-1131: the REDELIVER path runs the same tier ───────────────

/**
 * A hop-cap park, built through the real CLI.
 *
 * Recipe proven at `cli-commands.test.ts:266`: cap the thread at two hops, send,
 * have the peer reply, send again so the third hop parks, then scrape the
 * `--refused-entry-hash` the parked prose names. Everything here runs BEFORE the
 * recipient is armed, so none of the setup sends can wake anyone; `wakeCalls` is
 * cleared anyway, because a helper that quietly seeded a call would make every
 * "exactly one wake" assertion below meaningless.
 */
interface ParkedMessage {
  readonly predecessorThreadId: string;
  readonly refusedEntryHash: string;
  /** Wakes observed during the two setup sends. The CONTROL for the next field. */
  readonly wakesDuringSetup: number;
  /** Wakes observed during the send that actually PARKED. Must be zero. */
  readonly wakesDuringParkingSend: number;
}

async function parkOneMessage(): Promise<ParkedMessage> {
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

  // Counted ACROSS the parking send specifically, because the reset below would
  // otherwise make "the park woke nobody" true by construction rather than by
  // behaviour, which is the vacuous green this file exists to refuse.
  const wakesDuringSetup = wakeCalls.length;
  const { stdout: parkedMd } = await runBusCli(fixture.root, [
    "bus", "send", "--format", "md",
    "--endpoint", fixture.b.endpointId, "--task-id", fixture.bTaskId,
    "--thread", predecessorThreadId, "--kind", "reply", "--severity", "medium",
    "--body", "One more check needed before this can close.",
    "--idempotency-key", randomUUID(),
  ]);
  const wakesDuringParkingSend = wakeCalls.length - wakesDuringSetup;
  const hashMatch = parkedMd.match(/--refused-entry-hash ([0-9a-f]{64})/);
  if (!hashMatch) throw new Error(`no park in CLI output: ${parkedMd}`);
  wakeCalls.length = 0;
  return { predecessorThreadId, refusedEntryHash: hashMatch[1]!, wakesDuringSetup, wakesDuringParkingSend };
}

function redeliverArgs(park: ParkedMessage, format: "md" | "json"): string[] {
  return [
    "bus", "redeliver", "--format", format,
    "--endpoint", fixture.b.endpointId, "--task-id", fixture.bTaskId,
    "--predecessor-thread", park.predecessorThreadId,
    "--refused-entry-hash", park.refusedEntryHash,
  ];
}

describe("ISS-1131 the CLI redeliver path runs the wake tier", () => {
  it("invokes the wake ONCE, with the recipient endpoint and the shared text", async () => {
    // The case the tier most needs to cover: the original send PARKED, and a
    // parked send wakes nobody by design, so this redelivery is the first and
    // only chance to wake the peer about this content.
    const park = await parkOneMessage();
    await armCodexRecipient("idle");
    const result = payload((await runBusCli(fixture.root, redeliverArgs(park, "json"))).stdout);

    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0]!.recipientId).toBe(fixture.a.endpointId);
    expect(wakeCalls[0]!.wakeText).toBe(BUS_WAKE_TEXT);
    expect(realpathSync(wakeCalls[0]!.root)).toBe(realpathSync(fixture.root));
    expect(result["replaySource"]).toBe("none");
  });

  it("surfaces the outcome in the JSON result", async () => {
    const park = await parkOneMessage();
    await armCodexRecipient("idle");
    const result = payload((await runBusCli(fixture.root, redeliverArgs(park, "json"))).stdout);
    expect(result["wake"]).toBe("requested");
  });

  it("surfaces the outcome in the human summary, as its own sentence", async () => {
    const park = await parkOneMessage();
    await armCodexRecipient("idle");
    const { stdout } = await runBusCli(fixture.root, redeliverArgs(park, "md"));
    // THE BOUNDARY IS THE ASSERTION, not the presence of two substrings. Both
    // substrings survive a renderer that folds the wake INTO the redelivery
    // sentence, so a containment pair would let the folding mutant live while
    // reading as coverage of separation. Codex found it in code round 1.
    expect(stdout).toMatch(
      /Redelivered onto thread \S+ as message \S+\.\nWake: requested\./,
    );
  });

  it("wakes on the SUCCESSOR thread, not the predecessor", async () => {
    const park = await parkOneMessage();
    await armCodexRecipient("idle");
    const result = payload((await runBusCli(fixture.root, redeliverArgs(park, "json"))).stdout);
    expect(wakeCalls[0]!.threadId).toBe(result["threadId"]);
    expect(wakeCalls[0]!.threadId).not.toBe(park.predecessorThreadId);
  });

  it("wakes only AFTER the redelivered message is readable in the recipient mailbox", async () => {
    // Attribution is not sequencing: the successor thread id is knowable before
    // publication completes, so the test above cannot establish ordering. This
    // one reads the recipient's mailbox from inside the wake and asserts on the
    // recording afterwards, never inside, because a throw there is swallowed.
    const park = await parkOneMessage();
    await armCodexRecipient("idle");
    observeAtWake = async () => {
      observation.ran = true;
      const polled = await pollBus(fixture.root, {
        endpointId: fixture.a.endpointId,
        clientTaskId: fixture.aTaskId,
      });
      observation.messageIds = polled.messages.map((envelope) => envelope.message.messageId);
    };
    const result = payload((await runBusCli(fixture.root, redeliverArgs(park, "json"))).stdout);

    // Three facts, asserted apart. A callback that never ran and one whose read
    // failed are different failures and must not collapse into a single red.
    expect(observation.ran).toBe(true);
    expect(observation.error).toBeNull();
    expect(observation.messageIds).toContain(result["messageId"]);
  });
});

describe("ISS-1131 the MCP redeliver tool runs the same wake tier", () => {
  interface Registered {
    handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
  }

  function redeliverHandler(): Registered["handler"] {
    const tools = new Map<string, Registered["handler"]>();
    const server = {
      registerTool: (name: string, _schema: unknown, handler: Registered["handler"]) => {
        tools.set(name, handler);
      },
    };
    registerBusTools(server as never, fixture.root);
    const handler = tools.get("storybloq_bus_redeliver");
    if (!handler) throw new Error("storybloq_bus_redeliver was never registered");
    return handler;
  }

  async function redeliver(park: ParkedMessage): Promise<Record<string, unknown>> {
    const out = await redeliverHandler()({
      endpointId: fixture.b.endpointId,
      clientTaskId: fixture.bTaskId,
      predecessorThreadId: park.predecessorThreadId,
      refusedEntryHash: park.refusedEntryHash,
    });
    return payload(out.content[0]!.text);
  }

  it("invokes the wake ONCE and reports the outcome", async () => {
    const park = await parkOneMessage();
    await armCodexRecipient("idle");
    const result = await redeliver(park);
    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0]!.recipientId).toBe(fixture.a.endpointId);
    expect(wakeCalls[0]!.wakeText).toBe(BUS_WAKE_TEXT);
    expect(result["wake"]).toBe("requested");
  });

  it("does NOT wake an endpoint that never opted in, and the harness would have seen it", async () => {
    // POSITIVE CONTROL IN THE SAME TEST. Without it this passes today, before any
    // wiring exists, and proves nothing: an absence that reads as a result.
    const parkNever = await parkOneMessage();
    await armCodexRecipient("never");
    const optedOut = await redeliver(parkNever);
    expect(wakeCalls).toHaveLength(0);
    expect(optedOut).not.toHaveProperty("wake");

    const parkIdle = await parkOneMessage();
    await armCodexRecipient("idle");
    await redeliver(parkIdle);
    expect(wakeCalls).toHaveLength(1);
  });
});

describe("ISS-1131 a redelivery that committed no new mail wakes nobody", () => {
  it("a RECEIPT replay does not wake a second time, and the first one did", async () => {
    const park = await parkOneMessage();
    await armCodexRecipient("idle");
    const first = payload((await runBusCli(fixture.root, redeliverArgs(park, "json"))).stdout);
    // The control: the harness can see a wake on this exact path.
    expect(wakeCalls).toHaveLength(1);

    const second = payload((await runBusCli(fixture.root, redeliverArgs(park, "json"))).stdout);
    expect(second["replaySource"]).toBe("receipt");
    expect(second["messageId"]).toBe(first["messageId"]);
    expect(second).not.toHaveProperty("wake");
    expect(wakeCalls).toHaveLength(1);
  });

  it("a THROWING wake never fails the redeliver, and the mail is still committed", async () => {
    const park = await parkOneMessage();
    await armCodexRecipient("idle");
    wakeResult = async () => {
      throw new Error("app-server exploded");
    };
    const { stdout, exitCode } = await runBusCli(fixture.root, redeliverArgs(park, "json"));
    const result = payload(stdout);
    expect(exitCode ?? 0).toBe(0);
    // The control: the wake was actually reached, so the throw was reached.
    expect(wakeCalls).toHaveLength(1);
    expect(result["messageId"]).not.toBeNull();
    expect(result).not.toHaveProperty("wake");

    const polled = await pollBus(fixture.root, {
      endpointId: fixture.a.endpointId,
      clientTaskId: fixture.aTaskId,
    });
    expect(polled.messages.map((envelope) => envelope.message.messageId))
      .toContain(result["messageId"]);
  });

  it("a FAILING redeliver still reports its error: the wake wrapper swallows nothing", async () => {
    // The inverse of the test above, and the one that was missing. That test
    // proves a throwing WAKE cannot fail the redelivery; nothing proved that a
    // failing REDELIVERY still reaches the caller. A wrapper that try/caught the
    // redeliver as well as the wake would turn a refused redelivery into a
    // success-shaped result with an empty thread id, and the mutant that does
    // exactly that SURVIVED the first gate.
    const park = await parkOneMessage();
    await armCodexRecipient("idle");
    const bogus = { ...park, refusedEntryHash: "f".repeat(64) };
    const { stdout } = await runBusCli(fixture.root, redeliverArgs(bogus, "json"));

    const parsed = JSON.parse(stdout) as { data?: unknown; error?: { message?: string } };
    expect(parsed.error).toBeDefined();
    expect(parsed.data).toBeUndefined();
    // And it failed for the RIGHT reason, not because the wake ate it.
    expect(String(parsed.error?.message)).toContain("refusedEntryHash");
    expect(wakeCalls).toHaveLength(0);
  });

  it("CHARACTERISATION: the PARKED original invoked no wake at all", async () => {
    // Existing behaviour, green before and after this change, and evidence about
    // the park and null-message guards rather than about the redeliver wiring.
    // It earns its place because the "a redelivery cannot wake twice" argument
    // rests on it: no wake entry exists for the parked original, so the
    // redelivery's entry is the first for that content. Killed by the mutant that
    // removes BOTH suppression clauses, so it is not inert.
    //
    // It asserts NON-INVOCATION, never an absent persisted entry: this harness
    // mocks the runner, so no entry is ever appended and the entry form of the
    // claim would be vacuously true here.
    await armCodexRecipient("idle");
    const park = await parkOneMessage();
    // THE CONTROL. Armed before the setup sends, so the harness demonstrably sees
    // wakes on this exact fixture and path. Without it, the zero below is true
    // because the helper resets the counter, not because the park declined.
    expect(park.wakesDuringSetup).toBeGreaterThan(0);
    expect(park.wakesDuringParkingSend).toBe(0);
  });
});
