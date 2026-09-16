/**
 * T-498 5c: the real dispatcher plus the sequential run orchestrator.
 *
 * Wired only after explicit owner authorization (see the pen's ruling on
 * T-498, relayed 2026-09-12: 40 sessions, claude-sonnet-5 on both arms,
 * strictly sequential). Launches one real `claude -p` session per
 * (fixture, arm, repeat) cell -- subscription auth only, no tool access
 * (--restricted, a fixed isolated working directory with no `.story/`),
 * one at a time. Every session's result is written to disk atomically
 * before the next one starts, so a kill mid-run loses at most the one
 * in-flight session, and re-running with the same output root skips every
 * cell already validated as completed for the SAME model.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, open, rename } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIXTURES,
  captureInvocationBundle,
  renderPromptForBundle,
  scoreTranscript,
  type Arm,
  type FixtureSpec,
  type ScoreResult,
} from "./behavioral-gate.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const SKILL_PATH = resolve(SCRIPT_DIR, "../src/skill/SKILL.md");
export const REPEATS = 5;
export const ARMS: readonly Arm[] = ["oracle", "brief"];
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_SIGKILL_GRACE_MS = 10_000;
export const DEFAULT_OUTPUT_ROOT = resolve(SCRIPT_DIR, "../.5c-run-output");

/**
 * Env vars that would divert auth away from the authorized subscription
 * path (API key, or a third-party provider such as Bedrock/Vertex). This
 * list is a disclosed best effort, not an exhaustive guarantee -- it
 * covers the variables this codebase and Claude Code itself are known to
 * read; a genuinely unknown alternate-auth mechanism would not be caught.
 */
export const ALTERNATE_AUTH_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
] as const;

/**
 * Refuses to proceed if the PARENT process's own environment already has
 * an alternate-auth variable set -- fail fast and visibly rather than
 * silently overriding what may be a real, deliberate configuration on this
 * machine. Stripping happens separately, in the child's env only.
 */
export function assertSubscriptionAuthOnly(env: NodeJS.ProcessEnv = process.env): void {
  const present = ALTERNATE_AUTH_ENV_VARS.filter((name) => env[name] !== undefined);
  if (present.length > 0) {
    throw new Error(
      `behavioral-gate-run: refusing to start -- subscription auth is required for the 5c run, but these env vars are set: ${present.join(", ")}. Unset them (they would divert billing away from the authorized subscription path) before running.`,
    );
  }
}

export interface ClaudeCliResult {
  readonly result: string;
  readonly is_error: boolean;
  readonly subtype: string;
  readonly total_cost_usd: number;
  readonly usage: unknown;
  readonly session_id: string;
  readonly num_turns: number;
}

function isClaudeCliResult(value: unknown): value is ClaudeCliResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.result === "string" &&
    typeof v.is_error === "boolean" &&
    typeof v.subtype === "string" &&
    typeof v.total_cost_usd === "number" &&
    typeof v.session_id === "string" &&
    typeof v.num_turns === "number"
  );
}

/**
 * "timeout" is our own SIGTERM-then-SIGKILL escalation. "external-kill" is
 * an unrequested SIGKILL we did not send -- most plausibly the OS's OOM
 * killer on a swap-pressured machine, but SIGKILL alone cannot prove that
 * (an operator, a supervisor, or a container runtime could also send it),
 * so it is labelled honestly rather than asserted as confirmed OOM. Only
 * "external-kill" is retried (once, then stop-on-two-in-a-row); a plain
 * "timeout" is recorded as a failure and the run moves on without retrying it.
 */
export type SpawnKillKind = "timeout" | "external-kill";

export class SessionKilledError extends Error {
  constructor(
    public readonly kind: SpawnKillKind,
    message: string,
  ) {
    super(message);
  }
}

export class RecordPersistenceError extends Error {}

export interface DispatchResult {
  readonly transcript: string;
  readonly cli: ClaudeCliResult;
}

export type SpawnFn = (command: string, args: readonly string[], options: Record<string, unknown>) => ChildProcess;

