import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
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

export async function assertBusIgnoreFileSafe(storyRoot: string): Promise<void> {
  const path = join(storyRoot, ".gitignore");
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new BusError("invalid_input", ".story/.gitignore must be a regular file");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

export async function assertBusRuntimeIgnored(storyRoot: string): Promise<void> {
  await assertBusIgnoreFileSafe(storyRoot);
  let raw: string;
  try {
    raw = await readFile(join(storyRoot, ".gitignore"), "utf-8");
  } catch (err) {
    throw new BusError(
      "conflict",
      "Bus runtime is not protected by .story/.gitignore. Run `storybloq bus init` first.",
      err,
    );
  }
  let ignored = false;
  for (const entry of raw.split(/\r?\n/).map((line) => line.trim())) {
    const normalized = entry.startsWith("/") ? entry.slice(1) : entry;
    const pattern = normalized.startsWith("!/") ? `!${normalized.slice(2)}` : normalized;
    if (pattern === "bus/") ignored = true;
    else if (pattern === "!bus" || pattern.startsWith("!bus/")) ignored = false;
    else if (pattern.startsWith("!")) {
      throw new BusError("conflict", "Bus ignore safety cannot be verified with negation patterns");
    }
  }
  if (!ignored) {
    throw new BusError(
      "conflict",
      "Bus runtime is not protected by .story/.gitignore. Run `storybloq bus init` first.",
    );
  }
}

export async function resolveBusPaths(projectRoot: string, _create?: false): Promise<BusPaths> {
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
  return paths;
}

function requiredBusDirectories(paths: BusPaths): string[] {
  return [
    paths.busRoot,
    paths.threads,
    paths.endpoints,
    paths.succession,
    paths.mailboxes,
    join(paths.mailboxes, "implementer"),
    join(paths.mailboxes, "implementer", "pending"),
    join(paths.mailboxes, "reviewer"),
    join(paths.mailboxes, "reviewer", "pending"),
    paths.locks,
  ];
}

export async function createBusPathsForInitialization(projectRoot: string): Promise<BusPaths> {
  const paths = await resolveBusPaths(projectRoot);
  await assertBusRuntimeIgnored(paths.storyRoot);
  for (const directory of requiredBusDirectories(paths)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await rejectSymlink(directory, relative(paths.projectRoot, directory));
  }
  return paths;
}

export async function busRuntimeExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new BusError("io_error", `Cannot inspect Bus runtime: ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

export async function busLayoutFindings(paths: BusPaths): Promise<string[]> {
  const findings: string[] = [];
  for (const directory of requiredBusDirectories(paths)) {
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        findings.push(`layout: ${directory} is not a regular directory`);
      }
    } catch (err) {
      findings.push(`layout: ${directory}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return findings;
}

export async function assertBusLayout(paths: BusPaths): Promise<void> {
  const findings = await busLayoutFindings(paths);
  if (findings.length > 0) throw new BusError("corrupt", findings.join("; "));
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
