import { coordinateDuet, readDuetCoordination } from "../../core/duet-coordination.js";
import { loadArrangementsSafe } from "../../core/arrangement-loader.js";
import { DuetOperationSchema } from "../../models/duet.js";
import { ArrangementIdSchema, type OutputFormat } from "../../models/types.js";
import { formatArrangement, formatDuetCoordination, formatError, ExitCode } from "../../core/output-formatter.js";
import { CliValidationError } from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";

export async function handleDuetCoordinate(input: unknown, format: OutputFormat, root: string): Promise<CommandResult> {
  const parsed = DuetOperationSchema.safeParse(input);
  if (!parsed.success) throw new CliValidationError("invalid_input", parsed.error.message);
  return { output: formatDuetCoordination(await coordinateDuet(root, parsed.data), format) };
}

/** Positional identity and an explicit caller flag must not be shadowed by JSON. */
export function parseDuetOperation(id: string, json: string, clientTaskId?: string): unknown {
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new CliValidationError("invalid_input", "--json must contain a duet operation object"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliValidationError("invalid_input", "--json must contain a duet operation object");
  }
  const operation = value as Record<string, unknown>;
  if (operation.id !== undefined && operation.id !== id) throw new CliValidationError("invalid_input", "Operation id differs from positional arrangement id");
  if (clientTaskId !== undefined && operation.clientTaskId !== undefined && operation.clientTaskId !== clientTaskId) {
    throw new CliValidationError("invalid_input", "Operation caller differs from --client-task-id");
  }
  return { ...operation, id, ...(clientTaskId !== undefined && { clientTaskId }) };
}

export function handleDuetGet(id: string, ctx: CommandContext): CommandResult {
  if (!ArrangementIdSchema.safeParse(id).success) throw new CliValidationError("invalid_input", "Invalid arrangement id");
  const { arrangements } = loadArrangementsSafe(ctx.root);
  const arrangement = arrangements.find(a => a.id === id);
  if (!arrangement) return { output: formatError("not_found", `Arrangement ${id} not found`, ctx.format), exitCode: ExitCode.USER_ERROR, errorCode: "not_found" };
  const view = readDuetCoordination(ctx.root, arrangement);
  return { output: formatArrangement(arrangement, ctx.format, [], view) };
}
