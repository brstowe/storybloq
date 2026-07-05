/**
 * Verification log -- anchoring telemetry and deferral logging (ISS-823,
 * pen ruling R4).
 *
 * The fork's repo-side evidence gate is retired; T-026 server-side anchoring
 * in @storybloq/lenses is the verification layer. This module carries the
 * fork's LOG semantics forward in the same file shapes consumers already
 * read:
 *
 *  - `verification-telemetry.jsonl` -- one entry per synthesize call, keyed
 *    by reviewId, with the legacy counters (proposed/verified/rejected and
 *    the skip flags read by `classifyLensReviewPath` and
 *    `accumulateVerificationCounters`) plus the new anchoring outcome fields
 *    alongside (anchorRealignedCount, integrityFlagged, coverage).
 *  - `verification.log` -- one JSONL line per evidence_unverified deferral,
 *    in the legacy rejection-entry field shape.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { ReviewVerdict, Stage } from "@storybloq/lenses";
import type { VerificationCounters } from "../session-types.js";

// ── Anchoring telemetry (verification-telemetry.jsonl) ──────────

export interface AnchoringTelemetryEntry {
  readonly reviewId: string;
  readonly proposed: number;
  readonly verified: number;
  readonly rejected: number;
  readonly snapshotIntegrityFailure: boolean;
  readonly verificationSkipped: boolean;
  readonly verificationDegraded: boolean;
  readonly verificationRuntimeErrors: number;
  readonly logWriteFailures: number;
  // ISS-823: package anchoring outcomes, additive alongside the legacy shape.
  readonly anchorRealignedCount: number;
  readonly integrityFlagged: number;
  readonly coverage: "full" | "partial";
  readonly timestamp: string;
}

export function appendAnchoringTelemetry(
  sessionDir: string,
  entry: AnchoringTelemetryEntry,
): { ok: boolean } {
  try {
    appendFileSync(
      join(sessionDir, "verification-telemetry.jsonl"),
      JSON.stringify(entry) + "\n",
    );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ── Deferral logging (verification.log) ─────────────────────────

interface RejectionLine {
  findingId: string;
  lens: string;
  stage: string;
  reasonCode: string;
  failedEvidenceIndex: number;
  claimed: {
    file: string;
    startLine: number;
    endLine: number;
    codeHash: string;
  } | null;
  actualExcerpt: string;
  actualHash: string;
}

/**
 * Record every evidence_unverified deferral from a package verdict in the
 * legacy rejection-log shape. Returns the number of failed writes so the
 * caller can surface logWriteFailures in telemetry.
 */
export function appendDeferralRejections(
  sessionDir: string,
  verdict: ReviewVerdict,
  stage: Stage,
): number {
  const stageLabel = stage === "PLAN_REVIEW" ? "plan-review" : "code-review";
  let failures = 0;
  for (const d of verdict.deferred) {
    if (d.reason !== "evidence_unverified") continue;
    const f = d.finding;
    const line: RejectionLine = {
      findingId: f.id,
      lens: f.contributingLenses[0] ?? "unknown",
      stage: stageLabel,
      reasonCode: "evidence_unverified",
      failedEvidenceIndex: 0,
      claimed:
        f.file !== null
          ? {
              file: f.file,
              startLine: f.line ?? f.snippet?.startLine ?? 0,
              // The package snippet has no endLine field, so span it from the
              // quote's line count rather than collapsing multi-line evidence
              // to a single line in the log.
              endLine:
                (f.line ?? f.snippet?.startLine ?? 0) +
                (f.snippet ? f.snippet.quote.split("\n").length - 1 : 0),
              codeHash: f.snippet
                ? createHash("sha256").update(f.snippet.quote).digest("hex")
                : "",
            }
          : null,
      actualExcerpt: "",
      actualHash: "",
    };
    try {
      appendFileSync(
        join(sessionDir, "verification.log"),
        JSON.stringify(line) + "\n",
      );
    } catch {
      failures++;
    }
  }
  return failures;
}

// ── Telemetry accumulation (unchanged consumer semantics) ───────

export function accumulateVerificationCounters(ctx: {
  sessionDir: string;
  state: { verificationCounters?: VerificationCounters };
  writeState: (updates: { verificationCounters: VerificationCounters }) => unknown;
}): void {
  const telemetryPath = join(ctx.sessionDir, "verification-telemetry.jsonl");
  let raw: string;
  try {
    raw = readFileSync(telemetryPath, "utf-8");
  } catch {
    return;
  }

  // Split and drop the last segment: it's either "" (from trailing \n)
  // or a partial line from a concurrent append. Either way, exclude it.
  const lines = raw === "" ? [] : raw.split("\n").slice(0, -1);
  const prev = ctx.state.verificationCounters ?? {
    proposed: 0,
    verified: 0,
    rejected: 0,
    filed: 0,
    lastTelemetryLine: 0,
  };

  if (prev.lastTelemetryLine >= lines.length) return;

  let newProposed = 0;
  let newVerified = 0;
  let newRejected = 0;
  for (let i = prev.lastTelemetryLine; i < lines.length; i++) {
    try {
      const e = JSON.parse(lines[i]!);
      if (
        typeof e.proposed !== "number" ||
        typeof e.verified !== "number" ||
        typeof e.rejected !== "number"
      ) continue;
      newProposed += e.proposed;
      newVerified += e.verified;
      newRejected += e.rejected;
    } catch {
      // malformed line: skip, still advance checkpoint
    }
  }

  ctx.writeState({
    verificationCounters: {
      proposed: prev.proposed + newProposed,
      verified: prev.verified + newVerified,
      rejected: prev.rejected + newRejected,
      filed: prev.filed,
      lastTelemetryLine: lines.length,
    },
  });
}
