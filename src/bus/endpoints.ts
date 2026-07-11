import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { normalizeClientTaskId, type StorybloqClient } from "../autonomous/client-profile.js";
import { loadProject } from "../core/project-loader.js";
import { resolveInitializedBusPaths } from "./admin.js";
import { canonicalHash, sha256 } from "./canonical.js";
import { assertBusEnabled } from "./config.js";
import { BusError } from "./errors.js";
import { durableCreate, durableUnlink, durableWrite, listRegularJsonFiles, readJsonNoFollow } from "./io.js";
import { captureProcessSignature, inspectProcessIdentity, withHardenedLock } from "./lock.js";
import { resolveBusPaths } from "./paths.js";
import { normalizeBusText } from "./security.js";
import {
  BusEndpointSchema,
  BusSuccessionSchema,
  type BusClient,
  type BusEndpoint,
  type BusProcessRef,
  type BusRole,
  type BusSuccession,
  type BusSurface,
} from "./schemas.js";

const execFileAsync = promisify(execFile);
const SUCCESSION_TTL_MS = 15 * 60 * 1000;
const ENDPOINT_LOCK_TIMEOUT_MS = 15_000;
const EndpointIdSchema = z.string().uuid();

interface ProcessCandidate {
  readonly pid: number;
  readonly command: string;
}

async function processCandidate(pid: number): Promise<ProcessCandidate | null> {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "command="], { timeout: 500 });
      const command = stdout.trim();
      return command ? { pid, command } : null;
    }
    if (process.platform === "linux") {
      const handle = await import("node:fs/promises").then((fs) => fs.open(`/proc/${pid}/cmdline`, "r"));
      let command: string;
      try { command = (await handle.readFile("utf-8")).replace(/\0/g, " ").trim(); } finally { await handle.close(); }
      return command ? { pid, command } : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function parentPid(pid: number): Promise<number | null> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "ppid="], { timeout: 500 });
      const parsed = Number(stdout.trim());
      return Number.isInteger(parsed) && parsed > 1 ? parsed : null;
    }
    if (process.platform === "linux") {
      const raw = await import("node:fs/promises").then((fs) => fs.readFile(`/proc/${pid}/stat`, "utf-8"));
      const rightParen = raw.lastIndexOf(")");
      const fields = rightParen >= 0 ? raw.slice(rightParen + 1).trim().split(/\s+/) : [];
      const parsed = Number(fields[1]);
      return Number.isInteger(parsed) && parsed > 1 ? parsed : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function findClientProcess(client: BusClient): Promise<{ surface: BusSurface | null; process: ProcessCandidate | null }> {
  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const candidate = await processCandidate(pid);
    const command = candidate?.command ?? "";
    if (client === "codex" && /(?:^|[/ ])codex(?: |$)/i.test(command)) {
      return {
        surface: /\bapp-server\b/.test(command) ? "codex_desktop" : "codex_cli",
        process: candidate,
      };
    }
    if (client === "claude" && /(?:^|[/ ])claude(?: |$)/i.test(command)) {
      return { surface: "claude_cli", process: candidate };
    }
    const next = await parentPid(pid);
    if (!next || next === pid) break;
    pid = next;
  }
  return { surface: client === "claude" ? "claude_cli" : null, process: null };
}

