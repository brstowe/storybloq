import { execFileSync } from "node:child_process";

export type StorybloqClient = "claude" | "codex";

export interface ReviewBackendConfig {
  readonly reviewBackends: readonly string[];
  readonly codexReviewBackends?: readonly string[];
}

export function currentStorybloqClient(): StorybloqClient {
  return process.env.STORYBLOQ_CLIENT === "codex" ? "codex" : "claude";
}

export function reviewBackendsForClient(config: ReviewBackendConfig): readonly string[] {
  if (currentStorybloqClient() === "codex") {
    return config.codexReviewBackends ?? ["lenses"];
  }
  return config.reviewBackends;
}

export function hasNativeCodexCli(): boolean {
  try {
    execFileSync("codex", ["--version"], { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function nativeCodexReviewCommand(kind: "plan" | "code", sessionId: string): string {
  return `storybloq codex-review ${kind} --session ${sessionId} --format guide-report`;
}

export function shouldUseNativeCodexReview(reviewer: string, config: ReviewBackendConfig): boolean {
  return currentStorybloqClient() === "codex"
    && config.codexReviewBackends?.includes("codex") === true
    && reviewer === "codex"
    && hasNativeCodexCli();
}

export function nativeCodexReportInstruction(sessionId: string): string {
  return [
    "The command prints a JSON report. Pass that report to `storybloq_autonomous_guide`:",
    "```json",
    `{ "sessionId": "${sessionId}", "action": "report", "report": <paste codex-review JSON> }`,
    "```",
  ].join("\n");
}
