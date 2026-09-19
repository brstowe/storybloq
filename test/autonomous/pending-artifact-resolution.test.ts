/**
 * ISS-1221: the prepare site of an `issue_create` recovery record must
 * resolve the payload's phase the way `handleIssueCreate` will write it,
 * because phase is part of `issueCreateFingerprint`. A record fingerprinted
 * from the typed payload while the create infers a phase can never recognize
 * its own result (cross-layer trust violation: the create's tests proved the
 * phase landed, the replay's tests proved the fingerprint round-trips, and
 * nothing crossed the two).
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../../src/core/project-loader.js";
import { displayIdOf } from "../../src/core/resolver.js";
import { CliValidationError } from "../../src/cli/helpers.js";
import { handleIssueCreate } from "../../src/cli/commands/issue.js";
import { classifyPendingMutation, issueCreateFingerprint } from "../../src/autonomous/pending-artifacts.js";
import { resolveIssueCreatePayload, resolvePayloadTicketIdentities } from "../../src/autonomous/pending-artifact-resolution.js";
import { issueCreateArgsFromPayload } from "../../src/autonomous/issue-create-preparation.js";
import { deriveWorkspaceId, type PendingIssueCreatePayload, type PendingProjectMutation } from "../../src/autonomous/session-types.js";
import type { RecoveryAuthority } from "../../src/autonomous/pending-artifacts.js";
import { git as fixtureGit } from "../helpers/git-fixture.js";

const P2_TICKET = "t-p2abcdefgh234567";
const NO_AUTHORITY: RecoveryAuthority = { kind: "none" } as unknown as RecoveryAuthority;

function git(cwd: string, args: string[]): void {
  fixtureGit(cwd, args);
}

function buildRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "iss1221-"));
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(root, ".story", sub), { recursive: true });
  }
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "iss1221", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "iss1221", date: "2026-09-14",
    phases: [
      { id: "p1", label: "P1", name: "Phase 1", description: "Test" },
      { id: "p2", label: "P2", name: "Phase 2", description: "Test" },
    ],
    blockers: [],
  }));
  writeFileSync(join(root, ".story", "tickets", `${P2_TICKET}.json`), JSON.stringify({
    id: P2_TICKET, displayId: "T-002", title: "Ticket T-002", type: "task",
    status: "open", phase: "p2", order: 10, description: "", createdDate: "2026-09-14",
    completedDate: null, blockedBy: [], parentTicket: null,
  }));
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@t.t"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  return root;
}

function writeActiveSession(root: string, ticketId: string): void {
  const sessionId = "aaaaaaaa-0000-0000-0000-000000001221";
  const dir = join(root, ".story", "sessions", sessionId);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    schemaVersion: 1, sessionId, recipe: "coding", state: "IMPLEMENT", revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [], finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: null },
    lease: { workspaceId: deriveWorkspaceId(root), lastHeartbeat: now, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null, compactPending: false,
    compactPreparedAt: null, resumeBlocked: false, terminationReason: null, waitingForRetry: false,
    lastGuideCall: now, startedAt: now, guideCallCount: 0,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
    ticket: { id: ticketId, title: "Ticket T-002" },
  }));
  writeFileSync(join(dir, "events.log"), "");
}

const BASE = {
  title: "prepared before the create",
  severity: "medium",
  impact: "x",
  components: [] as string[],
  location: [] as string[],
};

async function prepareOk(root: string, raw: Parameters<typeof resolveIssueCreatePayload>[1]): Promise<PendingIssueCreatePayload> {
  const { state } = await loadProject(root);
  const prepared = await resolveIssueCreatePayload(state, raw, root);
  expect(prepared.ok).toBe(true);
  return (prepared as { ok: true; payload: PendingIssueCreatePayload }).payload;
}

/** Create through the real command via the replay adapter, then observe the landed issue the way recovery does. */
async function createAndObserve(root: string, payload: PendingIssueCreatePayload) {
  await handleIssueCreate(issueCreateArgsFromPayload(payload), "json", root);
  const { state } = await loadProject(root);
  const created = state.issues.find((i) => i.dedupeKey === payload.dedupeKey)!;
  expect(created).toBeDefined();
  const landedAt = displayIdOf(created);
  const resolvedPayloadTickets = resolvePayloadTicketIdentities(state, payload.relatedTickets);
  return {
    created,
    observation: {
      exists: true, identity: landedAt, dedupeKey: payload.dedupeKey, dedupeKeyAt: landedAt,
      entity: created, resolvedPayloadTickets, contentFingerprint: null,
    },
  };
}

