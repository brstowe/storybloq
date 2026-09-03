/**
 * T-424: limit-stop hook registration matrix.
 *
 * registerLimitStopFailureHook / registerLimitSessionStartHook (matcher-scoped
 * idempotency + bus-broadened matcher skip) / removeHookFromMatcherGroup /
 * ensureLimitHooksRegistered (kill-switch aware, upgrade path where the
 * count-gated legacy sweep can never install an absent hook type).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerLimitStopFailureHook,
  registerLimitSessionStartHook,
  removeHookFromMatcherGroup,
  ensureLimitHooksRegistered,
} from "../../../src/cli/commands/setup-skill.js";
import {
  LIMITSTOP_SUBCOMMAND,
  SESSIONSTART_SUBCOMMAND,
  STOPFAILURE_MATCHER,
  LIMIT_SESSIONSTART_MATCHER,
  formatHookCommand,
  PRECOMPACT_SUBCOMMAND,
  STOP_SUBCOMMAND,
} from "../../../src/core/hook-migration.js";

const BIN = "/usr/local/bin/storybloq";
const LIMITSTOP_CMD = formatHookCommand(BIN, LIMITSTOP_SUBCOMMAND);
const SESSIONSTART_CMD = formatHookCommand(BIN, SESSIONSTART_SUBCOMMAND);

interface MatcherGroup {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
}
interface Settings {
  hooks?: Record<string, MatcherGroup[]>;
}

let dir: string;
let globalDir: string;
let settingsPath: string;
let savedGlobalDir: string | undefined;

function readSettings(): Settings {
  return JSON.parse(readFileSync(settingsPath, "utf-8")) as Settings;
}

function groups(hookType: string): MatcherGroup[] {
  return readSettings().hooks?.[hookType] ?? [];
}

function groupFor(hookType: string, matcher: string): MatcherGroup | undefined {
  return groups(hookType).find((g) => (g.matcher ?? "") === matcher);
}

/** A settings.json as installed by current setup: all three hooks, no StopFailure. */
function writeCurrentInstallSettings(): void {
  writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      PreCompact: [{ matcher: "", hooks: [{ type: "command", command: formatHookCommand(BIN, PRECOMPACT_SUBCOMMAND) }] }],
      SessionStart: [{ matcher: "compact", hooks: [{ type: "command", command: SESSIONSTART_CMD }] }],
      Stop: [{ matcher: "", hooks: [{ type: "command", command: formatHookCommand(BIN, STOP_SUBCOMMAND), async: true }] }],
    },
  }, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "t424-hooks-"));
  globalDir = mkdtempSync(join(tmpdir(), "t424-hooks-global-"));
  settingsPath = join(dir, "settings.json");
  savedGlobalDir = process.env.STORYBLOQ_GLOBAL_DIR;
  process.env.STORYBLOQ_GLOBAL_DIR = globalDir;
});

afterEach(async () => {
  if (savedGlobalDir === undefined) delete process.env.STORYBLOQ_GLOBAL_DIR;
  else process.env.STORYBLOQ_GLOBAL_DIR = savedGlobalDir;
  await rm(dir, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

describe("registerLimitStopFailureHook", () => {
  it("registers under the rate_limit matcher", async () => {
    expect(await registerLimitStopFailureHook(settingsPath, BIN)).toBe("registered");
    const g = groupFor("StopFailure", STOPFAILURE_MATCHER);
    expect(g?.hooks).toEqual([{ type: "command", command: LIMITSTOP_CMD }]);
  });

  it("is idempotent", async () => {
    await registerLimitStopFailureHook(settingsPath, BIN);
    expect(await registerLimitStopFailureHook(settingsPath, BIN)).toBe("exists");
    expect(groups("StopFailure")).toHaveLength(1);
    expect(groupFor("StopFailure", STOPFAILURE_MATCHER)?.hooks).toHaveLength(1);
  });

  it("still installs the rate_limit group when the command sits under an unrelated matcher", async () => {
    // A user hand-moved (or a legacy install left) the same command under
    // server_error. Global idempotency would report "exists" and never install
    // the rate_limit group this feature needs; matcher-scoped idempotency must
    // install it anyway and leave the foreign group untouched.
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        StopFailure: [{ matcher: "server_error", hooks: [{ type: "command", command: LIMITSTOP_CMD }] }],
      },
    }, null, 2));

    expect(await registerLimitStopFailureHook(settingsPath, BIN)).toBe("registered");
    expect(groupFor("StopFailure", STOPFAILURE_MATCHER)?.hooks).toEqual([
      { type: "command", command: LIMITSTOP_CMD },
    ]);
    expect(groupFor("StopFailure", "server_error")?.hooks).toHaveLength(1);
  });

  it("skips when a BROAD matcher already covers rate_limit (no double-fire)", async () => {
    // A group whose alternation matcher includes rate_limit (e.g. a user or
    // future setup registered "rate_limit|server_error") already fires our
    // command. Adding the exact-matcher group would double-fire the hook on
    // every rate_limit stop -- coverage-aware idempotency must report "exists".
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        StopFailure: [{ matcher: "rate_limit|server_error", hooks: [{ type: "command", command: LIMITSTOP_CMD }] }],
      },
    }, null, 2));

    expect(await registerLimitStopFailureHook(settingsPath, BIN)).toBe("exists");
    // No exact-matcher group was added; the broad group is left intact.
    expect(groupFor("StopFailure", STOPFAILURE_MATCHER)).toBeUndefined();
    expect(groupFor("StopFailure", "rate_limit|server_error")?.hooks).toHaveLength(1);
  });
});

