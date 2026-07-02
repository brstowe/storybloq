import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CommandResult } from "../types.js";
import { CliValidationError } from "../helpers.js";
import { successEnvelope } from "../../core/output-formatter.js";
import { withProjectLock, writeConfigUnlocked } from "../../core/project-loader.js";
import { assertTeamWriteCapabilities } from "../../core/team-capabilities.js";
import { ConfigSchema } from "../../models/config.js";

const ALLOWED_KEYS = new Set([
  "enabled",
  "claimStalenessHours",
  "idAllocator",
  "idAllocatorRemote",
  "minCliVersion",
  "minMacVersion",
  "requiredFeatures",
]);

export function handleTeamConfigShow(
  root: string,
  format: string,
): CommandResult {
  const configPath = join(root, ".story", "config.json");
  if (!existsSync(configPath)) {
    throw new CliValidationError("not_found", "No .story/config.json found");
  }
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  const team = config.team ?? {};
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(team), null, 2) };
  }
  const entries = Object.entries(team as Record<string, unknown>);
  if (entries.length === 0) {
    return { output: "No team configuration set. Run `storybloq team init` to enable team mode." };
  }
  const lines = entries.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`);
  return { output: "Team config:\n" + lines.join("\n") };
}

export async function handleTeamConfigSet(
  root: string,
  key: string,
  value: string,
  format: string,
): Promise<CommandResult> {
  if (!ALLOWED_KEYS.has(key)) {
    throw new CliValidationError(
      "invalid_input",
      `Unknown team config key "${key}". Allowed: ${[...ALLOWED_KEYS].join(", ")}`,
    );
  }

  const configPath = join(root, ".story", "config.json");
  if (!existsSync(configPath)) {
    throw new CliValidationError("not_found", "No .story/config.json found");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = value;
  }

  await withProjectLock(root, { strict: false }, async ({ state }) => {
    const config = {
      ...state.config,
      team: {
        ...(state.config.team ?? {}),
        [key]: parsed,
      },
    };
    // ISS-755: setting the git-refs allocator must also fence the
    // remote-ref-reservations capability into requiredFeatures (mirrors
    // team-init). Applied on the merged config, before schema validation:
    // append if missing, idempotent, and it applies even when
    // requiredFeatures pre-existed.
    const team = config.team as Record<string, unknown>;
    if (team.idAllocator === "git-refs") {
      const features = Array.isArray(team.requiredFeatures)
        ? (team.requiredFeatures as string[])
        : [];
      if (!features.includes("remote-ref-reservations")) {
        team.requiredFeatures = [...features, "remote-ref-reservations"];
      }
    }
    const validated = ConfigSchema.parse(config);
    assertTeamWriteCapabilities(validated);
    await writeConfigUnlocked(validated, root);
  });

  if (format === "json") {
    return { output: JSON.stringify(successEnvelope({ key, value: parsed }), null, 2) };
  }
  return { output: `Set team.${key} = ${JSON.stringify(parsed)}` };
}
