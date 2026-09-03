import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { pendingMailboxCursor, sendBusMessage, setBusHookPolicy } from "../../src/bus/index.js";
import {
  handleSessionCompactPrepare,
  handleSessionResumePrompt,
} from "../../src/cli/commands/session-compact.js";
import { createBusFixture, type BusFixture } from "./helpers.js";

// D8 hooks and markers: the SessionStart marker is role-free with surface= and
// role_mode=per_message; pending counts are endpoint-scoped.

const fixtures: BusFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture.root, { recursive: true, force: true })));
});

async function fx(): Promise<BusFixture> {
  const value = await createBusFixture("bus-markers");
  fixtures.push(value);
  return value;
}

async function sendToImplementer(value: BusFixture, index: number): Promise<void> {
  await sendBusMessage(value.root, {
    endpointId: value.reviewer.endpointId,
    clientTaskId: value.reviewerTaskId,
    threadKind: "question",
    messageKind: "question",
    severity: "medium",
    body: `Verify the marker boundary ${index}`,
    refs: { ciRun: `ci-marker-${index}` },
    idempotencyKey: `marker-question-${index}`,
  });
}

// Returns the text strictly between a `[tag]` ... `[/tag]` marker block so a
// per-block assertion cannot be satisfied by an identical line in another block.
function extractBlock(context: string, tag: string): string {
  const open = `[${tag}]`;
  const close = `[/${tag}]`;
  const start = context.indexOf(open);
  const end = context.indexOf(close);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return context.slice(start + open.length, end);
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

describe("Storybloq Bus markers (D8)", () => {
  it("emits a role-free SessionStart marker with surface and role_mode", async () => {
    const value = await fx();
    await setBusHookPolicy(value.root, ["codex"], true);
    await sendToImplementer(value, 1);
    const transcriptPath = "/tmp/codex-marker-transcript.jsonl";
    await handleSessionCompactPrepare({
      client: "codex",
      clientTaskId: value.implementerTaskId,
      cwd: value.root,
      transcriptPath,
    });
    const output = await captureResumePrompt({
      codexHookJson: true,
      source: "compact",
      clientTaskId: "codex-task-after-marker-compact",
      cwd: value.root,
      transcriptPath,
    });
    const context = JSON.parse(output).hookSpecificOutput.additionalContext as string;

    // The `[storybloq-client-task]` block must itself carry the surface hint so
    // `bus setup` can distinguish codex_cli from codex_desktop. Assert on the
    // isolated block, not the whole context: the `[storybloq-bus-endpoint]` block
    // also contains a `surface=codex_desktop` line, so a whole-context search would
    // pass without proving the client-task block gained the hint.
    const clientTaskBlock = extractBlock(context, "storybloq-client-task");
    expect(clientTaskBlock).toContain("client=codex");
    expect(clientTaskBlock).toContain("id=codex-task-after-marker-compact");
    expect(clientTaskBlock).toContain("surface=codex_desktop");

    // The endpoint block is role-free, endpoint-scoped, and carries its own surface.
    const endpointBlock = extractBlock(context, "storybloq-bus-endpoint");
    expect(endpointBlock).toContain(`endpoint=${value.implementer.endpointId}`);
    expect(endpointBlock).toContain("surface=codex_desktop");
    expect(endpointBlock).toContain("role_mode=per_message");
    expect(endpointBlock).toContain("pending=1");
    // Role is per-message now: no fixed role in the marker.
    expect(context).not.toContain("role=implementer");
    expect(context).not.toContain("role=reviewer");
  });

  it("scopes pending mailbox counts to each endpoint", async () => {
    const value = await fx();
    await sendToImplementer(value, 1);
    await sendToImplementer(value, 2);
    // The cursor is endpoint-scoped and ownership-checked: each endpoint reads
    // its own pending count with its own matching clientTaskId (D2).
    const forImplementer = await pendingMailboxCursor(value.root, value.implementer.endpointId, value.implementerTaskId);
    const forReviewer = await pendingMailboxCursor(value.root, value.reviewer.endpointId, value.reviewerTaskId);
    expect(forImplementer.count).toBe(2);
    // The reviewer sent both messages; none are addressed to it.
    expect(forReviewer.count).toBe(0);
  });
});
