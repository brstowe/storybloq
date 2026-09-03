// T-430: project-local, client-correct delivery convergence. This is the delivery work that
// is safe to re-run every session WITHOUT touching global (~/.claude, ~/.codex) client hook
// files -- those are installed once by the `bus auto-attach on` / `bus setup` bootstrap. The
// detached auto-attach child calls ONLY this; the setup path's enableHooksForClient keeps the
// global install and delegates the project part here.

import type { BusClient } from "./schemas.js";
import { setBusHookPolicy } from "./hooks.js";

export interface DeliveryStepResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface DeliveryConvergence {
  // The reliable Stop-tier delivery policy (both clients). A failure here degrades delivery.
  readonly policy: DeliveryStepResult;
  // The Claude-only on-tool (PostToolUse) hook. `applicable` is false for non-Claude clients
  // (Codex has no PostToolUse surface), in which case ok is trivially true. A failure here is
  // best-effort and never undoes the Stop-tier policy.
  readonly toolHook: DeliveryStepResult & { readonly applicable: boolean };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function convergeProjectDelivery(root: string, client: BusClient): Promise<DeliveryConvergence> {
  // Always converge the reliable Stop tier for this client. Captured (never thrown) so the
  // caller gets a structured outcome; setup's enableHooksForClient re-raises on failure to
  // preserve its existing throw-on-policy-failure behavior.
  let policy: DeliveryStepResult;
  try {
    await setBusHookPolicy(root, [client], true);
    policy = { ok: true };
  } catch (err) {
    policy = { ok: false, error: errorMessage(err) };
  }

  // The on-tool hook is Claude-specific and project-local; installing it for Codex would
  // create an unrelated Claude config. Best-effort.
  if (client !== "claude") {
    return { policy, toolHook: { applicable: false, ok: true } };
  }
  let toolHook: DeliveryStepResult & { applicable: boolean };
  try {
    const { resolveStorybloqBin } = await import("../cli/commands/setup-skill.js");
    const bin = resolveStorybloqBin();
    if (!bin) {
      toolHook = { applicable: true, ok: false, error: "storybloq binary could not be resolved" };
    } else {
      const { installProjectBusToolHook } = await import("../core/project-settings.js");
      await installProjectBusToolHook(root, bin);
      toolHook = { applicable: true, ok: true };
    }
  } catch (err) {
    toolHook = { applicable: true, ok: false, error: errorMessage(err) };
  }
  return { policy, toolHook };
}
