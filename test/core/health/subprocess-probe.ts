/**
 * T-502 test seam: run a bounded read in a CHILD process under a deadline the
 * parent can actually enforce.
 *
 * The reads under test are synchronous. If `O_NONBLOCK` or the regular-file
 * check ever regresses, the read blocks the event loop, and a Vitest test
 * timeout is itself a timer on that loop: it can never fire, so the worker
 * hangs instead of the test failing. Running the read in a child with
 * `killSignal: "SIGKILL"` is the only way the regression shows up as a
 * failure within a bounded time.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNNER = `const m = await import(process.argv[2]);
const out = m[process.argv[4]](process.argv[3], Number(process.argv[5]));
console.log(JSON.stringify(out ?? null));
`;

export interface ProbeOutcome {
  readonly timedOut: boolean;
  readonly status: number | null;
  readonly value: unknown;
  readonly stderr: string;
}

/**
 * Import `moduleFile` in a child, call its `exportName(path, maxBytes)`, and
 * return the JSON-serialized result. `timeoutMs` is enforced with SIGKILL, so
 * a blocking read reports `timedOut` instead of hanging the suite.
 */
export function probeRead(opts: {
  moduleFile: string;
  exportName: string;
  path: string;
  maxBytes?: number;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): ProbeOutcome {
  const dir = mkdtempSync(join(tmpdir(), "storybloq-probe-"));
  const runner = join(dir, "runner.mjs");
  writeFileSync(runner, RUNNER, "utf-8");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", runner, opts.moduleFile, opts.path, opts.exportName, String(opts.maxBytes ?? 1024)],
    {
      timeout: opts.timeoutMs ?? 20_000,
      killSignal: "SIGKILL",
      encoding: "utf-8",
      env: { ...process.env, ...opts.env },
    },
  );
  const timedOut = (result.error as { code?: string } | undefined)?.code === "ETIMEDOUT";
  let value: unknown = null;
  try {
    value = JSON.parse((result.stdout ?? "").trim());
  } catch {
    value = null;
  }
  return { timedOut, status: result.status, value, stderr: result.stderr ?? "" };
}

/**
 * Run an arbitrary ESM snippet in a child under the same enforceable
 * deadline. Needed when the code under test is async but does synchronous
 * work BEFORE its first await: a regression there freezes the caller's event
 * loop, and a Vitest timeout is itself a timer on that loop.
 */
export function probeScript(opts: {
  source: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): ProbeOutcome {
  const dir = mkdtempSync(join(tmpdir(), "storybloq-probe-"));
  const runner = join(dir, "runner.mjs");
  writeFileSync(runner, opts.source, "utf-8");
  const result = spawnSync(process.execPath, ["--import", "tsx", runner], {
    timeout: opts.timeoutMs ?? 20_000,
    killSignal: "SIGKILL",
    encoding: "utf-8",
    env: { ...process.env, ...opts.env },
  });
  const timedOut = (result.error as { code?: string } | undefined)?.code === "ETIMEDOUT";
  let value: unknown = null;
  try {
    value = JSON.parse((result.stdout ?? "").trim());
  } catch {
    value = null;
  }
  return { timedOut, status: result.status, value, stderr: result.stderr ?? "" };
}
