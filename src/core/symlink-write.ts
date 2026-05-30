/**
 * Symlink-following atomic write primitives (ISS / Storybloq#12).
 *
 * The setup and hook writers used a "write tmp beside the target, then
 * rename(tmp, target)" pattern. `rename(2)` operates on the path entry, not
 * the symlink target, so it REPLACES a symlinked file with a standalone
 * regular file. When a user manages `~/.claude/settings.json` (or any of the
 * Codex dotfiles) through stow / chezmoi / yadm, that silently breaks the
 * symlink and leaves the tracked dotfile stale.
 *
 * The helpers here resolve a symlinked target to its real path FIRST and land
 * the tmp + rename on the real file, preserving the link and keeping the write
 * atomic (the tmp sits on the same filesystem as the real target).
 *
 * IMPORTANT: this is the DELIBERATE OPPOSITE of `guardPath` in
 * `project-loader.ts`, which REJECTS a symlinked target so that project data
 * inside `.story/` can never escape the repo through a planted symlink. User
 * dotfiles are symlinked on purpose and must be followed; in-repo project data
 * must not. Do NOT route `.story/` writers through this module.
 */

import { lstat, mkdir, readlink, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const MAX_SYMLINK_DEPTH = 40;

/**
 * Resolves the real path to WRITE THROUGH to, preserving the symlink at
 * `path`. The caller is expected to have already confirmed (via `lstat`) that
 * `path` is a symlink.
 *
 * - Live link (possibly chained / relative): `realpath` collapses the whole
 *   chain to the final real path.
 * - Dangling link: `realpath` throws ENOENT, so we walk `readlink` lexically
 *   to the link's intended final target (which may not exist yet -- we return
 *   it so the write CREATES it, rather than clobbering the link).
 * - Cyclic / too-deep chains and any non-ENOENT error throw, so the caller's
 *   existing try/catch degrades (skipped/0) rather than touching the link.
 */
export async function resolveSymlinkTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // Dangling link: resolve the chain by hand so we still write to the
    // link's intended target instead of replacing the link itself.
    let cur = path;
    for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth++) {
      const link = await readlink(cur);
      const next = isAbsolute(link) ? link : resolve(dirname(cur), link);
      let st;
      try {
        st = await lstat(next);
      } catch (le) {
        if ((le as NodeJS.ErrnoException).code === "ENOENT") return next; // final target missing -> create it here
        throw le;
      }
      if (st.isSymbolicLink()) {
        cur = next;
        continue;
      }
      return next;
    }
    throw new Error(`symlink chain too deep at ${path}`);
  }
}

/**
 * Atomic write that follows a symlinked target.
 *
 * If `targetPath` is a symlink, resolves it (live or dangling) and writes
 * through to the real target, preserving the link. If it is a regular file or
 * does not exist, behaves exactly like the previous tmp+rename write at the
 * literal path. Once `lstat` proves the path IS a symlink, the literal path is
 * never renamed onto -- a symlink we cannot resolve safely throws instead.
 *
 * Throws on write/rename failure (after cleaning up the tmp file) so callers
 * keep their existing try/catch -> "skipped"/0 degradation.
 */
export async function atomicWriteFollowingSymlink(targetPath: string, contents: string): Promise<void> {
  let st = null;
  try {
    st = await lstat(targetPath);
  } catch (e) {
    // ENOENT: nothing there yet -> write the literal path. Any other error
    // (EACCES, EPERM, ELOOP, ...) leaves the symlink-ness unknown, so rethrow
    // rather than risk clobbering.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const realTarget = st?.isSymbolicLink() ? await resolveSymlinkTarget(targetPath) : targetPath;

  const tmpPath = `${realTarget}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(realTarget), { recursive: true });
    await writeFile(tmpPath, contents, "utf-8");
    await rename(tmpPath, realTarget);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}
