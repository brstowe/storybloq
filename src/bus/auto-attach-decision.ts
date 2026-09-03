// T-430: pure, side-effect-free auto-attach decision. Kept in its own module (no I/O,
// no heavy imports) so it is trivially unit-testable and the child's decision logic can
// never accidentally depend on filesystem state.

export type EndpointLiveness = "attached" | "offline" | "unknown";
export type AutoAttachClient = "claude" | "codex";

export interface AutoAttachCandidate {
  readonly endpointId: string;
  readonly client: AutoAttachClient;
  readonly clientTaskId: string;
  readonly joinedAt: string;
  readonly liveness: EndpointLiveness;
}

export interface AutoAttachSelf {
  readonly client: AutoAttachClient;
  readonly clientTaskId: string;
}

export type AutoAttachDecision =
  | { readonly action: "attach"; readonly reason: string }
  | { readonly action: "replace"; readonly replaceId: string; readonly reason: string }
  | { readonly action: "skip"; readonly reason: string };

// Capacity is two endpoints per Bus. `active` is every non-retired endpoint annotated with
// its resolved liveness; `self` is this session's identity. Never replaces a live peer and
// never replaces self -- identity is the full {client, clientTaskId} tuple, because Claude
// and Codex task ids can collide as text and must not alias to the same endpoint. Strict
// "offline" (proven-dead pid) only ever authorizes a replace; "unknown" (a briefly-paused
// or codex_desktop endpoint) never does.
export function autoAttachDecision(
  active: readonly AutoAttachCandidate[],
  self: AutoAttachSelf,
): AutoAttachDecision {
  if (active.length === 0) {
    return { action: "attach", reason: "no active endpoints" };
  }

  const isSelf = (endpoint: AutoAttachCandidate): boolean =>
    endpoint.client === self.client && endpoint.clientTaskId === self.clientTaskId;
  const offline = active
    .filter((endpoint) => endpoint.liveness === "offline" && !isSelf(endpoint))
    .slice()
    .sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : a.joinedAt > b.joinedAt ? 1
      : a.endpointId < b.endpointId ? -1 : a.endpointId > b.endpointId ? 1 : 0));

  if (active.length === 1) {
    return offline.length >= 1
      ? { action: "replace", replaceId: offline[0]!.endpointId, reason: "sole peer is proven offline" }
      : { action: "attach", reason: "a slot is free" };
  }

  // Two (or more, defensively) active endpoints: the Bus is full. Only a proven-offline,
  // non-self peer can be reclaimed; otherwise stay unattached and disturb no live peer.
  if (offline.length >= 1) {
    return { action: "replace", replaceId: offline[0]!.endpointId, reason: "reclaiming a proven-offline peer" };
  }
  return { action: "skip", reason: "both slots held by live peers" };
}
