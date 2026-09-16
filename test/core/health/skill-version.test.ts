import { describe, it, expect } from "vitest";
import { checkSkillVersion } from "../../../src/core/health/skill-version.js";
import { ctxFor, stubDeps, skillTarget } from "./stub-deps.js";
import type { SkillTargetInfo } from "../../../src/core/skill-version-marker.js";
import type { HealthMarkerRead } from "../../../src/core/health/types.js";

const CLAUDE = skillTarget({ id: "claude", client: "claude", displayPath: "~/.claude/skills/story/" });
const CODEX = skillTarget({ id: "codex", client: "codex", displayPath: "~/.agents/skills/story/" });
const CODEX_COMPAT = skillTarget({ id: "codexCompat", client: "codex", displayPath: "~/.codex/skills/story/" });

function depsFor(markers: Record<string, HealthMarkerRead>) {
  const targets = [CLAUDE, CODEX, CODEX_COMPAT].filter((t) => markers[t.id] !== undefined);
  return stubDeps({
    skillMarker: {
      targets: () => targets,
      installed: () => true,
      marker: (target: SkillTargetInfo) => markers[target.id]!,
    },
  });
}

const ok = (value: string): HealthMarkerRead => ({ kind: "ok", value });

describe("T-502 skill-version check", () => {
  it("advises naming the display path and --client claude for a stale claude skill", async () => {
    const check = await checkSkillVersion(ctxFor(), depsFor({ claude: ok("1.13.0") }));
    expect(check.status).toBe("advise");
    expect(check.message).toBe(
      "The installed /story skill at ~/.claude/skills/story/ is older than storybloq 1.14.0. Run `storybloq setup --client claude` to refresh it.",
    );
  });

  it("derives --client codex from either codex-client target alone", async () => {
    for (const id of ["codex", "codexCompat"]) {
      const check = await checkSkillVersion(ctxFor(), depsFor({ [id]: ok("1.13.0") }));
      expect(check.detail.client).toBe("codex");
    }
  });

  it("derives --client codex when both codex targets are stale", async () => {
    const check = await checkSkillVersion(ctxFor(), depsFor({ codex: ok("1.13.0"), codexCompat: ok("1.12.0") }));
    expect(check.detail.client).toBe("codex");
    expect(check.message).toContain("~/.agents/skills/story/, ~/.codex/skills/story/");
  });

  it("derives --client all when a claude target and a codex target are both stale", async () => {
    for (const other of ["codex", "codexCompat"]) {
      const check = await checkSkillVersion(ctxFor(), depsFor({ claude: ok("1.13.0"), [other]: ok("1.13.0") }));
      expect(check.detail.client).toBe("all");
      expect(check.message).toContain("--client all");
    }
  });

  // The ok wording claims only what was established: nothing is OLDER. An
  // equal core with a prerelease suffix, and a marker newer than the running
  // CLI, both land here and neither is an equality.
  it("is ok for an equal, newer, or equal-core-prerelease marker, and never claims equality", async () => {
    for (const marker of ["1.14.0", "1.15.0", "1.14.0-rc.1"]) {
      const check = await checkSkillVersion(ctxFor(), depsFor({ claude: ok(marker) }));
      expect(check.status).toBe("ok");
      expect(check.message).toBe("No installed /story skill is older than storybloq 1.14.0.");
      expect(check.message).not.toContain("matches");
    }
  });

  it("skips when a marker is absent", async () => {
    const check = await checkSkillVersion(ctxFor(), depsFor({ claude: { kind: "absent" } }));
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe("skill version marker unreadable for claude");
  });

  it("skips when a marker is indeterminate", async () => {
    const check = await checkSkillVersion(ctxFor(), depsFor({ claude: { kind: "indeterminate", reason: "not a regular file" } }));
    expect(check.status).toBe("skip");
    expect(check.detail["marker:claude"]).toBe("indeterminate: not a regular file");
  });

  it("skips when a marker has no parseable numeric core", async () => {
    const check = await checkSkillVersion(ctxFor(), depsFor({ claude: ok("banana") }));
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toContain("unreadable for claude");
  });

  it("a proven-older target outranks an unreadable sibling", async () => {
    const check = await checkSkillVersion(ctxFor(), depsFor({ claude: ok("1.13.0"), codex: { kind: "absent" } }));
    expect(check.status).toBe("advise");
    expect(check.detail.client).toBe("claude");
  });

  it("skips when no skill is installed", async () => {
    const deps = stubDeps({ skillMarker: { targets: () => [CLAUDE], installed: () => false } });
    const check = await checkSkillVersion(ctxFor(), deps);
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe("no /story skill installed");
  });

  it("skips a dev or prerelease running version", async () => {
    for (const version of ["0.0.0-dev", "1.14.0-rc.1"]) {
      const check = await checkSkillVersion(ctxFor({ cliVersion: version }), depsFor({ claude: ok("1.13.0") }));
      expect(check.status).toBe("skip");
      expect(check.detail.reason).toBe("non-release build");
    }
  });
});
