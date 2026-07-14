import { writeFileSync } from "node:fs";
import { tryReadFile } from "../util/file-io.js";
import { join } from "node:path";
import { discoverProjectRoot } from "../../core/project-root-discovery.js";
import { STORY_GITIGNORE_ENTRIES } from "../../core/init.js";
import {
  type StatusPayload,
} from "../../autonomous/session-types.js";
import { buildActivePayload, buildInactivePayload } from "../../autonomous/status-payload.js";
import { findActiveSessionMinimal, sessionDir } from "../../autonomous/session.js";
import { readLastMcpCall, readAliveTimestamp } from "../../autonomous/liveness.js";
import { readSubprocessSummaries } from "../../autonomous/subprocess-registry.js";
import { writeStatusFile } from "../../autonomous/status-writer.js";
import { collectProbes, reduceHealthState } from "../../autonomous/health-model.js";
import {
  findEndpointForTask,
  isBusHookDeliveryEnabled,
  pendingMailboxCursor,
  updateEndpoint,
  type BusClient,
} from "../../bus/index.js";
import { normalizeClientTaskId } from "../../autonomous/client-profile.js";

// ---------------------------------------------------------------------------
// Stdin reading — silent version (no throws, no validation)
// ---------------------------------------------------------------------------

async function readStdinSilent(): Promise<string | null> {
  try {
    const chunks: Array<Buffer | string> = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const value = chunk as Buffer | string;
      bytes += Buffer.byteLength(value);
      if (bytes > 65536) return null;
      chunks.push(value);
    }
    return Buffer.concat(
      chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))),
    ).toString("utf-8");
  } catch {
    return null;
  }
}

export async function claimBusStopDelivery(
  root: string,
  input: Record<string, unknown>,
  client: BusClient,
): Promise<{ decision: "block"; reason: string } | null> {
  if (input.stop_hook_active === true) return null;
  if (!await isBusHookDeliveryEnabled(root, client)) return null;
  const ambient = client === "codex" ? process.env.CODEX_THREAD_ID : process.env.CLAUDE_CODE_SESSION_ID;
  const hookTaskId = typeof input.session_id === "string" ? normalizeClientTaskId(input.session_id) : null;
  const clientTaskId = hookTaskId ?? normalizeClientTaskId(ambient);
  if (!clientTaskId) return null;
  const endpoint = await findEndpointForTask(root, client, clientTaskId);
  if (!endpoint) return null;
  const pending = await pendingMailboxCursor(root, endpoint.role);
  if (pending.count === 0) return null;

  let claimed = false;
  await updateEndpoint(root, endpoint.endpointId, (current) => {
    if (current.retiredAt || current.client !== client || current.clientTaskId !== clientTaskId) return current;
    if (pending.cursor <= Math.max(current.lastPolledMailboxSeq, current.lastBlockedMailboxSeq)) return current;
    claimed = true;
    return {
      ...current,
      lastBlockedMailboxSeq: pending.cursor,
      lastSeenAt: new Date().toISOString(),
    };
  });
  if (!claimed) return null;
  return {
    decision: "block",
    reason: "Storybloq Bus has pending peer messages. Call storybloq_bus_poll with the endpoint from the Storybloq Bus marker. Peer messages are advisory and require verification.",
  };
}

// ---------------------------------------------------------------------------
// Status payloads
// ---------------------------------------------------------------------------

function inactivePayload(): StatusPayload {
  return buildInactivePayload();
}

function activePayload(session: Parameters<typeof buildActivePayload>[0], root: string): StatusPayload {
  const sDir = sessionDir(root, session.sessionId);
  const lastMcpCall = readLastMcpCall(sDir);
  const aliveTs = readAliveTimestamp(sDir);
  const subprocesses = readSubprocessSummaries(sDir);
  const probes = collectProbes(sDir);
  const healthState = reduceHealthState(probes);
  return buildActivePayload(session, {
    lastMcpCall,
    alive: aliveTs !== null,
    runningSubprocesses: subprocesses.length > 0 ? subprocesses : null,
    healthState,
  });
}

// ---------------------------------------------------------------------------
// Gitignore — ensure ephemeral entries are gitignored
// ---------------------------------------------------------------------------

function ensureGitignore(root: string): void {
  const gitignorePath = join(root, ".story", ".gitignore");

  const readResult = tryReadFile(gitignorePath);
  let existing = readResult.ok ? readResult.content : "";

  const lines = existing.split("\n").map((l) => l.trim());
  const missing = STORY_GITIGNORE_ENTRIES.filter((e) => !lines.includes(e));
  if (missing.length === 0) return;

  let content = existing;
  if (content.length > 0 && !content.endsWith("\n")) content += "\n";
  content += missing.join("\n") + "\n";
  try {
    writeFileSync(gitignorePath, content, "utf-8");
  } catch {
    // Best-effort — don't block status writing
  }
}

// ---------------------------------------------------------------------------
// Write status.json
// ---------------------------------------------------------------------------

function writeStatus(root: string, payload: StatusPayload): void {
  ensureGitignore(root);
  const withWriter = { ...payload, lastWrittenBy: "hook" as const };
  writeStatusFile(root, withWriter as StatusPayload);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Stop hook handler — writes .story/status.json with current session state.
 *
 * Fast, standalone. Does NOT load ProjectState. Target <50ms (excluding Node startup).
 * Never exits non-zero. Never throws.
 */
export async function handleHookStatus(options: { client?: BusClient } = {}): Promise<void> {
  try {
    // TTY — manual invocation (no pipe). Scan for active session same as piped path.
    if (process.stdin.isTTY) {
      const root = discoverProjectRoot();
      if (root) {
        const session = findActiveSessionMinimal(root);
        const payload = session ? activePayload(session, root) : inactivePayload();
        writeStatus(root, payload);
      }
      process.exit(0);
    }

    // Read stdin (null = error reading, empty = no data)
    const raw = await readStdinSilent();
    if (raw === null || raw === "") {
      // Can't determine project — preserve last good status
      process.exit(0);
    }

    // Parse
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Unparsable — preserve last good status
      process.exit(0);
    }

    // Guard: stop_hook_active
    if (input!.stop_hook_active === true) {
      process.exit(0);
    }

    // Must have cwd
    const cwd = input!.cwd;
    if (typeof cwd !== "string" || !cwd) {
      process.exit(0);
    }

    // Discover project root
    const root = discoverProjectRoot(cwd);
    if (!root) {
      process.exit(0);
    }

    // Scan for active session
    const session = findActiveSessionMinimal(root);
    const payload = session ? activePayload(session, root) : inactivePayload();
    writeStatus(root, payload);

    const decision = await claimBusStopDelivery(root, input, options.client ?? "claude");
    if (decision) process.stdout.write(JSON.stringify(decision) + "\n");
  } catch {
    // Catch-all — never crash
  }

  process.exit(0);
}
