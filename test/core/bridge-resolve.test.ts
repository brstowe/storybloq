/**
 * T-509 part 2: locating the bundled codex-claude-bridge without spawning it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { nativeRebuildDir, ownerPackageDir, resolveBundledBridge } from "../../src/core/bridge-resolve.js";

let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

/** A fake install: <base>/app/index.js requiring node_modules/codex-claude-bridge. */
function fakeInstall(opts: { bin?: unknown; main?: string; writeEntry?: boolean; version?: string } = {}): { from: string; pkgDir: string; entry: string } {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "bridge-resolve-")));
  const app = join(dir, "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "index.js"), "");
  const pkgDir = join(app, "node_modules", "codex-claude-bridge");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  const pkg: Record<string, unknown> = { name: "codex-claude-bridge", version: opts.version ?? "1.8.0" };
  if (opts.bin !== undefined) pkg.bin = opts.bin;
  if (opts.main !== undefined) pkg.main = opts.main;
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkg));
  const entry = join(pkgDir, "dist", "index.js");
  if (opts.writeEntry !== false) writeFileSync(entry, "#!/usr/bin/env node\n");
  return { from: pathToFileURL(join(app, "index.js")).href, pkgDir, entry };
}

describe("resolveBundledBridge", () => {
  it("installed: object-form bin resolves to the entry, with the package dir and version", () => {
    const f = fakeInstall({ bin: { "codex-claude-bridge": "dist/index.js" } });
    expect(resolveBundledBridge({ from: f.from })).toEqual({ kind: "installed", packageDir: f.pkgDir, entry: f.entry, version: "1.8.0" });
  });
  it("installed: string-form bin and a main fallback both resolve", () => {
    const a = fakeInstall({ bin: "dist/index.js" });
    expect(resolveBundledBridge({ from: a.from })).toMatchObject({ kind: "installed", entry: a.entry });
    rmSync(dir!, { recursive: true, force: true });
    const b = fakeInstall({ main: "./dist/index.js" });
    expect(resolveBundledBridge({ from: b.from })).toMatchObject({ kind: "installed", entry: b.entry });
  });
  it("absent: the package is not installed at all", () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "bridge-resolve-")));
    writeFileSync(join(dir, "index.js"), "");
    expect(resolveBundledBridge({ from: pathToFileURL(join(dir, "index.js")).href })).toEqual({ kind: "absent" });
  });
  it("unusable: a bin that escapes the package, an absolute bin, or a bin naming a directory", () => {
    const a = fakeInstall({ bin: "../../outside.js" });
    writeFileSync(join(dir!, "app", "outside.js"), "");
    expect(resolveBundledBridge({ from: a.from })).toMatchObject({ kind: "unusable", reason: expect.stringMatching(/escapes the package/) });
    rmSync(dir!, { recursive: true, force: true });
    const b = fakeInstall({ bin: "/bin/sh" });
    expect(resolveBundledBridge({ from: b.from })).toMatchObject({ kind: "unusable", reason: expect.stringMatching(/escapes the package/) });
    rmSync(dir!, { recursive: true, force: true });
    const c = fakeInstall({ bin: "dist" });
    expect(resolveBundledBridge({ from: c.from })).toMatchObject({ kind: "unusable", reason: expect.stringMatching(/entry file missing/) });
  });
  it("unusable: an in-package entry that is a symlink to a file outside the package", () => {
    const f = fakeInstall({ bin: "dist/index.js", writeEntry: false });
    const outside = join(dir!, "payload.js");
    writeFileSync(outside, "");
    symlinkSync(outside, f.entry);
    expect(resolveBundledBridge({ from: f.from })).toMatchObject({ kind: "unusable", reason: expect.stringMatching(/escapes the package/) });
  });
  it("unusable: a package.json that is valid JSON but not an object (null, an array)", () => {
    const f = fakeInstall({ bin: "dist/index.js" });
    // Node's resolver may reject the file first ("Invalid package config");
    // either way the answer is unusable with a reason, never a throw.
    writeFileSync(join(f.pkgDir, "package.json"), "null");
    expect(resolveBundledBridge({ from: f.from })).toMatchObject({ kind: "unusable", reason: expect.stringMatching(/package.json is not an object|Invalid package config/) });
    writeFileSync(join(f.pkgDir, "package.json"), "[1]");
    expect(resolveBundledBridge({ from: f.from })).toMatchObject({ kind: "unusable", reason: expect.stringMatching(/package.json is not an object|Invalid package config/) });
  });
  it("unusable: installed but the entry file is missing, with the reason", () => {
    const f = fakeInstall({ bin: { "codex-claude-bridge": "dist/index.js" }, writeEntry: false });
    const r = resolveBundledBridge({ from: f.from });
    expect(r.kind).toBe("unusable");
    expect((r as { reason: string }).reason).toMatch(/entry file missing/);
  });
});

