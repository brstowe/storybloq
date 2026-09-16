/**
 * T-509: locating the bundled codex-claude-bridge without running it.
 *
 * The bridge ships as an optionalDependency of this package, so it may be
 * installed, absent (its native module failed to build and npm skipped it),
 * or present but unusable. Setup and health need that distinction spelled
 * out; neither ever spawns anything from here.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const BRIDGE_PACKAGE_NAME = "codex-claude-bridge";

export type BundledBridge =
  | { readonly kind: "installed"; readonly packageDir: string; readonly entry: string; readonly version: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unusable"; readonly reason: string };

export interface ResolveOptions {
  /** Module URL or path to resolve FROM; defaults to this module. */
  readonly from?: string;
}

export function resolveBundledBridge(opts: ResolveOptions = {}): BundledBridge {
  let pkgPath: string;
  try {
    pkgPath = createRequire(opts.from ?? import.meta.url).resolve(`${BRIDGE_PACKAGE_NAME}/package.json`);
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "MODULE_NOT_FOUND") return { kind: "absent" };
    return { kind: "unusable", reason: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch (err: unknown) {
    return { kind: "unusable", reason: `package.json unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Valid JSON is not necessarily an object (`null`, an array): say so
  // instead of throwing on the first field read.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unusable", reason: "package.json is not an object" };
  }
  const pkg = parsed as { version?: unknown; bin?: unknown; main?: unknown };
  const rel = binOf(pkg.bin) ?? (typeof pkg.main === "string" ? pkg.main : null) ?? "dist/index.js";
  // The entry is later EXECUTED by whoever registers it, so it must be a
  // regular file inside the package: no absolute bin, no `..` escape, and no
  // in-package symlink pointing outside. Containment is checked on REAL paths.
  if (isAbsolute(rel) || !contains(dirname(pkgPath), resolve(dirname(pkgPath), rel))) {
    return { kind: "unusable", reason: `entry escapes the package: ${rel}` };
  }
  let packageDir: string;
  let entry: string;
  try {
    packageDir = realpathSync(dirname(pkgPath));
    entry = realpathSync(resolve(packageDir, rel));
  } catch {
    return { kind: "unusable", reason: `entry file missing: ${resolve(dirname(pkgPath), rel)}` };
  }
  if (!contains(packageDir, entry)) return { kind: "unusable", reason: `entry escapes the package: ${rel} -> ${entry}` };
  if (!isRegularFile(entry)) return { kind: "unusable", reason: `entry file missing: ${entry}` };
  return { kind: "installed", packageDir, entry, version: typeof pkg.version === "string" ? pkg.version : "unknown" };
}

/** True when `child` is strictly inside `dir` (lexically; callers pass real paths). */
function contains(dir: string, child: string): boolean {
  const inside = relative(dir, child);
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function binOf(bin: unknown): string | null {
  if (typeof bin === "string") return bin;
  if (bin && typeof bin === "object" && !Array.isArray(bin)) {
    const named = (bin as Record<string, unknown>)[BRIDGE_PACKAGE_NAME];
    if (typeof named === "string") return named;
    const first = Object.values(bin as Record<string, unknown>).find((v) => typeof v === "string");
    if (typeof first === "string") return first;
  }
  return null;
}

/**
 * The directory of the package that OWNS an executable: the real path is
 * walked upward to the NEAREST package.json, which decides. Its name must be
 * the bridge's; a nested dependency's package.json answers null, so rebuild
 * advice never names a guessed directory.
 */
export function ownerPackageDir(executablePath: string): string | null {
  let real: string;
  try {
    real = realpathSync(executablePath);
  } catch {
    return null;
  }
  let cur = dirname(real);
  for (;;) {
    const candidate = join(cur, "package.json");
    if (existsSync(candidate)) {
      try {
        const name = (JSON.parse(readFileSync(candidate, "utf-8")) as { name?: unknown }).name;
        return name === BRIDGE_PACKAGE_NAME ? cur : null;
      } catch {
        // The nearest package.json decides even when it cannot be read: an
        // outer bridge package must not claim a nested dependency's file.
        return null;
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Where `npm rebuild better-sqlite3` must run for the bridge at this
 * executable: the install root that OWNS the better-sqlite3 the bridge
 * resolves. In the bundled layout that module is hoisted beside the bridge
 * (`<storybloq>/node_modules/{codex-claude-bridge,better-sqlite3}`), so the
 * bridge's own directory is the wrong answer: npm rebuild there finds no
 * such dependency and reports success. Null when the executable is not the
 * bridge's or better-sqlite3 does not resolve from it, so advice never names
 * a guessed directory.
 */
export function nativeRebuildDir(executablePath: string): string | null {
  const owner = ownerPackageDir(executablePath);
  if (owner === null) return null;
  let sqlitePkg: string;
  try {
    sqlitePkg = realpathSync(createRequire(join(owner, "package.json")).resolve("better-sqlite3/package.json"));
  } catch {
    return null;
  }
  // <root>/node_modules/better-sqlite3/package.json -> <root>
  const pkgDir = dirname(sqlitePkg);
  const modules = dirname(pkgDir);
  return modules.endsWith("node_modules") ? dirname(modules) : null;
}
