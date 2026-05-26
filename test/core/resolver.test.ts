import { describe, it, expect } from "vitest";
import { makeTicket, makeIssue, makeState } from "./test-factories.js";

describe("resolveTicketRef", () => {
  it("resolves legacy ID via primary index", () => {
    const t = makeTicket({ id: "T-001" });
    const state = makeState({ tickets: [t] });
    const result = state.resolveTicketRef("T-001");
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.item.id).toBe("T-001");
      expect(result.matchedBy).toBe("id");
    }
  });

  it("resolves canonical ID via primary index", () => {
    const t = makeTicket({
      id: "t-k7m2p9x3w4a5b6e8",
      displayId: "T-051",
    } as any);
    const state = makeState({ tickets: [t] });
    const result = state.resolveTicketRef("t-k7m2p9x3w4a5b6e8");
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.item.id).toBe("t-k7m2p9x3w4a5b6e8");
      expect(result.matchedBy).toBe("id");
    }
  });

  it("resolves display ID via secondary index", () => {
    const t = makeTicket({
      id: "t-k7m2p9x3w4a5b6e8",
      displayId: "T-051",
    } as any);
    const state = makeState({ tickets: [t] });
    const result = state.resolveTicketRef("T-051");
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.item.id).toBe("t-k7m2p9x3w4a5b6e8");
      expect(result.matchedBy).toBe("displayId");
    }
  });

  it("resolves previous display ID with warning", () => {
    const t = makeTicket({
      id: "t-k7m2p9x3w4a5b6e8",
      displayId: "T-067",
      previousDisplayIds: ["T-051"],
    } as any);
    const state = makeState({ tickets: [t] });
    const result = state.resolveTicketRef("T-051");
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.item.id).toBe("t-k7m2p9x3w4a5b6e8");
      expect(result.matchedBy).toBe("previousDisplayId");
    }
  });

  it("current displayId wins over previousDisplayIds", () => {
    const t1 = makeTicket({
      id: "t-aaa",
      displayId: "T-051",
    } as any);
    const t2 = makeTicket({
      id: "t-bbb",
      displayId: "T-067",
      previousDisplayIds: ["T-051"],
    } as any);
    const state = makeState({ tickets: [t1, t2] });
    const result = state.resolveTicketRef("T-051");
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.item.id).toBe("t-aaa");
      expect(result.matchedBy).toBe("displayId");
    }
  });

  it("returns ambiguous when two tickets share displayId", () => {
    const t1 = makeTicket({
      id: "t-aaa",
      displayId: "T-051",
    } as any);
    const t2 = makeTicket({
      id: "t-bbb",
      displayId: "T-051",
    } as any);
    const state = makeState({ tickets: [t1, t2] });
    const result = state.resolveTicketRef("T-051");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.matches).toHaveLength(2);
    }
  });

  it("returns ambiguous when two items share a previousDisplayId", () => {
    const t1 = makeTicket({
      id: "t-aaa",
      displayId: "T-060",
      previousDisplayIds: ["T-030"],
    } as any);
    const t2 = makeTicket({
      id: "t-bbb",
      displayId: "T-070",
      previousDisplayIds: ["T-030"],
    } as any);
    const state = makeState({ tickets: [t1, t2] });
    const result = state.resolveTicketRef("T-030");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.matches).toHaveLength(2);
    }
  });

  it("returns missing when no match", () => {
    const state = makeState({ tickets: [makeTicket({ id: "T-001" })] });
    const result = state.resolveTicketRef("T-999");
    expect(result.kind).toBe("missing");
  });

  it("legacy ticket resolves via secondary index (displayId defaults to id)", () => {
    const t = makeTicket({ id: "T-030" });
    const state = makeState({ tickets: [t] });
    const result = state.resolveTicketRef("T-030");
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.matchedBy).toBe("id");
    }
  });

  it("does not cross-resolve issue IDs", () => {
    const iss = makeIssue({ id: "ISS-001" });
    const state = makeState({ issues: [iss] });
    const result = state.resolveTicketRef("ISS-001");
    expect(result.kind).toBe("missing");
  });
});

describe("resolveIssueRef", () => {
  it("resolves display ID for issue", () => {
    const iss = makeIssue({
      id: "i-abc123",
      displayId: "ISS-042",
    } as any);
    const state = makeState({ issues: [iss] });
    const result = state.resolveIssueRef("ISS-042");
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.item.id).toBe("i-abc123");
      expect(result.matchedBy).toBe("displayId");
    }
  });
});

describe("resolvedBlockers", () => {
  it("resolves mixed legacy and canonical refs in blockedBy", () => {
    const t1 = makeTicket({ id: "T-001" });
    const t2 = makeTicket({
      id: "t-k7m2p9x3w4a5b6e8",
      displayId: "T-002",
    } as any);
    const t3 = makeTicket({
      id: "T-003",
      blockedBy: ["T-001", "t-k7m2p9x3w4a5b6e8"],
    });
    const state = makeState({ tickets: [t1, t2, t3] });
    const blockers = state.resolvedBlockers(t3);
    expect(blockers).toHaveLength(2);
    expect(blockers.map((b) => b.id).sort()).toEqual(["T-001", "t-k7m2p9x3w4a5b6e8"]);
  });
});

describe("isBlockedByResolver", () => {
  it("missing blocker ref means blocked (safe default)", () => {
    const t = makeTicket({ id: "T-001", blockedBy: ["T-999"] });
    const state = makeState({ tickets: [t] });
    expect(state.isBlockedByResolver(t)).toBe(true);
  });

  it("ambiguous blocker ref means blocked", () => {
    const dup1 = makeTicket({ id: "t-aaa", displayId: "T-010" } as any);
    const dup2 = makeTicket({ id: "t-bbb", displayId: "T-010" } as any);
    const t = makeTicket({ id: "T-001", blockedBy: ["T-010"] });
    const state = makeState({ tickets: [dup1, dup2, t] });
    expect(state.isBlockedByResolver(t)).toBe(true);
  });

  it("complete blocker means not blocked", () => {
    const blocker = makeTicket({ id: "T-001", status: "complete" });
    const t = makeTicket({ id: "T-002", blockedBy: ["T-001"] });
    const state = makeState({ tickets: [blocker, t] });
    expect(state.isBlockedByResolver(t)).toBe(false);
  });
});

describe("resolvedParentRef", () => {
  it("returns null when no parentTicket", () => {
    const t = makeTicket({ id: "T-001" });
    const state = makeState({ tickets: [t] });
    expect(state.resolvedParentRef(t)).toBeNull();
  });

  it("returns found for valid parent", () => {
    const parent = makeTicket({ id: "T-001" });
    const child = makeTicket({ id: "T-002", parentTicket: "T-001" });
    const state = makeState({ tickets: [parent, child] });
    const result = state.resolvedParentRef(child);
    expect(result?.kind).toBe("found");
  });

  it("returns missing for invalid parent ref", () => {
    const child = makeTicket({ id: "T-002", parentTicket: "T-999" });
    const state = makeState({ tickets: [child] });
    const result = state.resolvedParentRef(child);
    expect(result?.kind).toBe("missing");
  });
});
