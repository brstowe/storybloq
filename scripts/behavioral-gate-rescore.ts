/**
 * T-498 5c re-score: rewrites the persisted records' scores under the
 * widened citedDecisiveHandover rule (pen ruling, 2026-09-13, after the
 * real 40-session run showed every "did not cite" failure had actually
 * named the decisive handover by date or day label, never the literal
 * filename). No live session runs here -- this only re-derives ScoreResult
 * from each record's already-persisted transcript and rewrites the score,
 * leaving the transcript and CLI metadata untouched. The pre-rescore
 * record is preserved alongside (a `.v1.json` sibling) so the old result
 * stays auditable: this widens the rubric after seeing results, and that
 * fact must stay visible rather than be silently overwritten.
 *
 * These are real paid-session records with no other copy -- both the
 * primary rewrite and the backup publish are atomic (temp file, fsync,
 * then rename/link into place), and an existing backup is validated
 * before the primary is touched. If the backup is unreadable or
 * malformed, this aborts rather than risk overwriting the only correct
 * copy without a trustworthy original to fall back on.
 */
import { readFile, open, rename, link, unlink } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURES, scoreTranscript, type Arm } from "./behavioral-gate.js";
import { ARMS, REPEATS, DEFAULT_OUTPUT_ROOT, type SessionRecord } from "./behavioral-gate-run.js";

export interface RescoreCellResult {
  readonly fixture: string;
  readonly arm: Arm;
  readonly repeat: number;
  readonly oldPass: boolean;
  readonly newPass: boolean;
  readonly cost: number;
}

function v1Path(recordPath: string): string {
  return recordPath.replace(/\.json$/, ".v1.json");
}

