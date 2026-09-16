/**
 * T-498 5c re-score: rewrites persisted records' scores under the widened
 * citedDecisiveHandover rule (2026-09-13 pen ruling on the real run's
 * results), without any live session and without touching transcripts.
 * Every test here seeds real, on-disk SessionRecord JSON and asserts on
 * what rescoreOutputRoot/formatReport actually produce -- no mocking of
 * scoreTranscript itself, since the whole point is proving the real
 * (already-widened) scorer's behaviour against real transcript text.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Native ESM's real module namespace is non-configurable, so vi.spyOn on
// "node:fs/promises" directly fails ("Module namespace is not
// configurable"). Mocking with a passthrough factory replaces it with a
// plain, configurable object -- every export still calls straight through
// to the real implementation unless a specific test overrides it, so this
// changes nothing for the other tests in this file.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual };
});
import { rescoreOutputRoot, formatReport, type RescoreCellResult } from "../../scripts/behavioral-gate-rescore.js";
import type { SessionRecord } from "../../scripts/behavioral-gate-run.js";

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "behavioral-gate-rescore-test-"));
  tempDirs.push(dir);
  return dir;
}

function seededRecord(overrides: Partial<SessionRecord> & Pick<SessionRecord, "fixture" | "arm" | "repeat">): SessionRecord {
  return {
    model: "claude-sonnet-5",
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    wallMs: 1000,
    promptBytes: 123,
    transcript: "placeholder",
    score: { pass: false, namedCorrectAlternative: false, citedDecisiveHandover: false, reason: "placeholder" },
    cli: { total_cost_usd: 0.05, usage: {}, session_id: "s", num_turns: 1 },
    ...overrides,
  };
}

interface WrittenRecord {
  readonly path: string;
  readonly bytes: string;
}

async function writeRecord(outputRoot: string, record: SessionRecord): Promise<WrittenRecord> {
  const dir = join(outputRoot, record.fixture, record.arm);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `repeat-${record.repeat}.json`);
  const bytes = JSON.stringify(record, null, 2);
  await writeFile(path, bytes, "utf-8");
  return { path, bytes };
}

describe("rescoreOutputRoot", () => {
  it("flips a cell from fail to pass when the old (strict-filename) score missed a date-only citation the widened rule now accepts", async () => {
    const outputRoot = await makeTempDir();
    const { path } = await writeRecord(
      outputRoot,
      seededRecord({
        fixture: "abandoned-no-reversal",
        arm: "oracle",
        repeat: 1,
        transcript: "T-5002 is next; the 2026-08-05 handover recorded T-5001 as abandoned.",
        score: { pass: false, namedCorrectAlternative: true, citedDecisiveHandover: false, reason: "old strict scorer missed the date-only citation" },
      }),
    );
    const results = await rescoreOutputRoot(outputRoot);
    const cell = results.find((r) => r.fixture === "abandoned-no-reversal" && r.arm === "oracle" && r.repeat === 1)!;
    expect(cell.oldPass).toBe(false);
    expect(cell.newPass).toBe(true);
    const onDisk = JSON.parse(await readFile(path, "utf-8")) as SessionRecord;
    expect(onDisk.score?.pass).toBe(true);
    expect(onDisk.transcript).toBe("T-5002 is next; the 2026-08-05 handover recorded T-5001 as abandoned.");
  });

  it("preserves the pre-rescore record byte-for-byte in a .v1 sibling file", async () => {
    const outputRoot = await makeTempDir();
    const { path, bytes } = await writeRecord(
      outputRoot,
      seededRecord({
        fixture: "abandoned-no-reversal",
        arm: "brief",
        repeat: 2,
        transcript: "T-5002 is next; day5 recorded T-5001 as abandoned.",
        score: { pass: false, namedCorrectAlternative: true, citedDecisiveHandover: false, reason: "pre-widening" },
      }),
    );
    await rescoreOutputRoot(outputRoot);
    const v1Path = join(outputRoot, "abandoned-no-reversal", "brief", "repeat-2.v1.json");
    const v1Bytes = await readFile(v1Path, "utf-8");
    // Full raw-byte comparison, not just a handful of parsed fields --
    // any field silently changing in the backup (formatting, a dropped
    // key) would fail this even if score/transcript individually matched.
    expect(v1Bytes).toBe(bytes);
    // path is the primary file's location, distinct from the .v1 backup;
    // used here only to confirm the primary was rewritten, not left as bytes.
    const primaryBytes = await readFile(path, "utf-8");
    expect(primaryBytes).not.toBe(bytes);
  });

  it("does not overwrite an existing .v1 backup on a second rescore pass, and the second pass's report still shows the ORIGINAL old verdict (idempotent backup + stable oldPass)", async () => {
    const outputRoot = await makeTempDir();
    const { bytes: originalBytes } = await writeRecord(
      outputRoot,
      seededRecord({
        fixture: "abandoned-no-reversal",
        arm: "oracle",
        repeat: 3,
        transcript: "T-5002 is next; day5 recorded T-5001 as abandoned.",
        score: { pass: false, namedCorrectAlternative: true, citedDecisiveHandover: false, reason: "original score, first run" },
      }),
    );
    const firstPass = await rescoreOutputRoot(outputRoot);
    const secondPass = await rescoreOutputRoot(outputRoot); // second pass, same records (now already rescored to pass)
    const v1Path = join(outputRoot, "abandoned-no-reversal", "oracle", "repeat-3.v1.json");
    const v1Bytes = await readFile(v1Path, "utf-8");
    expect(v1Bytes).toBe(originalBytes);

    const cellFirst = firstPass.find((r) => r.fixture === "abandoned-no-reversal" && r.arm === "oracle" && r.repeat === 3)!;
    const cellSecond = secondPass.find((r) => r.fixture === "abandoned-no-reversal" && r.arm === "oracle" && r.repeat === 3)!;
    expect(cellFirst.oldPass).toBe(false);
    // Without reading oldPass from the validated backup, a second pass
    // would compare the (already-rescored, now-passing) primary against
    // itself and report oldPass=true -- silently hiding the real change.
    expect(cellSecond.oldPass).toBe(false);
    expect(cellSecond.newPass).toBe(true);
  });

  it("fsyncs the backup's directory on the existing-backup path too, before the primary is replaced (not only when this pass's own link created the backup)", async () => {
    const outputRoot = await makeTempDir();
    await writeRecord(
      outputRoot,
      seededRecord({
        fixture: "abandoned-no-reversal",
        arm: "oracle",
        repeat: 1,
        transcript: "T-5002 is next; day5 recorded T-5001 as abandoned.",
        score: { pass: false, namedCorrectAlternative: true, citedDecisiveHandover: false, reason: "original" },
      }),
    );
    await rescoreOutputRoot(outputRoot); // first pass publishes the backup

    const dir = join(outputRoot, "abandoned-no-reversal", "oracle");
    const events: Array<{ kind: "open-dir" | "rename"; path: string }> = [];
    const realOpen = fsPromises.open;
    const realRename = fsPromises.rename;
    const openSpy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args: Parameters<typeof realOpen>) => {
      if (args[0] === dir && args[1] === "r") events.push({ kind: "open-dir", path: String(args[0]) });
      return realOpen(...(args as Parameters<typeof realOpen>));
    });
    const renameSpy = vi.spyOn(fsPromises, "rename").mockImplementation(async (...args: Parameters<typeof realRename>) => {
      events.push({ kind: "rename", path: String(args[1]) });
      return realRename(...(args as Parameters<typeof realRename>));
    });

    try {
      // Second pass: the backup already exists (publishOnce takes the
      // EEXIST branch), which is exactly the path that used to skip the
      // directory fsync entirely.
      await rescoreOutputRoot(outputRoot);
    } finally {
      openSpy.mockRestore();
      renameSpy.mockRestore();
    }

    const openDirIndex = events.findIndex((e) => e.kind === "open-dir");
    const renameIndex = events.findIndex((e) => e.kind === "rename");
    expect(openDirIndex).toBeGreaterThanOrEqual(0);
    expect(renameIndex).toBeGreaterThanOrEqual(0);
    expect(openDirIndex).toBeLessThan(renameIndex);
  });

  it("aborts rather than overwrite the primary when an existing .v1 backup is corrupt (not valid JSON)", async () => {
    const outputRoot = await makeTempDir();
    const { path } = await writeRecord(
      outputRoot,
      seededRecord({
        fixture: "abandoned-no-reversal",
        arm: "oracle",
        repeat: 5,
        transcript: "T-5002 is next; day5 recorded T-5001 as abandoned.",
        score: { pass: false, namedCorrectAlternative: true, citedDecisiveHandover: false, reason: "original" },
      }),
    );
    const v1Path = join(outputRoot, "abandoned-no-reversal", "oracle", "repeat-5.v1.json");
    await writeFile(v1Path, "{ this is not valid json", "utf-8");
    const primaryBefore = await readFile(path, "utf-8");

    await expect(rescoreOutputRoot(outputRoot)).rejects.toThrow(/not valid JSON/);

    // The primary record must be untouched -- a corrupt backup means we
    // never had a trustworthy original to compare against, so the primary
    // (still holding the pre-rescore data) must not be overwritten.
    const primaryAfter = await readFile(path, "utf-8");
    expect(primaryAfter).toBe(primaryBefore);
  });

  it("aborts rather than overwrite the primary when an existing .v1 backup belongs to a different cell", async () => {
    const outputRoot = await makeTempDir();
    const { path } = await writeRecord(
      outputRoot,
      seededRecord({
        fixture: "abandoned-no-reversal",
        arm: "oracle",
        repeat: 4,
        transcript: "T-5002 is next; day5 recorded T-5001 as abandoned.",
        score: { pass: false, namedCorrectAlternative: true, citedDecisiveHandover: false, reason: "original" },
      }),
    );
    const v1Path = join(outputRoot, "abandoned-no-reversal", "oracle", "repeat-4.v1.json");
    // A backup that parses fine but names the wrong cell entirely.
    await writeFile(v1Path, JSON.stringify(seededRecord({ fixture: "deferred-item", arm: "oracle", repeat: 1 })), "utf-8");
    const primaryBefore = await readFile(path, "utf-8");

    await expect(rescoreOutputRoot(outputRoot)).rejects.toThrow(/does not match the expected cell/);

    const primaryAfter = await readFile(path, "utf-8");
    expect(primaryAfter).toBe(primaryBefore);
  });

  it("aborts rather than overwrite the primary when an existing .v1 backup names the right cell but is incomplete (no transcript/score/cli)", async () => {
    const outputRoot = await makeTempDir();
    const { path } = await writeRecord(
      outputRoot,
      seededRecord({
        fixture: "abandoned-no-reversal",
        arm: "oracle",
        repeat: 2,
        transcript: "T-5002 is next; day5 recorded T-5001 as abandoned.",
        score: { pass: false, namedCorrectAlternative: true, citedDecisiveHandover: false, reason: "original" },
      }),
    );
    const v1Path = join(outputRoot, "abandoned-no-reversal", "oracle", "repeat-2.v1.json");
    // Right fixture/arm/repeat/status, but none of the fields that would
    // actually make it a recoverable original -- no transcript, score, or
    // cli. Round 5's check (fixture/arm/repeat/status only) would have
    // accepted this.
    await writeFile(
      v1Path,
      JSON.stringify({ fixture: "abandoned-no-reversal", arm: "oracle", repeat: 2, status: "completed" }),
      "utf-8",
    );
    const primaryBefore = await readFile(path, "utf-8");

    await expect(rescoreOutputRoot(outputRoot)).rejects.toThrow(/does not match the expected cell/);

    const primaryAfter = await readFile(path, "utf-8");
    expect(primaryAfter).toBe(primaryBefore);
  });

  it("still rejects a bare quote of the abandonment reasoning with no date/day-label/filename attribution", async () => {
    const outputRoot = await makeTempDir();
    await writeRecord(
      outputRoot,
      seededRecord({
        fixture: "abandoned-no-reversal",
        arm: "oracle",
        repeat: 4,
        transcript:
          "T-5002 is next. The report templates work was abandoned in favor of hand-writing the templates instead, because legal confirmed the license terms are incompatible with how we ship.",
        score: { pass: false, namedCorrectAlternative: true, citedDecisiveHandover: false, reason: "no citation" },
      }),
    );
    const results = await rescoreOutputRoot(outputRoot);
    const cell = results.find((r) => r.fixture === "abandoned-no-reversal" && r.arm === "oracle" && r.repeat === 4)!;
    expect(cell.oldPass).toBe(false);
    expect(cell.newPass).toBe(false);
  });

  it("leaves cli cost/session metadata and wallMs untouched", async () => {
    const outputRoot = await makeTempDir();
    await writeRecord(
      outputRoot,
      seededRecord({
        fixture: "deferred-item",
        arm: "oracle",
        repeat: 1,
        transcript: "T-3002 is next, the CSV export quick action.",
        score: { pass: true, namedCorrectAlternative: true, citedDecisiveHandover: true, reason: "already passing" },
        cli: { total_cost_usd: 0.1234, usage: { input_tokens: 9 }, session_id: "real-session-id", num_turns: 3 },
        wallMs: 54321,
      }),
    );
    await rescoreOutputRoot(outputRoot);
    const onDisk = JSON.parse(
      await readFile(join(outputRoot, "deferred-item", "oracle", "repeat-1.json"), "utf-8"),
    ) as SessionRecord;
    expect(onDisk.cli).toEqual({ total_cost_usd: 0.1234, usage: { input_tokens: 9 }, session_id: "real-session-id", num_turns: 3 });
    expect(onDisk.wallMs).toBe(54321);
  });

  it("passes a failed (killed) record through unchanged -- no transcript to rescore", async () => {
    const outputRoot = await makeTempDir();
    await writeRecord(
      outputRoot,
      seededRecord({
        fixture: "deferred-item",
        arm: "brief",
        repeat: 1,
        status: "failed",
        transcript: undefined,
        score: undefined,
        error: "simulated kill",
        killKind: "external-kill",
      }),
    );
    const results = await rescoreOutputRoot(outputRoot);
    const cell = results.find((r) => r.fixture === "deferred-item" && r.arm === "brief" && r.repeat === 1)!;
    expect(cell.oldPass).toBe(false);
    expect(cell.newPass).toBe(false);
    const onDisk = JSON.parse(
      await readFile(join(outputRoot, "deferred-item", "brief", "repeat-1.json"), "utf-8"),
    ) as SessionRecord;
    expect(onDisk.status).toBe("failed");
    expect(onDisk.error).toBe("simulated kill");
  });

  it("skips cells with no persisted record on disk rather than throwing (a partial output root is valid input)", async () => {
    const outputRoot = await makeTempDir();
    await writeRecord(
      outputRoot,
      seededRecord({
        fixture: "deferred-item",
        arm: "oracle",
        repeat: 1,
        transcript: "T-3002 is next.",
        score: { pass: true, namedCorrectAlternative: true, citedDecisiveHandover: true, reason: "ok" },
      }),
    );
    const results = await rescoreOutputRoot(outputRoot);
    expect(results).toHaveLength(1);
  });
});

describe("formatReport", () => {
  it("reports old vs new pass/fail per cell and the per-fixture-per-arm verdict against 4-of-5, plus total cost", () => {
    const results: RescoreCellResult[] = [
      { fixture: "abandoned-no-reversal", arm: "oracle", repeat: 1, oldPass: false, newPass: true, cost: 0.1 },
      { fixture: "abandoned-no-reversal", arm: "oracle", repeat: 2, oldPass: true, newPass: true, cost: 0.05 },
      { fixture: "abandoned-no-reversal", arm: "oracle", repeat: 3, oldPass: false, newPass: true, cost: 0.05 },
      { fixture: "abandoned-no-reversal", arm: "oracle", repeat: 4, oldPass: false, newPass: true, cost: 0.05 },
      { fixture: "abandoned-no-reversal", arm: "oracle", repeat: 5, oldPass: false, newPass: false, cost: 0.05 },
    ];
    const report = formatReport(results);
    expect(report).toContain("abandoned-no-reversal");
    expect(report).toContain("old 1/5");
    expect(report).toContain("new 4/5");
    expect(report).toMatch(/verdict.*PASS/i);
    expect(report).toContain("0.3000");
  });

  it("reports a FAIL verdict when the new pass count is still below 4-of-5", () => {
    const results: RescoreCellResult[] = [
      { fixture: "abandoned-intermediate-reversal", arm: "oracle", repeat: 1, oldPass: false, newPass: false, cost: 0.1 },
      { fixture: "abandoned-intermediate-reversal", arm: "oracle", repeat: 2, oldPass: false, newPass: true, cost: 0.1 },
      { fixture: "abandoned-intermediate-reversal", arm: "oracle", repeat: 3, oldPass: false, newPass: false, cost: 0.1 },
      { fixture: "abandoned-intermediate-reversal", arm: "oracle", repeat: 4, oldPass: false, newPass: false, cost: 0.1 },
      { fixture: "abandoned-intermediate-reversal", arm: "oracle", repeat: 5, oldPass: false, newPass: false, cost: 0.1 },
    ];
    const report = formatReport(results);
    expect(report).toMatch(/verdict.*FAIL/i);
  });
});
