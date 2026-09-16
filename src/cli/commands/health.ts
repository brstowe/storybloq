/**
 * T-502: `storybloq health` -- the on-demand tooling check.
 *
 * Thin on purpose. Everything the checks decide lives in `core/health`; this
 * file exists only to supply the two roots and pick a renderer.
 *
 * `projectDir` is the INVOCATION directory, `process.cwd()` for the CLI. That
 * is not a detail: Claude Code resolves `.claude/settings*.json` and
 * `.mcp.json` from the directory it was launched in, so a user running this
 * from a subdirectory of a monorepo is asking about THAT directory's layers,
 * not the ledger root's. The ledger root supplies config and nothing else,
 * and may be null.
 *
 * The command exits 0 in every case, including when a check errors. A tooling
 * report is information, not a gate: a non-zero exit here would break the
 * scripts and hooks that could usefully call it.
 */

import { runHealthCheck } from "../../core/health/entry.js";
import { formatHealthResult, healthResultJson } from "../../core/health/format.js";
import type { HealthCheckId, HealthDeps } from "../../core/health/types.js";
import type { OutputFormat } from "../../models/types.js";
import type { CommandResult } from "../types.js";

export interface HealthRoots {
  readonly ledgerRoot: string | null;
  readonly projectDir: string;
}

export interface HealthOptions {
  readonly only?: readonly HealthCheckId[];
  readonly refresh?: boolean;
  /** Test seam: overrides for individual default adapters. */
  readonly deps?: Partial<HealthDeps>;
}

export async function handleHealth(
  roots: HealthRoots,
  format: OutputFormat,
  opts: HealthOptions = {},
): Promise<CommandResult> {
  const result = await runHealthCheck(
    {
      ledgerRoot: roots.ledgerRoot,
      projectDir: roots.projectDir,
      cliVersion: process.env.STORYBLOQ_VERSION ?? "0.0.0-dev",
      depsOverride: opts.deps,
    },
    { only: opts.only, refresh: opts.refresh },
  );
  return {
    output: format === "json" ? healthResultJson(result) : formatHealthResult(result),
  };
}
