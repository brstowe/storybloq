/**
 * T-498 5c: the real dispatcher wiring + sequential run orchestrator.
 *
 * The dispatcher tests inject a fake `spawn` (an EventEmitter standing in
 * for a ChildProcess) so the timeout/kill/parse paths are proven WITHOUT
 * ever invoking the real `claude` CLI -- these tests must never spend real
 * money or launch a real model session. The orchestrator tests
 * (runOneCell/runMatrix) do use the real captureInvocationBundle/
 * renderPromptForBundle path against the real fixtures (cheap, in-process
 * MCP calls, no LLM), with an injected fake `dispatch` standing in for the
 * real CLI call.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  createClaudeCliDispatcher,
  assertSubscriptionAuthOnly,
  ALTERNATE_AUTH_ENV_VARS,
  SessionKilledError,
  RecordPersistenceError,
  runOneCell,
  runMatrix,
  SKILL_PATH,
  type SpawnFn,
  type DispatchResult,
  type SessionRecord,
} from "../../scripts/behavioral-gate-run.js";
import { FIXTURES } from "../../scripts/behavioral-gate.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  vi.useRealTimers();
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "behavioral-gate-run-test-"));
  tempDirs.push(dir);
  return dir;
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly killCalls: string[] = [];
  kill(signal: string): void {
    this.killCalls.push(signal);
  }
}

type SpawnLike = ReturnType<typeof import("node:child_process").spawn>;

function successJson(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    result: "T-3002 is next.",
    is_error: false,
    subtype: "success",
    total_cost_usd: 0.05,
    usage: { input_tokens: 100 },
    session_id: "abc",
    num_turns: 1,
    ...overrides,
  });
}

describe("assertSubscriptionAuthOnly", () => {
  it("passes silently when no alternate-auth env var is set", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(() => assertSubscriptionAuthOnly(env)).not.toThrow();
  });

  it("throws, naming the offending var, when an alternate-auth env var is present", () => {
    const env = { ANTHROPIC_API_KEY: "sk-test" } as NodeJS.ProcessEnv;
    expect(() => assertSubscriptionAuthOnly(env)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("throws for any variable in the documented list, not just the API key", () => {
    for (const name of ALTERNATE_AUTH_ENV_VARS) {
      const env = { [name]: "x" } as NodeJS.ProcessEnv;
      expect(() => assertSubscriptionAuthOnly(env)).toThrow();
    }
  });
});

describe("createClaudeCliDispatcher", () => {
  it("resolves with the parsed transcript and full CLI result on success", async () => {
    let capturedArgs: readonly string[] = [];
    let capturedEnv: Record<string, unknown> = {};
    const fake = new FakeChildProcess();
    const spawnFn: SpawnFn = (_cmd, args, options) => {
      capturedArgs = args;
      capturedEnv = options.env as Record<string, unknown>;
      queueMicrotask(() => {
        fake.stdout.emit("data", Buffer.from(successJson()));
        fake.emit("close", 0, null);
      });
      return fake as unknown as SpawnLike;
    };
    const dispatch = createClaudeCliDispatcher({ timeoutMs: 5000, isolatedCwd: "/tmp", spawnFn });
    const result = await dispatch("the rendered prompt", "claude-sonnet-5");
    expect(result.transcript).toBe("T-3002 is next.");
    expect(result.cli.total_cost_usd).toBe(0.05);
    expect(capturedArgs).toContain("--model");
    expect(capturedArgs).toContain("claude-sonnet-5");
    expect(capturedArgs).toContain("--restricted");
    expect(capturedArgs).toContain("--no-session-persistence");
    expect(capturedArgs).toContain("--disable-slash-commands");
    expect(capturedArgs).toContain("dontAsk");
    expect(capturedArgs).toContain("the rendered prompt");
    for (const name of ALTERNATE_AUTH_ENV_VARS) expect(capturedEnv[name]).toBeUndefined();
  });

  it("refuses to even construct a dispatcher when an alternate-auth var is set on the parent process (fail-fast)", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "should-never-reach-the-child";
    try {
      expect(() => createClaudeCliDispatcher({ timeoutMs: 5000, isolatedCwd: "/tmp" })).toThrow();
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
    }
  });

  it("still strips every alternate-auth env var from the CHILD even if one appears on the parent AFTER construction (defense in depth for the race the fail-fast check cannot close)", async () => {
    // Construct with a clean parent env (must succeed), THEN set the vars --
    // simulating a var appearing between construction and the actual
    // dispatch call -- and prove the per-invocation stripping still runs.
    let capturedEnv: Record<string, unknown> = {};
    const fake = new FakeChildProcess();
    const spawnFn: SpawnFn = (_cmd, _args, options) => {
      capturedEnv = options.env as Record<string, unknown>;
      queueMicrotask(() => {
        fake.stdout.emit("data", Buffer.from(successJson()));
        fake.emit("close", 0, null);
      });
      return fake as unknown as SpawnLike;
    };
    const dispatch = createClaudeCliDispatcher({ timeoutMs: 5000, isolatedCwd: "/tmp", spawnFn });

    const originals: Record<string, string | undefined> = {};
    for (const name of ALTERNATE_AUTH_ENV_VARS) {
      originals[name] = process.env[name];
      process.env[name] = "should-never-reach-the-child";
    }
    try {
      await dispatch("prompt", "claude-sonnet-5");
      for (const name of ALTERNATE_AUTH_ENV_VARS) expect(capturedEnv[name]).toBeUndefined();
    } finally {
      for (const name of ALTERNATE_AUTH_ENV_VARS) {
        if (originals[name] === undefined) delete process.env[name];
        else process.env[name] = originals[name];
      }
    }
  });

  it("rejects invalid timeoutMs/sigkillGraceMs (NaN, negative, or beyond the timer range) at construction rather than launching a pathological session", () => {
    expect(() => createClaudeCliDispatcher({ timeoutMs: Number.NaN, isolatedCwd: "/tmp" })).toThrow(/timeoutMs/);
    expect(() => createClaudeCliDispatcher({ timeoutMs: -1, isolatedCwd: "/tmp" })).toThrow(/timeoutMs/);
    expect(() => createClaudeCliDispatcher({ timeoutMs: 2_147_483_648, isolatedCwd: "/tmp" })).toThrow(/timeoutMs/);
    expect(() => createClaudeCliDispatcher({ timeoutMs: 5000, sigkillGraceMs: -5, isolatedCwd: "/tmp" })).toThrow(/sigkillGraceMs/);
  });

  it("rejects with a SessionKilledError('timeout') and sends SIGTERM when the timeout elapses", async () => {
    const fake = new FakeChildProcess();
    const spawnFn: SpawnFn = () => fake as unknown as SpawnLike;
    const dispatch = createClaudeCliDispatcher({ timeoutMs: 10, isolatedCwd: "/tmp", spawnFn });
    const promise = dispatch("prompt", "claude-sonnet-5");
    await new Promise((r) => setTimeout(r, 30));
    fake.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toBeInstanceOf(SessionKilledError);
    await expect(promise).rejects.toMatchObject({ kind: "timeout" });
    expect(fake.killCalls).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when the child ignores SIGTERM, and still classifies the outcome as timeout (not external-kill)", async () => {
    vi.useFakeTimers();
    const fake = new FakeChildProcess();
    const spawnFn: SpawnFn = () => fake as unknown as SpawnLike;
    const dispatch = createClaudeCliDispatcher({ timeoutMs: 10, sigkillGraceMs: 50, isolatedCwd: "/tmp", spawnFn });
    const promise = dispatch("prompt", "claude-sonnet-5");
    await vi.advanceTimersByTimeAsync(10); // fires the timeout -> SIGTERM
    expect(fake.killCalls).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(50); // child never closed -> grace elapses -> SIGKILL
    expect(fake.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
    fake.emit("close", null, "SIGKILL"); // the child finally reports the SIGKILL we just sent
    await expect(promise).rejects.toMatchObject({ kind: "timeout" });
  });

  it("rejects with a SessionKilledError('external-kill') on an unrequested SIGKILL", async () => {
    const fake = new FakeChildProcess();
    const spawnFn: SpawnFn = () => {
      queueMicrotask(() => fake.emit("close", null, "SIGKILL"));
      return fake as unknown as SpawnLike;
    };
    const dispatch = createClaudeCliDispatcher({ timeoutMs: 5000, isolatedCwd: "/tmp", spawnFn });
    await expect(dispatch("prompt", "claude-sonnet-5")).rejects.toMatchObject({ kind: "external-kill" });
  });

  it("rejects on a non-JSON stdout payload", async () => {
    const fake = new FakeChildProcess();
    const spawnFn: SpawnFn = () => {
      queueMicrotask(() => {
        fake.stdout.emit("data", Buffer.from("not json at all"));
        fake.emit("close", 0, null);
      });
      return fake as unknown as SpawnLike;
    };
    const dispatch = createClaudeCliDispatcher({ timeoutMs: 5000, isolatedCwd: "/tmp", spawnFn });
    await expect(dispatch("prompt", "claude-sonnet-5")).rejects.toThrow(/non-JSON stdout/);
  });

  it("rejects (never crashes) on syntactically valid JSON with an unexpected shape, e.g. a bare null", async () => {
    const fake = new FakeChildProcess();
    const spawnFn: SpawnFn = () => {
      queueMicrotask(() => {
        fake.stdout.emit("data", Buffer.from("null"));
        fake.emit("close", 0, null);
      });
      return fake as unknown as SpawnLike;
    };
    const dispatch = createClaudeCliDispatcher({ timeoutMs: 5000, isolatedCwd: "/tmp", spawnFn });
    await expect(dispatch("prompt", "claude-sonnet-5")).rejects.toThrow(/unexpected shape/);
  });

  it("rejects (never crashes) on a well-formed object missing required fields", async () => {
    const fake = new FakeChildProcess();
    const spawnFn: SpawnFn = () => {
      queueMicrotask(() => {
        fake.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok" })));
        fake.emit("close", 0, null);
      });
      return fake as unknown as SpawnLike;
    };
    const dispatch = createClaudeCliDispatcher({ timeoutMs: 5000, isolatedCwd: "/tmp", spawnFn });
    await expect(dispatch("prompt", "claude-sonnet-5")).rejects.toThrow(/unexpected shape/);
  });

  it("rejects when the CLI's own JSON reports is_error", async () => {
    const fake = new FakeChildProcess();
    const spawnFn: SpawnFn = () => {
      queueMicrotask(() => {
        fake.stdout.emit("data", Buffer.from(successJson({ is_error: true, subtype: "error_max_turns" })));
        fake.emit("close", 0, null);
      });
      return fake as unknown as SpawnLike;
    };
    const dispatch = createClaudeCliDispatcher({ timeoutMs: 5000, isolatedCwd: "/tmp", spawnFn });
    await expect(dispatch("prompt", "claude-sonnet-5")).rejects.toThrow(/is_error/);
  });

  it("rejects with stderr context on a non-zero exit code", async () => {
    const fake = new FakeChildProcess();
    const spawnFn: SpawnFn = () => {
      queueMicrotask(() => {
        fake.stderr.emit("data", Buffer.from("some cli failure"));
        fake.emit("close", 1, null);
      });
      return fake as unknown as SpawnLike;
    };
    const dispatch = createClaudeCliDispatcher({ timeoutMs: 5000, isolatedCwd: "/tmp", spawnFn });
    await expect(dispatch("prompt", "claude-sonnet-5")).rejects.toThrow(/some cli failure/);
  });
});

function fakeDispatchResult(transcript: string): DispatchResult {
  return {
    transcript,
    cli: { result: transcript, is_error: false, subtype: "success", total_cost_usd: 0.01, usage: {}, session_id: "s", num_turns: 1 },
  };
}

function seedRecord(fixture: string, arm: "oracle" | "brief", repeat: number, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    fixture,
    arm,
    repeat,
    model: "claude-sonnet-5",
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    wallMs: 1000,
    promptBytes: 123,
    transcript: "pre-seeded",
    score: { pass: true, namedCorrectAlternative: true, citedDecisiveHandover: true, reason: "pre-seeded" },
    cli: { total_cost_usd: 0.01, usage: {}, session_id: "pre-seeded", num_turns: 1 },
    ...overrides,
  };
}

describe("runOneCell (real fixture capture, fake dispatch)", () => {
  const fixture = FIXTURES.find((f) => f.name === "deferred-item")!;

  it("writes a completed record to disk with score and cli cost", async () => {
    const outputRoot = await makeTempDir();
    const dispatch = async () => fakeDispatchResult("Working on T-3002 next, the CSV export quick action.");
    const record = await runOneCell(fixture, "brief", 1, "claude-sonnet-5", outputRoot, { dispatch, skillPath: SKILL_PATH });
    expect(record.status).toBe("completed");
    expect(record.score?.pass).toBe(true);
    expect(record.promptBytes).toBeGreaterThan(0);
    const onDisk = JSON.parse(await readFile(join(outputRoot, "deferred-item", "brief", "repeat-1.json"), "utf-8")) as SessionRecord;
    expect(onDisk.status).toBe("completed");
    expect(onDisk.cli?.total_cost_usd).toBe(0.01);
  });

  it("writes a failed record to disk (with killKind) when the dispatcher throws", async () => {
    const outputRoot = await makeTempDir();
    const dispatch = async () => {
      throw new SessionKilledError("external-kill", "simulated external kill");
    };
    await expect(
      runOneCell(fixture, "oracle", 2, "claude-sonnet-5", outputRoot, { dispatch, skillPath: SKILL_PATH }),
    ).rejects.toThrow(/simulated external kill/);
    const onDisk = JSON.parse(await readFile(join(outputRoot, "deferred-item", "oracle", "repeat-2.json"), "utf-8")) as SessionRecord;
    expect(onDisk.status).toBe("failed");
    expect(onDisk.killKind).toBe("external-kill");
  });

  it("leaves no partial file behind and propagates RecordPersistenceError when persistence itself fails", async () => {
    const outputRoot = await makeTempDir();
    // Point the record's directory at a path that cannot be created (a file
    // exists where a directory is needed), forcing mkdir/writeRecordAtomic
    // to fail deterministically without mocking the filesystem.
    await writeFile(join(outputRoot, "deferred-item"), "not a directory", "utf-8");
    const dispatch = async () => fakeDispatchResult("Working on T-3002 next.");
    await expect(
      runOneCell(fixture, "brief", 1, "claude-sonnet-5", outputRoot, { dispatch, skillPath: SKILL_PATH }),
    ).rejects.toBeInstanceOf(RecordPersistenceError);
  });
});

describe("runMatrix (real fixtures, fake dispatch)", () => {
  it("skips a cell already recorded as completed on disk (resume) without calling dispatch for it", async () => {
    const outputRoot = await makeTempDir();
    let dispatchCalls = 0;
    for (const f of FIXTURES) {
      for (const arm of ["oracle", "brief"] as const) {
        for (let repeat = 1; repeat <= 5; repeat++) {
          if (f.name === "deferred-item" && arm === "brief" && repeat === 5) continue;
          const dir = join(outputRoot, f.name, arm);
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, `repeat-${repeat}.json`), JSON.stringify(seedRecord(f.name, arm, repeat)), "utf-8");
        }
      }
    }

    const dispatch = async () => {
      dispatchCalls++;
      return fakeDispatchResult("T-3002 is the actual next actionable item, the CSV export quick action.");
    };
    const outcome = await runMatrix({ model: "claude-sonnet-5", outputRoot, dispatch, skillPath: SKILL_PATH });
    expect(dispatchCalls).toBe(1);
    expect(outcome.stoppedEarly).toBe(false);
    expect(outcome.records).toHaveLength(40);
    const liveRecord = outcome.records.find((r) => r.fixture === "deferred-item" && r.arm === "brief" && r.repeat === 5)!;
    expect(liveRecord.transcript).toContain("CSV export quick action");
  }, 30000);

  it("does NOT resume from a truncated/malformed record, a status-only record, or a record from a different model", async () => {
    const outputRoot = await makeTempDir();
    const dir = join(outputRoot, "deferred-item", "brief");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "repeat-1.json"), '{"status":"completed", "fixture":"deferred-item"', "utf-8"); // truncated JSON
    await writeFile(join(dir, "repeat-2.json"), JSON.stringify({ status: "completed" }), "utf-8"); // status-only, no other required fields
    await writeFile(
      join(dir, "repeat-3.json"),
      JSON.stringify(seedRecord("deferred-item", "brief", 3, { model: "claude-haiku-4-5" })),
      "utf-8",
    ); // valid shape, wrong model

    let dispatchCalls = 0;
    const dispatch = async () => {
      dispatchCalls++;
      return fakeDispatchResult("T-3002 is next.");
    };
    // Pre-seed everything else as completed so only repeats 1-3 of
    // (deferred-item, brief) do live work, plus repeats 4-5 of the same
    // cell which were never seeded at all.
    for (const f of FIXTURES) {
      for (const arm of ["oracle", "brief"] as const) {
        for (let repeat = 1; repeat <= 5; repeat++) {
          if (f.name === "deferred-item" && arm === "brief") continue;
          const seedDir = join(outputRoot, f.name, arm);
          await mkdir(seedDir, { recursive: true });
          await writeFile(join(seedDir, `repeat-${repeat}.json`), JSON.stringify(seedRecord(f.name, arm, repeat)), "utf-8");
        }
      }
    }

    const outcome = await runMatrix({ model: "claude-sonnet-5", outputRoot, dispatch, skillPath: SKILL_PATH });
    expect(outcome.stoppedEarly).toBe(false);
    // All 5 repeats of (deferred-item, brief) had to actually run live --
    // none of the three seeded files (truncated, status-only, wrong-model)
    // was accepted as a valid resume point.
    expect(dispatchCalls).toBe(5);
    const cellRecords = outcome.records.filter((r) => r.fixture === "deferred-item" && r.arm === "brief");
    expect(cellRecords).toHaveLength(5);
    expect(cellRecords.every((r) => r.model === "claude-sonnet-5" && r.status === "completed")).toBe(true);
  }, 30000);

  it("stops the whole run after two consecutive external kills on the same cell, without proceeding to later fixtures", async () => {
    const outputRoot = await makeTempDir();
    let dispatchCalls = 0;
    const dispatch = async () => {
      dispatchCalls++;
      throw new SessionKilledError("external-kill", "simulated sustained kill pressure");
    };
    const outcome = await runMatrix({ model: "claude-sonnet-5", outputRoot, dispatch, skillPath: SKILL_PATH });
    expect(outcome.stoppedEarly).toBe(true);
    expect(outcome.stopReason).toMatch(/two consecutive/);
    // Exactly one cell attempted (original + one retry), stopped before any second cell.
    expect(dispatchCalls).toBe(2);
    expect(outcome.records).toHaveLength(1);
    expect(outcome.records[0]?.killKind).toBe("external-kill");
  }, 15000);

  it("retries a single external kill once and succeeds without stopping the run", async () => {
    const outputRoot = await makeTempDir();
    for (const f of FIXTURES) {
      for (const arm of ["oracle", "brief"] as const) {
        if (f.name === "deferred-item" && arm === "brief") continue;
        for (let repeat = 1; repeat <= 5; repeat++) {
          const dir = join(outputRoot, f.name, arm);
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, `repeat-${repeat}.json`), JSON.stringify(seedRecord(f.name, arm, repeat)), "utf-8");
        }
      }
    }
    let callCount = 0;
    const dispatch = async () => {
      callCount++;
      if (callCount === 1) throw new SessionKilledError("external-kill", "transient");
      return fakeDispatchResult("T-3002 next.");
    };
    const outcome = await runMatrix({ model: "claude-sonnet-5", outputRoot, dispatch, skillPath: SKILL_PATH });
    expect(outcome.stoppedEarly).toBe(false);
    expect(callCount).toBe(6); // 1 failed + 1 retry-succeeded for repeat 1, plus repeats 2-5
    const repeat1 = outcome.records.find((r) => r.fixture === "deferred-item" && r.arm === "brief" && r.repeat === 1)!;
    expect(repeat1.status).toBe("completed");
  }, 30000);

  it("does not retry, and does not count towards a double-kill, on a plain timeout or an ordinary error", async () => {
    const outputRoot = await makeTempDir();
    for (const f of FIXTURES) {
      for (const arm of ["oracle", "brief"] as const) {
        if (f.name === "deferred-item" && arm === "brief") continue;
        for (let repeat = 1; repeat <= 5; repeat++) {
          const dir = join(outputRoot, f.name, arm);
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, `repeat-${repeat}.json`), JSON.stringify(seedRecord(f.name, arm, repeat)), "utf-8");
        }
      }
    }
    let callCount = 0;
    const dispatch = async () => {
      callCount++;
      if (callCount === 1) throw new SessionKilledError("timeout", "timed out");
      if (callCount === 2) throw new Error("some ordinary dispatch failure");
      return fakeDispatchResult("T-3002 next.");
    };
    const outcome = await runMatrix({ model: "claude-sonnet-5", outputRoot, dispatch, skillPath: SKILL_PATH });
    expect(outcome.stoppedEarly).toBe(false);
    // Neither a timeout nor an ordinary error retries -- one dispatch call per repeat.
    expect(callCount).toBe(5);
    const repeat1 = outcome.records.find((r) => r.fixture === "deferred-item" && r.arm === "brief" && r.repeat === 1)!;
    expect(repeat1.status).toBe("failed");
    expect(repeat1.killKind).toBe("timeout");
    const repeat2 = outcome.records.find((r) => r.fixture === "deferred-item" && r.arm === "brief" && r.repeat === 2)!;
    expect(repeat2.status).toBe("failed");
    expect(repeat2.killKind).toBeUndefined();
  }, 30000);

  it("an external kill followed by a DIFFERENT failure kind on retry does not count as a double-kill and does not stop the run", async () => {
    const outputRoot = await makeTempDir();
    for (const f of FIXTURES) {
      for (const arm of ["oracle", "brief"] as const) {
        if (f.name === "deferred-item" && arm === "brief") continue;
        for (let repeat = 1; repeat <= 5; repeat++) {
          const dir = join(outputRoot, f.name, arm);
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, `repeat-${repeat}.json`), JSON.stringify(seedRecord(f.name, arm, repeat)), "utf-8");
        }
      }
    }
    let callCount = 0;
    const dispatch = async () => {
      callCount++;
      if (callCount === 1) throw new SessionKilledError("external-kill", "first kill");
      if (callCount === 2) throw new SessionKilledError("timeout", "retry just timed out, not killed again");
      return fakeDispatchResult("T-3002 next.");
    };
    const outcome = await runMatrix({ model: "claude-sonnet-5", outputRoot, dispatch, skillPath: SKILL_PATH });
    expect(outcome.stoppedEarly).toBe(false);
    expect(callCount).toBe(6); // repeat 1: kill + retry(timeout) = 2 calls, repeats 2-5 = 4 more
    const repeat1 = outcome.records.find((r) => r.fixture === "deferred-item" && r.arm === "brief" && r.repeat === 1)!;
    expect(repeat1.status).toBe("failed");
    expect(repeat1.killKind).toBe("timeout");
  }, 30000);

  it("propagates RecordPersistenceError out of runMatrix immediately, dispatching exactly once, when persistence fails at the very first cell", async () => {
    const outputRoot = await makeTempDir();
    // Read-only output root: the first cell's resume lookup still succeeds
    // (the file does not exist yet, a plain ENOENT, not a permission
    // failure), so its session dispatches -- but persisting the result then
    // fails because no new subdirectory can be created under a read-only
    // root, forcing the failure onto the write side only.
    await chmod(outputRoot, 0o555);
    let dispatchCalls = 0;
    const dispatch = async () => {
      dispatchCalls++;
      return fakeDispatchResult("T-3002 next.");
    };
    try {
      await expect(
        runMatrix({ model: "claude-sonnet-5", outputRoot, dispatch, skillPath: SKILL_PATH }),
      ).rejects.toBeInstanceOf(RecordPersistenceError);
    } finally {
      await chmod(outputRoot, 0o755);
    }
    // Exactly the first cell's session was dispatched (and paid for) before
    // the persistence failure stopped the run -- no later cell was attempted.
    expect(dispatchCalls).toBe(1);
  }, 15000);

  // These two tests force the write failure via chmod(0o555) on the
  // containing directory. That is a POSIX permission check: it has no
  // effect when the test runner has permission-bypass privileges (e.g.
  // root) and does not translate to Windows ACLs. This project's test
  // suite runs on macOS as a normal user, where the check is meaningful;
  // it is disclosed here rather than silently assumed portable.
  it("preserves an existing valid completed record's bytes if a later write to the same path fails before rename (atomic replacement safety)", async () => {
    const outputRoot = await makeTempDir();
    const dir = join(outputRoot, "deferred-item", "oracle");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "repeat-1.json");
    const original = seedRecord("deferred-item", "oracle", 1, { transcript: "original transcript, must survive" });
    const originalBytes = JSON.stringify(original);
    await writeFile(path, originalBytes, "utf-8");

    // Read-only directory: the destination file already exists and is
    // readable, but a NEW temp file cannot be created in it, so the
    // upcoming write attempt fails at open(tmpPath) -- before rename ever
    // touches the real path.
    await chmod(dir, 0o555);
    try {
      const fixture = FIXTURES.find((f) => f.name === "deferred-item")!;
      const dispatch = async () => fakeDispatchResult("a new transcript that must never land");
      await expect(
        runOneCell(fixture, "oracle", 1, "claude-sonnet-5", outputRoot, { dispatch, skillPath: SKILL_PATH }),
      ).rejects.toBeInstanceOf(RecordPersistenceError);
    } finally {
      await chmod(dir, 0o755);
    }

    // Compare the whole file, not just one field -- any field changing
    // (cost, score, status, timestamps) would mean the "atomic" guarantee
    // was violated, not just the transcript.
    const onDiskBytes = await readFile(path, "utf-8");
    expect(onDiskBytes).toBe(originalBytes);
  });
});
