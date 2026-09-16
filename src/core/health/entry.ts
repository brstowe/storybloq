/**
 * T-502: the one place both surfaces enter the health run.
 *
 * The CLI and the MCP tool differ only in where `projectDir` comes from (the
 * process cwd against the server's captured launch directory), so everything
 * after that -- client detection, config resolution, the deadline, the
 * default adapters -- lives here and cannot drift between them.
 */

import { defaultHealthDeps } from "./deps.js";
import { readHealthCheckConfig } from "./config.js";
import { HEALTH_TOTAL_BUDGET_MS, runHealth, type RunHealthOptions } from "./run.js";
import type { HealthClient, HealthDeps, HealthResult } from "./types.js";

export interface HealthRunInput {
  readonly ledgerRoot: string | null;
  /** The INVOCATION directory: CLI cwd, or the MCP server's launch directory. */
  readonly projectDir: string;
  readonly cliVersion: string;
  /** Test seam only; production builds the default adapters. */
  readonly deps?: HealthDeps;
  /**
   * Test seam: replace individual default adapters. Kept separate from `deps`
   * so a surface test can inject ONE effect (a throwing settings reader, say)
   * without having to restate the other nine.
   */
  readonly depsOverride?: Partial<HealthDeps>;
}

export function resolveHealthClient(env: Readonly<Record<string, string | undefined>>): HealthClient {
  return env.STORYBLOQ_CLIENT === "codex" ? "codex" : "claude";
}

export async function runHealthCheck(
  input: HealthRunInput,
  opts: RunHealthOptions = {},
): Promise<HealthResult> {
  const base = input.deps ?? defaultHealthDeps({ ledgerRoot: input.ledgerRoot });
  const deps = input.depsOverride ? { ...base, ...input.depsOverride } : base;
  return runHealth(
    {
      ledgerRoot: input.ledgerRoot,
      projectDir: input.projectDir,
      cliVersion: input.cliVersion,
      client: resolveHealthClient(deps.env),
      config: readHealthCheckConfig(input.ledgerRoot),
      deadline: deps.now() + HEALTH_TOTAL_BUDGET_MS,
    },
    deps,
    opts,
  );
}
