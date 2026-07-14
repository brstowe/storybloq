import { afterEach, describe, expect, it } from "vitest";
import {
  currentClientTaskId,
  currentStorybloqClient,
  isSameOwnerTask,
  legacyClaudeSessionIdForOwner,
  normalizeClientTaskId,
  ownerTaskForClient,
  ownerTaskForCurrentClient,
  resolveStorybloqClient,
  storybloqClientProfile,
} from "../../src/autonomous/client-profile.js";

const ORIGINAL = {
  client: process.env.STORYBLOQ_CLIENT,
  codexThread: process.env.CODEX_THREAD_ID,
  claudeSession: process.env.CLAUDE_CODE_SESSION_ID,
};

afterEach(() => {
  for (const [key, value] of Object.entries({
    STORYBLOQ_CLIENT: ORIGINAL.client,
    CODEX_THREAD_ID: ORIGINAL.codexThread,
    CLAUDE_CODE_SESSION_ID: ORIGINAL.claudeSession,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Storybloq client profile", () => {
  it("defaults unset and unknown client values to Claude", () => {
    expect(resolveStorybloqClient(undefined)).toBe("claude");
    expect(resolveStorybloqClient("other")).toBe("claude");
    delete process.env.STORYBLOQ_CLIENT;
    expect(currentStorybloqClient()).toBe("claude");
    expect(storybloqClientProfile()).toMatchObject({
      displayName: "Claude Code",
      storyCommand: "/story",
    });
  });

  it("derives legacy Claude telemetry from canonical task ownership", () => {
    const claudeOwner = ownerTaskForClient("claude", "claude-task", "now");
    const codexOwner = ownerTaskForClient("codex", "codex-task", "now");

    expect(legacyClaudeSessionIdForOwner(claudeOwner, "stale")).toBe("claude-task");
    expect(legacyClaudeSessionIdForOwner(codexOwner, "stale")).toBeNull();
    expect(legacyClaudeSessionIdForOwner(null, "legacy-task")).toBe("legacy-task");
    expect(legacyClaudeSessionIdForOwner(undefined, undefined)).toBeUndefined();
  });

  it("resolves Codex and its native command", () => {
    process.env.STORYBLOQ_CLIENT = "codex";
    expect(currentStorybloqClient()).toBe("codex");
    expect(storybloqClientProfile()).toMatchObject({
      displayName: "Codex",
      storyCommand: "$story",
    });
  });

  it("prefers an explicit Claude task id over an inherited MCP identity", () => {
    process.env.STORYBLOQ_CLIENT = "claude";
    process.env.CLAUDE_CODE_SESSION_ID = "claude-owner";
    expect(currentClientTaskId("supplied-owner")).toBe("supplied-owner");
  });

  it("falls back to Claude's inherited session id", () => {
    process.env.STORYBLOQ_CLIENT = "claude";
    process.env.CLAUDE_CODE_SESSION_ID = "claude-owner";
    expect(currentClientTaskId()).toBe("claude-owner");
  });

  it("prefers the explicit Codex task id because MCP may be shared", () => {
    process.env.STORYBLOQ_CLIENT = "codex";
    process.env.CODEX_THREAD_ID = "environment-thread";
    expect(currentClientTaskId("explicit-thread")).toBe("explicit-thread");
  });

  it("rejects malformed and oversized task ids", () => {
    expect(normalizeClientTaskId(" task with spaces ")).toBeNull();
    expect(normalizeClientTaskId("x".repeat(129))).toBeNull();
    expect(normalizeClientTaskId("019f4525-6398-7693-9bb7-2c71eb43519c"))
      .toBe("019f4525-6398-7693-9bb7-2c71eb43519c");
  });

  it("builds and compares owner tasks", () => {
    process.env.STORYBLOQ_CLIENT = "codex";
    const owner = ownerTaskForCurrentClient("task-1", "2026-07-09T00:00:00Z");
    expect(owner).toEqual({
      client: "codex",
      id: "task-1",
      boundAt: "2026-07-09T00:00:00Z",
    });
    expect(isSameOwnerTask(owner, { ...owner!, boundAt: "later" })).toBe(true);
    expect(isSameOwnerTask(owner, { ...owner!, id: "task-2" })).toBe(false);
    expect(ownerTaskForClient("codex", "task-2", "later")).toEqual({
      client: "codex",
      id: "task-2",
      boundAt: "later",
    });
  });
});
