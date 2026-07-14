import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { BusError } from "./errors.js";
import { canonicalHash } from "./canonical.js";
import { syncDirectory } from "./io.js";

const execFileAsync = promisify(execFile);
const LOCK_MAX_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 20;

const LockBodySchema = z.object({
  pid: z.number().int().positive(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  acquiredAt: z.string().datetime({ offset: true }),
  processSignature: z.string().min(1).max(512).nullable(),
}).strict();

type LockBody = z.infer<typeof LockBodySchema>;

export interface HardenedLockHandle {
  readonly lockPath: string;
  readonly token: string;
  readonly inode: number;
  readonly tempPath: string;
}

export interface HardenedLockOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireReaperGuard(
  lockPath: string,
  deadline: number,
  pollMs: number,
): Promise<HardenedLockHandle> {
  const guardPath = `${lockPath}.reap`;
  const token = randomBytes(32).toString("hex");
  const body: LockBody = {
    pid: process.pid,
    token,
    acquiredAt: new Date().toISOString(),
    processSignature: await captureProcessSignature(process.pid),
  };
  const tempPath = `${guardPath}.tmp.${process.pid}.${randomUUID()}`;
  const tempHandle = await open(tempPath, "wx", 0o600);
  try {
    await tempHandle.writeFile(JSON.stringify(body), "utf-8");
    await tempHandle.sync();
  } finally {
    await tempHandle.close();
  }

  try {
    while (Date.now() <= deadline) {
      try {
        await link(tempPath, guardPath);
        await syncDirectory(dirname(guardPath));
        return { lockPath: guardPath, token, inode: (await lstat(guardPath)).ino, tempPath };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new BusError("io_error", `Cannot acquire reaper guard for ${basename(lockPath)}`, err);
        }
      }
      await delay(pollMs);
    }
    throw new BusError("lock_timeout", `Timed out acquiring reaper guard for ${basename(lockPath)}`);
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

export async function captureProcessSignature(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "uid=,lstart=,command="], {
        timeout: 500,
        maxBuffer: 128 * 1024,
      });
      const normalized = stdout.trim().replace(/\s+/g, " ");
      return normalized ? `darwin:${canonicalHash(normalized)}` : null;
    }
    if (process.platform === "linux") {
      const procStat = await open(`/proc/${pid}/stat`, "r");
      let raw: string;
      try { raw = await procStat.readFile("utf-8"); } finally { await procStat.close(); }
      const rightParen = raw.lastIndexOf(")");
      if (rightParen < 0) return null;
      const fields = raw.slice(rightParen + 1).trim().split(/\s+/);
      const startTicks = fields[19];
      const proc = await stat(`/proc/${pid}`);
      return startTicks ? `linux:${proc.uid}:${startTicks}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

export type ProcessState = "alive" | "dead" | "unknown";

export async function inspectProcessIdentity(pid: number, expectedSignature: string | null): Promise<ProcessState> {
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
  if (!expectedSignature) return "unknown";
  const actual = await captureProcessSignature(pid);
  if (!actual) return "unknown";
  return actual === expectedSignature ? "alive" : "dead";
}

type LockReadResult =
  | { readonly status: "ok"; readonly body: LockBody; readonly inode: number }
  | { readonly status: "missing" }
  | { readonly status: "invalid" };

async function readLock(path: string): Promise<LockReadResult> {
  let handle;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size < 1 || fileStat.size > LOCK_MAX_BYTES) return { status: "invalid" };
    const parsed = LockBodySchema.safeParse(JSON.parse(await handle.readFile("utf-8")));
    return parsed.success
      ? { status: "ok", body: parsed.data, inode: fileStat.ino }
      : { status: "invalid" };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function compareAndUnlink(path: string, expectedInode: number, expectedToken: string): Promise<boolean> {
  let handle;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.ino !== expectedInode || fileStat.size > LOCK_MAX_BYTES) return false;
    const parsed = LockBodySchema.safeParse(JSON.parse(await handle.readFile("utf-8")));
    if (!parsed.success || parsed.data.token !== expectedToken) return false;
    const linked = await lstat(path);
    if (linked.isSymbolicLink() || linked.ino !== fileStat.ino) return false;
    await unlink(path);
    await syncDirectory(dirname(path));
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function acquireHardenedLock(
  lockPath: string,
  options: HardenedLockOptions = {},
): Promise<HardenedLockHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const body: LockBody = {
    pid: process.pid,
    token,
    acquiredAt: new Date().toISOString(),
    processSignature: await captureProcessSignature(process.pid),
  };
  const tempPath = `${lockPath}.tmp.${process.pid}.${randomUUID()}`;
  const tempHandle = await open(tempPath, "wx", 0o600);
  try {
    await tempHandle.writeFile(JSON.stringify(body), "utf-8");
    await tempHandle.sync();
  } finally {
    await tempHandle.close();
  }

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() <= deadline) {
      try {
        await link(tempPath, lockPath);
        await syncDirectory(dirname(lockPath));
        const inode = (await lstat(lockPath)).ino;
        return { lockPath, token, inode, tempPath };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new BusError("io_error", `Cannot acquire lock ${basename(lockPath)}`, err);
        }
      }

      const existing = await readLock(lockPath);
      if (existing.status === "missing") continue;
      if (existing.status === "invalid") {
        throw new BusError("corrupt", `Lock ${basename(lockPath)} is unreadable and will not be broken automatically`);
      }
      const holder = await inspectProcessIdentity(existing.body.pid, existing.body.processSignature);
      if (holder === "dead") {
        const reaper = await acquireReaperGuard(lockPath, deadline, pollMs);
        try {
          const latest = await readLock(lockPath);
          if (latest.status === "invalid") {
            throw new BusError("corrupt", `Lock ${basename(lockPath)} became unreadable during dead-holder recovery`);
          }
          if (latest.status === "ok") {
            const latestHolder = await inspectProcessIdentity(latest.body.pid, latest.body.processSignature);
            if (latestHolder === "dead") {
              await compareAndUnlink(lockPath, latest.inode, latest.body.token);
            }
          }
        } finally {
          await releaseHardenedLock(reaper);
        }
        continue;
      }
      await delay(pollMs);
    }
    throw new BusError("lock_timeout", `Timed out acquiring lock ${basename(lockPath)}`);
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

export async function releaseHardenedLock(handle: HardenedLockHandle): Promise<void> {
  await compareAndUnlink(handle.lockPath, handle.inode, handle.token);
  await unlink(handle.tempPath).catch(() => undefined);
}

export async function withHardenedLock<T>(
  lockPath: string,
  handler: () => Promise<T>,
  options: HardenedLockOptions = {},
): Promise<T> {
  const handle = await acquireHardenedLock(lockPath, options);
  try {
    return await handler();
  } finally {
    await releaseHardenedLock(handle);
  }
}

export const __testing = {
  compareAndUnlink,
  inspectProcess: inspectProcessIdentity,
  readLock,
};
