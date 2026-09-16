/**
 * T-499: process era -- the identity of the Claude Code PROCESS this
 * storybloq invocation belongs to.
 *
 * Why a process, not a session: `autoCompactWindow` is read when the Claude
 * Code process starts. Compaction and `/clear` keep the process (and the
 * setting) and `--resume` starts a new one, so the setting's provenance is
 * the process, and a session id (which survives `--resume`) cannot carry it.
 *
 * Hooks, the CLI and the MCP server all inherit `CLAUDE_PID`, so all three
 * compute the same era for one client process. The start time comes from
 * `ps`, run under `LC_ALL=C TZ=UTC` so the id is locale- and zone-
 * independent; precision is one second, which is this identifier's
 * documented limit.
 *
 * LIVENESS IS TRI-STATE and only `ended` closes anything. A `ps` that timed
 * out or failed to spawn proves nothing about the process, and a transient
 * failure must not permanently strip a live session of its capture.
 */

import { spawnSync } from "node:child_process";

export interface ProcessEra {
  readonly pid: number;
  /** ISO, second precision. */
  readonly startedAt: string;
  /** `<pid>:<epochSeconds>`; the provenance key everywhere. */
  readonly id: string;
}

export type ProcessCheck = "live" | "ended" | "unverifiable";

/** One `ps` invocation, replaceable in tests. Returns stdout, or null on timeout/spawn failure/non-zero exit with no output. */
export type PsRunner = (args: readonly string[]) => string | null;

export const PS_TIMEOUT_MS = 200;
/** A revalidation result is trusted for this long; `ended` is never un-ended. */
export const REVALIDATION_MEMO_MS = 5_000;

const ERA_ID = /^([1-9][0-9]{0,9}):([1-9][0-9]{0,12})$/;

export const defaultPsRunner: PsRunner = (args) => {
  try {
    const result = spawnSync("ps", [...args], {
      timeout: PS_TIMEOUT_MS,
      encoding: "utf-8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error) return null;
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    // Exit 0 with rows is the live answer. `ps -p <pid>` exits 1 with EMPTY
    // output when no listed pid exists: that is the one documented "no such
    // process" answer and is returned as "". Anything else (a signal-killed
    // ps has status null; exit 1 WITH output, or any other status, is an
    // operational failure) proves nothing about the process: unverifiable.
    if (result.status === 0) return stdout;
    if (result.status === 1 && stdout.trim().length === 0) return "";
    return null;
  } catch {
    return null;
  }
};

/**
 * Parses `ps -o lstart=` output ("Wed Sep  9 12:15:15 2026" under LC_ALL=C)
 * into epoch seconds. The child ran with TZ=UTC, so the wall clock printed is
 * UTC and " UTC" is appended before parsing so THIS process's zone plays no
 * part. Null on anything unparseable.
 */
export function parseLstart(text: string): number | null {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0 || trimmed.length > 40) return null;
  const ms = Date.parse(`${trimmed} UTC`);
  if (!Number.isFinite(ms)) return null;
  const seconds = Math.floor(ms / 1000);
  return seconds > 0 ? seconds : null;
}

export function parseClaudePid(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,9}$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function eraIdFor(pid: number, startedSeconds: number): string {
  return `${pid}:${startedSeconds}`;
}

export function parseEraId(id: string): { pid: number; startedSeconds: number } | null {
  const m = ERA_ID.exec(id);
  if (!m) return null;
  return { pid: Number(m[1]), startedSeconds: Number(m[2]) };
}

/** Start time of one pid via ps, in epoch seconds; `"ended"` when ps answered "no such process"; null when unverifiable. */
export function probeStart(pid: number, run: PsRunner): number | "ended" | null {
  const out = run(["-p", String(pid), "-o", "lstart="]);
  if (out === null) return null;
  if (out.trim().length === 0) return "ended";
  // Output that is not a start time is not evidence either way.
  return parseLstart(out) ?? null;
}

/**
 * Batched form for the era sweep: one `ps` for many pids. A pid absent from
 * WELL-FORMED output is `"ended"`; when ps fails, or any output line cannot
 * be read as `<pid> <lstart>`, the output is not evidence of anything and
 * every pid is null (unverifiable). Absence is only proof when the whole
 * answer was understood.
 */
export function probeStarts(pids: readonly number[], run: PsRunner): ReadonlyMap<number, number | "ended" | null> {
  const result = new Map<number, number | "ended" | null>();
  if (pids.length === 0) return result;
  const out = run(["-p", pids.join(","), "-o", "pid=,lstart="]);
  const unverifiable = (): typeof result => {
    for (const pid of pids) result.set(pid, null);
    return result;
  };
  if (out === null) return unverifiable();
  const seen = new Map<number, number>();
  for (const line of out.split("\n")) {
    if (line.trim().length === 0) continue;
    const m = /^\s*([0-9]+)\s+(.+)$/.exec(line);
    if (!m) return unverifiable();
    const started = parseLstart(m[2]!);
    if (started === null) return unverifiable();
    seen.set(Number(m[1]), started);
  }
  for (const pid of pids) result.set(pid, seen.get(pid) ?? "ended");
  return result;
}

interface Memo {
  readonly at: number;
  readonly check: ProcessCheck;
}

/**
 * The per-process era resolver. One instance per process (the default
 * export below); constructible for tests with an injected runner, env and
 * clock.
 */
export class ProcessEraResolver {
  private era: ProcessEra | null | undefined;
  private memo: Memo | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly run: PsRunner = defaultPsRunner,
    private readonly now: () => number = Date.now,
  ) {}

  /** Cached per process. Null when `CLAUDE_PID` is absent/malformed or the start time cannot be established. */
  current(): ProcessEra | null {
    if (this.era !== undefined) return this.era;
    const pid = parseClaudePid(this.env.CLAUDE_PID);
    if (pid === null) {
      this.era = null;
      return null;
    }
    const started = probeStart(pid, this.run);
    if (typeof started !== "number") {
      // Not cached: a transient ps failure at startup must not brand the whole
      // process era-less. The next call tries again.
      return null;
    }
    this.era = { pid, startedAt: new Date(started * 1000).toISOString(), id: eraIdFor(pid, started) };
    return this.era;
  }

  /**
   * Revalidates the cached era before an identity-sensitive side effect.
   * `live` only when ps reports the same pid with the SAME start time; a
   * different start time is pid reuse and reads as `ended`.
   */
  revalidate(): ProcessCheck {
    const era = this.current();
    if (era === null) return "unverifiable";
    const t = this.now();
    if (this.memo && (this.memo.check === "ended" || t - this.memo.at < REVALIDATION_MEMO_MS)) return this.memo.check;
    const check = checkEra(era.id, this.run);
    this.memo = { at: t, check };
    return check;
  }

  /** Test seam: forget everything, as a fresh process would. */
  reset(): void {
    this.era = undefined;
    this.memo = null;
  }
}

/** Liveness of an arbitrary era id (the sweep's per-entry check). */
export function checkEra(eraId: string, run: PsRunner): ProcessCheck {
  const parsed = parseEraId(eraId);
  if (!parsed) return "ended";
  const started = probeStart(parsed.pid, run);
  if (started === null) return "unverifiable";
  if (started === "ended") return "ended";
  return started === parsed.startedSeconds ? "live" : "ended";
}

export const processEra = new ProcessEraResolver();
