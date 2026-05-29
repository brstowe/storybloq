import { displayIdOf } from "../core/resolver.js";
import {
  deriveClaudeStatus,
  CURRENT_STATUS_SCHEMA_VERSION,
  type SessionState,
  type StatusPayloadActive,
  type StatusPayloadInactive,
} from "./session-types.js";

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}

export function buildActivePayload(
  session: SessionState,
  telemetry?: {
    lastMcpCall?: string | null;
    alive?: boolean | null;
    runningSubprocesses?: ReadonlyArray<{ pid: number; category: string; startedAt: string; stage: string }> | null;
    healthState?: string | null;
  },
): StatusPayloadActive {
  const issueDisplayIds = isStringRecord(session.resolvedIssueDisplayIds) ? session.resolvedIssueDisplayIds : {};
  const targetDisplayIds = isStringRecord(session.targetWorkDisplayIds) ? session.targetWorkDisplayIds : {};

  return {
    schemaVersion: CURRENT_STATUS_SCHEMA_VERSION,
    sessionActive: true,
    sessionId: session.sessionId,
    state: session.state,
    ticket: session.ticket?.displayId ?? session.ticket?.id ?? null,
    ticketTitle: session.ticket?.title ?? null,
    risk: session.ticket?.risk ?? null,
    claudeStatus: deriveClaudeStatus(session.state, session.waitingForRetry),
    observedAt: new Date().toISOString(),
    startedAt: session.startedAt ?? null,
    lastGuideCall: session.lastGuideCall ?? null,
    completedThisSession: [
      ...(session.completedTickets?.map((t) => displayIdOf(t)) ?? []),
      ...(session.resolvedIssues?.map((id) => issueDisplayIds[id] ?? id) ?? []),
    ],
    contextPressure: session.contextPressure?.level ?? "unknown",
    branch: session.git?.branch ?? null,
    source: "hook",
    substage: session.substage ?? null,
    substageStartedAt: session.substageStartedAt ?? null,
    pendingInstruction: session.pendingInstruction ?? null,
    pendingInstructionSetAt: session.pendingInstructionSetAt ?? null,
    claudeCodeSessionId: session.claudeCodeSessionId ?? null,
    binaryFingerprint: session.binaryFingerprint ?? null,
    runningSubprocesses: telemetry?.runningSubprocesses ?? session.runningSubprocesses ?? null,
    lastReviewVerdict: session.lastReviewVerdict ?? null,
    recentDeferrals: session.recentDeferrals ?? null,
    alive: telemetry?.alive ?? session.alive ?? null,
    lastMcpCall: telemetry?.lastMcpCall ?? session.lastMcpCall ?? null,
    healthState: telemetry?.healthState ?? session.healthState ?? null,
    // T-271: Queue progress
    // ISS-490: Use optional chaining instead of non-null assertion.
    targetWork: session.targetWork?.length ? session.targetWork.map((id) => targetDisplayIds[id] ?? id) : null,
    currentIssue: session.currentIssue
      ? {
        id: session.currentIssue.id,
        ...(session.currentIssue.displayId ? { displayId: session.currentIssue.displayId } : {}),
        title: session.currentIssue.title,
        severity: session.currentIssue.severity,
      }
      : null,
  };
}

export function buildInactivePayload(): StatusPayloadInactive {
  return {
    schemaVersion: CURRENT_STATUS_SCHEMA_VERSION,
    sessionActive: false,
    source: "hook",
  };
}
