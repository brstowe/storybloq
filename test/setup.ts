import { afterEach, beforeEach } from "vitest";

const CLIENT_IDENTITY_ENV = [
  "STORYBLOQ_CLIENT",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
] as const;

function clearAmbientClientIdentity(): void {
  for (const key of CLIENT_IDENTITY_ENV) delete process.env[key];
}

// Test behavior must not depend on whether Vitest was launched by Claude Code,
// Codex, or a plain shell. Individual tests opt into client identity explicitly.
clearAmbientClientIdentity();
beforeEach(clearAmbientClientIdentity);
afterEach(clearAmbientClientIdentity);
