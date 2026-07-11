import {
  appendValidationFindings,
  validateProject,
  mergeValidation,
} from "../../core/validation.js";
import { validateIssueSourceRefs } from "../../core/issue-source-ref.js";
import { ExitCode, formatValidation } from "../../core/output-formatter.js";
import type { CommandContext, CommandResult } from "../types.js";

export function handleValidate(ctx: CommandContext): CommandResult {
  const baseResult = validateProject(ctx.state);
  const merged = mergeValidation(baseResult, ctx.warnings);
  return {
    output: formatValidation(merged, ctx.format),
    exitCode: merged.valid ? ExitCode.OK : ExitCode.VALIDATION_ERROR,
  };
}

/** Full validation including Git and working-tree source provenance checks. */
export async function handleValidateWithSourceRefs(
  ctx: CommandContext,
): Promise<CommandResult> {
  const baseResult = validateProject(ctx.state);
  const merged = mergeValidation(baseResult, ctx.warnings);
  const sourceFindings = await validateIssueSourceRefs(ctx.root, ctx.state.activeIssues);
  const complete = appendValidationFindings(merged, sourceFindings);
  return {
    output: formatValidation(complete, ctx.format),
    exitCode: complete.valid ? ExitCode.OK : ExitCode.VALIDATION_ERROR,
  };
}
