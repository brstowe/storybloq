/**
 * T-502: the health result's two renderings.
 *
 * The md form is what a human reads and what the skill relays: one line per
 * check, and an indented `fix:` line under every advise. The fix line is the
 * relayed text, so it is never abbreviated or reflowed here.
 *
 * The header names the inspected directory. That is not decoration: the
 * settings and MCP registrations came from the INVOCATION directory, and a
 * user running the command from a subdirectory or from a different repository
 * than the one Claude has open must be able to see which files were read.
 */

import { successEnvelope } from "../output-formatter.js";
import type { HealthResult } from "./types.js";

export function formatHealthResult(result: HealthResult): string {
  const lines: string[] = [
    "# Health check",
    "",
    `storybloq ${result.cliVersion}, client ${result.client}`,
    `settings inspected for ${result.projectDir}`,
    "",
  ];
  for (const check of result.checks) {
    lines.push(`[${check.status}] ${check.id}: ${check.message}`);
    if (check.advice !== null) lines.push(`    fix: ${check.advice}`);
  }
  lines.push("");
  // "some checks did not run" is only true when a check was actually skipped
  // for the budget. A run whose LAST check merely finished late exhausted the
  // budget without dropping anything, and saying otherwise would send the
  // reader looking for a missing answer.
  const dropped = result.checks.some((c) => c.detail.reason === "time budget exhausted");
  lines.push(
    result.budgetExhausted
      ? dropped
        ? `Ran in ${result.durationMs} ms; the time budget was exhausted, so some checks did not run.`
        : `Ran in ${result.durationMs} ms, over the time budget; every selected check still ran.`
      : `Ran in ${result.durationMs} ms.`,
  );
  return lines.join("\n");
}

/**
 * ISS-1223: the shared `{version, data}` envelope every other `--format json`
 * command emits, with the whole result under `data`, so a caller that
 * unwraps `.data` (the skill, a hook, `--raw`) reads health the same way.
 */
export function healthResultJson(result: HealthResult): string {
  return JSON.stringify(successEnvelope(result), null, 2);
}
