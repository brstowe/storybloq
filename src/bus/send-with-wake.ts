/**
 * The send path with the wake tier attached.
 *
 * WHY THIS IS A SEPARATE MODULE, and not a call inside `sendBusMessage`: the wake
 * must never be able to fail a send. `sendBusMessage` commits the mail and returns;
 * only then does anything here run, outside its transaction. Section 7 of the T-489
 * plan calls that isolation structural rather than defensive, and a module boundary
 * is what makes it structural: `store.ts` has no import of the wake at all, so no
 * future edit inside the store transaction can reach it by accident.
 *
 * THREE surfaces attach here, and all three go through the SAME `wakeForSend`, so
 * the tier cannot be live on one and dead on another: the `bus send` CLI command
 * and the `storybloq_bus_send` MCP tool, both via `sendBusMessageWithWake`, and
 * `bus redeliver` plus `storybloq_bus_redeliver` via
 * `redeliverBusMessageWithWake` (ISS-1131).
 *
 * Redelivery lives HERE rather than beside the store for the same reason sending
 * does: `store.ts` must keep zero wake imports, or the isolation stops being
 * structural. It is a sibling rather than one merged entry point because the two
 * inputs are different types, and a union would push a discrimination onto every
 * caller to save one function.
 */

import {
  redeliverBusMessage,
  sendBusMessage,
  type BusRedeliverInput,
  type BusSendInput,
  type BusSendResult,
} from "./store.js";
import { wakeAfterSend } from "./wake-runner.js";
import { BUS_WAKE_TEXT, wakeTelemetry, wakeWanted } from "./wake.js";
import { listEndpoints } from "./endpoints.js";

/**
 * A send result plus what the wake tier did.
 *
 * `wake` is ABSENT, not `null`, when there was no attempt to describe: an endpoint
 * that never opted in, a send that committed no mail. Absence and a recorded
 * outcome are different facts and a reader must be able to tell them apart.
 */
export type BusSendWithWakeResult = BusSendResult & { readonly wake?: string };

export async function sendBusMessageWithWake(
  root: string,
  input: BusSendInput,
): Promise<BusSendWithWakeResult> {
  const sent = await sendBusMessage(root, input);
  // AFTER the send has resolved, never inside it. If this line is ever moved
  // above the await, or into `sendBusMessage`, the isolation is gone.
  const wake = await wakeForSend(root, sent);
  return wake === null ? sent : { ...sent, wake };
}

/**
 * The redeliver path with the same wake tier attached.
 *
 * ISS-1131. `redeliverBusMessage` commits real mail through `sendBusMessage` and
 * bypassed the seam entirely, so an idle peer was never woken for a redelivered
 * message. That is the case the tier most needs to cover: the original send was
 * PARKED at the hop cap, and a parked send wakes nobody by design, so this is the
 * first and only chance to wake the peer about that content.
 *
 * NO REDELIVER-SPECIFIC REPLAY GUARD, deliberately. `redeliverBusMessage` has
 * three exits and `wakeForSend`'s existing clause already refuses the two that
 * commit nothing: a marker hit returns `replayed: true` with `replaySource:
 * "marker"`, a receipt replay returns `replayed: true` with `"receipt"`, and only
 * a genuinely fresh redelivery returns `false` with `"none"`. `replayed` is
 * defined as `replaySource !== "none"` at every construction site in the store, so
 * a replay cannot present here as fresh. A second copy of that rule would be a
 * second thing to keep in step.
 */
export async function redeliverBusMessageWithWake(
  root: string,
  input: BusRedeliverInput,
): Promise<BusSendWithWakeResult> {
  const sent = await redeliverBusMessage(root, input);
  // AFTER the redelivery has resolved, never inside it, and NOT inside a try that
  // also covers the redelivery: a redeliver error must still reach the caller.
  const wake = await wakeForSend(root, sent);
  return wake === null ? sent : { ...sent, wake };
}

/**
 * Wake the recipient of a just-committed send.
 *
 * Returns the telemetry string for the send result, or null when no attempt was
 * made. NEVER THROWS: the mail is already committed and the caller's send stands.
 */
export async function wakeForSend(root: string, sent: BusSendResult): Promise<string | null> {
  try {
    // NO *NEW* MAIL, NO WAKE. Three shapes, one rule:
    //  - a parked send was refused at the hop cap;
    //  - a null messageId means nothing landed in a mailbox;
    //  - a REPLAY committed nothing new. It returns the original messageId with
    //    `parked: false`, so it looks exactly like a fresh send here, and without
    //    this clause retrying an idempotency key would start another turn on the
    //    peer and append another wake entry. That is precisely the retry the plan
    //    ruled out (section 1: one send, at most one wake attempt), arriving
    //    through the back door. It would also misattribute: the cursor comes from
    //    the CURRENT mailbox high-water, so a replay would carry unrelated newer
    //    mail's sequence on the replayed message's thread.
    // A wake is not a recovery mechanism, so a failed first wake is NOT retried by
    // replaying the send.
    if (sent.parked || sent.messageId === null || sent.replayed) return null;

    const listed = await listEndpoints(root);
    const recipient = listed.endpoints.find(
      (candidate) => candidate.endpointId === sent.toEndpoint,
    );
    // An unreadable recipient is not a reason to guess. Without the endpoint there
    // is no policy to honour and no thread id to wake.
    if (!recipient) return null;

    // The policy short-circuit is here as well as in gate 1, from the SAME
    // predicate, so the two cannot drift. Gate 1 is the authority for anyone
    // calling `attemptWake` directly; this is what keeps an endpoint that never
    // opted in from costing a send anything at all.
    if (!wakeWanted(recipient)) return null;

    const outcome = await wakeAfterSend({
      root,
      threadId: sent.threadId,
      recipient,
      wakeText: BUS_WAKE_TEXT,
    });
    return wakeTelemetry(outcome);
  } catch {
    // The mail is committed. A wake that blows up must be invisible to the sender
    // beyond the absent `wake` field, or the tier is worse than not having it.
    return null;
  }
}
