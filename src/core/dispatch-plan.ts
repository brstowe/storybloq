import type { Recommendation } from "./recommend.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DispatchTarget {
  readonly id: string;
  readonly displayId?: string;
  readonly kind: "ticket" | "issue";
  readonly title: string;
  readonly reason: string;
}

export interface DispatchPlanEntry {
  readonly target: DispatchTarget;
  readonly cwd: string;
  readonly prompt: string;
}

export interface DispatchPlan {
  readonly mode: "parallel";
  readonly entries: readonly DispatchPlanEntry[];
  readonly skipped: readonly { id: string; reason: string }[];
  readonly claudeVersion: string | null;
  readonly claudeVersionOk: boolean;
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

const MIN_AGENT_VIEW_VERSION = [2, 1, 139] as const;

function parseVersion(version: string): [number, number, number] | null {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function supportsAgentView(version: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  for (let i = 0; i < 3; i++) {
    if (parsed[i] > MIN_AGENT_VIEW_VERSION[i]) return true;
    if (parsed[i] < MIN_AGENT_VIEW_VERSION[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDispatchableKind(kind: string): kind is "ticket" | "issue" {
  return kind === "ticket" || kind === "issue";
}

function normalizeId(id: string): string {
  const upper = id.toUpperCase();
  const match = upper.match(/^(T-\d+)([A-Z]?)$/);
  if (match && match[2]) return match[1] + match[2].toLowerCase();
  return upper;
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

export function buildDispatchPlan(
  recommendations: readonly Recommendation[],
  ids: readonly string[] | "all",
  root: string,
  claudeVersion: string | null,
  maxAgents: number,
  lookupTitle?: (id: string) => string | undefined,
): DispatchPlan {
  const skipped: { id: string; reason: string }[] = [];
  let targets: DispatchTarget[];

  if (ids === "all") {
    const dispatchable = recommendations.filter((r) => isDispatchableKind(r.kind));
    targets = dispatchable
      .slice(0, maxAgents)
      .map((r) => ({
        id: r.id,
        displayId: r.displayId,
        kind: r.kind as "ticket" | "issue",
        title: r.title,
        reason: r.reason,
      }));

    for (const r of dispatchable.slice(maxAgents)) {
      skipped.push({ id: r.id, reason: `exceeds maxParallelAgents (${maxAgents})` });
    }
    const skippedActions = recommendations.filter((r) => r.kind === "action");
    for (const a of skippedActions) {
      skipped.push({ id: a.id, reason: "action (not dispatchable)" });
    }
  } else {
    targets = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const normalized = normalizeId(id);
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      const rec = recommendations.find((r) => r.id.toUpperCase() === normalized.toUpperCase());
      if (rec) {
        if (!isDispatchableKind(rec.kind)) {
          skipped.push({ id: normalized, reason: "action (not dispatchable)" });
        } else {
          targets.push({
            id: rec.id,
            displayId: rec.displayId,
            kind: rec.kind,
            title: rec.title,
            reason: rec.reason,
          });
        }
      } else if (/^(T-\d+[a-z]?|ISS-\d+)$/i.test(id)) {
        targets.push({
          id: normalized,
          kind: normalized.startsWith("ISS-") ? "issue" : "ticket",
          title: lookupTitle?.(normalized) ?? "",
          reason: "explicitly requested",
        });
      } else {
        skipped.push({ id, reason: "invalid ID format" });
      }
    }
    if (targets.length > maxAgents) {
      for (const t of targets.slice(maxAgents)) {
        skipped.push({ id: t.id, reason: `exceeds maxParallelAgents (${maxAgents})` });
      }
      targets = targets.slice(0, maxAgents);
    }
  }

  const entries: DispatchPlanEntry[] = targets.map((target) => ({
    target,
    cwd: root,
    prompt: target.id,
  }));

  const claudeVersionOk = claudeVersion !== null && supportsAgentView(claudeVersion);

  return {
    mode: "parallel",
    entries,
    skipped,
    claudeVersion,
    claudeVersionOk,
  };
}

// ---------------------------------------------------------------------------
// Federation plan builder
// ---------------------------------------------------------------------------

export function buildFederationDispatchPlan(
  nodeRecommendations: Map<string, { root: string; recommendations: readonly Recommendation[] }>,
  claudeVersion: string | null,
  maxAgents: number,
): DispatchPlan {
  const skipped: { id: string; reason: string }[] = [];

  const candidates: Array<{ target: DispatchTarget; cwd: string; score: number; node: string }> = [];
  const seen = new Set<string>();

  for (const [nodeName, { root, recommendations }] of nodeRecommendations) {
    for (const rec of recommendations) {
      if (!isDispatchableKind(rec.kind)) {
        skipped.push({ id: rec.id, reason: `action (not dispatchable) [${nodeName}]` });
        continue;
      }
      const globalKey = `${nodeName}:${rec.id}`;
      if (seen.has(globalKey)) {
        skipped.push({ id: rec.id, reason: `duplicate across nodes [${nodeName}]` });
        continue;
      }
      seen.add(globalKey);
      candidates.push({
        target: {
          id: rec.id,
          displayId: rec.displayId,
          kind: rec.kind,
          title: rec.title,
          reason: `${nodeName}: ${rec.reason}`,
        },
        cwd: root,
        score: rec.score,
        node: nodeName,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  for (const c of candidates.slice(maxAgents)) {
    skipped.push({ id: c.target.id, reason: `exceeds maxParallelAgents (${maxAgents}) [${c.node}]` });
  }

  const entries: DispatchPlanEntry[] = candidates
    .slice(0, maxAgents)
    .map((c) => ({
      target: c.target,
      cwd: c.cwd,
      prompt: c.target.id,
    }));

  const claudeVersionOk = claudeVersion !== null && supportsAgentView(claudeVersion);

  return {
    mode: "parallel",
    entries,
    skipped,
    claudeVersion,
    claudeVersionOk,
  };
}
