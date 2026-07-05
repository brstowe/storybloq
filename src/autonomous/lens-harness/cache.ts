/**
 * Per-artifact-hash finding cache for multi-round reviews (ISS-823 carry-over
 * from the retired review-lenses fork, adapted to the package finding schema).
 *
 * Round 2 fixing 3 of 15 files with 5 active lenses reuses the untouched
 * lenses' round-1 findings instead of respawning them. The cache key includes
 * the package lens version, stage, and context hashes so prompt/context
 * changes invalidate correctly.
 *
 * Format note: entries carry `formatVersion: 2` (package LensFinding shape,
 * pen ruling R1). Legacy fork-era entries (no formatVersion, fork finding
 * shape) never validate and are treated as misses, so a session that spans
 * the migration cannot replay fork-shaped findings into the package pipeline.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { LensFindingSchema, type LensFinding, type Stage } from "@storybloq/lenses";

const CACHE_DIR = "lens-cache";
const CACHE_FORMAT_VERSION = 2;

// CDX-19 cache invalidation observability. Counter is module-local and
// monotonically increasing across the process lifetime (operators read it
// via `getCacheMetrics()`; `resetCacheMetrics()` is test-only).
interface CacheMetrics {
  cache_validation_skip_total: number;
}
const cacheMetrics: CacheMetrics = { cache_validation_skip_total: 0 };

export function getCacheMetrics(): Readonly<CacheMetrics> {
  return { ...cacheMetrics };
}

export function resetCacheMetrics(): void {
  cacheMetrics.cache_validation_skip_total = 0;
}

interface CacheEntry {
  readonly formatVersion: number;
  readonly findings: readonly LensFinding[];
  readonly timestamp: string;
}

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 32);
}

export function buildCacheKey(
  lens: string,
  lensVersion: string,
  stage: Stage,
  artifact: string,
  ticketDescription: string,
  projectRules: string,
  knownFalsePositives: string,
): string {
  const parts = [
    lens,
    lensVersion,
    stage,
    sha256(artifact),
    sha256(ticketDescription),
    sha256(projectRules),
    sha256(knownFalsePositives),
  ];
  return sha256(parts.join(":"));
}

export function getFromCache(
  sessionDir: string,
  cacheKey: string,
): readonly LensFinding[] | null {
  const file = join(sessionDir, CACHE_DIR, `${cacheKey}.json`);
  if (!existsSync(file)) return null;
  try {
    const entry = JSON.parse(readFileSync(file, "utf-8")) as Partial<CacheEntry>;
    // Fork-era entries (no formatVersion) are structurally incompatible with
    // the package pipeline: treat as a miss rather than validating per-item.
    if (entry.formatVersion !== CACHE_FORMAT_VERSION) return null;
    if (!Array.isArray(entry.findings)) return null;
    // Empty findings is a valid cache hit (lens found nothing wrong)
    if (entry.findings.length === 0) return [];
    // CDX-19 invalidation contract: run cached findings through the package
    // Zod schema. Skip invalid findings (incrementing the metric + emitting a
    // structured warn per skip); do NOT rewrite the cache file; return the
    // surviving valid findings unchanged.
    const valid: LensFinding[] = [];
    for (const raw of entry.findings) {
      const res = LensFindingSchema.safeParse(raw);
      if (res.success) {
        valid.push(res.data);
        continue;
      }
      cacheMetrics.cache_validation_skip_total += 1;
      try {
        // eslint-disable-next-line no-console
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "cache_validation_skip",
            cacheKey,
            reason: res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          }),
        );
      } catch {
        // Swallow logger errors -- metric already incremented.
      }
    }
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

export function writeToCache(
  sessionDir: string,
  cacheKey: string,
  findings: readonly LensFinding[],
): void {
  const dir = join(sessionDir, CACHE_DIR);
  mkdirSync(dir, { recursive: true });
  const entry: CacheEntry = {
    formatVersion: CACHE_FORMAT_VERSION,
    findings,
    timestamp: new Date().toISOString(),
  };
  // Atomic write: write to tmp then rename (prevents torn writes under concurrent access)
  const tmpPath = join(dir, `${cacheKey}.tmp`);
  const finalPath = join(dir, `${cacheKey}.json`);
  writeFileSync(tmpPath, JSON.stringify(entry, null, 2));
  renameSync(tmpPath, finalPath);
}

export function clearCache(sessionDir: string): void {
  const dir = join(sessionDir, CACHE_DIR);
  if (!existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}
