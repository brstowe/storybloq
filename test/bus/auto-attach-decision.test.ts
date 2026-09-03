import { describe, expect, it } from "vitest";
import {
  autoAttachDecision,
  type AutoAttachCandidate,
  type AutoAttachSelf,
} from "../../src/bus/auto-attach-decision.js";

function candidate(overrides: Partial<AutoAttachCandidate> & { endpointId: string }): AutoAttachCandidate {
  return {
    client: "claude",
    clientTaskId: `task-${overrides.endpointId}`,
    joinedAt: "2026-07-15T00:00:00.000Z",
    liveness: "attached",
    ...overrides,
  };
}

describe("autoAttachDecision", () => {
  const SELF: AutoAttachSelf = { client: "claude", clientTaskId: "self-task" };

  it("attaches when there are no active endpoints", () => {
    expect(autoAttachDecision([], SELF)).toMatchObject({ action: "attach" });
  });

  it("attaches into the free slot when the sole peer is alive", () => {
    const active = [candidate({ endpointId: "a", liveness: "attached" })];
    expect(autoAttachDecision(active, SELF)).toMatchObject({ action: "attach" });
  });

  it("replaces the sole peer when it is proven offline", () => {
    const active = [candidate({ endpointId: "a", liveness: "offline" })];
    expect(autoAttachDecision(active, SELF)).toMatchObject({ action: "replace", replaceId: "a" });
  });

  it("attaches (never replaces self) when the sole active endpoint is self and offline", () => {
    const active = [candidate({ endpointId: "a", client: "claude", clientTaskId: SELF.clientTaskId, liveness: "offline" })];
    expect(autoAttachDecision(active, SELF)).toMatchObject({ action: "attach" });
  });

  it("replaces an offline peer that shares the task-id text but is a DIFFERENT client (not self)", () => {
    // Identity is {client, clientTaskId}: a codex endpoint whose task id happens to equal
    // this claude session's task id is a foreign peer, not self, so it can be reclaimed.
    const active = [candidate({ endpointId: "a", client: "codex", clientTaskId: SELF.clientTaskId, liveness: "offline" })];
    expect(autoAttachDecision(active, SELF)).toMatchObject({ action: "replace", replaceId: "a" });
  });

  it("skips when both slots are held by live peers", () => {
    const active = [
      candidate({ endpointId: "a", liveness: "attached" }),
      candidate({ endpointId: "b", liveness: "attached" }),
    ];
    expect(autoAttachDecision(active, SELF)).toMatchObject({ action: "skip" });
  });

  it("skips when the pair is one live and one unknown (unknown never qualifies)", () => {
    const active = [
      candidate({ endpointId: "a", liveness: "attached" }),
      candidate({ endpointId: "b", liveness: "unknown" }),
    ];
    expect(autoAttachDecision(active, SELF)).toMatchObject({ action: "skip" });
  });

  it("replaces the deterministic (oldest joinedAt) offline peer when the pair is both offline", () => {
    const active = [
      candidate({ endpointId: "newer", liveness: "offline", joinedAt: "2026-07-15T02:00:00.000Z" }),
      candidate({ endpointId: "older", liveness: "offline", joinedAt: "2026-07-15T01:00:00.000Z" }),
    ];
    expect(autoAttachDecision(active, SELF)).toMatchObject({ action: "replace", replaceId: "older" });
  });

  it("breaks a joinedAt tie lexicographically by endpointId", () => {
    const active = [
      candidate({ endpointId: "zeta", liveness: "offline", joinedAt: "2026-07-15T01:00:00.000Z" }),
      candidate({ endpointId: "alpha", liveness: "offline", joinedAt: "2026-07-15T01:00:00.000Z" }),
    ];
    expect(autoAttachDecision(active, SELF)).toMatchObject({ action: "replace", replaceId: "alpha" });
  });

  it("never selects self as the replace target when full", () => {
    const active = [
      candidate({ endpointId: "a", client: "claude", clientTaskId: SELF.clientTaskId, liveness: "offline" }),
      candidate({ endpointId: "b", liveness: "attached" }),
    ];
    expect(autoAttachDecision(active, SELF)).toMatchObject({ action: "skip" });
  });
});
