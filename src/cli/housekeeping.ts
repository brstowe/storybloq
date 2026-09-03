/**
 * Pre-command housekeeping: silent operations that run on every CLI
 * invocation before the user's command dispatches. Extracted from
 * cli/index.ts so the real startup path can be exercised by tests
 * without triggering the top-level `runCli()` side effect.
 *
 * Currently:
 *   - ISS-570 G3: auto-refresh /story skill files when the CLI version
 *     differs from the skill-dir marker.
 *   - ISS-590: legacy hook sweep runs inside autoRefreshSkillIfStale
 *     when the marker advances.
 *   - ISS-570 G1: kick off a background npm-registry check so the
 *     next invocation has fresh update-available data.
 *
 * Best-effort: never blocks the user's command and never throws.
 */

/**
 * ISS-777: pure predicate for the CLI entry point deciding when to SKIP
 * preCommandHousekeeping (an awaited skill refresh + a background npm-registry
 * fetch). These entry points run programmatically, many times, and must never
 * phone the npm registry per invocation:
 *   - merge-driver: git spawns it once per merged .story file (ISS-736).
 *   - hook-status: the Claude Code Stop hook, fires on every response.
 *   - hook-bus-tool: the PostToolUse (on-tool) Bus hook, fires on every tool call.
 *   - session compact-prepare / resume-prompt: the PreCompact + SessionStart
 *     hooks (see core/hook-migration.ts).
 * Interactive `session` subcommands (list/show/stop/...) keep housekeeping.
 *
 * `argv` is the hideBin(process.argv) slice, so argv[0] is the command name.
 * Kept dependency-free (no heavy imports) because index.ts runs it on every
 * CLI start.
 */
export function shouldSkipHousekeeping(argv: string[]): boolean {
  const command = argv[0];
  if (command === "merge-driver") return true;
  if (command === "hook-status") return true;
  // T-427: the PostToolUse (on-tool) Bus hook fires after every tool call and must
  // start instantly and never phone the npm registry.
  if (command === "hook-bus-tool") return true;
  // T-424: waker-run is the detached background waker; limit-stop is the
  // StopFailure hook. Both must start instantly and never phone the registry.
  if (command === "waker-run") return true;
  if (
    command === "session" &&
    (argv[1] === "compact-prepare" || argv[1] === "resume-prompt" || argv[1] === "limit-stop")
  ) {
    return true;
  }
  return false;
}

export async function preCommandHousekeeping(version: string, argv: string[] = []): Promise<void> {
  if (!version || version === "0.0.0-dev") return;
  // A setup invocation carrying --skip-hooks is an explicit opt-out: BOTH the
  // version-refresh reconcile (inside autoRefreshSkillIfStale) and the direct
  // reconcile below must honor it. This flag is computed FIRST so the refresh
  // call can suppress its limit-hook reconcile too (otherwise --skip-hooks was
  // defeated by the refresh installing hooks before setup ran).
  const isSetupSkippingHooks =
    (argv[0] === "setup" || argv[0] === "setup-skill") && argv.includes("--skip-hooks");
  try {
    const { autoRefreshSkillIfStale } = await import("../core/skill-version-marker.js");
    await autoRefreshSkillIfStale(version, { reconcileLimitHooks: !isSetupSkippingHooks });
  } catch {
    // Best-effort; never block the user's command.
  }
  if (!isSetupSkippingHooks) {
    try {
      // T-424: self-healing hook reconcile (cheap settings.json check) + waker
      // respawn when non-terminal limit records exist with no live waker. This
      // is the reboot/crash recovery story for pending auto-resumes.
      const { ensureLimitHooksRegistered } = await import("./commands/setup-skill.js");
      await ensureLimitHooksRegistered();
    } catch {
      // Best-effort.
    }
  }
  try {
    const { spawnWakerIfNeeded } = await import("../autonomous/waker.js");
    spawnWakerIfNeeded();
  } catch {
    // Best-effort.
  }
  try {
    const { refreshUpdateCacheInBackground } = await import("../core/update-check.js");
    refreshUpdateCacheInBackground();
  } catch {
    // Best-effort.
  }
}