/**
 * Real dispatcher: headless `claude -p`, subscription auth only (every
 * variable in ALTERNATE_AUTH_ENV_VARS is stripped from the child's env
 * even if set on the parent -- defense in depth alongside
 * assertSubscriptionAuthOnly's fail-fast check), the given model pinned
 * explicitly, no tool access (--restricted), no session persistence, run
 * from a fixed isolated cwd with no `.story/` so there is nothing to
 * explore even if a tool call slipped through. On timeout, SIGTERM is
 * sent first; if the child has not exited after `sigkillGraceMs`, SIGKILL
 * follows, and the outcome is still classified "timeout" (not
 * "external-kill") because we sent both signals ourselves. `spawnFn` is
 * injected so every path is unit-testable without ever invoking the real
 * CLI.
 */
/** Node's setTimeout silently fires almost immediately above this (a 32-bit signed ms count); a caller-supplied timeout past it would turn into a near-instant timeout on every session instead of a visible error. */
const MAX_TIMER_MS = 2_147_483_647;

function assertValidTimerMs(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new Error(`behavioral-gate-run: ${label} must be a positive integer <= ${MAX_TIMER_MS}ms, got ${value}`);
  }
}

export function createClaudeCliDispatcher(opts: {
  readonly timeoutMs: number;
  readonly isolatedCwd: string;
  readonly sigkillGraceMs?: number;
  readonly spawnFn?: SpawnFn;
}): (prompt: string, model: string) => Promise<DispatchResult> {
  assertSubscriptionAuthOnly();
  assertValidTimerMs(opts.timeoutMs, "timeoutMs");
  const sigkillGraceMs = opts.sigkillGraceMs ?? DEFAULT_SIGKILL_GRACE_MS;
  assertValidTimerMs(sigkillGraceMs, "sigkillGraceMs");
  const spawnFn = opts.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
  return (prompt: string, model: string) =>
    new Promise<DispatchResult>((resolvePromise, reject) => {
      const env = { ...process.env };
      for (const name of ALTERNATE_AUTH_ENV_VARS) delete env[name];
      const child = spawnFn(
        "claude",
        [
          "-p",
          prompt,
          "--model",
          model,
          "--output-format",
          "json",
          "--permission-mode",
          "dontAsk",
          "--restricted",
          "--no-session-persistence",
          "--disable-slash-commands",
        ],
        { cwd: opts.isolatedCwd, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const termTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), sigkillGraceMs);
      }, opts.timeoutMs);
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf-8")));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf-8")));
      child.on("error", (err) => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        reject(err);
      });
      child.on("close", (code, signal) => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        if (timedOut) {
          reject(new SessionKilledError("timeout", `claude -p timed out after ${opts.timeoutMs}ms`));
          return;
        }
        if (signal === "SIGKILL") {
          reject(
            new SessionKilledError(
              "external-kill",
              `claude -p terminated by an unrequested SIGKILL (not our own timeout escalation) -- most likely the OS OOM killer, but not confirmed`,
            ),
          );
          return;
        }
        if (code !== 0) {
          reject(new Error(`claude -p exited ${code} (signal ${signal}): ${stderr.slice(0, 2000)}`));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch (err) {
          reject(new Error(`claude -p produced non-JSON stdout: ${(err as Error).message}: ${stdout.slice(0, 500)}`));
          return;
        }
        if (!isClaudeCliResult(parsed)) {
          reject(new Error(`claude -p produced JSON with an unexpected shape: ${stdout.slice(0, 500)}`));
          return;
        }
        if (parsed.is_error) {
          reject(new Error(`claude -p reported is_error (subtype ${parsed.subtype}): ${stdout.slice(0, 2000)}`));
          return;
        }
        resolvePromise({ transcript: parsed.result, cli: parsed });
      });
    });
}

export interface SessionRecord {
  readonly fixture: string;
  readonly arm: Arm;
  readonly repeat: number;
  readonly model: string;
  readonly status: "completed" | "failed";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly wallMs: number;
  readonly promptBytes: number;
  readonly transcript?: string;
  readonly score?: ScoreResult;
  readonly cli?: { readonly total_cost_usd: number; readonly usage: unknown; readonly session_id: string; readonly num_turns: number };
  readonly error?: string;
  readonly killKind?: SpawnKillKind;
}

