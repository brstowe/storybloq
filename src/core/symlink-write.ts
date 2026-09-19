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
 *
 * Accepted behaviors (intentional, do not "harden"):
 *  - Following a DANGLING link writes through to (and `mkdir -p` creates) the
 *    link's intended final target, even if that is an arbitrary ancestor chain.
 *    This is the fresh-stow self-heal case: the user deliberately symlinked the
 *    dotfile, the content is the tool's own generated config, no pre-existing
 *    file is overwritten, and planting the link already requires write access to
 *    the parent. Restricting to "only follow when the parent exists" would break
 *    that case, so it is left as-is.
 *  - Atomicity relies on `tmpPath` sitting beside the RESOLVED real target so the
 *    final `rename` stays on the target's filesystem. This is verified by
 *    construction (the tmp path is derived from `realTarget`), not by a cross-FS
 *    test, which is not portable.
 */

import { lstat, mkdir, readlink, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_SYMLINK_DEPTH = 40;

/**
 * The real path of `path`, or, where it does not exist yet, the real path of
 * its first existing ancestor with the missing tail joined back on. A
 * dangling-link target (the fresh-stow case above) has no realpath of its own
 * but still has a definite place on disk.
 */
async function realpathLenient(path: string): Promise<string> {
  const missing: string[] = [];
  let cur = resolve(path);
  for (;;) {
    try {
      const real = await realpath(cur);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = dirname(cur);
      if (parent === cur) throw e;
      missing.push(basename(cur));
      cur = parent;
    }
  }
}

/** `b` is `a` or somewhere under it. A path test, not a string prefix: /x/storybloq does not contain /x/storybloq-x. */
function containsPath(a: string, b: string): boolean {
  const rel = relative(a, b);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * ISS-1234: refuses a directory copy whose destination resolves to the very
 * tree it is copying from. Following a symlinked destination is deliberate
 * (issue #12 above), and the copy REPLACES the target whole, so a link that
 * points back into the package's own source turns a refresh into a sync
 * that deletes every file the stage does not carry. That happened once, to
 * the repository plugin directory.
 *
 * Overlap in either direction counts: the target inside the source, or the
 * source inside the target. A link to anywhere else is still followed.
 * `destDir` is the path as the caller named it (the link); `destTarget` is
 * where it resolves, which is what is compared.
 */
export async function assertNoSelfOverlap(sourceDir: string, destDir: string, destTarget: string = destDir): Promise<void> {
  const source = await realpathLenient(sourceDir);
  const target = await realpathLenient(destTarget);
  // The swap stages at `<target>.tmp`, backs up at `<target>.bak`, and REMOVES
  // both before it copies: a source sitting at either is deleted before a
  // single file is read from it, so they count as the target here.
  const swapPaths = [target, `${target}.tmp`, `${target}.bak`];
  if (!swapPaths.some((path) => containsPath(source, path) || containsPath(path, source))) return;
  const via = destTarget === destDir ? "" : ` -> ${destTarget}`;
  throw new Error(
    `refusing to install into ${destDir}${via}: it is the package's own source directory (${sourceDir}); ` +
    "remove the link or point it elsewhere",
  );
}

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
    // Defensive bound only: a real cyclic chain throws ELOOP from realpath above
    // and never reaches here; this caps a pathological all-dangling chain.
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
