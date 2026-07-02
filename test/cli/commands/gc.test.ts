import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleGc } from "../../../src/cli/commands/gc.js";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function agedTimestamp(daysAgo: number): string {
  const ms = Date.parse("2026-05-01T00:00:00Z") - daysAgo * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function createProject(opts: { team: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "story-gc-"));
  const story = join(root, ".story");
  mkdirSync(join(story, "tickets"), { recursive: true });
  writeJson(join(story, "config.json"), {
    version: 2,
    schemaVersion: opts.team ? 2 : 1,
    project: "test",
    type: "app",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    ...(opts.team ? { team: { enabled: true } } : {}),
  });
  writeJson(join(story, "roadmap.json"), {
    title: "Test",
    date: "2026-05-01",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "" }],
    blockers: [],
  });
  return root;
}

function writeAgedTombstone(root: string, id: string): string {
  const path = join(root, ".story", "tickets", `${id}.json`);
  writeJson(path, {
    id,
    title: "Old deleted ticket",
    type: "task",
    status: "open",
    phase: "p1",
    order: 10,
    description: "",
    createdDate: "2026-01-01",
    completedDate: null,
    blockedBy: [],
    parentTicket: null,
    lifecycle: "deleted",
    deletedAt: agedTimestamp(60), // well past the 30-day retention window
    deletedBy: "alice@example.com",
  });
  return path;
}

function writeActiveTicket(root: string, id: string, fields: Record<string, unknown>): string {
  const path = join(root, ".story", "tickets", `${id}.json`);
  writeJson(path, {
    id,
    title: `Active ${id}`,
    type: "task",
    status: "open",
    phase: "p1",
    order: 20,
    description: "",
    createdDate: "2026-01-01",
    completedDate: null,
    blockedBy: [],
    parentTicket: null,
    ...fields,
  });
  return path;
}

describe("handleGc apply loop", () => {
  it("physically unlinks an aged tombstone in non-team mode", async () => {
    const root = createProject({ team: false });
    const ticketPath = writeAgedTombstone(root, "T-001");
    expect(existsSync(ticketPath)).toBe(true);

    const result = await handleGc(root, { apply: true });

    expect(result.exitCode ?? 0).toBe(0);
    expect(existsSync(ticketPath)).toBe(false);
    expect(result.output).toContain("T-001");
  });

  it("physically unlinks an aged tombstone in team mode (no re-stamp)", async () => {
    const root = createProject({ team: true });
    const ticketPath = writeAgedTombstone(root, "t-0000000000000001");
    expect(existsSync(ticketPath)).toBe(true);

    const result = await handleGc(root, { apply: true });

    expect(result.exitCode ?? 0).toBe(0);
    // The fix for ISS-672: GC purges the aged tombstone rather than re-stamping it.
    // A re-stamp would leave the file in place with a reset deletedAt; assert it is gone.
    expect(existsSync(ticketPath)).toBe(false);
  });

  describe("--force referential-integrity guard (ISS-704)", () => {
    it("refuses to purge a referenced tombstone and leaves it on disk", async () => {
      const root = createProject({ team: true });
      const tombstonePath = writeAgedTombstone(root, "t-0000000000000001");
      // An active ticket still references the tombstone by its canonical id.
      writeActiveTicket(root, "t-0000000000000002", { blockedBy: ["t-0000000000000001"] });
      expect(existsSync(tombstonePath)).toBe(true);

      const result = await handleGc(root, { apply: true, force: true });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("cannot");
      expect(result.output).toContain("t-0000000000000001");
      expect(result.output).toContain("t-0000000000000002"); // the referrer
      expect(result.output).toContain("storybloq repair");
      // Refusal is atomic: the referenced tombstone is NOT unlinked.
      expect(existsSync(tombstonePath)).toBe(true);
    });

    it("--force still purges an unreferenced aged tombstone (no blocked candidates)", async () => {
      const root = createProject({ team: true });
      const tombstonePath = writeAgedTombstone(root, "t-0000000000000001");
      expect(existsSync(tombstonePath)).toBe(true);

      const result = await handleGc(root, { apply: true, force: true });

      expect(result.exitCode ?? 0).toBe(0);
      expect(existsSync(tombstonePath)).toBe(false);
    });

    it("without --force, a referenced tombstone is skipped (not an error) and stays on disk", async () => {
      const root = createProject({ team: true });
      const tombstonePath = writeAgedTombstone(root, "t-0000000000000001");
      writeActiveTicket(root, "t-0000000000000002", { blockedBy: ["t-0000000000000001"] });

      const result = await handleGc(root, { apply: true });

      expect(result.exitCode ?? 0).toBe(0);
      // Blocked candidates are never in plan.eligible, so the file remains.
      expect(existsSync(tombstonePath)).toBe(true);
    });
  });

  describe("invalid --retention-days (ISS-758: handler-level exit code)", () => {
    it("returns exitCode 1 for a non-numeric value (yargs coerces garbage to NaN)", async () => {
      const root = createProject({ team: false });
      const result = await handleGc(root, { retentionDays: Number.NaN });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("retention-days");
    });

    it("returns exitCode 1 for a negative value", async () => {
      const root = createProject({ team: false });
      const result = await handleGc(root, { retentionDays: -1 });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("retention-days");
    });
  });
});
