// T-430: the parent-side spawn of the detached auto-attach child. This is the ONLY code the
// SessionStart hook and per-turn retry run on their critical path, and it must stay a
// constant-time read + spawn: no locks, no durable writes, no /bin/ps. The suppression hint
// is a single cheap read of the child-written outcome record; correctness lives entirely in
// the child's try-lock, so a wrong hint only costs a redundant (self-exiting) process.

import { spawn as nodeSpawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import type { BusClient, BusSurface } from "./schemas.js";
import { readAutoAttachOutcome, shouldSpawnAutoAttach } from "./auto-attach-outcome.js";

export interface SpawnAutoAttachInput {
  readonly root: string;
  readonly client: BusClient;
  readonly clientTaskId: string;
  readonly surface: BusSurface;
  // The live process's clock (Date.now()). Passed in so this module never reads the clock
  // itself (keeps it trivially testable and deterministic).
  readonly nowMs: number;
}

export type SpawnAutoAttachResult = "spawned" | "suppressed" | "skipped";

// The narrow slice of a spawned child this module uses. Injectable so tests never launch a
// real detached process (the test runner's argv[1] would otherwise be executed).
export interface SpawnedChildLike {
  on(event: "error", listener: (err: Error) => void): unknown;
  unref(): unknown;
}
export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedChildLike;

export interface SpawnAutoAttachDeps {
  // Injectable spawn seam (defaults to node:child_process spawn). Tests pass a spy so no real
  // process is created; correctness is unaffected because the child self-gates via its try-lock.
  readonly spawn?: SpawnLike;
  // Injectable CLI entry (defaults to process.argv[1]) so a test can assert the argv without
  // depending on the runner's own entry path.
  readonly cliEntry?: string;
}

export async function spawnAutoAttachBestEffort(
  input: SpawnAutoAttachInput,
  deps: SpawnAutoAttachDeps = {},
): Promise<SpawnAutoAttachResult> {
  try {
    // Read-only suppression hint + backoff: skip if a fresh child is in flight or one just ran.
    const outcome = await readAutoAttachOutcome(input.root, input.client, input.clientTaskId);
    if (!shouldSpawnAutoAttach(outcome, input.nowMs)) return "suppressed";

    const cliEntry = deps.cliEntry ?? process.argv[1];
    if (!cliEntry) return "skipped";

    // Detached, unref'd, error-listener-guarded (mirrors the waker launcher): an async spawn
    // failure can never terminate the hook process. argv array + process.execPath, no shell.
    const spawnFn: SpawnLike = deps.spawn ?? (nodeSpawn as unknown as SpawnLike);
    const child = spawnFn(
      process.execPath,
      [
        cliEntry,
        "bus",
        "__session-attach",
        "--client", input.client,
        "--task-id", input.clientTaskId,
        "--surface", input.surface,
        "--root", input.root,
      ],
      { cwd: input.root, detached: true, stdio: "ignore" },
    );
    child.on("error", () => {});
    child.unref();
    return "spawned";
  } catch {
    return "skipped";
  }
}
