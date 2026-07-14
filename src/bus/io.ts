import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import { BusError } from "./errors.js";

const DEFAULT_MAX_BYTES = 64 * 1024;

export async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

type DurableTempWriter = (handle: FileHandle, content: string) => Promise<void>;

const defaultTempWriter: DurableTempWriter = async (handle, content) => {
  await handle.writeFile(content, "utf-8");
  await handle.sync();
};

async function writeDurableTemp(
  target: string,
  content: string,
  writer: DurableTempWriter = defaultTempWriter,
): Promise<string> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp.${process.pid}.${randomUUID()}`;
  const handle = await open(temp, "wx", 0o600);
  let failure: unknown;
  try {
    await writer(handle, content);
  } catch (err) {
    failure = err;
  }
  try {
    await handle.close();
  } catch (err) {
    failure ??= err;
  }
  if (failure) {
    await unlink(temp).catch(() => undefined);
    throw failure;
  }
  return temp;
}

export async function durableCreate(target: string, content: string): Promise<void> {
  const temp = await writeDurableTemp(target, content);
  try {
    await link(temp, target);
    await syncDirectory(dirname(target));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new BusError("conflict", `File already exists: ${basename(target)}`, err);
    throw new BusError("io_error", `Failed to create ${basename(target)}`, err);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

export async function durableWrite(target: string, content: string): Promise<void> {
  const temp = await writeDurableTemp(target, content);
  try {
    await rename(temp, target);
    await syncDirectory(dirname(target));
  } catch (err) {
    throw new BusError("io_error", `Failed to write ${basename(target)}`, err);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

export async function durableRename(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    await syncDirectory(dirname(to));
  } catch (err) {
    throw new BusError("io_error", `Failed to publish ${basename(to)}`, err);
  }
}

export async function durableUnlink(target: string): Promise<void> {
  try {
    await unlink(target);
    await syncDirectory(dirname(target));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new BusError("io_error", `Failed to remove ${basename(target)}`, err);
    }
  }
}

export async function readJsonNoFollow<T>(
  path: string,
  schema: ZodType<T>,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<T> {
  let handle;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new BusError("corrupt", `${basename(path)} is not a regular file`);
    if (stat.size < 0 || stat.size > maxBytes) {
      throw new BusError("corrupt", `${basename(path)} exceeds ${maxBytes} bytes`);
    }
    const raw = await handle.readFile("utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new BusError("corrupt", `Invalid JSON in ${basename(path)}: ${(err as Error).message}`, err);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new BusError("corrupt", `Invalid schema in ${basename(path)}: ${result.error.issues[0]?.message ?? "unknown error"}`);
    }
    return result.data;
  } catch (err) {
    if (err instanceof BusError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new BusError("not_found", `File not found: ${basename(path)}`, err);
    if (code === "ELOOP") throw new BusError("corrupt", `Symlink rejected: ${basename(path)}`, err);
    throw new BusError("io_error", `Failed to read ${basename(path)}`, err);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function listRegularJsonFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new BusError("io_error", `Cannot enumerate ${basename(directory)}`, err);
  }
  return entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

export async function rejectPathSymlink(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new BusError("corrupt", `Symlink rejected: ${basename(path)}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export const __testing = { writeDurableTemp };
