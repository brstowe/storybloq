import { mkdtemp, rm, writeFile, mkdir, readdir, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  autoAttachOutcomeKey,
  clearAutoAttachOutcomes,
  listAutoAttachOutcomes,
  readAutoAttachOutcome,
  removeAutoAttachOutcome,
  shouldSpawnAutoAttach,
  writeAutoAttachOutcome,
  AutoAttachOutcomeSchema,
  RUNNING_FRESHNESS_MS,
  TERMINAL_BACKOFF_MS,
  type AutoAttachOutcome,
} from "../../src/bus/auto-attach-outcome.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function busRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bus-outcome-"));
  roots.push(root);
  // resolveBusPaths requires .story/bus and its subdirs to exist.
  for (const sub of ["threads", "endpoints", "succession", "mailboxes", "idempotency", "locks"]) {
    await mkdir(join(root, ".story", "bus", sub), { recursive: true });
  }
  return root;
}

describe("auto-attach outcome records", () => {
  it("round-trips a durable outcome record with client, kind, reason, endpointId", async () => {
    const root = await busRoot();
    await writeAutoAttachOutcome(root, {
      client: "claude",
      clientTaskId: "task-1",
      kind: "degraded",
      endpointId: "11111111-1111-1111-1111-111111111111",
      reason: "materialization_failed",
      at: "2026-07-15T00:00:00.000Z",
    });
    const read = await readAutoAttachOutcome(root, "claude", "task-1");
    expect(read).toMatchObject({
      v: 1,
      client: "claude",
      kind: "degraded",
      endpointId: "11111111-1111-1111-1111-111111111111",
      reason: "materialization_failed",
    });
  });

  it("keys records per (client, clientTaskId): same task text across clients does not collide", async () => {
    const root = await busRoot();
    await writeAutoAttachOutcome(root, { client: "claude", clientTaskId: "shared", kind: "attached", at: "2026-07-15T00:00:00.000Z" });
    await writeAutoAttachOutcome(root, { client: "codex", clientTaskId: "shared", kind: "skipped_full", reason: "capacity_full", at: "2026-07-15T00:00:00.000Z" });
    expect(autoAttachOutcomeKey("claude", "shared")).not.toBe(autoAttachOutcomeKey("codex", "shared"));
    expect((await readAutoAttachOutcome(root, "claude", "shared"))?.kind).toBe("attached");
    expect((await readAutoAttachOutcome(root, "codex", "shared"))?.kind).toBe("skipped_full");
  });

  it("overwrites a prior degraded record with a later success", async () => {
    const root = await busRoot();
    await writeAutoAttachOutcome(root, { client: "claude", clientTaskId: "t", kind: "degraded", reason: "materialization_failed", at: "2026-07-15T00:00:00.000Z" });
    await writeAutoAttachOutcome(root, { client: "claude", clientTaskId: "t", kind: "converged", at: "2026-07-15T00:01:00.000Z" });
    const read = await readAutoAttachOutcome(root, "claude", "t");
    expect(read?.kind).toBe("converged");
    expect(read?.reason).toBeUndefined();
  });

  it("removes a record (not-applicable gate) leaving no orphan", async () => {
    const root = await busRoot();
    await writeAutoAttachOutcome(root, { client: "claude", clientTaskId: "t", kind: "running", at: "2026-07-15T00:00:00.000Z" });
    await removeAutoAttachOutcome(root, "claude", "t");
    expect(await readAutoAttachOutcome(root, "claude", "t")).toBeNull();
  });

  it("reads missing/corrupt records as null (best-effort hint)", async () => {
    const root = await busRoot();
    expect(await readAutoAttachOutcome(root, "claude", "absent")).toBeNull();
    const dir = join(root, ".story", "bus", "auto-attach");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${autoAttachOutcomeKey("claude", "corrupt")}.json`), "not-json", "utf-8");
    expect(await readAutoAttachOutcome(root, "claude", "corrupt")).toBeNull();
  });

  it("lists outcomes, skipping non-json and unreadable files", async () => {
    const root = await busRoot();
    await writeAutoAttachOutcome(root, { client: "claude", clientTaskId: "a", kind: "attached", at: "2026-07-15T00:00:00.000Z" });
    await writeAutoAttachOutcome(root, { client: "codex", clientTaskId: "b", kind: "skipped_full", reason: "capacity_full", at: "2026-07-15T00:00:00.000Z" });
    const dir = join(root, ".story", "bus", "auto-attach");
    await writeFile(join(dir, "README.txt"), "ignore me", "utf-8");
    await writeFile(join(dir, `${autoAttachOutcomeKey("claude", "junk")}.json`), "not-json", "utf-8");
    const listed = await listAutoAttachOutcomes(root);
    expect(listed).toHaveLength(2);
    expect(listed.map((l) => l.outcome.kind).sort()).toEqual(["attached", "skipped_full"]);
  });

  describe("shouldSpawnAutoAttach (churn gate)", () => {
    const base = (over: Partial<AutoAttachOutcome>): AutoAttachOutcome => ({
      v: 1, client: "claude", kind: "running", at: "2026-07-15T00:00:00.000Z", ...over,
    });

    it("spawns when there is no record", () => {
      expect(shouldSpawnAutoAttach(null, Date.now())).toBe(true);
    });

    it("suppresses while a running record is fresh, allows once it is stale", () => {
      const at = "2026-07-15T00:00:00.000Z";
      const now = Date.parse(at);
      expect(shouldSpawnAutoAttach(base({ kind: "running", at }), now + RUNNING_FRESHNESS_MS - 1)).toBe(false);
      expect(shouldSpawnAutoAttach(base({ kind: "running", at }), now + RUNNING_FRESHNESS_MS + 1)).toBe(true);
    });

    it("backs off after a terminal record until the interval passes", () => {
      const at = "2026-07-15T00:00:00.000Z";
      const now = Date.parse(at);
      expect(shouldSpawnAutoAttach(base({ kind: "failed", at }), now + TERMINAL_BACKOFF_MS - 1)).toBe(false);
      expect(shouldSpawnAutoAttach(base({ kind: "failed", at }), now + TERMINAL_BACKOFF_MS + 1)).toBe(true);
    });

    it("allows spawn on unparseable timestamp or clock skew", () => {
      expect(shouldSpawnAutoAttach(base({ at: "not-a-date" }), Date.now())).toBe(true);
      const future = base({ kind: "running", at: "2026-07-15T01:00:00.000Z" });
      expect(shouldSpawnAutoAttach(future, Date.parse("2026-07-15T00:00:00.000Z"))).toBe(true);
    });
  });

  describe("schema reason invariants", () => {
    const AT = "2026-07-15T00:00:00.000Z";
    it("requires a reason on degraded/failed/skipped_full kinds", () => {
      for (const kind of ["degraded", "failed", "skipped_full"] as const) {
        expect(AutoAttachOutcomeSchema.safeParse({ v: 1, client: "claude", kind, at: AT }).success).toBe(false);
        expect(AutoAttachOutcomeSchema.safeParse({ v: 1, client: "claude", kind, reason: "internal_failure", at: AT }).success).toBe(true);
      }
    });
    it("rejects a reason on success/transient kinds", () => {
      for (const kind of ["running", "attached", "replaced", "converged"] as const) {
        expect(AutoAttachOutcomeSchema.safeParse({ v: 1, client: "claude", kind, reason: "internal_failure", at: AT }).success).toBe(false);
        expect(AutoAttachOutcomeSchema.safeParse({ v: 1, client: "claude", kind, at: AT }).success).toBe(true);
      }
    });
  });

  describe("filesystem hardening", () => {
    it("refuses to resurrect a deleted runtime on write (fails closed, creates nothing)", async () => {
      const root = await busRoot();
      // Delete the whole bus runtime after resolution would otherwise succeed.
      await rm(join(root, ".story", "bus"), { recursive: true, force: true });
      await expect(
        writeAutoAttachOutcome(root, { client: "claude", clientTaskId: "t", kind: "attached", at: "2026-07-15T00:00:00.000Z" }),
      ).rejects.toThrow();
      // The write must NOT have re-created any part of the runtime.
      await expect(lstat(join(root, ".story", "bus"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects a symlinked auto-attach dir instead of following it", async () => {
      const root = await busRoot();
      const elsewhere = await mkdtemp(join(tmpdir(), "aa-evil-"));
      roots.push(elsewhere);
      await symlink(elsewhere, join(root, ".story", "bus", "auto-attach"));
      await expect(
        writeAutoAttachOutcome(root, { client: "claude", clientTaskId: "t", kind: "attached", at: "2026-07-15T00:00:00.000Z" }),
      ).rejects.toThrow();
      // reads/list/clear are best-effort: they swallow and yield nothing, never following the link.
      expect(await readAutoAttachOutcome(root, "claude", "t")).toBeNull();
      expect(await listAutoAttachOutcomes(root)).toHaveLength(0);
      await expect(clearAutoAttachOutcomes(root)).resolves.toBeUndefined();
    });

    it("clearAutoAttachOutcomes removes ONLY canonical-hash outcome files, leaving foreign files", async () => {
      const root = await busRoot();
      await writeAutoAttachOutcome(root, { client: "claude", clientTaskId: "a", kind: "attached", at: "2026-07-15T00:00:00.000Z" });
      const dir = join(root, ".story", "bus", "auto-attach");
      await writeFile(join(dir, "README.txt"), "keep", "utf-8");
      await writeFile(join(dir, "deadbeef.json"), "{}", "utf-8"); // non-64-hex stem: not an outcome
      await clearAutoAttachOutcomes(root);
      const remaining = (await readdir(dir)).sort();
      expect(remaining).toEqual(["README.txt", "deadbeef.json"]);
    });

    it("clearAutoAttachOutcomes never follows or deletes a canonical-hash SYMLINK (regular files only)", async () => {
      const root = await busRoot();
      await writeAutoAttachOutcome(root, { client: "claude", clientTaskId: "a", kind: "attached", at: "2026-07-15T00:00:00.000Z" });
      const dir = join(root, ".story", "bus", "auto-attach");
      // A symlink whose name is a valid 64-hex outcome filename, pointing at a secret outside.
      const secret = join(root, "secret.txt");
      await writeFile(secret, "do not touch", "utf-8");
      const evilName = `${"a".repeat(64)}.json`;
      await symlink(secret, join(dir, evilName));
      await clearAutoAttachOutcomes(root);
      // The symlink is a non-regular file: skipped, never unlinked, never followed to the target.
      expect((await lstat(join(dir, evilName))).isSymbolicLink()).toBe(true);
      expect((await readdir(dir)).includes(evilName)).toBe(true);
      await expect(lstat(secret)).resolves.toBeDefined(); // target untouched
    });

    it("removeAutoAttachOutcome rejects a symlinked auto-attach dir instead of following it", async () => {
      const root = await busRoot();
      const elsewhere = await mkdtemp(join(tmpdir(), "aa-evil-rm-"));
      roots.push(elsewhere);
      await symlink(elsewhere, join(root, ".story", "bus", "auto-attach"));
      await expect(removeAutoAttachOutcome(root, "claude", "t")).rejects.toThrow();
    });
  });
});