async function gitOutput(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, timeout: 3000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function gitBinding(root: string): Promise<{ branch: string | null; worktreeId: string }> {
  const commonDir = await gitOutput(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitDir = await gitOutput(root, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const branch = await gitOutput(root, ["symbolic-ref", "--short", "HEAD"]);
  return {
    branch,
    worktreeId: canonicalHash({ root, commonDir: commonDir ?? root, gitDir: gitDir ?? root }),
  };
}

async function processRefFor(surface: BusSurface, candidate: ProcessCandidate | null): Promise<BusProcessRef | null> {
  if (surface === "codex_desktop" || !candidate) return null;
  const signature = await captureProcessSignature(candidate.pid);
  return signature
    ? { pid: candidate.pid, signature, capturedAt: new Date().toISOString() }
    : null;
}

export async function listEndpoints(root: string): Promise<{ endpoints: BusEndpoint[]; findings: string[] }> {
  const paths = await resolveBusPaths(root, false);
  const endpoints: BusEndpoint[] = [];
  const findings: string[] = [];
  for (const filename of await listRegularJsonFiles(paths.endpoints)) {
    try {
      const endpoint = await readJsonNoFollow(join(paths.endpoints, filename), BusEndpointSchema);
      if (filename !== `${endpoint.endpointId}.json`) {
        findings.push(`${filename}: endpoint id does not match filename`);
        continue;
      }
      endpoints.push(endpoint);
    } catch (err) {
      findings.push(`${filename}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { endpoints, findings };
}

export async function findEndpointForTask(
  root: string,
  client: BusClient,
  clientTaskId: string,
): Promise<BusEndpoint | null> {
  const normalized = normalizeClientTaskId(clientTaskId);
  if (!normalized) return null;
  const { endpoints } = await listEndpoints(root);
  return endpoints.find((endpoint) =>
    !endpoint.retiredAt && endpoint.client === client && endpoint.clientTaskId === normalized,
  ) ?? null;
}

export async function endpointLiveness(endpoint: BusEndpoint): Promise<"attached" | "offline" | "unknown"> {
  if (endpoint.surface === "codex_desktop" || !endpoint.processRef) return "unknown";
  const state = await inspectProcessIdentity(endpoint.processRef.pid, endpoint.processRef.signature);
  return state === "alive" ? "attached" : state === "dead" ? "offline" : "unknown";
}

export async function refreshEndpointForSessionStart(
  root: string,
  endpointId: string,
  clientTaskId: string,
): Promise<BusEndpoint> {
  const endpoint = await assertEndpointCaller(root, endpointId, clientTaskId);
  const detected = await findClientProcess(endpoint.client);
  if (detected.process && detected.surface && detected.surface !== endpoint.surface) {
    throw new BusError("conflict", `Endpoint surface changed from ${endpoint.surface} to ${detected.surface}`);
  }
  const processRef = await processRefFor(
    endpoint.surface,
    detected.surface === endpoint.surface ? detected.process : null,
  );
  return withEndpointCaller(root, endpoint.endpointId, clientTaskId, async (_current, persist) =>
    persist((current) => ({
      ...current,
      processRef,
      state: processRef ? "attached" : "unknown",
      lastSeenAt: new Date().toISOString(),
    })),
  );
}

export interface JoinEndpointInput {
  readonly role: BusRole;
  readonly client: StorybloqClient;
  readonly clientTaskId: string;
  readonly surface?: BusSurface;
  readonly replace?: boolean;
}

export async function joinEndpoint(root: string, input: JoinEndpointInput): Promise<{ endpoint: BusEndpoint; existing: boolean }> {
  const taskId = normalizeClientTaskId(input.clientTaskId);
  if (!taskId) throw new BusError("invalid_input", "A valid client task id is required to join the Bus");
  assertBusEnabled((await loadProject(root)).state.config);
  const paths = await resolveInitializedBusPaths(root);
  return withHardenedLock(join(paths.locks, "endpoints.lock"), async () => {
    const listed = await listEndpoints(paths.projectRoot);
    if (listed.findings.length > 0) {
      throw new BusError("corrupt", `Endpoint registry is corrupt: ${listed.findings[0]}`);
    }
    const sameTask = listed.endpoints.find((endpoint) =>
      !endpoint.retiredAt && endpoint.client === input.client && endpoint.clientTaskId === taskId,
    );
    if (sameTask) {
      if (sameTask.role !== input.role) {
        throw new BusError("conflict", `This task already owns the ${sameTask.role} endpoint`);
      }
      return { endpoint: sameTask, existing: true };
    }

    const incumbent = listed.endpoints.find((endpoint) => !endpoint.retiredAt && endpoint.role === input.role);
    if (incumbent) {
      const liveness = await endpointLiveness(incumbent);
      if (liveness !== "offline" || input.replace !== true) {
        throw new BusError(
          "conflict",
          `${input.role} is owned by an ${liveness} endpoint. Replacement requires positive offline proof and --replace.`,
        );
      }
      const retiredAt = new Date().toISOString();
      await durableWrite(join(paths.endpoints, `${incumbent.endpointId}.json`), JSON.stringify({
        ...incumbent,
        state: "offline",
        retiredAt,
        retiredReason: "replaced",
        lastSeenAt: retiredAt,
      }, null, 2) + "\n");
    }

    const detected = await findClientProcess(input.client);
    if (input.surface && detected.process && detected.surface && input.surface !== detected.surface) {
      throw new BusError(
        "conflict",
        `Requested ${input.surface} does not match the detected ${detected.surface} client process`,
      );
    }
    const surface = input.surface ?? detected.surface;
    if (!surface || (input.client === "claude" && surface !== "claude_cli") ||
        (input.client === "codex" && surface === "claude_cli")) {
      throw new BusError("invalid_input", "Cannot determine the client surface safely; pass --surface explicitly");
    }
    const binding = await gitBinding(paths.projectRoot);
    const processRef = await processRefFor(
      surface,
      detected.surface === surface ? detected.process : null,
    );
    const now = new Date().toISOString();
    const endpoint: BusEndpoint = BusEndpointSchema.parse({
      schema: "storybloq-bus-endpoint/v1",
      endpointId: randomUUID(),
      role: input.role,
      client: input.client,
      surface,
      clientTaskId: taskId,
      resumeHandle: taskId,
      projectRoot: paths.projectRoot,
      gitBranch: binding.branch,
      worktreeId: binding.worktreeId,
      processRef,
      state: processRef ? "attached" : "unknown",
      joinedAt: now,
      lastSeenAt: now,
      wakePolicy: "never",
      lastPolledMailboxSeq: 0,
      lastBlockedMailboxSeq: 0,
      retiredAt: null,
      retiredReason: null,
    });
    await durableCreate(join(paths.endpoints, `${endpoint.endpointId}.json`), JSON.stringify(endpoint, null, 2) + "\n");
    return { endpoint, existing: false };
  });
}

export async function assertEndpointCaller(
  root: string,
  endpointId: string,
  clientTaskId: string,
): Promise<BusEndpoint> {
  if (!EndpointIdSchema.safeParse(endpointId).success) {
    throw new BusError("invalid_input", "Invalid endpoint id");
  }
  const taskId = normalizeClientTaskId(clientTaskId);
  if (!taskId) throw new BusError("unauthorized", "A valid client task id is required");
  const paths = await resolveInitializedBusPaths(root);
  const endpoint = await readJsonNoFollow(join(paths.endpoints, `${endpointId}.json`), BusEndpointSchema);
  if (endpoint.retiredAt || endpoint.clientTaskId !== taskId) {
    throw new BusError("unauthorized", "Endpoint ownership does not match this task");
  }
  return endpoint;
}

export async function updateEndpoint(
  root: string,
  endpointId: string,
  update: (endpoint: BusEndpoint) => BusEndpoint,
): Promise<BusEndpoint> {
  return withEndpointLock(root, endpointId, async (_endpoint, persist) => persist(update));
}

type EndpointPersist = (update: (endpoint: BusEndpoint) => BusEndpoint) => Promise<BusEndpoint>;

async function withEndpointLock<T>(
  root: string,
  endpointId: string,
  handler: (endpoint: BusEndpoint, persist: EndpointPersist) => Promise<T>,
): Promise<T> {
  if (!EndpointIdSchema.safeParse(endpointId).success) {
    throw new BusError("invalid_input", "Invalid endpoint id");
  }
  const paths = await resolveInitializedBusPaths(root);
  // Endpoint ownership spans nested thread and mailbox operations whose lock
  // waits can each reach five seconds. The outer acquisition must not expire first.
  return withHardenedLock(join(paths.locks, `endpoint-${endpointId}.lock`), async () => {
    const path = join(paths.endpoints, `${endpointId}.json`);
    let current = await readJsonNoFollow(path, BusEndpointSchema);
    const persist: EndpointPersist = async (update) => {
      const next = BusEndpointSchema.parse(update(current));
      await durableWrite(path, JSON.stringify(next, null, 2) + "\n");
      current = next;
      return next;
    };
    return handler(current, persist);
  }, { timeoutMs: ENDPOINT_LOCK_TIMEOUT_MS });
}

export async function withEndpointCaller<T>(
  root: string,
  endpointId: string,
  clientTaskId: string,
  handler: (endpoint: BusEndpoint, persist: EndpointPersist) => Promise<T>,
): Promise<T> {
  const taskId = normalizeClientTaskId(clientTaskId);
  if (!taskId) throw new BusError("unauthorized", "A valid client task id is required");
  return withEndpointLock(root, endpointId, async (endpoint, persist) => {
    if (endpoint.retiredAt || endpoint.clientTaskId !== taskId) {
      throw new BusError("unauthorized", "Endpoint ownership does not match this task");
    }
    return handler(endpoint, persist);
  });
}

export async function leaveEndpoint(root: string, endpointId: string, clientTaskId: string): Promise<BusEndpoint> {
  return withEndpointCaller(root, endpointId, clientTaskId, async (_endpoint, persist) =>
    persist((current) => {
      const now = new Date().toISOString();
      return { ...current, state: "offline", retiredAt: now, retiredReason: "left", lastSeenAt: now };
    }),
  );
}

export async function retireEndpoint(root: string, endpointId: string, reason: string): Promise<BusEndpoint> {
  if (!EndpointIdSchema.safeParse(endpointId).success) {
    throw new BusError("invalid_input", "Invalid endpoint id");
  }
  const normalizedReason = normalizeBusText(reason, "Retirement reason", 1024);
  return withEndpointLock(root, endpointId, async (endpoint, persist) => {
    if (await endpointLiveness(endpoint) !== "unknown") {
      throw new BusError("conflict", "Forced retirement is limited to endpoints with unknown liveness");
    }
    return persist((current) => {
      const now = new Date().toISOString();
      return { ...current, state: "offline", retiredAt: now, retiredReason: normalizedReason, lastSeenAt: now };
    });
  });
}

export async function mintCompactionSuccession(input: {
  root: string;
  client: BusClient;
  clientTaskId: string;
  transcriptPath: string;
}): Promise<BusSuccession | null> {
  const taskId = normalizeClientTaskId(input.clientTaskId);
  if (!taskId) return null;
  const endpoint = await findEndpointForTask(input.root, input.client, taskId);
  if (!endpoint || !input.transcriptPath) return null;
  const paths = await resolveInitializedBusPaths(input.root);
  const transcriptHash = sha256(input.transcriptPath);
  return withHardenedLock(join(paths.locks, `endpoint-${endpoint.endpointId}.lock`), async () => {
    const now = Date.now();
    for (const { record: existing } of await liveSuccessionRecords(paths.succession, now)) {
      if (existing.endpointId === endpoint.endpointId && existing.kind === "compact" &&
          existing.transcriptHash === transcriptHash && !existing.consumedAt) return existing;
    }
    const createdAt = new Date(now).toISOString();
    const succession: BusSuccession = BusSuccessionSchema.parse({
      schema: "storybloq-bus-succession/v1",
      successionId: randomUUID(),
      endpointId: endpoint.endpointId,
      client: input.client,
      fromTaskId: taskId,
      transcriptHash,
      kind: "compact",
      createdAt,
      expiresAt: new Date(now + SUCCESSION_TTL_MS).toISOString(),
      consumedAt: null,
    });
    await durableCreate(join(paths.succession, `${succession.successionId}.json`), JSON.stringify(succession, null, 2) + "\n");
    return succession;
  });
}

async function liveSuccessionRecords(
  directory: string,
  now: number,
): Promise<Array<{ path: string; record: BusSuccession }>> {
  const records: Array<{ path: string; record: BusSuccession }> = [];
  for (const filename of await listRegularJsonFiles(directory)) {
    try {
      const path = join(directory, filename);
      const record = await readJsonNoFollow(path, BusSuccessionSchema);
      if (filename !== `${record.successionId}.json`) continue;
      if (new Date(record.expiresAt).getTime() <= now) {
        await durableUnlink(path);
        continue;
      }
      records.push({ path, record });
    } catch {
      // Doctor reports malformed records; succession remains fail-closed.
    }
  }
  return records;
}

export async function consumeCompactionSuccession(input: {
  root: string;
  client: BusClient;
  clientTaskId: string;
  transcriptPath: string;
}): Promise<BusEndpoint | null> {
  const taskId = normalizeClientTaskId(input.clientTaskId);
  if (!taskId || !input.transcriptPath) return null;
  const paths = await resolveInitializedBusPaths(input.root);
  const transcriptHash = sha256(input.transcriptPath);
  return withHardenedLock(join(paths.locks, "endpoints.lock"), async () => {
    const freshMatches: Array<{ path: string; record: BusSuccession }> = [];
    const retryMatches: Array<{ path: string; record: BusSuccession }> = [];
    const now = Date.now();
    for (const candidate of await liveSuccessionRecords(paths.succession, now)) {
      const record = candidate.record;
      if (record.client !== input.client || record.kind !== "compact" ||
          record.transcriptHash !== transcriptHash) continue;
      if (!record.consumedAt) freshMatches.push(candidate);
      else if (record.toTaskId === taskId) retryMatches.push(candidate);
    }
    if (freshMatches.length > 1) return null;
    let match = freshMatches[0];
    if (!match) {
      const endpointIds = new Set(retryMatches.map((candidate) => candidate.record.endpointId));
      if (endpointIds.size !== 1) return null;
      match = retryMatches.reduce<typeof retryMatches[number] | undefined>((latest, candidate) => {
        if (!latest) return candidate;
        const order = candidate.record.createdAt.localeCompare(latest.record.createdAt) ||
          candidate.record.successionId.localeCompare(latest.record.successionId);
        return order > 0 ? candidate : latest;
      }, undefined);
    }
    if (!match) return null;
    return withHardenedLock(join(paths.locks, `endpoint-${match.record.endpointId}.lock`), async () => {
      const endpointPath = join(paths.endpoints, `${match.record.endpointId}.json`);
      const endpoint = await readJsonNoFollow(endpointPath, BusEndpointSchema);
      const latestRecord = await readJsonNoFollow(match.path, BusSuccessionSchema);
      if (endpoint.retiredAt || endpoint.client !== input.client ||
          latestRecord.successionId !== match.record.successionId) {
        return null;
      }
      if (latestRecord.consumedAt) {
        return latestRecord.toTaskId === taskId && endpoint.clientTaskId === taskId ? endpoint : null;
      }
      if (endpoint.clientTaskId === taskId) {
        await durableWrite(match.path, JSON.stringify({
          ...latestRecord,
          toTaskId: taskId,
          consumedAt: new Date().toISOString(),
        }, null, 2) + "\n");
        return endpoint;
      }
      if (endpoint.clientTaskId !== latestRecord.fromTaskId) return null;
      const refreshed: BusEndpoint = BusEndpointSchema.parse({
        ...endpoint,
        clientTaskId: taskId,
        resumeHandle: taskId,
        lastSeenAt: new Date().toISOString(),
      });
      await durableWrite(endpointPath, JSON.stringify(refreshed, null, 2) + "\n");
      await durableWrite(match.path, JSON.stringify({
        ...latestRecord,
        toTaskId: taskId,
        consumedAt: new Date().toISOString(),
      }, null, 2) + "\n");
      return refreshed;
    });
  });
}