describe("registerLimitSessionStartHook", () => {
  it("adds a second 'resume' group beside the existing 'compact' group (same command)", async () => {
    writeCurrentInstallSettings();
    expect(await registerLimitSessionStartHook(settingsPath, BIN)).toBe("registered");

    const compact = groupFor("SessionStart", "compact");
    const resume = groupFor("SessionStart", LIMIT_SESSIONSTART_MATCHER);
    expect(compact?.hooks).toHaveLength(1);
    expect(resume?.hooks).toEqual([{ type: "command", command: SESSIONSTART_CMD }]);
  });

  it("is idempotent within the resume group", async () => {
    writeCurrentInstallSettings();
    await registerLimitSessionStartHook(settingsPath, BIN);
    expect(await registerLimitSessionStartHook(settingsPath, BIN)).toBe("exists");
    expect(groupFor("SessionStart", LIMIT_SESSIONSTART_MATCHER)?.hooks).toHaveLength(1);
  });

  it("skips when a bus-broadened matcher already covers 'resume'", async () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: SESSIONSTART_CMD }] }],
      },
    }));
    expect(await registerLimitSessionStartHook(settingsPath, BIN)).toBe("exists");
    expect(groupFor("SessionStart", LIMIT_SESSIONSTART_MATCHER)).toBeUndefined();
  });

  it("skips when an empty (match-all) matcher already carries the command", async () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: SESSIONSTART_CMD }] }],
      },
    }));
    expect(await registerLimitSessionStartHook(settingsPath, BIN)).toBe("exists");
    expect(groups("SessionStart")).toHaveLength(1);
  });

  it("does NOT skip when a foreign command covers 'resume'", async () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "other-tool do-thing" }] }],
      },
    }));
    expect(await registerLimitSessionStartHook(settingsPath, BIN)).toBe("registered");
    expect(groupFor("SessionStart", LIMIT_SESSIONSTART_MATCHER)?.hooks).toHaveLength(1);
  });

  it("still installs the resume hook when an existing matcher is an INVALID regex that textually contains 'resume'", async () => {
    // An uncompilable matcher (e.g. `resume|[`) never matches at runtime, so it
    // does NOT actually fire our command. A `|`-split coverage fallback would
    // read it as covering 'resume' and suppress installation, leaving NO working
    // hook. Coverage must fail closed on an invalid regex -> install anyway.
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "resume|[", hooks: [{ type: "command", command: SESSIONSTART_CMD }] }],
      },
    }));
    expect(await registerLimitSessionStartHook(settingsPath, BIN)).toBe("registered");
    // A valid, functioning resume group was added alongside the broken one.
    expect(groupFor("SessionStart", LIMIT_SESSIONSTART_MATCHER)?.hooks).toEqual([
      { type: "command", command: SESSIONSTART_CMD },
    ]);
  });
});

describe("removeHookFromMatcherGroup", () => {
  it("removes only the targeted matcher group's entry", async () => {
    writeCurrentInstallSettings();
    await registerLimitSessionStartHook(settingsPath, BIN);

    const result = await removeHookFromMatcherGroup(
      "SessionStart", SESSIONSTART_CMD, LIMIT_SESSIONSTART_MATCHER, settingsPath,
    );
    expect(result).toBe("removed");
    expect(groupFor("SessionStart", LIMIT_SESSIONSTART_MATCHER)?.hooks).toHaveLength(0);
    // The compact group is untouched.
    expect(groupFor("SessionStart", "compact")?.hooks).toHaveLength(1);
  });

  it("returns not_found when the entry is absent", async () => {
    writeCurrentInstallSettings();
    const result = await removeHookFromMatcherGroup(
      "SessionStart", SESSIONSTART_CMD, LIMIT_SESSIONSTART_MATCHER, settingsPath,
    );
    expect(result).toBe("not_found");
  });
});

describe("ensureLimitHooksRegistered", () => {
  it("installs both hooks on a current install with zero StopFailure hooks (upgrade path)", async () => {
    writeCurrentInstallSettings();
    const result = await ensureLimitHooksRegistered(settingsPath, BIN);
    expect(result.changed).toBe(true);
    expect(groupFor("StopFailure", STOPFAILURE_MATCHER)?.hooks).toHaveLength(1);
    expect(groupFor("SessionStart", LIMIT_SESSIONSTART_MATCHER)?.hooks).toHaveLength(1);
  });

  it("reports changed: false when already reconciled", async () => {
    writeCurrentInstallSettings();
    await ensureLimitHooksRegistered(settingsPath, BIN);
    const second = await ensureLimitHooksRegistered(settingsPath, BIN);
    expect(second.changed).toBe(false);
  });

  it("removes both hooks when the global kill switch is set, leaving the compact group", async () => {
    writeCurrentInstallSettings();
    await ensureLimitHooksRegistered(settingsPath, BIN);

    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ limitResume: { enabled: false } }));
    const result = await ensureLimitHooksRegistered(settingsPath, BIN);
    expect(result.changed).toBe(true);
    expect(groupFor("StopFailure", STOPFAILURE_MATCHER)?.hooks ?? []).toHaveLength(0);
    expect(groupFor("SessionStart", LIMIT_SESSIONSTART_MATCHER)?.hooks ?? []).toHaveLength(0);
    expect(groupFor("SessionStart", "compact")?.hooks).toHaveLength(1);

    // Idempotent while disabled.
    const again = await ensureLimitHooksRegistered(settingsPath, BIN);
    expect(again.changed).toBe(false);
  });

  it("registers on fresh settings from scratch", async () => {
    const result = await ensureLimitHooksRegistered(settingsPath, BIN);
    expect(result.changed).toBe(true);
    expect(groupFor("StopFailure", STOPFAILURE_MATCHER)?.hooks).toHaveLength(1);
    expect(groupFor("SessionStart", LIMIT_SESSIONSTART_MATCHER)?.hooks).toHaveLength(1);
  });
});
