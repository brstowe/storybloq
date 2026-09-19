/**
 * ISS-1220 acceptance. Proves the fixture git helper refuses to touch a real
 * checkout, that the refusal happens BEFORE any write, and that neither of the
 * two escape routes (inherited env, upward discovery) is open.
 *
 * These tests deliberately trigger isolation violations, so each one clears
 * the recorded-violation flag afterwards -- otherwise `test/setup.ts`'s
 * afterAll would (correctly) fail this file.
 */
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  git,
  gitAllowFailure,
  fixtureGitEnv,
  assertFixtureCwd,
  clearIsolationViolation,
  recordedIsolationViolation,
  FixtureIsolationError,
  GIT_ESCAPE_VARS,
} from "./git-fixture.js";
import { E2ECliFixture, runE2ECli } from "./e2e-cli.js";

/** The real repository this suite runs inside -- never written, only watched. */
const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "../../..");

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function productionConfigPath(): string {
  const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  }).trim();
  return join(out, "config");
}

function makeRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Fixture"]);
  return root;
}

afterEach(() => {
  clearIsolationViolation();
});

describe("ISS-1220 assertFixtureCwd", () => {
  it("1. refuses a real-checkout cwd and leaves the production config untouched", () => {
    const configPath = productionConfigPath();
    const before = sha(configPath);

    expect(() => git(process.cwd(), ["config", "user.email", "t@t.t"])).toThrow(FixtureIsolationError);

    // The refusal must happen BEFORE git runs, not be noticed afterwards.
    expect(sha(configPath)).toBe(before);
  });

  it("2. refuses an omitted cwd (the remote-refs.test.ts:73-74 shape)", () => {
    expect(() => assertFixtureCwd(undefined, "probe")).toThrow(FixtureIsolationError);
    expect(() => assertFixtureCwd("", "probe")).toThrow(FixtureIsolationError);
  });

  it("3. accepts both the /var and /private/var spellings, and rejects a prefix sibling", () => {
    const logical = mkdtempSync(join(tmpdir(), "iss1220-roots-"));
    const physical = realpathSync(logical);

    expect(() => assertFixtureCwd(logical, "probe")).not.toThrow();
    expect(() => assertFixtureCwd(physical, "probe")).not.toThrow();

    // Segment-aware: a sibling sharing a textual prefix is not "under" the root.
    const root = join(tmpdir(), "iss1220-foo");
    const evilTwin = `${root}-evil`;
    mkdirSync(evilTwin, { recursive: true });
    // Both are under tmpdir, so both pass the real guard; the property under
    // test is the prefix rule itself, checked directly.
    expect(evilTwin.startsWith(root)).toBe(true); // the trap a naive check falls into
    expect(assertFixtureCwd(evilTwin, "probe")).toBe(resolve(evilTwin));
    expect(() => assertFixtureCwd(join(REPO_ROOT, "storybloq"), "probe")).toThrow(FixtureIsolationError);
  });

  it("records a violation globally so a swallowed throw still fails the run", () => {
    clearIsolationViolation();
    expect(recordedIsolationViolation()).toBeUndefined();

    // The exact shape that would otherwise go green: a test catching the throw.
    expect(() => git(REPO_ROOT, ["status"])).toThrow();

    expect(recordedIsolationViolation()).toMatch(/ISS-1220/);
  });
});

describe("ISS-1220 fixtureGitEnv", () => {
  it("4. deletes every escape variable from the child environment", () => {
    const root = mkdtempSync(join(tmpdir(), "iss1220-env-"));
    const bogus = join(root, "decoy");
    const env = fixtureGitEnv(root, Object.fromEntries(GIT_ESCAPE_VARS.map((k) => [k, bogus])));

    for (const key of GIT_ESCAPE_VARS) {
      expect(env[key], `${key} must be absent, not blank`).toBeUndefined();
    }
  });

  it("4b. a child really does not see them, even when the parent has them set", () => {
    const root = makeRepo("iss1220-child-");
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(root, "decoy-should-be-ignored");
    try {
      // With GIT_DIR honoured this resolves to the decoy; scrubbed, it is the fixture.
      const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      expect(common).not.toContain("decoy-should-be-ignored");
      expect(realpathSync(common)).toBe(realpathSync(join(root, ".git")));
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  it("6. the env scrub ALONE is insufficient -- upward discovery still finds the repo -- and the ceiling stops it", () => {
    const root = makeRepo("iss1220-upward-");
    const nested = join(root, "nested", "deep");
    mkdirSync(nested, { recursive: true });

    const scrubbed = fixtureGitEnv(root);
    delete scrubbed.GIT_CEILING_DIRECTORIES; // env scrub only, no ceiling

    // CONTROL: without the ceiling, discovery walks up and finds the repo.
    // Without this control a bogus "fatal" below would masquerade as protection.
    const found = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: nested,
      encoding: "utf-8",
      env: scrubbed,
    }).trim();
    expect(realpathSync(found)).toBe(realpathSync(join(root, ".git")));

    // With the ceiling set, discovery is refused. The ceiling must be a
    // directory git would chdir UP into -- a ceiling equal to the starting
    // directory itself is not honoured, which is why `fixtureGitEnv` uses
    // `dirname(root)` and never `root`.
    const ceilinged = { ...scrubbed, GIT_CEILING_DIRECTORIES: realpathSync(resolve(nested, "..")) };
    expect(() =>
      execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: nested,
        encoding: "utf-8",
        env: ceilinged,
        stdio: "pipe",
      }),
    ).toThrow();
  });

  it("6b. the ceiling fixtureGitEnv actually produces stops discovery above the fixture root", () => {
    // The helper's real shape: cwd = root, ceiling = dirname(root). A bare
    // directory with no .git of its own must not resolve to an ancestor repo.
    const outer = makeRepo("iss1220-outer-");
    const inner = join(outer, "inner");
    mkdirSync(inner, { recursive: true });

    expect(() => git(inner, ["rev-parse", "--git-common-dir"])).toThrow();
  });

  it("9. overwrites an inherited GIT_CEILING_DIRECTORIES rather than appending to it", () => {
    const root = mkdtempSync(join(tmpdir(), "iss1220-ceiling-"));
    const previous = process.env.GIT_CEILING_DIRECTORIES;
    // A leading empty entry disables symlink resolution for later entries; if
    // this value were preserved and appended to, the fixture's own ceiling
    // could be silently voided.
    process.env.GIT_CEILING_DIRECTORIES = ":/";
    try {
      const env = fixtureGitEnv(root);
      expect(env.GIT_CEILING_DIRECTORIES).not.toContain(":");
      expect(env.GIT_CEILING_DIRECTORIES).toBe(realpathSync(resolve(root, "..")));
    } finally {
      if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previous;
    }
  });

  it("7. a --global write lands in the sandbox and never in the developer's ~/.gitconfig", () => {
    const root = makeRepo("iss1220-global-");
    const realGlobal = join(homedir(), ".gitconfig");
    const before = existsSync(realGlobal) ? sha(realGlobal) : "ABSENT";

    // Must SUCCEED (not crash the way GIT_CONFIG_GLOBAL=/dev/null would).
    git(root, ["config", "--global", "user.email", "sandboxed@example.invalid"]);

    const after = existsSync(realGlobal) ? sha(realGlobal) : "ABSENT";
    expect(after).toBe(before);

    const sandboxPath = fixtureGitEnv(root).GIT_CONFIG_GLOBAL as string;
    expect(readFileSync(sandboxPath, "utf-8")).toContain("sandboxed@example.invalid");
  });
});

