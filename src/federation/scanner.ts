import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ResolvedNode } from "./resolver.js";
import { loadProject, type LoadResult } from "../core/project-loader.js";
import { findLatestHandover } from "./handover-utils.js";
import { resolveShortcode } from "../core/shortcode.js";
import { resolveAutoAgent } from "../core/auto-agent.js";

export interface NodeScanSummary {
  project: string;
  type: string;
  ticketCount: number;
  openTickets: number;
  completeTickets: number;
  issueCount: number;
  openIssues: number;
  lastHandoverDate: string | null;
  lastHandoverTitle: string | null;
  /**
   * FORK: the node's own shortcode -- its config override when it has one,
   * otherwise derived from the node directory. `null` only when the directory
   * name slugifies to nothing usable.
   */
  shortcode: string | null;
  /** FORK: the node's own autonomous-agent switch. Never inherited from the root. */
  autoAgent: boolean;
}

export type NodeScanResult =
  | { reachable: true; summary: NodeScanSummary }
  | { reachable: false; reason: string };

export interface ScanOptions {
  timeoutMs?: number;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

export async function scanNodeSummary(
  storyDir: string,
  signal?: AbortSignal,
): Promise<NodeScanSummary> {
  checkAborted(signal);

  let configRaw: string;
  try {
    configRaw = await readFile(join(storyDir, "config.json"), "utf-8");
  } catch {
    throw new Error("Cannot read node config.json");
  }
  checkAborted(signal);
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(configRaw) as Record<string, unknown>;
  } catch {
    throw new Error("Corrupt config.json: invalid JSON");
  }

  async function countDir(
    dir: string,
    statusBuckets: readonly string[],
  ): Promise<{ total: number; counts: Map<string, number> }> {
    const counts = new Map<string, number>(statusBuckets.map((s) => [s, 0]));
    let total = 0;
    try {
      const files = await readdir(dir);
      checkAborted(signal);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      const results = await Promise.all(
        jsonFiles.map(async (f): Promise<string | null> => {
          try {
            checkAborted(signal);
            const raw = await readFile(join(dir, f), "utf-8");
            checkAborted(signal);
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            return typeof parsed.status === "string" ? parsed.status : null;
          } catch (err) {
            if (signal?.aborted) throw err;
            return null;
          }
        }),
      );
      for (const status of results) {
        if (status === null) continue;
        total++;
        if (counts.has(status)) counts.set(status, (counts.get(status) ?? 0) + 1);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
    }
    return { total, counts };
  }

  const [ticketResult, issueResult, handoverInfo] = await Promise.all([
    countDir(join(storyDir, "tickets"), ["open", "complete"]),
    countDir(join(storyDir, "issues"), ["open"]),
    findLatestHandover(join(storyDir, "handovers")).catch(() => null),
  ]);

  return {
    project: typeof config.project === "string" ? config.project : "unknown",
    shortcode: resolveShortcode(dirname(storyDir), config)?.shortcode ?? null,
    autoAgent: resolveAutoAgent(config).enabled,
    type: typeof config.type === "string" ? config.type : "unknown",
    ticketCount: ticketResult.total,
    openTickets: ticketResult.counts.get("open") ?? 0,
    completeTickets: ticketResult.counts.get("complete") ?? 0,
    issueCount: issueResult.total,
    openIssues: issueResult.counts.get("open") ?? 0,
    lastHandoverDate: handoverInfo?.date ?? null,
    lastHandoverTitle: handoverInfo?.heading ?? null,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, ms);

    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export async function scanAllSummaries(
  nodes: Map<string, ResolvedNode>,
  options?: ScanOptions,
): Promise<Map<string, NodeScanResult>> {
  const timeoutMs = options?.timeoutMs ?? 2000;
  const results = new Map<string, NodeScanResult>();

  const promises: Array<{ name: string; promise: Promise<NodeScanResult> }> = [];

  for (const [name, node] of nodes) {
    if (!node.resolved) {
      results.set(name, { reachable: false, reason: node.reason });
      continue;
    }

    const controller = new AbortController();
    const scanPromise = withTimeout(
      scanNodeSummary(node.storyDir, controller.signal),
      timeoutMs,
      controller,
    )
      .then((summary): NodeScanResult => ({ reachable: true, summary }))
      .catch((err): NodeScanResult => {
        const isTimeout = (err instanceof Error && err.message === "timeout") ||
          (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError");
        return { reachable: false, reason: isTimeout ? "timeout" : "scan error" };
      });

    promises.push({ name, promise: scanPromise });
  }

  const settled = await Promise.all(promises.map((p) => p.promise));
  for (let i = 0; i < promises.length; i++) {
    results.set(promises[i]!.name, settled[i]!);
  }

  return results;
}

export async function loadNodeFullState(storyDir: string): Promise<LoadResult> {
  const root = dirname(storyDir);
  return loadProject(root);
}
