import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, unlink, readFile, writeFile, symlink } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { initProject } from "../../src/core/init.js";
import { writeArrangementUnlocked, loadArrangementsSafe } from "../../src/core/arrangement-loader.js";
import { coordinateDuet, readDuetCoordination } from "../../src/core/duet-coordination.js";
import { serializeJSON } from "../../src/core/project-loader.js";
import { scanSessionSummaries } from "../../src/core/session-scan.js";
import { getMergeRules } from "../../src/core/field-classification.js";
import type { DuetOperation } from "../../src/models/duet.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const id = "a-0123456789abcdef";
const pen = { client: "codex" as const, id: "pen-task" };
const worker = { client: "codex" as const, id: "worker-task" };
let root: string;
let session: string;
let revision: number;
let nonce: string;
// The production operation returns the current view after each mutation.
async function call(op: Record<string, unknown>) {
  const result = await coordinateDuet(root, { id, clientTaskId: pen.id, expectedSessionId: session, expectedRevision: revision, ...op } as DuetOperation) as any;
  revision = result.state.revision;
  nonce = result.state.nonce;
  return result;
}
async function start() {
  return call({ action: "start", expectedSessionId: null, newSessionId: session, mode: "native-return" });
}
async function ready() {
  await start();
  return call({ action: "receipt", receipt: { id: "hello", nonce, direction: "worker-to-manager", source: worker, destination: pen, mode: "native-return", senderTool: "mcp__codex_app__send_message_to_thread", collectionTool: null, observedAt: new Date().toISOString() } });
}
const assignment = { id: "work-1", scope: "Read existing evidence", allowedActions: ["read"], acceptance: ["Report exact evidence"], nextGate: "pen review" };
beforeEach(async () => {
  vi.stubEnv("STORYBLOQ_CLIENT", "codex");
  root = await mkdtemp(join(tmpdir(), "duet-test-"));
  await initProject(root, { name: "duet" });
  await writeArrangementUnlocked({ id, lifecycle: "active", bounds: ["ISS-1155"], parties: [{ role: "pen", client: pen.client, identityAnchor: pen.id }, { role: "worker", client: worker.client, identityAnchor: worker.id }], gates: [], unreachability: { onIrreversibleWork: "hold" }, createdDate: "2026-09-07", updatedAt: "2026-09-07T00:00:00.000Z" }, root);
  session = randomUUID(); revision = 0;
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

describe("durable duet operations", () => {
  it("starts unverified and verifies only an observed current return", async () => {
    expect((await start()).route.status).toBe("missing");
    const result = await call({ action: "receipt", receipt: { id: "hello", nonce, direction: "worker-to-manager", source: worker, destination: pen, mode: "native-return", senderTool: "sender", collectionTool: null, observedAt: new Date().toISOString() } });
    expect(result.route.status).toBe("current");
    expect(result.arrangement.communicationReceipts[0].recorder).toEqual(pen);
  });
  it("refuses a worker and the same pen id under another client", async () => {
    await expect(call({ action: "start", expectedSessionId: null, newSessionId: session, mode: "native-return", clientTaskId: worker.id })).rejects.toThrow(/pen/);
    vi.stubEnv("STORYBLOQ_CLIENT", "claude");
    await expect(start()).rejects.toThrow(/pen/);
  });
  it("preserves open assignments across rotation and refuses stale-session writes", async () => {
    await ready(); await call({ action: "assign", assignment });
    const old = session; session = randomUUID();
    const result = await call({ action: "start", expectedSessionId: old, newSessionId: session, mode: "native-return" });
    expect(result.state.assignments[0].dispatchSessionId).toBe(old);
    expect(result.route.status).toBe("stale");
    await expect(call({ action: "update", expectedSessionId: old, assignmentId: assignment.id, event: { id: "late", kind: "progress", content: "hello" } })).rejects.toThrow(/session/);
  });
  it("deduplicates reports after reload and never reopens resolved work", async () => {
    await ready(); await call({ action: "assign", assignment });
    const report = { id: "send-1", kind: "report", reportId: "report-1", content: "done", evidence: ["evidence.md"] };
    await call({ action: "update", assignmentId: assignment.id, event: report });
    await call({ action: "update", assignmentId: assignment.id, event: { id: "review-1", kind: "review", reportId: "report-1", content: "evidence checked" } });
    const result = await call({ action: "update", assignmentId: assignment.id, event: { ...report, id: "collected-1" } });
    expect(result.state.assignments[0].status).toBe("resolved");
    expect(result.state.assignments[0].events.filter((e: any) => e.input.kind === "report")).toHaveLength(1);
  });
  it("refuses to recreate lost historical runtime as an empty session", async () => {
    await ready(); await call({ action: "assign", assignment });
    await unlink(join(root, ".story/duet-sessions", id, "state.json"));
    await expect(call({ action: "start", newSessionId: randomUUID(), mode: "native-return" })).rejects.toThrow(/recovery/i);
  });
  it("replays an exact start after response loss without rotating twice", async () => {
    const first = await start();
    const repeated = await call({ action: "start", expectedSessionId: null, expectedRevision: 0, newSessionId: session, mode: "native-return" });
    expect(repeated.state).toEqual(first.state);
  });
  it("rejects a stale same-session revision", async () => {
    await ready(); await call({ action: "assign", assignment });
    await expect(call({ action: "update", expectedRevision: revision - 1, assignmentId: assignment.id, event: { id: "stale", kind: "question", content: "Question" } })).rejects.toThrow(/revision/);
  });
  it("refuses a nonce chosen by the receipt and a foreign worker", async () => {
    await start();
    const receipt = { id: "r1", nonce, direction: "worker-to-manager", source: worker, destination: pen, mode: "native-return", senderTool: "sender", collectionTool: null, observedAt: new Date().toISOString() };
    await expect(call({ action: "receipt", receipt: { ...receipt, nonce: randomUUID() } })).rejects.toThrow(/challenge/);
    await expect(call({ action: "receipt", receipt: { ...receipt, source: { ...worker, id: "foreign" } } })).rejects.toThrow(/parties/);
    await expect(call({ action: "assign", assignment })).rejects.toThrow(/return route/);
  });
  it("records manager-collected return with no invented sender", async () => {
    await call({ action: "start", expectedSessionId: null, newSessionId: session, mode: "manager-collected" });
    const receipt = { id: "r1", nonce, direction: "worker-to-manager", source: worker, destination: pen, mode: "manager-collected", senderTool: null, collectionTool: "mcp__codex_app__wait_threads", observedAt: new Date().toISOString() };
    const result = await call({ action: "receipt", receipt });
    expect(result.route).toEqual({ status: "current", mode: "manager-collected" });
  });
  it("preserves identical receipt retries and rejects changed observation time", async () => {
    const first = await ready();
    const stored = first.arrangement.communicationReceipts[0];
    const { recorder: _r, coordinationSessionId: _s, ...receipt } = stored;
    const result = await call({ action: "receipt", expectedRevision: 1, receipt });
    expect(result.arrangement.communicationReceipts).toEqual([stored]);
    await expect(call({ action: "receipt", receipt: { ...receipt, observedAt: "2026-09-07T01:00:00.000Z" } })).rejects.toThrow(/immutable/);
    await expect(call({ action: "receipt", receipt: { ...receipt, senderTool: "anotherSender" } })).rejects.toThrow(/immutable/);
  });
  it("keeps questions, obligations and distinct reports across reload", async () => {
    await ready(); await call({ action: "assign", assignment });
    await call({ action: "update", assignmentId: assignment.id, event: { id: "question", kind: "question", content: "Need scope", pendingDecision: "Which evidence?" } });
    for (const n of [1, 2]) await call({ action: "update", assignmentId: assignment.id, event: { id: `event-${n}`, kind: "report", reportId: `report-${n}`, content: `Revision ${n}` } });
    await expect(call({ action: "update", assignmentId: assignment.id, event: { id: "old-review", kind: "review", reportId: "report-1" } })).rejects.toThrow(/latest/);
    const view = readDuetCoordination(root, loadArrangementsSafe(root).arrangements[0]!);
    expect(view.state!.assignments[0]!.events).toHaveLength(3);
  });
  it("demands status once per silent interval until meaningful worker activity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T00:00:00Z"));
    await ready(); await call({ action: "assign", assignment });
    const update = (id: string, kind: string) => call({ action: "update", assignmentId: assignment.id, event: { id, kind } });
    await expect(update("early", "status-demand")).rejects.toThrow(/60/);
    vi.setSystemTime(new Date("2026-09-07T00:59:59Z"));
    await call({ action: "update", assignmentId: assignment.id, event: { id: "poll", kind: "cursor", cursor: "cursor-1" } });
    vi.setSystemTime(new Date("2026-09-07T01:00:00Z"));
    await update("due", "status-demand");
    await expect(update("repeat", "status-demand")).rejects.toThrow(/60/);
    vi.setSystemTime(new Date("2026-09-07T10:00:00Z"));
    await expect(update("still-silent", "status-demand")).rejects.toThrow(/60/);
    await update("worker", "progress");
    vi.setSystemTime(new Date("2026-09-07T10:59:59Z"));
    await expect(update("too-soon", "status-demand")).rejects.toThrow(/60/);
    vi.setSystemTime(new Date("2026-09-07T11:00:00Z"));
    await update("new-interval", "status-demand");
  });
  it("rejects dangling runtime symlinks without touching their destination", async () => {
    await start();
    const path = join(root, ".story/duet-sessions", id, "state.json");
    await unlink(path);
    await symlink(join(root, "missing-external.json"), path);
    await expect(call({ action: "start", newSessionId: randomUUID(), mode: "native-return" })).rejects.toThrow(/recovery/i);
  });
  it("rejects receipt capacity overflow before changing runtime or arrangement", async () => {
    await start();
    const a = loadArrangementsSafe(root).arrangements[0]!;
    a.padding = "x".repeat(65_250 - Buffer.byteLength(serializeJSON(a)));
    await writeArrangementUnlocked(a, root);
    const path = join(root, ".story/arrangements", `${id}.json`);
    const before = await readFile(path, "utf8");
    const receipt = { id: "r1", nonce, direction: "worker-to-manager", source: worker, destination: pen, mode: "native-return", senderTool: "sender", collectionTool: null, observedAt: new Date().toISOString() };
    await expect(call({ action: "receipt", receipt })).rejects.toThrow(/capacity/);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(loadArrangementsSafe(root).arrangements).toHaveLength(1);
  });
  it("recovers a rotation interrupted between arrangement and runtime renames", async () => {
    await ready(); await call({ action: "assign", assignment });
    const previous = session; session = randomUUID();
    const priorRevision = revision;
    const original = fsPromises.rename;
    let injected = false;
    const rename = vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
      if (!injected && String(to).endsWith(`/duet-sessions/${id}/state.json`)) { injected = true; throw new Error("injected interruption"); }
      return original(from, to);
    });
    await expect(call({ action: "start", expectedSessionId: previous, newSessionId: session, mode: "native-return" })).rejects.toThrow();
    rename.mockRestore();
    expect(injected).toBe(true);
    const resumed = await call({ action: "start", expectedSessionId: previous, expectedRevision: priorRevision, newSessionId: session, mode: "native-return" });
    expect(resumed.state.assignments[0].input.id).toBe(assignment.id);
    expect(resumed.state.start.sessionId).toBe(session);
  });
  it("refuses preplanted transaction staging symlinks without overwriting their target", async () => {
    await start();
    const sentinel = join(root, "sentinel.txt");
    await writeFile(sentinel, "unchanged");
    await symlink(sentinel, join(root, ".story/duet-sessions", id, `state.json.${process.pid}.tmp`));
    await expect(call({ action: "start", newSessionId: randomUUID(), mode: "native-return" })).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
    expect(loadArrangementsSafe(root).arrangements[0]!.currentCoordinationSessionId).toBe(session);
  });
  it("recovers tracked obligations and report identities without harness cursors (ISS-1075)", async () => {
    await ready();
    await call({ action: "assign", assignment: { ...assignment, penOwes: ["Review report"], workerOwes: ["Evidence"], resourceHolds: ["xcodebuild slot"], pendingDecision: "Owner approval" } });
    const report = { id: "r-event", kind: "report", reportId: "r", content: "evidence", evidence: ["artifact.md"] };
    await call({ action: "update", assignmentId: assignment.id, event: report });
    await call({ action: "update", assignmentId: assignment.id, event: { id: "c-event", kind: "cursor", cursor: "private-harness-cursor" } });
    const tracked = loadArrangementsSafe(root).arrangements[0]!;
    expect(JSON.stringify(tracked)).not.toContain("private-harness-cursor");
    await rm(join(root, ".story/duet-sessions"), { recursive: true });
    expect(readDuetCoordination(root, tracked).route.status).toBe("recovery-required");
    const oldSession = session;
    session = randomUUID();
    const result = await call({ action: "recover", expectedSessionId: oldSession, newSessionId: session, mode: "native-return", recoveryEvidence: "Restored tracked checkpoint after machine handoff" });
    expect(result.route.status).toBe("stale");
    expect(result.state.assignments[0].input.penOwes).toEqual(["Review report"]);
    expect(result.state.assignments[0].input.resourceHolds).toEqual(["xcodebuild slot"]);
    expect(result.state.assignments[0].cursor).toBeUndefined();
    const duplicate = await call({ action: "update", assignmentId: assignment.id, event: { ...report, id: "collected-report" } });
    expect(duplicate.state.assignments[0].events).toHaveLength(1);
    await expect(call({ action: "assign", assignment: { ...assignment, id: "fresh-work" } })).rejects.toThrow(/return route/);
  });
  it("refuses recovery over readable newer local reports without changing either history", async () => {
    await ready(); await call({ action: "assign", assignment });
    const path = join(root, ".story/arrangements", `${id}.json`);
    const old = await readFile(path, "utf8"); const oldRevision = revision;
    await call({ action: "update", assignmentId: assignment.id, event: { id: "new-report", kind: "report", reportId: "new", content: "Must survive" } });
    const statePath = join(root, ".story/duet-sessions", id, "state.json");
    const newer = await readFile(statePath, "utf8");
    await writeFile(path, old);
    await expect(call({ action: "recover", expectedRevision: oldRevision, newSessionId: randomUUID(), mode: "native-return", recoveryEvidence: "Old branch restored" })).rejects.toThrow(/diverges/);
    expect(await readFile(path, "utf8")).toBe(old);
    expect(await readFile(statePath, "utf8")).toBe(newer);
  });
  it("rejects durable report fields on cursor events and cursors on reports", async () => {
    await ready(); await call({ action: "assign", assignment });
    await expect(call({ action: "update", assignmentId: assignment.id, event: { id: "r", kind: "report", reportId: "r", cursor: "local" } })).rejects.toThrow(/Only cursor/);
    await expect(call({ action: "update", assignmentId: assignment.id, event: { id: "c", kind: "cursor", cursor: "local", pendingDecision: "Do not drop me" } })).rejects.toThrow(/Cursor events carry only/);
  });
  it("preserves the silent-interval demand limit through recovery", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-07T00:00:00Z"));
    await ready(); await call({ action: "assign", assignment });
    vi.setSystemTime(new Date("2026-09-07T01:00:00Z"));
    await call({ action: "update", assignmentId: assignment.id, event: { id: "demand", kind: "status-demand" } });
    await rm(join(root, ".story/duet-sessions"), { recursive: true });
    vi.setSystemTime(new Date("2026-09-07T10:00:00Z"));
    const old = session; session = randomUUID();
    await call({ action: "recover", expectedSessionId: old, newSessionId: session, mode: "native-return", recoveryEvidence: "Machine handoff" });
    await expect(call({ action: "update", assignmentId: assignment.id, event: { id: "repeat", kind: "status-demand" } })).rejects.toThrow(/60/);
  });
  it("archives corrupt bounded runtime before explicit checkpoint recovery", async () => {
    await ready(); await call({ action: "assign", assignment });
    await writeFile(join(root, ".story/duet-sessions", id, "state.json"), "{corrupt runtime bytes");
    const old = session; session = randomUUID();
    await call({ action: "recover", expectedSessionId: old, newSessionId: session, mode: "native-return", recoveryEvidence: "Validated tracked checkpoint; preserve corrupt bytes" });
    expect(await readFile(join(root, ".story/duet-sessions", id, "recovery", `${session}.json`), "utf8")).toBe("{corrupt runtime bytes");
  });
  it("keeps duet state outside autonomous session discovery and fences merge fields", async () => {
    await ready(); await call({ action: "assign", assignment });
    const scan = scanSessionSummaries(root);
    expect(scan.activeSessions).toEqual([]);
    expect(scan.resumableSessions).toEqual([]);
    expect(scan.diagnostics).toEqual([]);
    const rules = getMergeRules("arrangement");
    for (const field of ["currentCoordinationSessionId", "communicationReceipts", "coordinationCheckpoint"]) expect(rules[field]).toEqual({ kind: "hard-conflict" });
  });
  it("refuses missing caller identity and inactive arrangements", async () => {
    await expect(call({ action: "start", expectedSessionId: null, newSessionId: session, mode: "native-return", clientTaskId: undefined })).rejects.toThrow(/pen/);
    const a = loadArrangementsSafe(root).arrangements[0]!;
    await writeArrangementUnlocked({ ...a, lifecycle: "suspended" }, root);
    await expect(start()).rejects.toThrow(/active/);
  });
});