function recordFor(payload: PendingIssueCreatePayload) {
  return {
    type: "issue_create", expectedId: "ISS-042", transitionId: "txn-1221",
    provenance: { ownerTask: "task-prepare", revision: 12, ticket: null },
    content: { payload, semanticFingerprint: issueCreateFingerprint(payload)! },
  } satisfies PendingProjectMutation;
}

describe("resolveIssueCreatePayload (ISS-1221): the preparer writes what the create writes", () => {
  let root: string | null = null;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("(a) infers the phase from the related ticket, and the replayed create is recognized", async () => {
    root = buildRepo();
    const payload = await prepareOk(root, { ...BASE, relatedTickets: ["T-002"], dedupeKey: "dk-a" });
    expect(payload.phase).toBe("p2");
    expect(payload.relatedTickets).toEqual([P2_TICKET]);
    const record = recordFor(payload);
    const { created, observation } = await createAndObserve(root, payload);
    expect(created.phase).toBe("p2");
    expect(issueCreateFingerprint(created), "the fingerprint of what landed is the fingerprint the record stored")
      .toBe(record.content.semanticFingerprint);
    expect(classifyPendingMutation(record, observation, NO_AUTHORITY)).toEqual({ kind: "applied" });
  });

  it("(b) keeps an explicit phase even when the related ticket is elsewhere", async () => {
    root = buildRepo();
    const payload = await prepareOk(root, { ...BASE, relatedTickets: ["T-002"], dedupeKey: "dk-b", phase: "p1" });
    expect(payload.phase).toBe("p1");
    const { created } = await createAndObserve(root, payload);
    expect(created.phase).toBe("p1");
  });

  it("(c) resolves to no phase with no links and no session, and the create writes none", async () => {
    root = buildRepo();
    const payload = await prepareOk(root, { ...BASE, relatedTickets: [], dedupeKey: "dk-c" });
    expect(payload.phase).toBeNull();
    const { created } = await createAndObserve(root, payload);
    expect(created.phase).toBeNull();
  });

  it("(c2) a session that appears after preparation cannot change what the create writes", async () => {
    root = buildRepo();
    const payload = await prepareOk(root, { ...BASE, relatedTickets: [], dedupeKey: "dk-c2" });
    expect(payload.phase).toBeNull();
    const record = recordFor(payload);
    // The race: an autonomous session picks the p2 ticket between prepare and replay.
    writeActiveSession(root, P2_TICKET);
    const { created, observation } = await createAndObserve(root, payload);
    expect(created.phase, "an explicit null is a resolved answer, not an invitation to infer").toBeNull();
    expect(classifyPendingMutation(record, observation, NO_AUTHORITY)).toEqual({ kind: "applied" });
  });

  it("(d) refuses an unresolvable link", async () => {
    root = buildRepo();
    const { state } = await loadProject(root);
    const prepared = await resolveIssueCreatePayload(state, { ...BASE, relatedTickets: ["T-999"], dedupeKey: "dk-d" }, root);
    expect(prepared).toMatchObject({ ok: false, reason: "unresolvable-links" });
  });

  async function refusalMatchesWriter(rootDir: string, raw: Parameters<typeof resolveIssueCreatePayload>[1], reason: string) {
    const { state } = await loadProject(rootDir);
    const prepared = await resolveIssueCreatePayload(state, raw, rootDir);
    expect(prepared).toMatchObject({ ok: false, reason });
    const message = (prepared as { ok: false; message: string }).message;
    let thrown: unknown = null;
    try {
      await handleIssueCreate(issueCreateArgsFromPayload(raw), "json", rootDir);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliValidationError);
    expect((thrown as CliValidationError).message, "the resolver refuses with the writer's own words").toBe(message);
  }

  it("(e) refuses an unknown severity with the writer's message", async () => {
    root = buildRepo();
    await refusalMatchesWriter(root, { ...BASE, severity: "urgent", relatedTickets: [], dedupeKey: "dk-e" }, "severity");
  });

  it("(f) refuses a dedupe key the writer refuses", async () => {
    root = buildRepo();
    await refusalMatchesWriter(root, { ...BASE, relatedTickets: [], dedupeKey: "k".repeat(513) }, "dedupeKey");
  });

  it("(g) refuses an explicit phase that is not in the roadmap", async () => {
    root = buildRepo();
    await refusalMatchesWriter(root, { ...BASE, relatedTickets: [], dedupeKey: "dk-g", phase: "p9" }, "phase");
  });

  it("(h) an invalid explicit phase wins over an unresolvable link, as in the writer", async () => {
    root = buildRepo();
    await refusalMatchesWriter(root, { ...BASE, relatedTickets: ["T-999"], dedupeKey: "dk-h", phase: "p9" }, "phase");
  });

  it("(i) a live dedupe key is a completed no-op before the phase is looked at, as in the writer", async () => {
    root = buildRepo();
    const first = await prepareOk(root, { ...BASE, relatedTickets: [], dedupeKey: "dk-i" });
    const { created } = await createAndObserve(root, first);
    const { state } = await loadProject(root);
    const prepared = await resolveIssueCreatePayload(state, { ...BASE, relatedTickets: [], dedupeKey: "dk-i", phase: "p9" }, root);
    expect(prepared).toEqual({ ok: "deduplicated", issueId: created.id });
    const result = await handleIssueCreate({ ...BASE, relatedTickets: [], dedupeKey: "dk-i", phase: "p9" }, "json", root);
    expect(JSON.parse(result.output).data.id, "the writer returns the existing issue without validating the phase").toBe(created.id);
  });

  it("(l) an inferred phase that is no longer in the roadmap is refused by both preparer and writer", async () => {
    root = buildRepo();
    const STALE = "t-staphase23456789";
    writeFileSync(join(root, ".story", "tickets", `${STALE}.json`), JSON.stringify({
      id: STALE, displayId: "T-003", title: "Ticket T-003", type: "task",
      status: "open", phase: "gone", order: 20, description: "", createdDate: "2026-09-14",
      completedDate: null, blockedBy: [], parentTicket: null,
    }));
    const raw = { ...BASE, relatedTickets: ["T-003"], dedupeKey: "dk-l" };
    const { state } = await loadProject(root);
    const prepared = await resolveIssueCreatePayload(state, raw, root);
    expect(prepared, "the preparer refuses the inferred phase the way it refuses an explicit one")
      .toMatchObject({ ok: false, reason: "phase", message: 'Phase "gone" not found in roadmap' });
    let thrown: unknown = null;
    try {
      await handleIssueCreate(issueCreateArgsFromPayload(raw), "json", root);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliValidationError);
    expect((thrown as CliValidationError).message, "the writer refuses the same input at post-write validation")
      .toContain('references unknown phase "gone"');
    const { state: after } = await loadProject(root);
    expect(after.issues.some((i) => i.dedupeKey === "dk-l"), "nothing was written").toBe(false);
  });

  it("(k) a payload with no dedupe key never matches an issue that also has none", async () => {
    root = buildRepo();
    const noKey = { ...BASE, relatedTickets: [] as string[] };
    await handleIssueCreate({ ...noKey, title: "already there, no key" }, "json", root);
    const { state } = await loadProject(root);
    expect(state.issues.some((i) => i.dedupeKey === undefined), "the fixture holds a keyless issue").toBe(true);
    const prepared = await resolveIssueCreatePayload(state, noKey, root);
    expect(prepared.ok, "no key means nothing to deduplicate against").toBe(true);
  });

  it("(j) a live dedupe key is a completed no-op before links are resolved, as in the writer", async () => {
    root = buildRepo();
    const first = await prepareOk(root, { ...BASE, relatedTickets: [], dedupeKey: "dk-j" });
    const { created } = await createAndObserve(root, first);
    const { state } = await loadProject(root);
    const prepared = await resolveIssueCreatePayload(state, { ...BASE, relatedTickets: ["T-999"], dedupeKey: "dk-j" }, root);
    expect(prepared).toEqual({ ok: "deduplicated", issueId: created.id });
  });
});
