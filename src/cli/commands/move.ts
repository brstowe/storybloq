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

    let newRank: string;
    if (options.after) {
      const after = siblings[targetIdx]!;
      const next = targetIdx + 1 < siblings.length ? siblings[targetIdx + 1]! : null;
      newRank = generateKeyBetween(after.rank ?? null, next?.rank ?? null);
    } else {
      const before = siblings[targetIdx]!;
      const prev = targetIdx > 0 ? siblings[targetIdx - 1]! : null;
      newRank = generateKeyBetween(prev?.rank ?? null, before.rank ?? null);
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
