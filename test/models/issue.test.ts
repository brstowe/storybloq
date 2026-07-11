import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fixturesDir, readJson } from "../helpers.js";
import {
  IssueSchema,
  IssueSourceRefInputSchema,
  IssueSourceRefSchema,
} from "../../src/models/issue.js";

describe("IssueSchema", () => {
  describe("valid issues", () => {
    it("parses a resolved issue with all fields", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/issues/ISS-001.json"));
      const result = IssueSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("ISS-001");
        expect(result.data.status).toBe("resolved");
        expect(result.data.resolution).toBe("Updated engines field to require Node 20+.");
        expect(result.data.resolvedDate).toBe("2026-01-03");
      }
    });

    it("parses an open issue with optional order and phase", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/issues/ISS-002.json"));
      const result = IssueSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.order).toBe(10);
        expect(result.data.phase).toBe("alpha");
        expect(result.data.resolution).toBeNull();
        expect(result.data.resolvedDate).toBeNull();
      }
    });

    it("parses an issue with optional fields absent", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/issues/ISS-001.json"));
      const result = IssueSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.order).toBeUndefined();
        expect(result.data.phase).toBeUndefined();
      }
    });

    it("parses critical severity", () => {
      const data = {
        id: "ISS-099", title: "Critical issue", status: "open", severity: "critical",
        components: ["core"], impact: "System down.", resolution: null,
        location: ["main.ts:1"], discoveredDate: "2026-01-01", resolvedDate: null,
        relatedTickets: [],
      };
      const result = IssueSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.severity).toBe("critical");
      }
    });

    it("parses all valid fixture issues", () => {
      for (const file of ["ISS-001.json", "ISS-002.json"]) {
        const data = readJson(resolve(fixturesDir, `valid/basic/issues/${file}`));
        expect(IssueSchema.safeParse(data).success, `Failed to parse ${file}`).toBe(true);
      }
    });
  });

  describe("invalid issues", () => {
    it("rejects an issue with invalid severity", () => {
      const data = readJson(resolve(fixturesDir, "invalid/bad-severity-issue.json"));
      expect(IssueSchema.safeParse(data).success).toBe(false);
    });

    it("rejects an issue with invalid id format", () => {
      const data = {
        id: "ISSUE-001", title: "Bad ID", status: "open", severity: "low",
        components: [], impact: "None.", resolution: null, location: [],
        discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [],
      };
      expect(IssueSchema.safeParse(data).success).toBe(false);
    });

    it("rejects an issue with missing required field", () => {
      const data = {
        id: "ISS-100", title: "Missing impact", status: "open", severity: "low",
        components: [], resolution: null, location: [],
        discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [],
      };
      expect(IssueSchema.safeParse(data).success).toBe(false);
    });

    it("rejects an issue with invalid relatedTickets format", () => {
      const data = {
        id: "ISS-101", title: "Bad related", status: "open", severity: "low",
        components: [], impact: "Bad ref.", resolution: null, location: [],
        discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: ["not-a-ticket-id"],
      };
      expect(IssueSchema.safeParse(data).success).toBe(false);
    });
  });

  describe("round-trip unknown key preservation", () => {
    it("preserves unknown extra keys through parse and serialize", () => {
      const data = {
        id: "ISS-050", title: "Issue with extras", status: "open", severity: "low",
        components: ["test"], impact: "None.", resolution: null, location: ["file.ts:1"],
        discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [],
        extraField: "preserved", extraNumber: 99,
      };
      const result = IssueSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.extraField).toBe("preserved");
        expect(result.data.extraNumber).toBe(99);

        const serialized = JSON.parse(JSON.stringify(result.data));
        const reparsed = IssueSchema.safeParse(serialized);
        expect(reparsed.success).toBe(true);
        if (reparsed.success) {
          expect(reparsed.data.extraField).toBe("preserved");
        }
      }
    });
  });

  describe("source references", () => {
    const hash = "a".repeat(64);

    it("accepts durable revision and hash provenance", () => {
      const result = IssueSourceRefSchema.safeParse({
        path: "src/example.ts",
        startLine: 4,
        endLine: 6,
        revision: "abcdef12",
        contentHash: hash,
        reviewId: "review-1",
      });
      expect(result.success).toBe(true);
    });

    it("allows write input without a hash so the handler can capture it", () => {
      expect(IssueSourceRefInputSchema.safeParse({
        path: "src/example.ts",
        startLine: 4,
      }).success).toBe(true);
    });

    it("keeps write input strict while persisted refs preserve additive fields", () => {
      const candidate = {
        path: "src/example.ts",
        startLine: 4,
        contentHash: hash,
        futureEvidence: { provider: "review-v2" },
      };

      expect(IssueSourceRefInputSchema.safeParse(candidate).success).toBe(false);
      const persisted = IssueSourceRefSchema.safeParse(candidate);
      expect(persisted.success).toBe(true);
      if (persisted.success) {
        expect(persisted.data.futureEvidence).toEqual({ provider: "review-v2" });
      }
    });

    it("requires durable persisted provenance", () => {
      expect(IssueSourceRefSchema.safeParse({
        path: "src/example.ts",
        startLine: 4,
      }).success).toBe(false);
    });

    it.each([
      "/tmp/example.ts",
      "../example.ts",
      "src/../example.ts",
      "src\\example.ts",
      "src/example.ts:4",
    ])("rejects unsafe source path %s", (path) => {
      expect(IssueSourceRefInputSchema.safeParse({ path, startLine: 1 }).success).toBe(false);
    });

    it("rejects reversed line ranges and malformed hashes", () => {
      expect(IssueSourceRefInputSchema.safeParse({
        path: "src/example.ts",
        startLine: 5,
        endLine: 4,
      }).success).toBe(false);
      expect(IssueSourceRefSchema.safeParse({
        path: "src/example.ts",
        startLine: 1,
        contentHash: "not-a-hash",
      }).success).toBe(false);
    });

    it("rejects control characters in provenance identifiers", () => {
      expect(IssueSourceRefInputSchema.safeParse({
        path: "src/example.ts",
        startLine: 1,
        reviewId: "review\u001b[2J",
      }).success).toBe(false);
    });
  });
});
