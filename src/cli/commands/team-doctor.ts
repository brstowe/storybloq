import { runDoctor, type DoctorContext } from "../../core/team-doctor.js";
import { formatDoctorResult, ExitCode } from "../../core/output-formatter.js";
import { withProjectLock } from "../../core/project-loader.js";
import type { CommandResult } from "../types.js";

export interface TeamDoctorOptions {
  readonly ci: boolean;
  readonly format: "md" | "json";
}

export async function handleTeamDoctor(
  root: string,
  options: TeamDoctorOptions,
): Promise<CommandResult> {
  let output = "";
  let exitCode: number = ExitCode.OK;

  await withProjectLock(root, { strict: false }, async ({ state, warnings }) => {
    const isTeamMode = (state.config.schemaVersion ?? 1) >= 2;

    const ctx: DoctorContext = {
      root,
      cliVersion: null,
      isTeamMode,
      loadWarnings: warnings,
    };

    try {
      const { version } = await import("../../../package.json", { with: { type: "json" } });
      ctx.cliVersion = version ?? null;
    } catch {
      // Version unavailable
    }

    const result = runDoctor(state, ctx);
    output = formatDoctorResult(result, options.format);

    if (options.ci && result.errorCount > 0) {
      exitCode = 1;
    }
  });

  return { output, exitCode };
}
