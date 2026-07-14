import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanActiveSessions, scanSessionSummaries } from "../../src/core/session-scan.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "storybloq-session-scan-"));
  roots.push(root);
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  return root;
}

function writeSession(root: string, sessionId: string, state: Record<string, unknown>): void {
  const dir = join(root, ".story", "sessions", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    sessionId,
    status: "active",
    state: "IMPLEMENT",
    mode: "auto",
    ticket: { id: "T-020", title: "Task ownership" },
    compactPending: false,
    ...state,
  }));
}

describe("scanSessionSummaries", () => {
  it("preserves activeSessions and adds full task/lease metadata", () => {
    const root = makeRoot();
    writeSession(root, "live-session", {
      ownerTask: { client: "codex", id: "codex-task", boundAt: "2026-07-09T00:00:00Z" },
      lease: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

    const result = scanSessionSummaries(root);
    expect(result.resumableSessions).toEqual([]);
    expect(result.activeSessions).toHaveLength(1);
    expect(result.activeSessions[0]).toMatchObject({
      sessionId: "live-session",
      ownerTask: { client: "codex", id: "codex-task" },
      leaseState: "live",
      compactPending: false,
    });
    expect(scanActiveSessions(root)).toEqual(result.activeSessions);
  });

  it("reports an expired COMPACT session as resumable but not live", () => {
    const root = makeRoot();
    writeSession(root, "compact-session", {
      state: "COMPACT",
      compactPending: true,
      ownerTask: null,
      lease: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });

    const result = scanSessionSummaries(root);
    expect(result.activeSessions).toEqual([]);
    expect(result.resumableSessions).toHaveLength(1);
    expect(result.resumableSessions[0]).toMatchObject({
      sessionId: "compact-session",
      ownerTask: null,
      leaseState: "expired",
      compactPending: true,
    });
  });

  it("drops malformed owner identity and falls back to the directory session id", () => {
    const root = makeRoot();
    writeSession(root, "safe-session-id", {
      sessionId: 42,
      ownerTask: { client: "codex", id: "bad task id", boundAt: "2026-07-09T00:00:00Z" },
      lease: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

    const result = scanSessionSummaries(root);
    expect(result.activeSessions[0]).toMatchObject({
      sessionId: "safe-session-id",
      ownerTask: null,
      leaseState: "live",
    });
  });

  it("classifies a missing COMPACT lease as resumable", () => {
    const root = makeRoot();
    writeSession(root, "missing-lease", {
      state: "COMPACT",
      compactPending: true,
      ownerTask: null,
    });

    const result = scanSessionSummaries(root);
    expect(result.activeSessions).toEqual([]);
    expect(result.resumableSessions[0]).toMatchObject({
      sessionId: "missing-lease",
      leaseExpiresAt: null,
      leaseState: "missing",
    });
  });

  it("classifies an invalid COMPACT lease as resumable", () => {
    const root = makeRoot();
    writeSession(root, "invalid-lease", {
      state: "COMPACT",
      compactPending: true,
      ownerTask: null,
      lease: { expiresAt: "not-a-date" },
    });

    const result = scanSessionSummaries(root);
    expect(result.activeSessions).toEqual([]);
    expect(result.resumableSessions[0]).toMatchObject({
      sessionId: "invalid-lease",
      leaseExpiresAt: "not-a-date",
      leaseState: "invalid",
    });
  });
});
