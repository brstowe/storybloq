import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile, readdir, lstat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { atomicWriteFollowingSymlink } from "../../src/core/symlink-write.js";

// Issue Storybloq/storybloq#12: rename(2) replaces a symlink with a regular
// file. atomicWriteFollowingSymlink must resolve a symlinked target and write
// through to the real file, preserving the link. Every test that touches
// symlinks is skipped on Windows (symlink creation needs elevation there).

describe("atomicWriteFollowingSymlink", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `storybloq-symwrite-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("preserves a live symlink and writes through to the real target", async () => {
    if (process.platform === "win32") return;
    const real = join(dir, "real.json");
    const link = join(dir, "link.json");
    await writeFile(real, "old", "utf-8");
    await symlink(real, link);

    await atomicWriteFollowingSymlink(link, "new");

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf-8")).toBe("new");
    expect(await readFile(link, "utf-8")).toBe("new");
    const names = await readdir(dir);
    expect(names.some((n) => n.includes(".tmp"))).toBe(false);
  });

  it("updates a regular file in place without turning it into a symlink", async () => {
    const target = join(dir, "plain.json");
    await writeFile(target, "old", "utf-8");

    await atomicWriteFollowingSymlink(target, "new");

    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    expect(await readFile(target, "utf-8")).toBe("new");
  });

  it("creates a regular file when the target is missing", async () => {
    const target = join(dir, "missing.json");

    await atomicWriteFollowingSymlink(target, "fresh");

    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    expect(await readFile(target, "utf-8")).toBe("fresh");
  });

  it("preserves a DANGLING symlink and creates its intended target (does not clobber the link)", async () => {
    if (process.platform === "win32") return;
    const realMissing = join(dir, "dotfiles", "settings.json"); // parent dir does not exist yet
    const link = join(dir, "link.json");
    await symlink(realMissing, link);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);

    await atomicWriteFollowingSymlink(link, "healed");

    // The link itself must remain a symlink, NOT be replaced by a regular file.
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    // The link's intended target was created and now carries the content.
    expect(await readFile(realMissing, "utf-8")).toBe("healed");
  });

  it("follows a relative symlink", async () => {
    if (process.platform === "win32") return;
    const real = join(dir, "real.json");
    const link = join(dir, "link.json");
    await writeFile(real, "old", "utf-8");
    await symlink("real.json", link); // relative target

    await atomicWriteFollowingSymlink(link, "rel");

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf-8")).toBe("rel");
  });

  it("follows a chained symlink to the final real target", async () => {
    if (process.platform === "win32") return;
    const real = join(dir, "real.json");
    const mid = join(dir, "mid.json");
    const link = join(dir, "link.json");
    await writeFile(real, "old", "utf-8");
    await symlink(real, mid);
    await symlink(mid, link);

    await atomicWriteFollowingSymlink(link, "chain");

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect((await lstat(mid)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf-8")).toBe("chain");
  });

  it("throws on a cyclic symlink rather than clobbering", async () => {
    if (process.platform === "win32") return;
    const a = join(dir, "a");
    const b = join(dir, "b");
    await symlink(b, a);
    await symlink(a, b); // a -> b -> a

    await expect(atomicWriteFollowingSymlink(a, "x")).rejects.toThrow();
    // The link is still a link; it was never replaced.
    expect((await lstat(a)).isSymbolicLink()).toBe(true);
  });
});
