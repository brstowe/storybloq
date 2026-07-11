import { posix } from "node:path";
import { BusError } from "./errors.js";
import { canonicalHash, sha256 } from "./canonical.js";
import type { BusMessageKind, BusMessageRefs, BusRole } from "./schemas.js";

const HIGH_CONFIDENCE_SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{40,255})\b/ },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "OpenAI API key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: "credential-bearing URL", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
];

export function assertNoHighConfidenceSecret(value: string, label = "Message"): void {
  for (const detector of HIGH_CONFIDENCE_SECRET_PATTERNS) {
    if (detector.pattern.test(value)) {
      throw new BusError("secret_detected", `${label} rejected: detected ${detector.name}`);
    }
  }
}

export function normalizeBusText(value: string, label: string, maxBytes: number): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) {
    throw new BusError("invalid_input", `${label} cannot be empty`);
  }
  if (Buffer.byteLength(normalized, "utf-8") > maxBytes) {
    throw new BusError("invalid_input", `${label} exceeds ${maxBytes} bytes`);
  }
  if (/[\u0000\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(normalized)) {
    throw new BusError("invalid_input", `${label} contains unsupported control characters`);
  }
  assertNoHighConfidenceSecret(normalized, label);
  return normalized;
}

export function normalizeMessageBody(body: string, maxBytes: number): string {
  return normalizeBusText(body, "Message body", maxBytes);
}

export function normalizeFileRef(file: string): string {
  if (file.includes("\\") || /[\u0000-\u001f\u007f-\u009f]/.test(file) ||
      file.startsWith("/") || /^[A-Za-z]:/.test(file)) {
    throw new BusError("invalid_input", `Unsafe file reference: ${file}`);
  }
  const normalized = posix.normalize(file);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new BusError("invalid_input", `Unsafe file reference: ${file}`);
  }
  return normalized;
}

export function normalizeMessageRefs(refs: BusMessageRefs): BusMessageRefs {
  const normalized: BusMessageRefs = {
    ...(refs.issue ? { issue: refs.issue.trim() } : {}),
    ...(refs.ticket ? { ticket: refs.ticket.trim() } : {}),
    ...(refs.commit ? { commit: refs.commit.toLowerCase() } : {}),
    ...(refs.ciRun ? { ciRun: refs.ciRun.trim() } : {}),
    ...(refs.files ? { files: [...new Set(refs.files.map(normalizeFileRef))].sort() } : {}),
  };
  for (const value of [normalized.issue, normalized.ticket, normalized.ciRun, ...(normalized.files ?? [])]) {
    if (value) assertNoHighConfidenceSecret(value, "Message reference");
  }
  return normalized;
}

export function idempotencyKeyHash(endpointId: string, key: string): string {
  const normalized = key.trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(normalized)) {
    throw new BusError("invalid_input", "Idempotency key must be 1-128 printable characters");
  }
  return sha256(`${endpointId}\0${normalized}`);
}

export function actionableFingerprint(input: {
  fromRole: BusRole;
  toRole: BusRole;
  kind: BusMessageKind;
  body: string;
  refs: BusMessageRefs;
}): string {
  return canonicalHash({
    direction: `${input.fromRole}->${input.toRole}`,
    kind: input.kind,
    body: input.body,
    refs: input.refs,
  });
}

export function evidenceKeys(evidence: { commit?: string; ciRun?: string }): string[] {
  return [
    ...(evidence.commit ? [`commit:${evidence.commit.toLowerCase()}`] : []),
    ...(evidence.ciRun ? [`ci:${evidence.ciRun}`] : []),
  ];
}
