/**
 * Lens cache tests (ISS-823 migration of the fork's cache.test.ts to the
 * package finding schema and the formatVersion-2 entry format).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LensFinding } from "@storybloq/lenses";
import {
  buildCacheKey,
  getFromCache,
  writeToCache,
  clearCache,
  getCacheMetrics,
  resetCacheMetrics,
} from "../../../src/autonomous/lens-harness/cache.js";

let sessionDir: string;

const finding: LensFinding = {
  id: "sec-1",
  severity: "blocking",
  category: "injection",
  file: "src/api.ts",
  line: 10,
  snippet: { quote: "db.query('SELECT * FROM users')", startLine: 10 },
  description: "test finding",
  suggestion: "parameterize the query",
  confidence: 0.9,
};

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "lens-cache-test-"));
});

afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

describe("lens cache", () => {
  it("returns null for cache miss", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    expect(getFromCache(sessionDir, key)).toBeNull();
  });

  it("stores and retrieves findings", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    writeToCache(sessionDir, key, [finding]);
    const cached = getFromCache(sessionDir, key);
    expect(cached).toHaveLength(1);
    expect(cached![0]!.category).toBe("injection");
  });

  it("produces different keys for different file content", () => {
    const k1 = buildCacheKey("security", "v1", "CODE_REVIEW", "contentA", "desc", "rules", "fps");
    const k2 = buildCacheKey("security", "v1", "CODE_REVIEW", "contentB", "desc", "rules", "fps");
    expect(k1).not.toBe(k2);
  });

  it("produces different keys for different lens versions", () => {
    const k1 = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    const k2 = buildCacheKey("security", "v2", "CODE_REVIEW", "content", "desc", "rules", "fps");
    expect(k1).not.toBe(k2);
  });

  it("produces different keys for different stages", () => {
    const k1 = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    const k2 = buildCacheKey("security", "v1", "PLAN_REVIEW", "content", "desc", "rules", "fps");
    expect(k1).not.toBe(k2);
  });

  it("clearCache removes all cached entries", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    writeToCache(sessionDir, key, [finding]);
    expect(getFromCache(sessionDir, key)).not.toBeNull();
    clearCache(sessionDir);
    expect(getFromCache(sessionDir, key)).toBeNull();
  });

  it("clearCache is safe on non-existent directory", () => {
    clearCache(join(sessionDir, "nonexistent"));
    // No throw
  });

  it("handles empty findings array", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    writeToCache(sessionDir, key, []);
    const cached = getFromCache(sessionDir, key);
    expect(cached).toHaveLength(0);
  });
});

// ── CDX-19 cache invalidation contract (package schema) ─────────────

describe("lens cache CDX-19 invalidation contract", () => {
  beforeEach(() => {
    resetCacheMetrics();
  });

  // formatVersion null = omit the field entirely (fork-era entry shape).
  function writeRawCacheEntry(key: string, payload: unknown, formatVersion: number | null = 2): void {
    const dir = join(sessionDir, "lens-cache");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${key}.json`),
      JSON.stringify({
        ...(formatVersion !== null ? { formatVersion } : {}),
        findings: payload,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  it("skips invalid findings, returns only valid siblings (CDX-19.1)", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    const goodA = finding;
    const badZod = { ...finding, confidence: 7 }; // out-of-range confidence rejected by Zod
    const goodB = { ...finding, id: "sec-2", description: "another finding" };
    writeRawCacheEntry(key, [goodA, badZod, goodB]);
    const cached = getFromCache(sessionDir, key);
    expect(cached).toHaveLength(2);
    const descriptions = (cached ?? []).map((f) => f.description);
    expect(descriptions).toContain("test finding");
    expect(descriptions).toContain("another finding");
  });

  it("increments cache_validation_skip_total by one per invalid finding (CDX-19.2)", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    const badA = { ...finding, confidence: 7 };
    const badB = { ...finding, severity: "critical" }; // fork severity vocabulary rejected
    const good = finding;
    writeRawCacheEntry(key, [good, badA, badB]);
    getFromCache(sessionDir, key);
    expect(getCacheMetrics().cache_validation_skip_total).toBe(2);
  });

  it("emits exactly one structured warn log line per invalid entry (CDX-19.3)", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    const bad = { ...finding, confidence: 7 };
    writeRawCacheEntry(key, [finding, bad]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    getFromCache(sessionDir, key);
    const warnCalls = warnSpy.mock.calls.filter((call) => {
      const first = call[0];
      return typeof first === "string" && first.includes("cache_validation_skip");
    });
    expect(warnCalls).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("does not rewrite the cache file on invalidation (CDX-19.4)", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    const bad = { ...finding, confidence: 7 };
    writeRawCacheEntry(key, [finding, bad]);
    const path = join(sessionDir, "lens-cache", `${key}.json`);
    const before = readFileSync(path, "utf-8");
    getFromCache(sessionDir, key);
    const after = readFileSync(path, "utf-8");
    expect(after).toBe(before);
  });

  it("treats fork-era entries without formatVersion as a miss (ISS-823)", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    // A fork-shaped entry: no formatVersion, fork finding schema. Must never
    // replay into the package pipeline.
    writeRawCacheEntry(
      key,
      [
        {
          lens: "security",
          lensVersion: "security-v1",
          severity: "critical",
          recommendedImpact: "blocker",
          category: "injection",
          description: "fork finding",
          file: "src/api.ts",
          line: 10,
          evidence: [{ file: "src/api.ts", startLine: 10, endLine: 10, code: "x" }],
          suggestedFix: null,
          confidence: 0.9,
          assumptions: null,
          requiresMoreContext: false,
        },
      ],
      null,
    );
    expect(getFromCache(sessionDir, key)).toBeNull();
    // No per-finding validation ran: the whole entry misses on format.
    expect(getCacheMetrics().cache_validation_skip_total).toBe(0);
  });

  it("strict schema rejects extra orchestrator fields instead of passing them through (R1)", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    const withForkMeta = { ...finding, issueKey: "k-A", blocking: true };
    writeRawCacheEntry(key, [withForkMeta, { ...finding, id: "sec-2" }]);
    const cached = getFromCache(sessionDir, key);
    // The strict package schema drops the finding carrying fork-era extras.
    expect(cached).toHaveLength(1);
    expect(cached![0]!.id).toBe("sec-2");
    expect(getCacheMetrics().cache_validation_skip_total).toBe(1);
  });
});
