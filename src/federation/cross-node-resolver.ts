import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CROSS_NODE_REF_CAPTURE_REGEX } from "../models/ticket.js";
import type { Ticket } from "../models/ticket.js";
import type { ResolvedNode } from "./resolver.js";

export type CrossNodeRefStatus =
  | { resolved: true; status: "complete" | "open" | "inprogress" }
  | { resolved: false; reason: string };


function normalizeStatus(status: string): "complete" | "open" | "inprogress" {
  if (status === "complete" || status === "resolved") return "complete";
  if (status === "inprogress") return "inprogress";
  return "open";
}

const DISPLAY_TICKET_REGEX = /^T-\d+[a-z]?$/;
const DISPLAY_ISSUE_REGEX = /^ISS-\d+$/;

// Tickets dir for legacy (T-) AND canonical (t-) ticket refs; issues dir for
// ISS-/i-. ISS-687: dispatching on startsWith("T-") alone misrouted canonical
// ticket refs (lowercase t-) to issues/, so they never resolved.
function subdirFor(itemId: string): "tickets" | "issues" {
  return itemId.startsWith("T-") || itemId.startsWith("t-") ? "tickets" : "issues";
}

function statusFromContent(parsed: Record<string, unknown>): CrossNodeRefStatus {
  if (typeof parsed.status === "string") {
    return { resolved: true, status: normalizeStatus(parsed.status) };
  }
  return { resolved: false, reason: "item not found in node" };
}

/// Resolves a single `itemId` (canonical or display form) against a node's
/// .story/ dir. ISS-687.
async function resolveItemStatus(storyDir: string, itemId: string): Promise<CrossNodeRefStatus> {
  const dir = join(storyDir, subdirFor(itemId));

  // 1. Direct filename match: canonical refs (t-/i-) and legacy/unreconciled
  //    display refs whose file is still named by the display id.
  try {
    const raw = await readFile(join(dir, `${itemId}.json`), "utf-8");
    return statusFromContent(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    // fall through to the displayId-from-content scan
  }

  // 2. displayId-from-content fallback (N-059): a display-form ref against a
  //    node whose item was reconciled to a canonical filename. Scan for a file
  //    whose displayId matches; fall back to a previousDisplayIds match only if
  //    no current displayId matches (current displayId wins, per the resolver).
  //    Canonical refs never reach here -- they resolve by filename in step 1.
  if (DISPLAY_TICKET_REGEX.test(itemId) || DISPLAY_ISSUE_REGEX.test(itemId)) {
    try {
      const files = await readdir(dir);
      let prevFallback: CrossNodeRefStatus | null = null;
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const parsed = JSON.parse(await readFile(join(dir, file), "utf-8")) as Record<string, unknown>;
          if (parsed.displayId === itemId) return statusFromContent(parsed);
          if (
            prevFallback === null &&
            Array.isArray(parsed.previousDisplayIds) &&
            (parsed.previousDisplayIds as unknown[]).includes(itemId)
          ) {
            prevFallback = statusFromContent(parsed);
          }
        } catch {
          // skip unreadable/malformed file
        }
      }
      if (prevFallback) return prevFallback;
    } catch {
      // dir missing -- fall through to unresolved
    }
  }

  return { resolved: false, reason: "item not found in node" };
}

export class CrossNodeBlockingResolver {
  private constructor(private readonly statuses: Map<string, CrossNodeRefStatus>) {}

  static async build(
    tickets: readonly Ticket[],
    resolvedNodes: Map<string, ResolvedNode>,
  ): Promise<CrossNodeBlockingResolver> {
    const refsByNode = new Map<string, Set<string>>();

    for (const ticket of tickets) {
      const refs = ticket.crossNodeBlockedBy;
      if (!refs) continue;
      for (const ref of refs) {
        const match = CROSS_NODE_REF_CAPTURE_REGEX.exec(ref);
        if (!match) continue;
        const nodeName = match[1]!;
        const itemId = match[2]!;
        if (!refsByNode.has(nodeName)) refsByNode.set(nodeName, new Set());
        refsByNode.get(nodeName)!.add(itemId);
      }
    }

    const statuses = new Map<string, CrossNodeRefStatus>();

    for (const [nodeName, itemIds] of refsByNode) {
      const node = resolvedNodes.get(nodeName);

      if (!node || !node.resolved) {
        const reason = node?.reason ?? "node not configured";
        for (const itemId of itemIds) {
          statuses.set(`${nodeName}:${itemId}`, { resolved: false, reason });
        }
        continue;
      }

      const reads = Array.from(itemIds).map(async (itemId) => {
        statuses.set(`${nodeName}:${itemId}`, await resolveItemStatus(node.storyDir, itemId));
      });

      await Promise.all(reads);
    }

    return new CrossNodeBlockingResolver(statuses);
  }

  isCrossNodeBlocked(ticket: Ticket): boolean | "unresolved" {
    const refs = ticket.crossNodeBlockedBy;
    if (!refs || refs.length === 0) return false;

    let hasUnresolved = false;

    for (const ref of refs) {
      if (typeof ref !== "string") continue;
      const status = this.statuses.get(ref);
      if (!status) {
        hasUnresolved = true;
        continue;
      }

      if (!status.resolved) {
        hasUnresolved = true;
        continue;
      }

      if (status.status !== "complete") {
        return true;
      }
    }

    return hasUnresolved ? "unresolved" : false;
  }

  getCrossNodeStatus(ref: string): CrossNodeRefStatus | undefined {
    return this.statuses.get(ref);
  }

  get resolvedStatuses(): ReadonlyMap<string, CrossNodeRefStatus> {
    return this.statuses;
  }
}
