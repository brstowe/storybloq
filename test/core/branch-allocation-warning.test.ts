import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkBranchAllocationWarning } from "../../src/core/branch-allocation-warning.js";
import { makeState, minimalConfig } from "./test-factories.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function commit(cwd: string, subject: string): string {
  git(cwd, ["commit", "--allow-empty", "-m", subject]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("checkBranchAllocationWarning", () => {
  let root: string;
  let savedGlobal: string | undefined;
  let savedSystem: string | undefined;
  let savedNoSystem: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "branch-alloc-warn-"));
    // Isolate from the host machine's own global/system git config, which
    // may set init.defaultBranch (e.g. Xcode's bundled git ships a system
    // gitconfig with init.defaultBranch=main baked in, which GIT_CONFIG_SYSTEM
    // alone does not override -- GIT_CONFIG_NOSYSTEM is what actually
    // disables it) -- without this, the "cannot decide" acceptance case
    // would pass or fail depending on who runs the suite.
    savedGlobal = process.env.GIT_CONFIG_GLOBAL;
    savedSystem = process.env.GIT_CONFIG_SYSTEM;
    savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    git(root, ["init", "-q", "--object-format=sha1", "-b", "main"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
  });

  afterEach(async () => {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = savedSystem;
    if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
    await rm(root, { recursive: true, force: true });
  });

  /** Fabricates `refs/remotes/origin/HEAD -> refs/remotes/origin/<branch>` without a real remote. */
  function fakeOriginHead(branch: string, sha: string): void {
    git(root, ["update-ref", `refs/remotes/origin/${branch}`, sha]);
    git(root, ["symbolic-ref", `refs/remotes/origin/HEAD`, `refs/remotes/origin/${branch}`]);
  }

  /** Backdates every marker file's mtime by `hoursAgo`, to exercise the 24h/7-day windows without sleeping. */
  function ageAllMarkers(hoursAgo: number): void {
    const dir = join(root, ".story", "telemetry", "id-warnings");
    const past = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
    for (const entry of readdirSync(dir)) {
      utimesSync(join(dir, entry), past, past);
    }
  }

  it("warns once per branch per 24h when the allocator is local on a non-default branch", () => {
    const sha = commit(root, "initial");
    fakeOriginHead("main", sha);
    git(root, ["checkout", "-q", "-b", "feature-x"]);

    const state = makeState({ config: minimalConfig });
    const first = checkBranchAllocationWarning(root, "ticket", state, "T-042");
    expect(first).toContain("T-042");
    expect(first).toContain("feature-x");
    expect(first).toContain("storybloq team init");

    const second = checkBranchAllocationWarning(root, "ticket", state, "T-043");
    expect(second).toBeNull();
  });

  it("warns again on the same branch once the 24h window has elapsed", () => {
    const sha = commit(root, "initial");
    fakeOriginHead("main", sha);
    git(root, ["checkout", "-q", "-b", "feature-x"]);

    const state = makeState({ config: minimalConfig });
    expect(checkBranchAllocationWarning(root, "ticket", state, "T-042")).not.toBeNull();
    expect(checkBranchAllocationWarning(root, "ticket", state, "T-043")).toBeNull();

    ageAllMarkers(25);
    const renewed = checkBranchAllocationWarning(root, "ticket", state, "T-044");
    expect(renewed).toContain("T-044");
  });

  it("throttles each branch independently -- a warning on one branch does not suppress another", () => {
    const sha = commit(root, "initial");
    fakeOriginHead("main", sha);

    const state = makeState({ config: minimalConfig });
    git(root, ["checkout", "-q", "-b", "feature-a"]);
    expect(checkBranchAllocationWarning(root, "ticket", state, "T-042")).toContain("feature-a");
    expect(checkBranchAllocationWarning(root, "ticket", state, "T-043")).toBeNull();

    git(root, ["checkout", "-q", "-b", "feature-b"]);
    expect(checkBranchAllocationWarning(root, "ticket", state, "T-044")).toContain("feature-b");
    expect(checkBranchAllocationWarning(root, "ticket", state, "T-045")).toBeNull();
  });

  it("sweeps a marker older than 7 days on the next call, rather than growing the marker directory forever", () => {
    const sha = commit(root, "initial");
    fakeOriginHead("main", sha);
    git(root, ["checkout", "-q", "-b", "feature-x"]);

    const state = makeState({ config: minimalConfig });
    expect(checkBranchAllocationWarning(root, "ticket", state, "T-042")).not.toBeNull();

    const dir = join(root, ".story", "telemetry", "id-warnings");
    const staleName = readdirSync(dir)[0];
    expect(readdirSync(dir)).toHaveLength(1);

    ageAllMarkers(24 * 8);
    // The sweep runs as a side effect of the next call, on any branch --
    // check here that the aged marker for feature-x is gone once a call on
    // a DIFFERENT branch runs the sweep, rather than accumulating forever.
    git(root, ["checkout", "-q", "-b", "feature-y"]);
    checkBranchAllocationWarning(root, "ticket", state, "T-050");
    const remaining = readdirSync(dir);
    expect(remaining).toHaveLength(1);
    expect(remaining).not.toContain(staleName);
  });

  it("does not warn on the default branch", () => {
    const sha = commit(root, "initial");
    fakeOriginHead("main", sha);

    const state = makeState({ config: minimalConfig });
    expect(checkBranchAllocationWarning(root, "ticket", state, "T-042")).toBeNull();
  });

  it("does not warn under the git-refs allocator with team mode enabled", () => {
    const sha = commit(root, "initial");
    fakeOriginHead("main", sha);
    git(root, ["checkout", "-q", "-b", "feature-x"]);

    const state = makeState({
      config: { ...minimalConfig, team: { enabled: true, idAllocator: "git-refs" } },
    });
    expect(checkBranchAllocationWarning(root, "ticket", state, "T-042")).toBeNull();
  });

  it("still warns when idAllocator is \"git-refs\" but team.enabled is false (ISS-1190 review finding)", () => {
    // The create handlers only consult idAllocator when team.enabled ===
    // true; with team mode disabled, every create mints locally regardless
    // of a stale idAllocator left over in config. Suppressing the warning
    // here would silently hide exactly the collision this check exists to
    // catch.
    const sha = commit(root, "initial");
    fakeOriginHead("main", sha);
    git(root, ["checkout", "-q", "-b", "feature-x"]);

    const state = makeState({
      config: { ...minimalConfig, team: { enabled: false, idAllocator: "git-refs" } },
    });
    expect(checkBranchAllocationWarning(root, "ticket", state, "T-042")).toContain("T-042");
  });

  it("still warns when idAllocator is \"git-refs\" but team.enabled is omitted entirely (not just false)", () => {
    // Codex review finding: `team: undefined` doesn't retain idAllocator at
    // all, so it would pass even under the original buggy guard (idAllocator
    // isn't "git-refs" there either) -- this is the case that actually
    // exercises "enabled omitted" with idAllocator retained.
    const sha = commit(root, "initial");
    fakeOriginHead("main", sha);
    git(root, ["checkout", "-q", "-b", "feature-x"]);

    const state = makeState({
      config: { ...minimalConfig, team: { idAllocator: "git-refs" } },
    });
    expect(checkBranchAllocationWarning(root, "ticket", state, "T-042")).toContain("T-042");
  });

  it("warns on detached HEAD", () => {
    const sha = commit(root, "initial");
    fakeOriginHead("main", sha);
    git(root, ["checkout", "-q", sha]);

    const state = makeState({ config: minimalConfig });
    const result = checkBranchAllocationWarning(root, "ticket", state, "T-042");
    expect(result).toContain("HEAD");
  });

  it("does not warn when no origin/HEAD and no init.defaultBranch can be determined", () => {
    commit(root, "initial");
    git(root, ["checkout", "-q", "-b", "feature-x"]);

    const state = makeState({ config: minimalConfig });
    expect(checkBranchAllocationWarning(root, "ticket", state, "T-042")).toBeNull();
  });

  it("falls back to a NON-'main' init.defaultBranch when there is no origin/HEAD (named mutant: hardcoding the default branch to \"main\")", () => {
    // No fakeOriginHead call -- this exercises the init.defaultBranch
    // fallback exclusively. init.defaultBranch is set to "trunk", not
    // "main", specifically so a mutant that hardcodes the default-branch
    // result to the literal "main" fails both assertions below (it would
    // treat "trunk" itself as non-default, and "feature-y" as if "main"
    // were the resolved default, rather than "trunk").
    git(root, ["config", "init.defaultBranch", "trunk"]);
    commit(root, "initial");
    git(root, ["branch", "-m", "trunk"]);

    const state = makeState({ config: minimalConfig });
    expect(checkBranchAllocationWarning(root, "ticket", state, "T-042")).toBeNull();

    git(root, ["checkout", "-q", "-b", "feature-y"]);
    const result = checkBranchAllocationWarning(root, "ticket", state, "T-043");
    expect(result).toContain("feature-y");
  });
});

describe("checkBranchAllocationWarning: root is not a git repository at all", () => {
  let plainDir: string;

  beforeEach(async () => {
    plainDir = await mkdtemp(join(tmpdir(), "branch-alloc-warn-noreo-"));
  });

  afterEach(async () => {
    await rm(plainDir, { recursive: true, force: true });
  });

  it("never warns -- a .story/ project is not required to be a git repository", () => {
    // Outside any repository, `git symbolic-ref -q --short HEAD` fails with
    // the SAME non-zero exit a real detached HEAD produces, so this is the
    // regression case for that ambiguity: without the isInsideGitRepo gate,
    // every create in a non-git project would misread as detached HEAD and
    // warn every single time.
    const state = makeState({ config: minimalConfig });
    expect(checkBranchAllocationWarning(plainDir, "ticket", state, "T-042")).toBeNull();
  });
});
