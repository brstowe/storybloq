/**
 * T-502: the health run. Fixed order, one shared deadline, no check can take
 * the run down with it.
 *
 * The budget is ONE total soft deadline rather than five per-check timers.
 * A user asked a question and is waiting for an answer: five sequential
 * 2 second caps would be a 10 second command. Each check receives the
 * REMAINING budget and clamps its own external call to it, and a check whose
 * turn begins after the deadline reports `skip` rather than starting work
 * that would overrun. `durationMs` is measured and reported; no normal-case
 * bound is promised, because the honest answer depends on the network.
 *
 * A throwing or rejecting check becomes `error` for that id ALONE. Reporting
 * four answers plus one named failure is strictly better than reporting
 * nothing, which is what a single try/catch around the whole run would give.
 */

import { checkCliVersion } from "./cli-version.js";
import { checkCodexBridge } from "./codex-bridge.js";
import { checkCrossSessionInbound } from "./cross-session-inbound.js";
import { checkHookDuplicates } from "./hook-duplicates.js";
import { checkSkillVersion } from "./skill-version.js";
import { checkUsageWindow } from "./usage-window.js";
import {
  HEALTH_CHECK_IDS,
  errorCheck,
  skipCheck,
  type HealthCheck,
  type HealthCheckId,
  type HealthContext,
  type HealthDeps,
  type HealthResult,
} from "./types.js";

export const HEALTH_TOTAL_BUDGET_MS = 5000;

export const PROJECT_DISABLED_REASON = "disabled in .story/config.json";
export const GLOBAL_DISABLED_REASON = "disabled in ~/.claude/storybloq/config.json";
export const BUDGET_REASON = "time budget exhausted";

export interface RunHealthOptions {
  readonly only?: readonly HealthCheckId[];
  readonly refresh?: boolean;
}

export async function runHealth(
  ctx: HealthContext,
  deps: HealthDeps,
  opts: RunHealthOptions = {},
): Promise<HealthResult> {
  const startedAt = deps.now();
  const selected = opts.only && opts.only.length > 0
    ? HEALTH_CHECK_IDS.filter((id) => opts.only!.includes(id))
    : [...HEALTH_CHECK_IDS];

  const globallyDisabled = readGlobalKillSwitch(deps);
  const checks: HealthCheck[] = [];
  let budgetSkipped = false;

  for (const id of selected) {
    if (globallyDisabled) {
      checks.push(disabledSkip(id, GLOBAL_DISABLED_REASON, "~/.claude/storybloq/config.json"));
      continue;
    }
    if (!ctx.config.enabled || !ctx.config.checks[id]) {
      checks.push(disabledSkip(id, PROJECT_DISABLED_REASON, ".story/config.json"));
      continue;
    }
    if (deps.now() > ctx.deadline) {
      budgetSkipped = true;
      checks.push(
        skipCheck(
          id,
          `Skipped: the ${HEALTH_TOTAL_BUDGET_MS / 1000} second health budget was exhausted before this check ran.`,
          BUDGET_REASON,
        ),
      );
      continue;
    }
    try {
      checks.push(await runOne(id, ctx, deps, opts));
    } catch (err: unknown) {
      checks.push(errorCheck(id, err instanceof Error ? err.constructor.name : typeof err));
    }
  }

  const finishedAt = deps.now();
  return {
    ranAt: new Date(startedAt).toISOString(),
    cliVersion: ctx.cliVersion,
    client: ctx.client,
    projectDir: ctx.projectDir,
    checks,
    durationMs: finishedAt - startedAt,
    budgetExhausted: budgetSkipped || finishedAt > ctx.deadline,
  };
}

function runOne(
  id: HealthCheckId,
  ctx: HealthContext,
  deps: HealthDeps,
  opts: RunHealthOptions,
): Promise<HealthCheck> {
  switch (id) {
    case "usage-window":
      return checkUsageWindow(ctx, deps);
    case "cli-version":
      return checkCliVersion(ctx, deps, { refresh: opts.refresh });
    case "codex-bridge":
      return checkCodexBridge(ctx, deps);
    case "skill-version":
      return checkSkillVersion(ctx, deps);
    case "cross-session-inbound":
      return checkCrossSessionInbound(ctx, deps);
    case "hook-duplicates":
      return checkHookDuplicates(ctx, deps);
  }
}

/** A disabled check stays in the list: a silently absent check reads as a passed one. */
function disabledSkip(id: HealthCheckId, reason: string, where: string): HealthCheck {
  return skipCheck(id, `This check is switched off in ${where}.`, reason);
}

function readGlobalKillSwitch(deps: HealthDeps): boolean {
  try {
    return deps.globalConfig()?.healthCheck?.enabled === false;
  } catch {
    return false;
  }
}
