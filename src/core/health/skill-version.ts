/**
 * T-502 check 4: is the installed `/story` skill older than the CLI.
 *
 * PROVEN OLDER ONLY. The advise fires when a marker parses and its numeric
 * core is strictly below the running version. A marker that is missing or
 * unreadable proves nothing, so it produces `skip`, not an advise: telling a
 * user to re-run setup because we could not read a file is noise, and the
 * auto-refresh path already handles a missing marker on its own.
 *
 * The comparison is the same core comparison `shouldRefresh` uses, restricted
 * to its strictly-older branch. The equal-core-with-a-prerelease-suffix and
 * missing-marker branches belong to the auto-refresh decision, which is
 * allowed to normalize files; this check only reports to a human.
 */

import { compareVersionStrings } from "../team-capabilities.js";
import { adviseCheck, okCheck, skipCheck, type HealthCheck, type HealthContext, type HealthDeps } from "./types.js";

const ID = "skill-version" as const;

const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
const CORE_MATCH = /^(\d+\.\d+\.\d+)([-+].*)?$/;

export async function checkSkillVersion(ctx: HealthContext, deps: HealthDeps): Promise<HealthCheck> {
  const running = ctx.cliVersion;
  if (!running || !PLAIN_VERSION.test(running)) {
    return skipCheck(
      ID,
      `Storybloq is running ${running || "an unknown version"}, which is not a published release, so the installed skill cannot be called out of date.`,
      "non-release build",
      { installed: running || null },
    );
  }

  const installed = deps.skillMarker.targets().filter((target) => deps.skillMarker.installed(target));
  if (installed.length === 0) {
    return skipCheck(ID, "No /story skill is installed, so there is nothing to compare against the CLI.", "no /story skill installed");
  }

  const detail: Record<string, string | number | boolean | null> = { cliVersion: running };
  const stale: typeof installed = [];
  const unreadable: string[] = [];

  for (const target of installed) {
    const marker = deps.skillMarker.marker(target);
    if (marker.kind === "absent") {
      detail[`marker:${target.id}`] = "absent";
      unreadable.push(target.id);
      continue;
    }
    if (marker.kind === "indeterminate") {
      detail[`marker:${target.id}`] = `indeterminate: ${marker.reason}`;
      unreadable.push(target.id);
      continue;
    }
    detail[`marker:${target.id}`] = marker.value;
    const core = CORE_MATCH.exec(marker.value)?.[1];
    if (core === undefined) {
      unreadable.push(target.id);
      continue;
    }
    if (compareVersionStrings(running, core) > 0) stale.push(target);
  }

  if (stale.length > 0) {
    const clients = new Set(stale.map((target) => target.client));
    const clientArg = clients.size > 1 ? "all" : clients.has("claude") ? "claude" : "codex";
    const displayPaths = stale.map((target) => target.displayPath).join(", ");
    return adviseCheck(
      ID,
      `The installed /story skill at ${displayPaths} is older than storybloq ${running}. Run \`storybloq setup --client ${clientArg}\` to refresh it.`,
      { ...detail, stale: stale.map((t) => t.id).join(", "), client: clientArg },
    );
  }

  if (unreadable.length > 0) {
    return skipCheck(
      ID,
      `Storybloq could not read the /story skill version marker for ${unreadable.join(", ")}, so it cannot tell whether the skill is up to date.`,
      `skill version marker unreadable for ${unreadable.join(", ")}`,
      detail,
    );
  }

  // Not "matches": an equal core with a prerelease marker suffix, and a marker
  // NEWER than the running CLI, both land here and neither is an equality.
  // What was actually established is that nothing is older.
  return okCheck(ID, `No installed /story skill is older than storybloq ${running}.`, detail);
}