async function writeTempThenFsync(dir: string, prefix: string, contents: string): Promise<string> {
  const tmpPath = join(dir, `.${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(contents, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return tmpPath;
}

/**
 * Fsyncs the directory entry itself, not just the file's bytes -- a
 * rename/link is only durable across a crash once the directory that
 * names it has also been synced. Genuine failures (permissions, I/O)
 * propagate; only the specific "this filesystem does not support
 * directory fsync" errors are treated as non-fatal, and even then only
 * after actually attempting the sync, not assumed in advance.
 */
async function fsyncDir(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOTSUP" && code !== "EINVAL") throw err;
  } finally {
    await handle.close();
  }
}

/** Atomically replaces `path`'s contents -- a kill mid-write can never leave a truncated primary record, and the rename is fsynced into its directory so it survives a crash, not just a clean exit. */
async function writeFileAtomicReplace(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  const tmpPath = await writeTempThenFsync(dir, "tmp", contents);
  await rename(tmpPath, path);
  await fsyncDir(dir);
}

/**
 * Publishes `contents` at `path` ONLY if nothing is there yet. The
 * existence check IS the publish attempt (a hard link into the final
 * name, which fails with EEXIST rather than silently overwriting) -- no
 * read-then-write gap for a second, concurrent invocation to race
 * through. The content is fully written and fsynced under a private temp
 * name before it is ever linked to the public name, so a reader can never
 * observe a partially-written backup. The directory is fsynced before
 * returning EITHER outcome, not only "created" -- a caller that reads the
 * backup back and then replaces the primary must never do so before the
 * backup's directory entry (whichever invocation created it) is itself
 * durable, and an earlier invocation's own sync could have failed or not
 * yet run.
 */
async function publishOnce(path: string, contents: string): Promise<"created" | "already-exists"> {
  const dir = dirname(path);
  const tmpPath = await writeTempThenFsync(dir, "tmp-backup", contents);
  let outcome: "created" | "already-exists";
  try {
    await link(tmpPath, path);
    outcome = "created";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    outcome = "already-exists";
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
  await fsyncDir(dir);
  return outcome;
}

/**
 * A backup is trustworthy only if it is a COMPLETE completed-session
 * record for the SAME session as the current primary -- matching
 * fixture/arm/repeat alone (round 4's check) is not enough: an object
 * with only those three fields plus a `status` string would pass that
 * check while carrying no real transcript, score, or CLI metadata to
 * recover. Cross-checking transcript, model, and the CLI session_id
 * against the primary proves this is genuinely the same session's
 * pre-rescore snapshot, not merely a same-shaped record for the right
 * cell.
 */
function isPlausibleBackup(value: unknown, primary: SessionRecord): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  const score = r.score as Record<string, unknown> | undefined;
  const cli = r.cli as Record<string, unknown> | undefined;
  return (
    r.fixture === primary.fixture &&
    r.arm === primary.arm &&
    r.repeat === primary.repeat &&
    r.model === primary.model &&
    r.status === "completed" &&
    typeof r.transcript === "string" &&
    r.transcript === primary.transcript &&
    typeof score === "object" &&
    score !== null &&
    typeof score.pass === "boolean" &&
    typeof cli === "object" &&
    cli !== null &&
    typeof cli.session_id === "string" &&
    cli.session_id === primary.cli?.session_id
  );
}

/**
 * Re-scores every persisted record found under `outputRoot` for the four
 * fixtures/two arms/five repeats. A cell with no file on disk is skipped
 * (not an error) -- a partial output root is valid input, since a real
 * run may still be filling in. A failed/killed record (no transcript)
 * passes through unchanged; there is nothing to rescore.
 */
export async function rescoreOutputRoot(outputRoot: string): Promise<readonly RescoreCellResult[]> {
  const results: RescoreCellResult[] = [];
  for (const fixture of FIXTURES) {
    for (const arm of ARMS) {
      for (let repeat = 1; repeat <= REPEATS; repeat++) {
        const path = join(outputRoot, fixture.name, arm, `repeat-${repeat}.json`);
        let raw: string;
        try {
          raw = await readFile(path, "utf-8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw err;
        }
        const record = JSON.parse(raw) as SessionRecord;
        const cost = record.cli?.total_cost_usd ?? 0;

        if (record.status !== "completed" || typeof record.transcript !== "string") {
          // Nothing to rescore -- carry the old (or absent) verdict through unchanged.
          const oldPass = record.score?.pass ?? false;
          results.push({ fixture: fixture.name, arm, repeat, oldPass, newPass: oldPass, cost });
          continue;
        }

        // Publish the backup BEFORE touching the primary -- the primary
        // must never be overwritten while the only copy of its original
        // is still sitting in an unpublished temp file.
        const backupPath = v1Path(path);
        const publishResult = await publishOnce(backupPath, raw);

        let original: SessionRecord;
        if (publishResult === "created") {
          // This pass's primary, as read above, IS the pre-rescore original.
          original = record;
        } else {
          // A backup already existed (an earlier rescore pass) -- it holds
          // the TRUE original, which the current primary may no longer
          // reflect. Validate before trusting it: a corrupt or mismatched
          // backup here means aborting is safer than silently comparing
          // against the wrong "old" verdict or, worse, proceeding to
          // overwrite the primary with no trustworthy original at all.
          let backupRaw: string;
          try {
            backupRaw = await readFile(backupPath, "utf-8");
          } catch (err) {
            throw new Error(
              `behavioral-gate-rescore: existing backup at ${backupPath} could not be read, aborting: ${(err as Error).message}`,
            );
          }
          let backupParsed: unknown;
          try {
            backupParsed = JSON.parse(backupRaw);
          } catch (err) {
            throw new Error(
              `behavioral-gate-rescore: existing backup at ${backupPath} is not valid JSON, aborting rather than risk overwriting the primary without a trustworthy original: ${(err as Error).message}`,
            );
          }
          if (!isPlausibleBackup(backupParsed, record)) {
            throw new Error(
              `behavioral-gate-rescore: existing backup at ${backupPath} does not match the expected cell (fixture/arm/repeat/model/transcript/session id), aborting rather than trusting it as the original`,
            );
          }
          original = backupParsed;
        }

        const oldPass = original.score?.pass ?? false;
        const newScore = scoreTranscript(record.transcript, fixture);
        const updated: SessionRecord = { ...record, score: newScore };
        await writeFileAtomicReplace(path, JSON.stringify(updated, null, 2));

        results.push({ fixture: fixture.name, arm, repeat, oldPass, newPass: newScore.pass, cost });
      }
    }
  }
  return results;
}

const PASS_THRESHOLD = 4;

/** Old vs new pass/fail per cell, the per-fixture-per-arm verdict against 4-of-5, and total cost -- unchanged since rescoring never re-dispatches a session. */
export function formatReport(results: readonly RescoreCellResult[]): string {
  const lines: string[] = [];
  for (const fixture of FIXTURES) {
    const fixtureResults = results.filter((r) => r.fixture === fixture.name);
    if (fixtureResults.length === 0) continue;
    lines.push(`=== ${fixture.name} ===`);
    for (const arm of ARMS) {
      const cellResults = fixtureResults.filter((r) => r.arm === arm);
      if (cellResults.length === 0) continue;
      const oldPassCount = cellResults.filter((r) => r.oldPass).length;
      const newPassCount = cellResults.filter((r) => r.newPass).length;
      const verdict = newPassCount >= PASS_THRESHOLD ? "PASS" : "FAIL";
      lines.push(`  ${arm}: old ${oldPassCount}/${cellResults.length} -> new ${newPassCount}/${cellResults.length} -- verdict: ${verdict}`);
      for (const r of cellResults) {
        lines.push(`    repeat ${r.repeat}: old=${r.oldPass ? "pass" : "fail"} new=${r.newPass ? "pass" : "fail"}`);
      }
    }
  }
  const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
  lines.push("", `Total cost (unchanged -- from the original CLI-reported usage, no new sessions): $${totalCost.toFixed(4)}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const outputRoot = process.env.BEHAVIORAL_GATE_OUTPUT_ROOT ?? DEFAULT_OUTPUT_ROOT;
  const results = await rescoreOutputRoot(outputRoot);
  console.log(formatReport(results));
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
