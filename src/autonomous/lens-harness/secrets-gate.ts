/**
 * Data classification gate -- scans for secrets before fan-out (ISS-823
 * carry-over from the retired review-lenses fork, meta-finding adapted to
 * the package finding schema).
 *
 * Uses detect-secrets (Yelp, MIT) on working tree files.
 * Graceful degradation: if not installed, logs warning and proceeds.
 */

import { execFileSync, execSync } from "node:child_process";
import type { LensFinding } from "@storybloq/lenses";
import { resolveAndValidate } from "./path-safety.js";

/**
 * Stable id of the orchestrator secrets meta-finding. Injected into the
 * `security` lens output at synthesize time; consumers filter on it so it is
 * never written to the per-lens cache or double-injected on a later round.
 */
export const SECRETS_GATE_FINDING_ID = "orchestrator-secrets-gate";

export interface SecretsGateResult {
  readonly active: boolean;
  readonly secretsFound: boolean;
  readonly redactedLines: ReadonlyMap<string, readonly number[]>;
  readonly metaFinding: LensFinding | null;
}

export function runSecretsGate(
  changedFiles: readonly string[],
  projectRoot: string,
  requireGate: boolean,
): SecretsGateResult {
  // Check if detect-secrets is installed and get its path
  const binaryPath = findDetectSecrets();
  const installed = binaryPath !== null;

  if (!installed) {
    if (requireGate) {
      throw new Error(
        "detect-secrets is required (requireSecretsGate: true) but not installed. " +
          "Install with: pip install detect-secrets",
      );
    }
    return { active: false, secretsFound: false, redactedLines: new Map(), metaFinding: null };
  }

  // Run detect-secrets on changed files
  const redactedLines = new Map<string, number[]>();
  let secretsFound = false;

  for (const file of changedFiles) {
    // Path traversal + symlink protection
    if (!resolveAndValidate(projectRoot, file)) continue;

    try {
      const output = execFileSync(
        binaryPath!,
        ["scan", "--", file],
        { cwd: projectRoot, encoding: "utf-8", timeout: 10_000 },
      );
      const parsed = JSON.parse(output);
      const results = parsed?.results ?? {};
      for (const [filePath, secrets] of Object.entries(results)) {
        if (Array.isArray(secrets) && secrets.length > 0) {
          secretsFound = true;
          const lines = secrets
            .map((s: { line_number?: number }) => s.line_number)
            .filter((n: unknown): n is number => typeof n === "number");
          redactedLines.set(filePath, lines);
        }
      }
    } catch {
      // detect-secrets failed on this file -- continue
    }
  }

  // Package-shaped meta-finding (pen ruling R1). It is deliberately
  // NON-LOCALIZED (file/line null, no snippet): the T-026 anchor pass lets
  // non-localized findings through untouched, and the redacted placeholder
  // could never verify against the artifact anyway. Severity "blocking" +
  // the alwaysBlock category force the pipeline verdict to reject.
  const metaFinding: LensFinding | null = secretsFound
    ? {
        id: SECRETS_GATE_FINDING_ID,
        severity: "blocking",
        category: "hardcoded-secrets",
        file: null,
        line: null,
        description:
          "Detected potential secrets in the diff (files: " +
          [...redactedLines.keys()].join(", ") +
          "). Lines were redacted before the content reached any review lens.",
        suggestion:
          "Remove secrets from source code. Use environment variables or a secrets manager.",
        confidence: 0.9,
      }
    : null;

  return { active: true, secretsFound, redactedLines, metaFinding };
}

function findDetectSecrets(): string | null {
  try {
    // Capture absolute path for reliable invocation regardless of PATH changes
    const cmd = process.platform === "win32" ? "where detect-secrets" : "command -v detect-secrets";
    const path = execSync(cmd, {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    return path || null;
  } catch {
    return null;
  }
}

export function redactContent(
  content: string,
  linesToRedact: readonly number[],
): string {
  if (linesToRedact.length === 0) return content;
  const lines = content.split("\n");
  const redactSet = new Set(linesToRedact);
  return lines
    .map((line, i) =>
      redactSet.has(i + 1) ? "[REDACTED -- potential secret]" : line,
    )
    .join("\n");
}

/**
 * Redact secret lines directly in a unified diff artifact. Scans for file
 * path headers and redacts matching new-side line numbers. (Moved from the
 * fork orchestrator; behavior unchanged.)
 */
export function redactArtifactSecrets(
  artifact: string,
  redactedLines: ReadonlyMap<string, readonly number[]>,
): string {
  if (redactedLines.size === 0) return artifact;
  const lines = artifact.split("\n");
  let currentFile: string | null = null;
  let currentLineNum = 0;
  const linesToRedact = new Set<number>(); // indices into the lines array

  // Pre-build Sets for O(1) lookup per line
  const redactSets = new Map<string, Set<number>>();
  for (const [file, lineNums] of redactedLines) {
    redactSets.set(file, new Set(lineNums));
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Detect file header in unified diff: +++ b/path/to/file
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      currentLineNum = 0;
      continue;
    }
    // Detect hunk header: @@ -a,b +c,d @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      currentLineNum = parseInt(hunkMatch[1]!, 10) - 1;
      continue;
    }
    // Track line numbers for added/context lines
    if (!line.startsWith("-")) {
      currentLineNum++;
      if (currentFile && redactSets.get(currentFile)?.has(currentLineNum)) {
        linesToRedact.add(i);
      }
    }
  }

  return lines
    .map((line, i) => {
      if (!linesToRedact.has(i)) return line;
      // Preserve the one-char unified-diff marker (+ added, space context) so
      // the redacted artifact stays a structurally valid diff -- the package's
      // T-026 anchoring (buildNewSideIndex) and origin classification depend on
      // the new-side prefix. Redacted lines are only ever added/context lines
      // (deletions are never scanned), so the marker is + or space.
      const marker = line.startsWith("+") || line.startsWith(" ") ? line[0] : "";
      return `${marker}[REDACTED -- potential secret]`;
    })
    .join("\n");
}
