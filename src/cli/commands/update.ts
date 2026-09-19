/**
 * T-518: `storybloq update`, the one command that replaces the two people
 * kept forgetting one of: install the newest package, then re-run setup so
 * the skill, the Mods copy and the hooks match it, then say restart.
 *
 * PREFIX. Everything happens in the prefix of the Node that is running this
 * CLI: `npm` is taken from beside `process.execPath`, and the binary that is
 * re-exec'd afterwards is that prefix's own `bin/storybloq`. Under nvm, fnm
 * or volta the `npm` on PATH can belong to another Node, and installing
 * there would leave this CLI exactly as old as before. The PATH walk is the
 * fallback only where the prefix has no launcher.
 *
 * The setup step is a RE-EXEC of the freshly installed binary, never
 * `handleSetup` in this process. The CLI is ESM with lazy `await import()`s,
 * so once `npm install -g` has replaced `dist/`, a module this process
 * imports later comes from the new dist while the ones already loaded are
 * old; running setup from that mix is how a half-updated copy gets written.
 *
 * Windows never runs npm from here: the OS locks the running `cli.js` and
 * `storybloq.cmd`, so the install fails with EPERM or EBUSY partway and can
 * leave the package half replaced. There the command prints the two manual
 * steps and exits clean.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveGlobalStorybloqBin, resolveStorybloqBin } from "./setup-skill.js";

export type UpdateClient = "claude" | "codex" | "all";

export const UPDATE_PACKAGE_SPEC = "@storybloq/storybloq@latest";

export interface UpdateRunOptions {
  readonly stdio: "inherit" | "pipe";
  readonly encoding: "utf-8";
}

/** Test seams. Production callers pass none of these. */
export interface UpdateDeps {
  /** `execFileSync` with `encoding: "utf-8"`, so it answers a string. */
  readonly run: (cmd: string, args: readonly string[], opts: UpdateRunOptions) => string;
  /** The directory of the running Node binary: `dirname(process.execPath)`. */
  readonly execDir: string;
  /** The PATH-walk fallback for the binary when the prefix has no launcher. */
  readonly fallbackBin: () => string | null;
  readonly platform: NodeJS.Platform;
  readonly currentVersion: string;
  readonly log: (line: string) => void;
  readonly warn: (line: string) => void;
}

export interface UpdateOptions {
  readonly client?: UpdateClient;
}

/** npm beside the running Node, so the install lands in this CLI's own prefix. */
export function npmInPrefix(execDir: string): string {
  const beside = join(execDir, "npm");
  return existsSync(beside) ? beside : "npm";
}

/** This prefix's launcher once npm has written it; the PATH walk only failing that. */
export function storybloqInPrefix(execDir: string, fallback: () => string | null): string {
  const beside = join(execDir, "storybloq");
  if (existsSync(beside)) return beside;
  return fallback() ?? "storybloq";
}

function defaultFallbackBin(): string | null {
  return resolveGlobalStorybloqBin() ?? resolveStorybloqBin();
}

export function manualUpdateLines(client: UpdateClient): readonly string[] {
  return [
    "Windows keeps the running storybloq files locked, so this command cannot replace them from inside. In a fresh terminal run:",
    `  npm install -g ${UPDATE_PACKAGE_SPEC}`,
    `  storybloq setup --client ${client}`,
    `then restart ${restartTargets(client)}.`,
  ];
}

function restartTargets(client: UpdateClient): string {
  return client === "claude" ? "Claude Code" : client === "codex" ? "Codex" : "Claude Code and Codex";
}

export async function handleUpdate(options: UpdateOptions = {}, deps: Partial<UpdateDeps> = {}): Promise<void> {
  const client = options.client ?? "all";
  const platform = deps.platform ?? process.platform;
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const warn = deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const before = deps.currentVersion ?? process.env.STORYBLOQ_VERSION ?? "0.0.0-dev";

  if (platform === "win32") {
    for (const line of manualUpdateLines(client)) log(line);
    return;
  }

  const run = deps.run ?? ((cmd, args, opts) => execFileSync(cmd, [...args], opts));
  const execDir = deps.execDir ?? dirname(process.execPath);
  const npm = npmInPrefix(execDir);

  log(`Installing ${UPDATE_PACKAGE_SPEC} with ${npm} (you have ${before})...`);
  try {
    run(npm, ["install", "-g", UPDATE_PACKAGE_SPEC], { stdio: "inherit", encoding: "utf-8" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`storybloq update: npm install failed (${msg}). Nothing else was changed; setup was not run.`);
    process.exitCode = 1;
    return;
  }

  const bin = storybloqInPrefix(execDir, deps.fallbackBin ?? defaultFallbackBin);

  let after = "the installed version";
  try {
    const text = run(bin, ["--version"], { stdio: "pipe", encoding: "utf-8" }).trim();
    if (text !== "") after = text;
  } catch {
    // The version line is a courtesy; setup is the step that matters.
  }

  // A re-exec of the NEW binary, not handleSetup here: see the module comment.
  try {
    run(bin, ["setup", "--client", client], { stdio: "inherit", encoding: "utf-8" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`storybloq update: the package is installed but setup failed (${msg}). Run \`storybloq setup --client ${client}\` to finish.`);
    process.exitCode = 1;
    return;
  }

  log(`Updated storybloq ${before} -> ${after}. Restart ${restartTargets(client)} now.`);
}
