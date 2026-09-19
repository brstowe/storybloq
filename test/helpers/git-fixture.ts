/**
 * ISS-1220: the single git entry point for every test fixture.
 *
 * Incident (2026-09-14): the production shared checkout's `.git/config` was
 * rewritten with `core.bare = true` and a `[user]` section (t@t.t) while a
 * fixture ran from a linked worktree of this repo. Every git command on the
 * checkout then failed with "this operation must be run in a work tree".
 *
 * Two independent escape routes reach the real repository from a test, and
 * this module closes both:
 *
 *   1. INHERITED ENV. `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`/
 *      `GIT_INDEX_FILE`/`GIT_OBJECT_DIRECTORY` point git at a repository
 *      regardless of cwd. They are DELETED, not blanked: git treats an empty
 *      `GIT_DIR` as unset in some versions but not all, so absence is the
 *      only state that is safe everywhere.
 *
 *   2. UPWARD DISCOVERY. Deleting those vars is NOT sufficient on its own --
 *      git still walks parent directories looking for a `.git`. Verified
 *      against this checkout: with no GIT_* set,
 *      `git -C storybloq/test rev-parse --git-common-dir` resolves to the
 *      production `/Users/amirshayegh/Developer/CPM/.git`. So every call also
 *      asserts its cwd is under a temp root, and sets
 *      `GIT_CEILING_DIRECTORIES` so discovery stops at the fixture even if a
 *      guard is ever bypassed.
 *
 * `git config --global` is a third route that neither of the above covers, so
 * global/system config is redirected to throwaway files as well.
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Deleted from every fixture git child's environment. */
export const GIT_ESCAPE_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
] as const;

/**
 * Thrown when a fixture would have run git somewhere other than a temp root.
 * A distinct class so a broad `catch` can re-throw it rather than fold it
 * into an ordinary git failure.
 */
export class FixtureIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureIsolationError";
  }
}

/**
 * A violation must fail the run even if nothing re-throws it.
 *
 * An existing assertion shaped `expect(() => git(...)).toThrow()` would catch
 * a `FixtureIsolationError` and go GREEN -- reporting a sandbox breach as the
 * git failure it was expecting. ISS-1220 forbids editing those assertions, so
 * the throw alone cannot be the whole guard: the violation is also recorded
 * here, and `test/setup.ts`'s `afterAll` fails the file when it is set.
 * `globalThis` rather than a module-level variable so a split module registry
 * cannot separate the recorder from the reader.
 */
const VIOLATION_KEY = Symbol.for("storybloq.iss1220.fixtureIsolationViolation");

interface ViolationCarrier {
  [VIOLATION_KEY]?: string;
}

function recordViolation(message: string): void {
  const carrier = globalThis as ViolationCarrier;
  // First violation wins: it is the one with the untainted stack.
  if (carrier[VIOLATION_KEY] === undefined) carrier[VIOLATION_KEY] = message;
}

/** The recorded violation for this process, if any. Read by test/setup.ts. */
export function recordedIsolationViolation(): string | undefined {
  return (globalThis as ViolationCarrier)[VIOLATION_KEY];
}

/** Clears the recorded violation. Only this module's own tests should call it. */
export function clearIsolationViolation(): void {
  delete (globalThis as ViolationCarrier)[VIOLATION_KEY];
}

/**
 * Every spelling of the temp root that a fixture may legitimately present.
 * On macOS `os.tmpdir()` is `/var/folders/...` while its realpath is
 * `/private/var/folders/...`; `mkdtempSync` returns the former and
 * `realpathSync(mkdtempSync(...))` -- which several fixtures use -- the
 * latter. Both are valid, so both are accepted.
 */
function tempRoots(): string[] {
  const roots = [resolve(tmpdir())];
  try {
    const real = realpathSync(tmpdir());
    if (!roots.includes(real)) roots.push(real);
  } catch {
    // tmpdir() must exist; if realpath fails, the logical spelling stands alone.
  }
  return roots;
}

