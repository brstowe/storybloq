/**
 * ISS-1221: severity and dedupe-key validation run BEFORE the ledger lock, and
 * through the shared validators the recovery-record preparer also uses. This
 * file deliberately has no top-level import of the command module: the mocks
 * must be registered before it is first evaluated, or a cached instance is
 * reused and the spies see nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK_SENTINEL = new Error("withProjectLock must not be reached for a pre-lock refusal");

describe("handleIssueCreate refuses severity and dedupe key before taking the lock (ISS-1221)", () => {
  let dir: string;
  beforeEach(async () => {
    vi.resetModules();
    dir = await mkdtemp(join(tmpdir(), "iss1221-prelock-"));
  });
  afterEach(async () => {
    vi.doUnmock("../../../src/core/project-loader.js");
    vi.doUnmock("../../../src/core/issue-create-input.js");
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function loadWithSpies() {
    const lock = vi.fn(async () => { throw LOCK_SENTINEL; });
    vi.doMock("../../../src/core/project-loader.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../../src/core/project-loader.js")>();
      return { ...actual, withProjectLock: lock };
    });
    const validators = {
      severity: vi.fn(),
      dedupeKey: vi.fn(),
    };
    vi.doMock("../../../src/core/issue-create-input.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../../src/core/issue-create-input.js")>();
      validators.severity = vi.fn(actual.validateIssueCreateSeverity);
      validators.dedupeKey = vi.fn(actual.validateIssueCreateDedupeKey);
      return {
        ...actual,
        validateIssueCreateSeverity: validators.severity,
        validateIssueCreateDedupeKey: validators.dedupeKey,
      };
    });
    const { handleIssueCreate } = await import("../../../src/cli/commands/issue.js");
    return { handleIssueCreate, lock, validators };
  }

  it("an unknown severity is refused by the shared validator and never reaches the lock", async () => {
    const { handleIssueCreate, lock, validators } = await loadWithSpies();
    await expect(handleIssueCreate(
      { title: "x", severity: "urgent", impact: "x", components: [], relatedTickets: [], location: [] },
      "json", dir,
    )).rejects.toThrow('Unknown issue severity "urgent": must be one of critical, high, medium, low');
    expect(validators.severity).toHaveBeenCalledTimes(1);
    expect(lock).not.toHaveBeenCalled();
  });

  it("a bad dedupe key is refused by the shared validator and never reaches the lock", async () => {
    const { handleIssueCreate, lock, validators } = await loadWithSpies();
    await expect(handleIssueCreate(
      { title: "x", severity: "high", impact: "x", components: [], relatedTickets: [], location: [], dedupeKey: "k".repeat(513) },
      "json", dir,
    )).rejects.toThrow(/512/);
    expect(validators.dedupeKey).toHaveBeenCalledTimes(1);
    expect(lock).not.toHaveBeenCalled();
  });
});
