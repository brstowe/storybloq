import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import {
  acknowledgeBusMessage,
  initializeBus,
  joinEndpoint,
  pollBus,
  sendBusMessage,
} from "../../src/bus/index.js";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(root: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: root })).stdout.trim();
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Storybloq Bus Git isolation", () => {
  it("does not change HEAD, the index, or tracked worktree state after opt-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "bus-git-invariant-"));
    roots.push(root);
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "bus-test@example.com"]);
    await git(root, ["config", "user.name", "Bus Test"]);
    await initProject(root, { name: "git-invariant" });
    await writeFile(join(root, "source.txt"), "baseline\n", "utf-8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "baseline"]);

    await initializeBus(root);
    await git(root, ["add", ".story/config.json", ".story/.gitignore"]);
    await git(root, ["commit", "-m", "enable bus"]);
    const headBefore = await git(root, ["rev-parse", "HEAD"]);
    const branchBefore = await git(root, ["branch", "--show-current"]);
    const indexBefore = digest(await readFile(join(root, ".git", "index")));

    const implementerTaskId = "git-codex-task";
    const reviewerTaskId = "git-claude-task";
    const implementer = (await joinEndpoint(root, {
      role: "implementer",
      client: "codex",
      clientTaskId: implementerTaskId,
      surface: "codex_desktop",
    })).endpoint;
    const reviewer = (await joinEndpoint(root, {
      role: "reviewer",
      client: "claude",
      clientTaskId: reviewerTaskId,
      surface: "claude_cli",
    })).endpoint;
    const sent = await sendBusMessage(root, {
      endpointId: reviewer.endpointId,
      clientTaskId: reviewerTaskId,
      threadKind: "question",
      toRole: "implementer",
      messageKind: "question",
      severity: "medium",
      body: "Verify Git isolation",
      refs: { ciRun: "ci-git-isolation" },
      idempotencyKey: "git-isolation-question",
    });
    await pollBus(root, {
      endpointId: implementer.endpointId,
      clientTaskId: implementerTaskId,
    });
    await acknowledgeBusMessage(root, {
      endpointId: implementer.endpointId,
      clientTaskId: implementerTaskId,
      messageId: sent.messageId!,
      disposition: "accepted",
    });

    expect(await git(root, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await git(root, ["branch", "--show-current"])).toBe(branchBefore);
    expect(digest(await readFile(join(root, ".git", "index")))).toBe(indexBefore);
    expect(await git(root, ["status", "--porcelain"])).toBe("");
  });
});