function isUnder(path: string, root: string): boolean {
  // `relative` rather than string prefixing: it is segment-aware (so
  // `/tmp/foo-evil` cannot pass for the root `/tmp/foo`) and it does not
  // assume case-sensitive comparison the way startsWith does.
  const rel = relative(root, path);
  // `startsWith("..")` alone would falsely reject a directory legitimately
  // NAMED "..evil"; only an exact ".." or a ".." path SEGMENT is traversal.
  const escapes = rel === ".." || rel.startsWith(".." + sep);
  return rel === "" || (!escapes && !isAbsolute(rel));
}

/**
 * Fails closed unless `cwd` is under a temp root. `undefined` is the most
 * dangerous input, not the most innocent: it means `execFileSync` would
 * inherit `process.cwd()`, which under vitest is the production checkout.
 * That is the live shape at `test/core/remote-refs.test.ts:73-74`.
 */
export function assertFixtureCwd(cwd: string | undefined, label: string): string {
  if (cwd === undefined || cwd === "") {
    const message =
      `ISS-1220: ${label} was called without a cwd. An omitted cwd inherits process.cwd(), ` +
      `which under vitest is the real repository -- this is exactly how the production ` +
      `.git/config was rewritten on 2026-09-14. Pass an explicit fixture root under os.tmpdir().`;
    recordViolation(message);
    throw new FixtureIsolationError(message);
  }

  const resolved = resolve(cwd);
  const candidates = [resolved];
  try {
    const real = realpathSync(resolved);
    if (real !== resolved) candidates.push(real);
  } catch {
    // A not-yet-created fixture dir is judged on its logical path alone.
  }

  const roots = tempRoots();
  if (candidates.some((c) => roots.some((r) => isUnder(c, r)))) return resolved;

  const message =
    `ISS-1220: ${label} was pointed at ${resolved}, which is not under a temp root ` +
    `(${roots.join(", ")}). A fixture must never run git against a real checkout -- ` +
    `create the fixture with mkdtempSync(join(tmpdir(), ...)) instead.`;
  recordViolation(message);
  throw new FixtureIsolationError(message);
}

/**
 * Throwaway global/system config, shared per process.
 *
 * NOT placed inside the fixture repo: a stray `gitconfig-global` file there
 * would show up as untracked in the `git status --porcelain` assertions that
 * several fixtures make, and ISS-1220 forbids editing those assertions.
 *
 * `/dev/null` is deliberately not used: git writes config through a `.lock`
 * sibling, so `GIT_CONFIG_GLOBAL=/dev/null git config --global ...` fails with
 * "could not lock config file /dev/null: Operation not permitted". A fixture
 * that legitimately writes a global config must succeed, into a file nobody
 * reads.
 */
let sandboxConfigDir: string | undefined;

function configSandbox(): { global: string; system: string } {
  if (sandboxConfigDir === undefined) {
    // mkdtempSync, NOT a pid-derived name: vitest's pool is a configuration
    // detail (threads share a pid, forks do not), and a sandbox whose safety
    // depends on which pool is configured is a latent race. A unique
    // directory is correct under either, and costs nothing.
    sandboxConfigDir = mkdtempSync(join(tmpdir(), "storybloq-fixture-gitconfig-"));
    for (const name of ["global", "system"]) {
      writeFileSync(join(sandboxConfigDir, name), "", { flag: "a" });
    }
  }
  return { global: join(sandboxConfigDir, "global"), system: join(sandboxConfigDir, "system") };
}

/**
 * The ceiling that stops upward discovery. Realpath'd where possible: git
 * resolves symlinks in ceiling entries by default, so either spelling works
 * today, but the physical path costs nothing and survives a change of default.
 */
function ceilingFor(root: string): string {
  const parent = dirname(resolve(root));
  try {
    return realpathSync(parent);
  } catch {
    return parent; // parent not created yet -- the logical path is still a valid ceiling
  }
}

/**
 * The environment for a fixture git child.
 *
 * `GIT_CEILING_DIRECTORIES` is OVERWRITTEN, never appended to an inherited
 * value. An empty entry in that variable disables symlink resolution for
 * every entry after it (verified: `GIT_CEILING_DIRECTORIES=":$tmp/repo/nested"`
 * is ignored and discovery walks straight past it), so an inherited value
 * could silently void the ceiling set here.
 */
