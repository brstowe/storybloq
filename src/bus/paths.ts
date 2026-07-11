import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { BusError } from "./errors.js";
import type { BusRole } from "./schemas.js";

export interface BusPaths {
  readonly projectRoot: string;
  readonly storyRoot: string;
  readonly busRoot: string;
  readonly threads: string;
  readonly endpoints: string;
  readonly succession: string;
  readonly mailboxes: string;
  readonly locks: string;
}

async function rejectSymlink(path: string, label: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new BusError("invalid_input", `${label} cannot be a symlink`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

export async function resolveBusPaths(projectRoot: string, create = false): Promise<BusPaths> {
  let canonicalProject: string;
  try {
    canonicalProject = await realpath(resolve(projectRoot));
  } catch (err) {
    throw new BusError("not_found", `Cannot resolve project root: ${projectRoot}`, err);
  }
  const storyRoot = join(canonicalProject, ".story");
  await rejectSymlink(storyRoot, ".story");
  try {
    const storyStat = await lstat(storyRoot);
    if (!storyStat.isDirectory()) throw new BusError("invalid_input", ".story is not a directory");
  } catch (err) {
    if (err instanceof BusError) throw err;
    throw new BusError("not_found", "No .story project found", err);
  }

  const busRoot = join(storyRoot, "bus");
  await rejectSymlink(busRoot, ".story/bus");
  const paths: BusPaths = {
    projectRoot: canonicalProject,
    storyRoot,
    busRoot,
    threads: join(busRoot, "threads"),
    endpoints: join(busRoot, "endpoints"),
    succession: join(busRoot, "succession"),
    mailboxes: join(busRoot, "mailboxes"),
    locks: join(busRoot, "locks"),
  };
  for (const [path, label] of [
    [paths.threads, ".story/bus/threads"],
    [paths.endpoints, ".story/bus/endpoints"],
    [paths.succession, ".story/bus/succession"],
    [paths.mailboxes, ".story/bus/mailboxes"],
    [paths.locks, ".story/bus/locks"],
  ] as const) {
    await rejectSymlink(path, label);
  }
  if (create) {
    for (const directory of [
      busRoot,
      paths.threads,
      paths.endpoints,
      paths.succession,
      paths.mailboxes,
      join(paths.mailboxes, "implementer"),
      join(paths.mailboxes, "implementer", "pending"),
      join(paths.mailboxes, "reviewer"),
      join(paths.mailboxes, "reviewer", "pending"),
      paths.locks,
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await rejectSymlink(directory, relative(canonicalProject, directory));
    }
  }
  return paths;
}

export function assertContainedPath(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new BusError("invalid_input", `Bus path escapes runtime root: ${target}`);
  }
}

export function roleMailboxPath(paths: BusPaths, role: BusRole): string {
  const path = join(paths.mailboxes, role);
  assertContainedPath(paths.busRoot, path);
  return path;
}
