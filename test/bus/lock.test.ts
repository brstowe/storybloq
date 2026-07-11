import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireHardenedLock,
  releaseHardenedLock,
} from "../../src/bus/lock.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempLock(): Promise<{ root: string; lockPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "bus-lock-"));
  roots.push(root);
  return { root, lockPath: join(root, "locks", "test.lock") };
}

function waitForMessage<T>(child: ChildProcess, predicate: (message: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: T): void => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`worker exited before expected message: code=${code} signal=${signal}`));
    };
    const cleanup = (): void => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function worker(mode: "holder" | "contender", lockPath: string, counterPath: string): ChildProcess {
  const fixture = fileURLToPath(new URL("./fixtures/lock-worker.ts", import.meta.url));
  return fork(fixture, [mode, lockPath, counterPath], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
}

describe("Storybloq Bus hardened lock", () => {
  it("does not break a live holder based on elapsed time", async () => {
    const { lockPath } = await tempLock();
    const first = await acquireHardenedLock(lockPath);
    await expect(acquireHardenedLock(lockPath, { timeoutMs: 60, pollMs: 5 }))
      .rejects.toMatchObject({ code: "lock_timeout" });
    await releaseHardenedLock(first);
  });

  it("recovers a positively dead holder", async () => {
    const { lockPath } = await tempLock();
    await import("node:fs/promises").then((fs) => fs.mkdir(dirname(lockPath), { recursive: true }));
    await writeFile(lockPath, JSON.stringify({
      pid: 99999999,
      token: "a".repeat(64),
      acquiredAt: new Date().toISOString(),
      processSignature: null,
    }), "utf-8");
    const handle = await acquireHardenedLock(lockPath, { timeoutMs: 1000 });
    await releaseHardenedLock(handle);
  });

  it("wedges safely on an unreadable lock instead of guessing", async () => {
    const { lockPath } = await tempLock();
    await import("node:fs/promises").then((fs) => fs.mkdir(dirname(lockPath), { recursive: true }));
    await writeFile(lockPath, "not-json", "utf-8");
    await expect(acquireHardenedLock(lockPath, { timeoutMs: 100 }))
      .rejects.toMatchObject({ code: "corrupt" });
  });

  it("does not recursively break an abandoned reaper guard", async () => {
    const { lockPath } = await tempLock();
    await import("node:fs/promises").then((fs) => fs.mkdir(dirname(lockPath), { recursive: true }));
    const dead = {
      pid: 99999999,
      token: "b".repeat(64),
      acquiredAt: new Date().toISOString(),
      processSignature: null,
    };
    await writeFile(lockPath, JSON.stringify(dead), "utf-8");
    await writeFile(`${lockPath}.reap`, JSON.stringify({ ...dead, token: "c".repeat(64) }), "utf-8");
    await expect(acquireHardenedLock(lockPath, { timeoutMs: 80, pollMs: 5 }))
      .rejects.toMatchObject({ code: "lock_timeout" });
    expect(await readFile(lockPath, "utf-8")).toContain("99999999");
  });

  it("serializes forty contenders after a SIGKILL without duplicate sequence 1", async () => {
    const { root, lockPath } = await tempLock();
    const counterPath = join(root, "counter.txt");
    const holder = worker("holder", lockPath, counterPath);
    await waitForMessage<{ type: string }>(holder, (message) => message.type === "ready");
    await new Promise<void>((resolve) => {
      holder.once("exit", () => resolve());
      holder.kill("SIGKILL");
    });

    const children = Array.from({ length: 40 }, () => worker("contender", lockPath, counterPath));
    let results: number[];
    try {
      results = await Promise.all(children.map(async (child) => {
        const message = await waitForMessage<{ type: string; seq?: number; message?: string }>(
          child,
          (candidate) => candidate.type === "done" || candidate.type === "error",
        );
        if (message.type === "error") throw new Error(message.message);
        return message.seq!;
      }));
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }

    expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    expect(await readFile(counterPath, "utf-8")).toBe("40");
  }, 60_000);
});