export function fixtureGitEnv(
  root: string,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const sandbox = configSandbox();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...overrides,
    GIT_CEILING_DIRECTORIES: ceilingFor(root),
    GIT_CONFIG_GLOBAL: sandbox.global,
    GIT_CONFIG_SYSTEM: sandbox.system,
  };
  for (const key of GIT_ESCAPE_VARS) delete env[key];
  return env;
}

export interface FixtureGitOptions {
  /** Extra environment for this call (e.g. GIT_MERGE_AUTOEDIT). Cannot widen isolation. */
  readonly env?: Record<string, string>;
  readonly stdio?: "pipe" | "ignore" | "inherit";
  /** Label used in isolation errors, so a failure names the fixture that caused it. */
  readonly label?: string;
}

/**
 * Run git against a fixture. Asserts the cwd, scrubs the environment, returns
 * trimmed stdout, and throws on a non-zero exit exactly as `execFileSync` does.
 */
export function git(root: string, args: string[], opts: FixtureGitOptions = {}): string {
  const label = opts.label ?? `git ${args[0] ?? ""}`.trim();
  const cwd = assertFixtureCwd(root, label);
  const out = execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: fixtureGitEnv(cwd, opts.env),
    stdio: opts.stdio ?? "pipe",
  });
  // `stdio: "ignore"` yields null rather than a string.
  return typeof out === "string" ? out.trim() : "";
}

/**
 * Shell-string form, for the fixtures that build a command line rather than an
 * argv array (`git("commit -m 'initial'")`).
 *
 * Re-tokenizing those strings into argv would change what the quotes mean and
 * therefore what the fixture does, and ISS-1220 forbids changing test
 * behaviour -- so the shell is preserved and only the two escape routes are
 * closed. `command` is the part AFTER "git".
 */
export function gitShell(root: string, command: string, opts: FixtureGitOptions = {}): string {
  const cwd = assertFixtureCwd(root, opts.label ?? `git ${command}`);
  const out = execSync(`git ${command}`, {
    cwd,
    encoding: "utf-8",
    env: fixtureGitEnv(cwd, opts.env),
    stdio: opts.stdio === "ignore" ? "ignore" : ["ignore", "pipe", "pipe"],
  });
  return typeof out === "string" ? out.trim() : "";
}

/**
 * Generic shell runner for fixtures whose helper is not git-specific but whose
 * every call is a git command against a fixture root.
 */
export function fixtureShell(root: string, command: string): string {
  const cwd = assertFixtureCwd(root, command);
  const out = execSync(command, {
    cwd,
    encoding: "utf-8",
    env: fixtureGitEnv(cwd),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return typeof out === "string" ? out.trim() : "";
}

export interface FixtureGitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run git without throwing on a non-zero exit -- for call sites that assert on
 * a failure (merge conflicts, invalid refs).
 *
 * The cwd assertion runs BEFORE the try/catch and is never inside it. A broad
 * catch here would otherwise convert an isolation breach into an ordinary
 * "git exited non-zero" result, and the guard would appear to have fired while
 * actually having been silenced.
 */
export function gitAllowFailure(
  root: string,
  args: string[],
  opts: FixtureGitOptions = {},
): FixtureGitResult {
  const label = opts.label ?? `git ${args[0] ?? ""}`.trim();
  const cwd = assertFixtureCwd(root, label); // outside the try, deliberately
  const env = fixtureGitEnv(cwd, opts.env);
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf-8", env, stdio: "pipe" });
    return { status: 0, stdout: stdout ?? "", stderr: "" };
  } catch (err: unknown) {
    if (err instanceof FixtureIsolationError) throw err; // never swallowed
    const e = err as { status?: number; stdout?: string; stderr?: string };
    // A spawn failure (ENOENT, an invalid cwd) carries no stdout/stderr at
    // all; without this fallback the caller sees status 1 and two empty
    // strings, which is impossible to debug.
    const fallback = err instanceof Error ? err.message : String(err);
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? fallback };
  }
}
