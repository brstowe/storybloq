import { describe, it, expect } from "vitest";
import {
  buildAutoStartEventData,
  buildTieredStartEventData,
} from "../../src/autonomous/event-data.js";

describe("T-383: session_start event displayIdMap", () => {
  describe("auto-mode start event data", () => {
    it("includes displayIdMap from targetWorkDisplayIds", () => {
      const targetWork = ["t-abc1234567890123", "i-issue00000000001"];
      const targetWorkDisplayIds: Record<string, string> = {
        "t-abc1234567890123": "T-042",
        "i-issue00000000001": "ISS-077",
      };

      const eventData = buildAutoStartEventData({
        recipe: "coding",
        branch: "feature/test",
        head: "abc123",
        targetWork,
        targetWorkDisplayIds,
      });

      expect(eventData.targetWork).toEqual(["t-abc1234567890123", "i-issue00000000001"]);
      expect(eventData.displayIdMap).toEqual({
        "t-abc1234567890123": "T-042",
        "i-issue00000000001": "ISS-077",
      });
    });

    it("uses canonical targetWork from session state, not raw input", () => {
      const eventData = buildAutoStartEventData({
        recipe: "coding",
        branch: "main",
        head: "def456",
        targetWork: ["t-canonical0000001"],
        targetWorkDisplayIds: { "t-canonical0000001": "T-001" },
      });

      expect(eventData.targetWork).toEqual(["t-canonical0000001"]);
      expect(eventData.displayIdMap).toEqual({ "t-canonical0000001": "T-001" });
    });

    it("defaults displayIdMap to empty when no display IDs cached", () => {
      const eventData = buildAutoStartEventData({
        recipe: "coding",
        branch: "main",
        head: "ghi789",
        targetWork: ["T-001"],
        targetWorkDisplayIds: undefined,
      });

      expect(eventData.displayIdMap).toEqual({});
    });

    it("omits targetWork and displayIdMap when no targets", () => {
      const eventData = buildAutoStartEventData({
        recipe: "coding",
        branch: "main",
        head: "jkl012",
        targetWork: [],
        targetWorkDisplayIds: undefined,
      });

      expect(eventData.targetWork).toBeUndefined();
      expect(eventData.displayIdMap).toBeUndefined();
    });
  });

  describe("tiered-mode start event data", () => {
    it("writes canonical ticketId and displayIdMap", () => {
      const eventData = buildTieredStartEventData({
        recipe: "coding",
        branch: "feature/test",
        head: "abc123",
        mode: "review",
        canonicalTicketId: "t-abc1234567890123",
        displayId: "T-042",
      });

      expect(eventData.ticketId).toBe("t-abc1234567890123");
      expect(eventData.displayIdMap).toEqual({ "t-abc1234567890123": "T-042" });
    });

    it("omits displayIdMap when canonical equals display", () => {
      const eventData = buildTieredStartEventData({
        recipe: "coding",
        branch: "main",
        head: "def456",
        mode: "guided",
        canonicalTicketId: "T-005",
        displayId: "T-005",
      });

      expect(eventData.ticketId).toBe("T-005");
      expect(eventData.displayIdMap).toBeUndefined();
    });
  });
});

