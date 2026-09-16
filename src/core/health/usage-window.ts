/**
 * T-502 check 1: the auto-compact window.
 *
 * This check owns NO rule of its own. The threshold, the 1M-model case and
 * the wording all belong to T-501 (`usageAdvisoryFrom` + `renderUsageAdvisory`)
 * and are called, not reimplemented, so `/story` priming and `storybloq
 * health` can never say two different things about the same setting.
 *
 * What this check does own is the three-valued layer rule. The window is read
 * from the highest `ok` layer; if any layer ABOVE it could not be read, or no
 * layer is `ok` and any layer could not be read, the answer is `skip` naming
 * the path, because that unreadable layer is exactly the one that would have
 * decided the verdict.
 */

import { renderUsageAdvisory } from "../session-intel/push.js";
import { usageAdvisoryFrom } from "../session-intel/sampler.js";
import { adviseCheck, okCheck, skipCheck, type HealthCheck, type HealthContext, type HealthDeps } from "./types.js";

const ID = "usage-window" as const;

/**
 * Locale-independent thousands grouping. `toLocaleString` would make the
 * pinned message text depend on the machine's ICU data, and these strings are
 * asserted verbatim by tests and relayed verbatim by the skill.
 */
function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** T-501's own soft budget for one read-only caller acquisition. */
export const CALLER_SAMPLE_CAP_MS = 150;

export async function checkUsageWindow(ctx: HealthContext, deps: HealthDeps): Promise<HealthCheck> {
  const base = { projectDir: ctx.projectDir };
  if (ctx.client === "codex") {
    return skipCheck(ID, "Claude Code's auto-compact window does not apply to Codex.", "not applicable to Codex", base);
  }

  const cfg = deps.sessionIntelConfig(ctx.ledgerRoot);
  // Checked FIRST: with the advisory switched off there is no verdict to
  // suppress, so an unreadable settings layer must not produce a skip and
  // there is no reason to read settings or touch the session at all.
  if (cfg.recommendedWindowMax === 0) {
    return okCheck(ID, "The auto-compact window advisory is switched off by sessionIntel.recommendedWindowMax = 0.", {
      ...base,
      recommendedMax: 0,
    });
  }

  const { layers } = deps.settings.autoCompactWindow(ctx.projectDir);

  // Layers arrive lowest precedence first, so the LAST ok wins.
  let winnerIndex = -1;
  for (let i = 0; i < layers.length; i++) {
    if (layers[i]!.kind === "ok" && layers[i]!.value !== undefined) winnerIndex = i;
  }
  const blocking = layers.find((layer, i) => layer.kind === "indeterminate" && i > winnerIndex);
  if (blocking) {
    return skipCheck(
      ID,
      `Storybloq could not read ${blocking.path}, so it cannot tell what your auto-compact window is.`,
      `unreadable: ${blocking.path}`,
      { ...base, source: blocking.source },
    );
  }

  const winner = winnerIndex >= 0 ? layers[winnerIndex]! : null;
  const window = winner?.value ?? null;
  const source = winner?.source ?? null;

  const remaining = ctx.deadline - deps.now();
  const sample = remaining > 0 ? deps.callerSample(Math.min(CALLER_SAMPLE_CAP_MS, remaining)) : null;
  const oneMillionFlag = sample?.oneMillionFlag ?? null;

  const detail = {
    ...base,
    window,
    source,
    oneMillionFlag,
    recommendedMax: cfg.recommendedWindowMax,
  };

  const advisory = usageAdvisoryFrom({ window, source }, oneMillionFlag, cfg);
  if (advisory) return adviseCheck(ID, renderUsageAdvisory(advisory), { ...detail, kind: advisory.kind });

  if (window !== null) {
    return okCheck(ID, `Your Claude Code auto-compact window is ${grouped(window)} tokens, at or below the recommended ${grouped(cfg.recommendedWindowMax)}.`, detail);
  }
  return okCheck(ID, "Storybloq did not observe an autoCompactWindow setting, and this session did not report a 1M-context model.", detail);
}
