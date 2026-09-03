// T-430: the shared "is this session's Bus delivery fully converged?" predicate. It is the
// single source of truth for whether an auto-attach child should be spawned, used by BOTH the
// SessionStart hook (session-compact) and the per-turn Stop retry (hook-status). Keeping it in
// the bus layer (not a CLI command module) avoids coupling those two command files and keeps the
// convergence definition in one place.

import { findEndpointForTask } from "./endpoints.js";
import { isBusHookDeliveryEnabled } from "./hooks.js";
import { readAutoAttachOutcome } from "./auto-attach-outcome.js";
import type { BusClient } from "./schemas.js";

// Returns true when this task's Bus session is NOT fully converged and a child should run:
//  - no active endpoint for this task yet, OR
//  - an endpoint exists but this client's delivery policy did not converge, OR
//  - an unresolved `degraded` outcome is recorded for this task's CURRENT active endpoint
//    (materialization/tool-hook shortfall) -- crucially this fires even when delivery IS enabled
//    and a marker would be emitted, so a materialization-degraded endpoint is not left stuck
//    (Codex has no Stop retry, so its ONLY recovery is the next SessionStart honoring this).
// Steady state (endpoint present + delivery converged + no matching degraded record) -> false.
//
// FAILS OPEN: this is a best-effort spawn HINT, never a correctness gate. A read error (e.g. a
// corrupt endpoint registry) returns true so the child still runs -- the child's own gates are
// the sole authority and will record the real terminal (e.g. registry_corrupt). Suppressing the
// child on a read error would strand a corrupt/degraded session, fatally so for Codex.
export async function autoAttachConvergenceNeeded(
  root: string,
  client: BusClient,
  clientTaskId: string,
): Promise<boolean> {
  try {
    const endpoint = await findEndpointForTask(root, client, clientTaskId);
    if (!endpoint) return true;
    if (!await isBusHookDeliveryEnabled(root, client)) return true;
    const outcome = await readAutoAttachOutcome(root, client, clientTaskId);
    return outcome?.kind === "degraded" && outcome.endpointId === endpoint.endpointId;
  } catch {
    return true;
  }
}