function recordPath(outputRoot: string, fixture: string, arm: Arm, repeat: number): string {
  return join(outputRoot, fixture, arm, `repeat-${repeat}.json`);
}

/** Runtime validation, not just a type assertion -- a malformed, partial, or wrong-model record must never be treated as a valid completed cell. Includes `cli`: a resumed record's cost feeds directly into the final cost total and summarizeFixture's `.toFixed()` call, so malformed or missing CLI metadata must not be silently accepted. */
function isValidCompletedRecord(
  value: unknown,
  expected: { readonly fixture: string; readonly arm: Arm; readonly repeat: number; readonly model: string },
): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (
    !(
      r.status === "completed" &&
      r.fixture === expected.fixture &&
      r.arm === expected.arm &&
      r.repeat === expected.repeat &&
      r.model === expected.model &&
      typeof r.transcript === "string" &&
      typeof r.wallMs === "number" &&
      typeof r.promptBytes === "number" &&
      typeof r.startedAt === "string" &&
      typeof r.finishedAt === "string" &&
      typeof r.score === "object" &&
      r.score !== null &&
      typeof (r.score as Record<string, unknown>).pass === "boolean"
    )
  ) {
    return false;
  }
  const cli = r.cli as Record<string, unknown> | undefined;
  return (
    typeof cli === "object" &&
    cli !== null &&
    typeof cli.total_cost_usd === "number" &&
    Number.isFinite(cli.total_cost_usd) &&
    cli.total_cost_usd >= 0 &&
    typeof cli.session_id === "string" &&
    typeof cli.num_turns === "number" &&
    Number.isInteger(cli.num_turns) &&
    cli.num_turns >= 0
  );
}

/**
 * Returns the parsed record if the path holds a valid completed record for
 * this exact cell/model; null if the path is absent, or holds truncated
 * JSON or a record that fails validation (both cases simply rerun the
 * cell). Any OTHER read error (permissions, I/O) is NOT treated as
 * "incomplete" -- it propagates, since guessing "rerun it" on a read
 * failure could pay for a new session and then overwrite a record we
 * simply failed to read, silently destroying a real completed result.
 */
async function readRecordIfCompleted(
  path: string,
  expected: { readonly fixture: string; readonly arm: Arm; readonly repeat: number; readonly model: string },
): Promise<SessionRecord | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Truncated or otherwise malformed -- treat as not completed rather
    // than aborting resume; the cell is simply rerun.
    return null;
  }
  return isValidCompletedRecord(parsed, expected) ? (parsed as SessionRecord) : null;
}

/**
 * Writes the record to a unique temp file in the destination directory,
 * fsyncs the file descriptor, then atomically renames it into place, so a
 * kill mid-write can never leave a truncated/partial record at the real
 * path. Best-effort directory fsync follows (some filesystems do not
 * support it; failure there is not fatal, the file itself is already
 * durable and atomically named).
 */
async function writeRecordAtomic(path: string, record: SessionRecord): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(JSON.stringify(record, null, 2), "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, path);
  try {
    const dirHandle = await open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Best effort only -- not every filesystem supports fsync on a directory.
  }
}

/** Persists a record or throws RecordPersistenceError -- never silently drops a session's result. */
async function persistRecord(path: string, record: SessionRecord): Promise<void> {
  try {
    await writeRecordAtomic(path, record);
  } catch (err) {
    throw new RecordPersistenceError(`failed to persist session record at ${path}: ${(err as Error).message}`);
  }
}

export interface RunOneCellDeps {
  readonly dispatch: (prompt: string, model: string) => Promise<DispatchResult>;
  readonly skillPath: string;
}

/**
 * Runs exactly one (fixture, arm, repeat) cell -- capture, render,
 * dispatch, score, persist. Never retries internally; the caller
 * (runMatrix) owns the one-retry-on-external-kill policy. A
 * RecordPersistenceError is never converted into a normal failed session
 * -- it always propagates as-is, since a run that cannot persist results
 * must not keep spending on sessions it cannot record.
 */
