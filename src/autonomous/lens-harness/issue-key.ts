import { createHash } from "node:crypto";

/**
 * Deterministic issue key generation for finding dedup at the filing boundary
 * (ISS-823 carry-over from the retired review-lenses fork, adapted to the
 * package MergedFinding shape).
 *
 * Uses DJB2 hash for the unlocated fallback key. Note: this is an independent
 * key space from guide.ts deferral fingerprints (different output format).
 */

interface KeyableFinding {
  readonly file: string | null;
  readonly line: number | null;
  readonly category: string;
  readonly description: string;
  readonly contributingLenses: readonly string[];
}

function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

export function generateIssueKey(finding: KeyableFinding): string {
  const lens = finding.contributingLenses[0] ?? "lens";
  if (finding.file && finding.line != null) {
    return `${lens}:${finding.file}:${finding.line}:${finding.category}`;
  }
  // Unlocated fallback: no file/line
  const descWords = finding.description.split(/\s+/).slice(0, 20).join(" ");
  return `${lens}:${finding.category}:${djb2(descWords)}`;
}

/** Idempotency identity for one finding occurrence in one review. */
export function generateReviewFilingKey(
  reviewId: string,
  finding: KeyableFinding,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([reviewId, generateIssueKey(finding)]), "utf8")
    .digest("hex");
  return `review-lenses:${digest}`;
}
