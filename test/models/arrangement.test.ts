import { describe, it, expect } from "vitest";
import { ArrangementSchema } from "../../src/models/arrangement.js";
import { IDENTITY_ANCHOR_FORMAT_MESSAGE, looksLikeClientTaskId } from "../../src/models/types.js";

function baseArrangement(overrides: Record<string, unknown> = {}) {
  return {
    id: "a-0123456789abcdef",
    lifecycle: "active",
    bounds: ["T-473"],
    parties: [
      { role: "pen", client: "claude", identityAnchor: "claude-session-abc" },
      { role: "worker", client: "claude", identityAnchor: "claude-session-def" },
    ],
    gates: [],
    unreachability: { onIrreversibleWork: "hold" },
    createdDate: "2026-08-27",
    ...overrides,
  };
}

describe("ArrangementSchema", () => {
  describe("duet evidence", () => {
    it("rejects malformed coordination session ids", () => {
      expect(ArrangementSchema.safeParse(baseArrangement({ currentCoordinationSessionId: "../foreign" })).success).toBe(false);
    });
    it("rejects incomplete self-attested receipts", () => {
      expect(ArrangementSchema.safeParse(baseArrangement({ communicationReceipts: [{ verified: true }] })).success).toBe(false);
    });
    it("rejects malformed receipt task identities", () => {
      const receipt = {
        id: "return-1", nonce: "49bffaeb-1c78-4bc9-b0a5-05d9bf14f0f4",
        coordinationSessionId: "f98b2230-ac16-439b-a540-17e87088cf00",
        direction: "worker-to-manager", mode: "native-return",
        source: { client: "codex", id: "worker" },
        destination: { client: "codex", id: "pen" },
        recorder: { client: "codex", id: "pen" },
        senderTool: "mcp__codex_app__send_message_to_thread", collectionTool: null,
        observedAt: "2026-09-07T20:00:00.000Z",
      };
      expect(ArrangementSchema.safeParse(baseArrangement({ communicationReceipts: [receipt] })).success).toBe(true);
      for (const field of ["source", "destination", "recorder"] as const) {
        expect(ArrangementSchema.safeParse(baseArrangement({ communicationReceipts: [{ ...receipt, [field]: { client: "codex", id: "../display name" } }] })).success).toBe(false);
      }
    });
  });
  describe("valid arrangements", () => {
    it("parses a well-formed two-party arrangement", () => {
      const result = ArrangementSchema.safeParse(baseArrangement());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parties).toHaveLength(2);
        expect(result.data.unreachability.onIrreversibleWork).toBe("hold");
      }
    });

    it("accepts a display-form bound ref", () => {
      const result = ArrangementSchema.safeParse(baseArrangement({ bounds: ["T-473"] }));
      expect(result.success).toBe(true);
    });

    it("accepts a canonical bound ref (binding item 1: mixed ledger is permanent)", () => {
      const result = ArrangementSchema.safeParse(baseArrangement({ bounds: ["t-0123456789abcdef"] }));
      expect(result.success).toBe(true);
    });

    it("accepts a mix of display-form and canonical bounds", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({ bounds: ["T-473", "i-0123456789abcdef"] }),
      );
      expect(result.success).toBe(true);
    });

    it("accepts a canonical-form node-qualified bound (ISS-1077)", () => {
      const result = ArrangementSchema.safeParse(baseArrangement({ bounds: ["engine:t-0123456789abcdef"] }));
      expect(result.success).toBe(true);
    });

    it("accepts a mix of local and node-qualified bounds", () => {
      const result = ArrangementSchema.safeParse(baseArrangement({ bounds: ["T-473", "engine:i-0123456789abcdef"] }));
      expect(result.success).toBe(true);
    });

    it("accepts onIrreversibleWork: escalate", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({ unreachability: { onIrreversibleWork: "escalate" } }),
      );
      expect(result.success).toBe(true);
    });

    it("preserves unknown extra keys through parse and serialize (passthrough)", () => {
      const data = baseArrangement({ someFutureField: "preserved" });
      const result = ArrangementSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>).someFutureField).toBe("preserved");
        const roundTripped = ArrangementSchema.safeParse(JSON.parse(JSON.stringify(result.data)));
        expect(roundTripped.success).toBe(true);
        if (roundTripped.success) {
          expect((roundTripped.data as Record<string, unknown>).someFutureField).toBe("preserved");
        }
      }
    });

    it("reserves a per-party provenanceLogRef field without requiring it (acceptance 5)", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({
          parties: [
            { role: "pen", client: "claude", identityAnchor: "claude-session-abc", provenanceLogRef: "bus://thread/1" },
            { role: "worker", client: "codex", identityAnchor: "codex-thread-def" },
          ],
        }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parties[0]?.provenanceLogRef).toBe("bus://thread/1");
      }
    });
  });

  describe("party topology invariant", () => {
    it("rejects two workers and no pen", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({
          parties: [
            { role: "worker", client: "claude", identityAnchor: "claude-session-abc" },
            { role: "worker", client: "claude", identityAnchor: "claude-session-def" },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects two pens and no worker", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({
          parties: [
            { role: "pen", client: "claude", identityAnchor: "claude-session-abc" },
            { role: "pen", client: "claude", identityAnchor: "claude-session-def" },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects duplicate identity (same client + identityAnchor) even across roles", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({
          parties: [
            { role: "pen", client: "claude", identityAnchor: "same-anchor" },
            { role: "worker", client: "claude", identityAnchor: "same-anchor" },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects a single-party arrangement (array min length)", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({ parties: [{ role: "pen", client: "claude", identityAnchor: "claude-session-abc" }] }),
      );
      expect(result.success).toBe(false);
    });

    it("accepts the same identityAnchor across different clients", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({
          parties: [
            { role: "pen", client: "claude", identityAnchor: "shared-name" },
            { role: "worker", client: "codex", identityAnchor: "shared-name" },
          ],
        }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe("unreachability.onIrreversibleWork (binding item 4)", () => {
    it("rejects 'continue' as structurally unrepresentable", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({ unreachability: { onIrreversibleWork: "continue" } }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects a missing onIrreversibleWork", () => {
      const candidate = baseArrangement();
      delete (candidate as { unreachability?: unknown }).unreachability;
      const result = ArrangementSchema.safeParse({ ...candidate, unreachability: {} });
      expect(result.success).toBe(false);
    });
  });

  describe("identityAnchor format", () => {
    it("rejects an identityAnchor that does not match CLIENT_TASK_ID_PATTERN", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({
          parties: [
            { role: "pen", client: "claude", identityAnchor: "has a space" },
            { role: "worker", client: "claude", identityAnchor: "claude-session-def" },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects an empty identityAnchor", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({
          parties: [
            { role: "pen", client: "claude", identityAnchor: "" },
            { role: "worker", client: "claude", identityAnchor: "claude-session-def" },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects a session name with a bracketed ref and names the client-task-id requirement (ISS-1117)", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({
          parties: [
            { role: "pen", client: "claude", identityAnchor: "agentkit-platform-7b [abbe56]" },
            { role: "worker", client: "claude", identityAnchor: "claude-session-def" },
          ],
        }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.join(".") === "parties.0.identityAnchor");
        expect(issue?.message).toBe(IDENTITY_ANCHOR_FORMAT_MESSAGE);
      }
    });
  });

  describe("looksLikeClientTaskId (ISS-1117)", () => {
    it("accepts uuid-shaped anchors, including a non-v4-conformant Codex-style thread id", () => {
      expect(looksLikeClientTaskId("b8df203d-d3f5-4520-8057-96babf59612c")).toBe(true);
      expect(looksLikeClientTaskId("01a07f63-e16d-7783-9ee3-61d9aaaf941c")).toBe(true);
    });

    it("rejects a chosen display name, even one that already passes CLIENT_TASK_ID_PATTERN", () => {
      expect(looksLikeClientTaskId("claude-session-abc")).toBe(false);
      expect(looksLikeClientTaskId("agentkit-platform-7b")).toBe(false);
      expect(looksLikeClientTaskId("")).toBe(false);
    });

    it("rejects a uuid-shaped string containing a non-hex character (pins the character class to hex, not just to shape)", () => {
      expect(looksLikeClientTaskId("g1a07f63-e16d-7783-9ee3-61d9aaaf941c")).toBe(false);
    });
  });

  describe("invalid arrangements", () => {
    it("rejects invalid ID format", () => {
      const result = ArrangementSchema.safeParse(baseArrangement({ id: "ARR-001" }));
      expect(result.success).toBe(false);
    });

    it("rejects an empty bounds array", () => {
      const result = ArrangementSchema.safeParse(baseArrangement({ bounds: [] }));
      expect(result.success).toBe(false);
    });

    it("rejects an invalid lifecycle", () => {
      const result = ArrangementSchema.safeParse(baseArrangement({ lifecycle: "archived" }));
      expect(result.success).toBe(false);
    });

    it("rejects an invalid client", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({
          parties: [
            { role: "pen", client: "gemini", identityAnchor: "claude-session-abc" },
            { role: "worker", client: "claude", identityAnchor: "claude-session-def" },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });

    it("accepts a display-form node-qualified bound (ISS-1077, amended by A4)", () => {
      // A non-team-mode node's items have no canonical id at all -- resolveBoundRef
      // stores whatever shape the resolved item's own `.id` actually is. Display
      // form is exactly as valid a stored bound as canonical form; see
      // NodeQualifiedBoundRefSchema's docblock for the full rationale and the
      // traced-and-fenced coverage residual this permits.
      const result = ArrangementSchema.safeParse(baseArrangement({ bounds: ["engine:T-001"] }));
      expect(result.success).toBe(true);
    });

    it("rejects a node-qualified bound with a bad node-name shape", () => {
      const result = ArrangementSchema.safeParse(baseArrangement({ bounds: ["Engine!:t-0123456789abcdef"] }));
      expect(result.success).toBe(false);
    });

    it("rejects a node-qualified bound with neither ticket nor issue shape", () => {
      const result = ArrangementSchema.safeParse(baseArrangement({ bounds: ["engine:x-0123456789abcdef"] }));
      expect(result.success).toBe(false);
    });
  });
});