export async function runOneCell(
  fixture: FixtureSpec,
  arm: Arm,
  repeat: number,
  model: string,
  outputRoot: string,
  deps: RunOneCellDeps,
): Promise<SessionRecord> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const path = recordPath(outputRoot, fixture.name, arm, repeat);
  let prompt = "";
  try {
    const bundle = await captureInvocationBundle(fixture, arm, deps.skillPath);
    prompt = renderPromptForBundle(bundle);
    const { transcript, cli } = await deps.dispatch(prompt, model);
    const score = scoreTranscript(transcript, fixture);
    const record: SessionRecord = {
      fixture: fixture.name,
      arm,
      repeat,
      model,
      status: "completed",
      startedAt,
      finishedAt: new Date().toISOString(),
      wallMs: Date.now() - started,
      promptBytes: Buffer.byteLength(prompt, "utf-8"),
      transcript,
      score,
      cli: { total_cost_usd: cli.total_cost_usd, usage: cli.usage, session_id: cli.session_id, num_turns: cli.num_turns },
    };
    await persistRecord(path, record);
    return record;
  } catch (err) {
    if (err instanceof RecordPersistenceError) throw err;
    const killKind = err instanceof SessionKilledError ? err.kind : undefined;
    const record: SessionRecord = {
      fixture: fixture.name,
      arm,
      repeat,
      model,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      wallMs: Date.now() - started,
      promptBytes: Buffer.byteLength(prompt, "utf-8"),
      error: (err as Error).message,
      ...(killKind ? { killKind } : {}),
    };
    await persistRecord(path, record);
    throw Object.assign(err as Error, { record });
  }
}

/**
 * Runs one cell, and if (and only if) it fails with an external kill
 * (SIGKILL we did not request), retries it exactly once. `doubleKill` is
 * true only when BOTH the original attempt and its one retry were
 * external-killed -- the specific "two consecutive kills" condition that
 * stops the whole run. A RecordPersistenceError always propagates
 * immediately, never retried, never absorbed into a SessionRecord.
 */
async function runCellWithOneRetry(
  fixture: FixtureSpec,
  arm: Arm,
  repeat: number,
  model: string,
  outputRoot: string,
  deps: RunOneCellDeps,
): Promise<{ record: SessionRecord; doubleKill: boolean }> {
  try {
    const record = await runOneCell(fixture, arm, repeat, model, outputRoot, deps);
    return { record, doubleKill: false };
  } catch (err) {
    if (err instanceof RecordPersistenceError) throw err;
    const killKind = (err as { record?: SessionRecord }).record?.killKind;
    if (killKind !== "external-kill") {
      return { record: (err as { record: SessionRecord }).record, doubleKill: false };
    }
    try {
      const record = await runOneCell(fixture, arm, repeat, model, outputRoot, deps);
      return { record, doubleKill: false };
    } catch (retryErr) {
      if (retryErr instanceof RecordPersistenceError) throw retryErr;
      const retryKillKind = (retryErr as { record?: SessionRecord }).record?.killKind;
      return {
        record: (retryErr as { record: SessionRecord }).record,
        doubleKill: retryKillKind === "external-kill",
      };
    }
  }
}

export interface MatrixOutcome {
  readonly records: readonly SessionRecord[];
  readonly stoppedEarly: boolean;
  readonly stopReason?: string;
}

export interface RunMatrixOpts {
  readonly model: string;
  readonly outputRoot: string;
  readonly dispatch: (prompt: string, model: string) => Promise<DispatchResult>;
  readonly skillPath: string;
  readonly onFixtureComplete?: (fixture: string, records: readonly SessionRecord[]) => void | Promise<void>;
}