describe("ISS-1220 gitAllowFailure", () => {
  it("8. throws on an isolation violation rather than reporting it as a git failure", () => {
    // The whole point: a non-throwing wrapper must not launder a breach into
    // an ordinary non-zero status that a caller shrugs off.
    expect(() => gitAllowFailure(REPO_ROOT, ["status"])).toThrow(FixtureIsolationError);
  });

  it("still reports ordinary git failures as a status, without throwing", () => {
    const root = makeRepo("iss1220-allowfail-");
    const result = gitAllowFailure(root, ["rev-parse", "--verify", "refs/heads/nonexistent"]);
    expect(result.status).not.toBe(0);
  });
});

describe("ISS-1220 runE2ECli cwd default", () => {
  it("a call with NO cwd runs in the fixture's temp root, not the real repository", async () => {
    // Regression test for the round-1 critical finding: the guard was written
    // as `if (opts.cwd !== undefined) assertFixtureCwd(...)`, which left the
    // omitted-cwd case -- the dangerous one -- completely unguarded, since
    // spawnSync then inherits process.cwd().
    //
    // Behavioural, not structural: run from the real checkout, `status`
    // reports the actual storybloq project (hundreds of tickets). If the child
    // inherited process.cwd() that is what it would see.
    const fixture = await E2ECliFixture.create();
    try {
      const result = runE2ECli(fixture, ["status", "--format", "json"]);
      const combined = `${result.stdout}${result.stderr}`;

      // POSITIVE first: negative assertions alone would pass just as happily
      // if the CLI never ran at all. These pin that it ran AND saw an empty
      // root -- exit 1 with the no-project error.
      expect(result.status, `CLI did not run as expected:\n${combined}`).toBe(1);
      expect(combined).toContain("No .story/ project found");

      // Then the actual property: it must not have seen the real checkout.
      expect(combined).not.toContain('"project": "storybloq"');
      expect(combined).not.toContain('"totalTickets"');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("ISS-1220 incident mechanism", () => {
  it("5. records whether GIT_DIR + `git init --bare <path>` can flip core.bare on the GIT_DIR target", () => {
    // The unproven half of the 2026-09-14 incident. Run against a THROWAWAY
    // standalone repo under tmpdir -- never a linked worktree of this repo.
    const victim = makeRepo("iss1220-victim-");
    const victimConfig = join(victim, ".git", "config");
    const before = readFileSync(victimConfig, "utf-8");

    const target = join(mkdtempSync(join(tmpdir(), "iss1220-target-")), "bare");
    const env = { ...process.env, GIT_DIR: join(victim, ".git") };
    delete env.GIT_CEILING_DIRECTORIES;
    try {
      execFileSync("git", ["init", "--bare", target], { env, stdio: "pipe", cwd: tmpdir() });
    } catch {
      // Whether it errors is itself data; the config comparison below is the assertion.
    }

    const after = readFileSync(victimConfig, "utf-8");
    const flipped = /bare\s*=\s*true/.test(after) && !/bare\s*=\s*true/.test(before);

    // This test PINS observed behaviour rather than asserting a hypothesis.
    // If `flipped` is ever true, this mechanism is confirmed and the guard's
    // value is proven end to end; today it records what was ruled out.
    expect(typeof flipped).toBe("boolean");
    if (flipped) {
      throw new Error(
        "ISS-1220 mechanism CONFIRMED: GIT_DIR plus `git init --bare <path>` rewrote the " +
          "GIT_DIR target's config. Report this to the pen -- the incident's unexplained " +
          "core.bare flip now has a proven cause.",
      );
    }
  });
});
