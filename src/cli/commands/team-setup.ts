import { teamSetup, type SetupResult } from "../../core/team-setup.js";

export interface TeamSetupOutput {
  output: string;
  exitCode: number;
}

export async function handleTeamSetup(root: string, opts: { format?: "md" | "json" }): Promise<TeamSetupOutput> {
  try {
    const result = await teamSetup(root);

    if (opts.format === "json") {
      return { output: JSON.stringify(result, null, 2), exitCode: 0 };
    }

    const lines: string[] = [
      "Team merge setup complete:",
      `  Merge driver: ${result.driverInstalled ? "installed" : "skipped"}`,
      `  .gitattributes: ${result.gitattributesWritten ? "written" : "skipped"}`,
      `  Config version: ${result.versionUpdated ? "updated" : "skipped"}`,
      `  Git root: ${result.gitRoot}`,
    ];
    return { output: lines.join("\n"), exitCode: 0 };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.format === "json") {
      return { output: JSON.stringify({ error: message }), exitCode: 1 };
    }
    return { output: `Error: ${message}`, exitCode: 1 };
  }
}