/**
 * Sequential run over every (fixture, arm, repeat) cell -- resumable
 * (skips cells already validated as completed, for the SAME model, on
 * disk) and one-live-session-at-a-time by construction (no parallel
 * dispatch). An external kill (SIGKILL we did not send) is retried once
 * for that same cell; if the retry is ALSO externally killed (two
 * consecutive kills on the same cell), the whole matrix stops, per the
 * pen's instruction. A RecordPersistenceError anywhere stops the matrix
 * immediately (propagates out of this function) -- results that cannot be
 * saved must not be followed by more paid sessions.
 */
export async function runMatrix(opts: RunMatrixOpts): Promise<MatrixOutcome> {
  const records: SessionRecord[] = [];
  for (const fixture of FIXTURES) {
    const fixtureRecords: SessionRecord[] = [];
    for (const arm of ARMS) {
      for (let repeat = 1; repeat <= REPEATS; repeat++) {
        const path = recordPath(opts.outputRoot, fixture.name, arm, repeat);
        const existing = await readRecordIfCompleted(path, { fixture: fixture.name, arm, repeat, model: opts.model });
        if (existing) {
          records.push(existing);
          fixtureRecords.push(existing);
          continue;
        }
        const { record, doubleKill } = await runCellWithOneRetry(fixture, arm, repeat, opts.model, opts.outputRoot, {
          dispatch: opts.dispatch,
          skillPath: opts.skillPath,
        });
        records.push(record);
        fixtureRecords.push(record);
        if (doubleKill) {
          return { records, stoppedEarly: true, stopReason: "two consecutive external kills (same cell, original + retry)" };
        }
      }
    }
    await opts.onFixtureComplete?.(fixture.name, fixtureRecords);
  }
  return { records, stoppedEarly: false };
}

function summarizeFixture(fixture: string, records: readonly SessionRecord[]): string {
  const lines: string[] = [`=== ${fixture} complete (${records.length} sessions) ===`];
  for (const arm of ARMS) {
    const armRecords = records.filter((r) => r.arm === arm);
    const passCount = armRecords.filter((r) => r.status === "completed" && r.score?.pass).length;
    const failCount = armRecords.length - passCount;
    lines.push(`  ${arm}: ${passCount}/${armRecords.length} passed, ${failCount} failed/errored`);
    for (const r of armRecords) {
      const outcome =
        r.status === "failed"
          ? `FAILED (${r.killKind ?? "error"}: ${r.error})`
          : r.score?.pass
            ? "pass"
            : `fail (${r.score?.reason})`;
      lines.push(`    repeat ${r.repeat}: ${outcome}, ${r.wallMs}ms${r.cli ? `, $${r.cli.total_cost_usd.toFixed(4)}` : ""}`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  assertSubscriptionAuthOnly();
  const model = process.env.BEHAVIORAL_GATE_MODEL ?? "claude-sonnet-5";
  const outputRoot = process.env.BEHAVIORAL_GATE_OUTPUT_ROOT ?? DEFAULT_OUTPUT_ROOT;
  const timeoutMs = process.env.BEHAVIORAL_GATE_TIMEOUT_MS
    ? Number(process.env.BEHAVIORAL_GATE_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  const isolatedCwd = join(outputRoot, "_isolated-cwd");
  await mkdir(isolatedCwd, { recursive: true });

  console.log(`T-498 5c run starting: model=${model}, outputRoot=${outputRoot}, timeoutMs=${timeoutMs}`);
  const dispatch = createClaudeCliDispatcher({ timeoutMs, isolatedCwd });
  const outcome = await runMatrix({
    model,
    outputRoot,
    dispatch,
    skillPath: SKILL_PATH,
    onFixtureComplete: (fixture, records) => {
      console.log(summarizeFixture(fixture, records));
    },
  });

  const totalCost = outcome.records.reduce((sum, r) => sum + (r.cli?.total_cost_usd ?? 0), 0);
  console.log(`\nRun ${outcome.stoppedEarly ? `STOPPED EARLY (${outcome.stopReason})` : "complete"}.`);
  console.log(`Total sessions recorded: ${outcome.records.length}. Total cost (from CLI-reported usage): $${totalCost.toFixed(4)}`);
  console.log(`Records written under: ${outputRoot}`);

  if (outcome.stoppedEarly) process.exitCode = 1;
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
