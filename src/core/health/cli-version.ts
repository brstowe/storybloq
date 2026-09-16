/**
 * T-502 check 2: is the installed CLI the newest published one.
 *
 * The registry answer is shared, not private: this reads and writes the same
 * `~/.claude/storybloq/update-check.json` the startup banner and
 * `storybloq_status` already use, so the once-per-day contract holds across
 * every entry point and a health run adds no traffic when the cache is fresh.
 *
 * The rule that matters here is NEVER A STALE CLAIM. A failed fetch with no
 * usable cache is reported as `skip` "offline"; it is not rendered as
 * "you are up to date", which is the one wrong answer this check could give.
 */

import { compareVersionStrings } from "../team-capabilities.js";
import { adviseCheck, okCheck, skipCheck, type HealthCheck, type HealthContext, type HealthDeps } from "./types.js";

const ID = "cli-version" as const;

/** Cap for the registry request, taken from the remaining run budget. */
export const REGISTRY_FETCH_CAP_MS = 2000;

const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

export interface CliVersionOptions {
  readonly refresh?: boolean;
}

export async function checkCliVersion(
  ctx: HealthContext,
  deps: HealthDeps,
  opts: CliVersionOptions = {},
): Promise<HealthCheck> {
  const installed = ctx.cliVersion;
  if (!installed || !PLAIN_VERSION.test(installed)) {
    return skipCheck(
      ID,
      `Storybloq is running ${installed || "an unknown version"}, which is not a published release, so there is nothing to compare it against.`,
      "non-release build",
      { installed: installed || null },
    );
  }

  // The fetch itself honours these, but saying so as the skip REASON is the
  // point: a user who set CI or NO_UPDATE_NOTIFIER should be told the check
  // was declined rather than left reading a silent ok.
  if (isSet(deps.env.NO_UPDATE_NOTIFIER) || isSet(deps.env.CI)) {
    return skipCheck(
      ID,
      "Update checks are switched off in this environment (NO_UPDATE_NOTIFIER or CI is set), so Storybloq did not ask the registry.",
      "update checks disabled",
      { installed },
    );
  }

  const force = opts.refresh === true;
  const cached = force ? null : deps.versionCache.read(installed);
  let info = cached;
  if (!info) {
    const remaining = ctx.deadline - deps.now();
    if (remaining <= 0) {
      return skipCheck(
        ID,
        "Skipped: the health budget was exhausted before Storybloq could ask the registry which version is published.",
        "time budget exhausted",
        { installed },
      );
    }
    info = await deps.versionCache.refresh({
      currentVersion: installed,
      force,
      timeoutMs: Math.min(REGISTRY_FETCH_CAP_MS, remaining),
    });
  }
  if (!info) {
    return skipCheck(
      ID,
      "Storybloq could not reach the npm registry, so it cannot say whether a newer version is published.",
      "offline",
      { installed },
    );
  }

  const latest = info.latestVersion;
  const cmp = compareVersionStrings(installed, latest);
  const detail = { installed, latest, cached: cached !== null };
  if (cmp < 0) {
    return adviseCheck(
      ID,
      `storybloq ${installed} is installed; ${latest} is published. Update with \`npm install -g @storybloq/storybloq@latest\`, then run \`storybloq setup\`.`,
      detail,
    );
  }
  if (cmp > 0) {
    return okCheck(ID, `storybloq ${installed} is installed, which is newer than the published ${latest}.`, {
      ...detail,
      note: "the installed version is ahead of the registry",
    });
  }
  return okCheck(ID, `storybloq ${installed} is installed, which is the newest published version.`, detail);
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}