describe("ownerPackageDir", () => {
  it("walks up from the real executable to the package whose name is codex-claude-bridge, through a symlinked launcher", () => {
    const f = fakeInstall({ bin: { "codex-claude-bridge": "dist/index.js" } });
    const binDir = join(dir!, "bin");
    mkdirSync(binDir);
    const link = join(binDir, "codex-claude-bridge");
    symlinkSync(f.entry, link);
    expect(ownerPackageDir(link)).toBe(f.pkgDir);
    expect(ownerPackageDir(f.entry)).toBe(f.pkgDir);
  });
  it("is null for a file owned by another package, an absent path, or no package at all", () => {
    const f = fakeInstall({ bin: { "codex-claude-bridge": "dist/index.js" } });
    const other = join(dir!, "app", "node_modules", "other");
    mkdirSync(join(other, "dist"), { recursive: true });
    writeFileSync(join(other, "package.json"), JSON.stringify({ name: "other" }));
    writeFileSync(join(other, "dist", "index.js"), "");
    expect(ownerPackageDir(join(other, "dist", "index.js"))).toBeNull();
    expect(ownerPackageDir(join(dir!, "missing.js"))).toBeNull();
    // A dependency nested inside the bridge is owned by ITS package, not the bridge.
    const nested = join(f.pkgDir, "node_modules", "better-sqlite3");
    mkdirSync(join(nested, "build"), { recursive: true });
    writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "better-sqlite3" }));
    writeFileSync(join(nested, "build", "x.node"), "");
    expect(ownerPackageDir(join(nested, "build", "x.node"))).toBeNull();
    // ... and still not when that nested package.json is unreadable.
    writeFileSync(join(nested, "package.json"), "{ broken");
    expect(ownerPackageDir(join(nested, "build", "x.node"))).toBeNull();
    expect(ownerPackageDir(f.entry.replace("codex-claude-bridge", "codex-claude-bridge-x"))).toBeNull();
  });
});

describe("nativeRebuildDir", () => {
  function sqlite(at: string): void {
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "12.0.0" }));
  }
  it("is the install root that owns the better-sqlite3 the bridge resolves: the HOIST parent, not the bridge package", () => {
    // Bundled layout: <app>/node_modules/{codex-claude-bridge,better-sqlite3}. npm rebuild must run in <app>.
    const f = fakeInstall({ bin: { "codex-claude-bridge": "dist/index.js" } });
    sqlite(join(dir!, "app", "node_modules", "better-sqlite3"));
    expect(nativeRebuildDir(f.entry)).toBe(join(dir!, "app"));
  });
  it("is the bridge package when better-sqlite3 is nested inside it", () => {
    const f = fakeInstall({ bin: { "codex-claude-bridge": "dist/index.js" } });
    sqlite(join(f.pkgDir, "node_modules", "better-sqlite3"));
    expect(nativeRebuildDir(f.entry)).toBe(f.pkgDir);
  });
  it("is null when the executable is not the bridge's, or better-sqlite3 does not resolve from it", () => {
    const f = fakeInstall({ bin: { "codex-claude-bridge": "dist/index.js" } });
    expect(nativeRebuildDir(f.entry)).toBeNull();
    const other = join(dir!, "app", "node_modules", "other", "dist");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(dir!, "app", "node_modules", "other", "package.json"), JSON.stringify({ name: "other" }));
    writeFileSync(join(other, "index.js"), "");
    sqlite(join(dir!, "app", "node_modules", "better-sqlite3"));
    expect(nativeRebuildDir(join(other, "index.js"))).toBeNull();
    expect(nativeRebuildDir(join(dir!, "missing.js"))).toBeNull();
  });
});
