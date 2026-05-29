import { resolve } from "node:path";
import { generateKeyBetween, compareByRank } from "../../core/fractional-index.js";
import type { CommandResult } from "../types.js";

export interface MoveOptions {
  after?: string;
  before?: string;
  format?: "md" | "json";
}

export async function handleTicketMove(
  id: string,
  root: string,
  options: MoveOptions,
): Promise<CommandResult> {
  const format = options.format ?? "md";

  if (options.after && options.before) {
    return { output: "Error: specify --after or --before, not both.", exitCode: 1 };
  }
  if (!options.after && !options.before) {
    return { output: "Error: specify --after or --before.", exitCode: 1 };
  }

  const targetId = (options.after ?? options.before)!;
  if (targetId === id) {
    return { output: "Error: cannot move a ticket relative to itself.", exitCode: 1 };
  }

  const { withProjectLock, writeTicketUnlocked } = await import("../../core/project-loader.js");

  let output = "";
  await withProjectLock(root, { strict: false }, async ({ state }) => {
    const ticket = state.ticketByID(id);
    if (!ticket) {
      output = format === "json"
        ? JSON.stringify({ ok: false, error: `Ticket ${id} not found.` }, null, 2)
        : `Error: ticket ${id} not found.`;
      return;
    }

    const target = state.ticketByID(targetId);
    if (!target) {
      output = format === "json"
        ? JSON.stringify({ ok: false, error: `Target ticket ${targetId} not found.` }, null, 2)
        : `Error: target ticket ${targetId} not found.`;
      return;
    }

    if (ticket.phase !== target.phase) {
      output = format === "json"
        ? JSON.stringify({ ok: false, error: `Tickets are in different phases.` }, null, 2)
        : `Error: ${id} (phase ${ticket.phase}) and ${targetId} (phase ${target.phase}) are in different phases.`;
      return;
    }

    const siblings = state.phaseTickets(ticket.phase)
      .filter((t) => t.id !== id)
      .map((t) => ({ rank: (t as Record<string, unknown>).rank as string | undefined, order: t.order, id: t.id }))
      .sort(compareByRank);

    const targetIdx = siblings.findIndex((s) => s.id === targetId);
    if (targetIdx === -1) {
      output = `Error: target ${targetId} not found in phase siblings.`;
      return;
    }

    // Lower/upper rank bounds for the new position. For --after we slot between the
    // target and its next sibling; for --before, between the previous sibling and
    // the target.
    let lo: string | null;
    let hi: string | null;
    if (options.after) {
      lo = siblings[targetIdx]!.rank ?? null;
      hi = targetIdx + 1 < siblings.length ? (siblings[targetIdx + 1]!.rank ?? null) : null;
    } else {
      lo = targetIdx > 0 ? (siblings[targetIdx - 1]!.rank ?? null) : null;
      hi = siblings[targetIdx]!.rank ?? null;
    }

    let newRank: string;
    try {
      // ISS-688: the spec allows duplicate ranks, so the immediate bounds can be
      // equal (or non-increasing) and there is no value strictly between them. Rather
      // than let generateKeyBetween's midpoint() throw (which surfaced as an opaque
      // io_error), widen the bound past the duplicate-rank group to the nearest
      // DISTINCT sibling, so the ticket lands just after/before the group and still
      // before/after the next distinct sibling (siblings are sorted ascending by rank).
      if (lo !== null && hi !== null && lo >= hi) {
        if (options.after) {
          let upper: string | null = null;
          for (let j = targetIdx + 1; j < siblings.length; j++) {
            const r = siblings[j]!.rank;
            if (r != null && r > lo) { upper = r; break; }
          }
          newRank = generateKeyBetween(lo, upper);
        } else {
          let lower: string | null = null;
          for (let j = targetIdx - 1; j >= 0; j--) {
            const r = siblings[j]!.rank;
            if (r != null && r < hi) { lower = r; break; }
          }
          newRank = generateKeyBetween(lower, hi);
        }
      } else {
        newRank = generateKeyBetween(lo, hi);
      }
    } catch {
      // Genuine exhaustion (e.g. moving before the minimum rank): actionable guidance
      // instead of a crash. reconcile --rebalance-ranks restores spread-out ranks.
      const msg = `Cannot compute a rank for this move: sibling ranks are duplicated or exhausted. Run \`storybloq reconcile --rebalance-ranks\` and retry.`;
      output = format === "json"
        ? JSON.stringify({ ok: false, error: msg }, null, 2)
        : `Error: ${msg}`;
      return;
    }

    const updated = { ...ticket, rank: newRank } as Record<string, unknown>;
    await writeTicketUnlocked(updated as any, resolve(root));

    if (format === "json") {
      output = JSON.stringify({ ok: true, data: { id, rank: newRank } }, null, 2);
    } else {
      output = `Moved ${id} ${options.after ? "after" : "before"} ${targetId} (rank: ${newRank}).`;
    }
  });

  return { output };
}
