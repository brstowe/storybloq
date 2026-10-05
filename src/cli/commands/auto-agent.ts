/**
 * Fork feature: `storybloq auto-agent get|set|clear`.
 *
 * The board's autonomous-agent switch. `get` always answers (false when
 * nothing is stored); `set` records an explicit value; `clear` removes the key
 * and returns the board to the default.
 *
 * `clear` is NOT the same as `set false`, and both exist for that reason: one
 * says "this board has no opinion", the other says "this board is explicitly
 * off". They resolve to the same behaviour today and read differently in
 * `source`, which is what lets a UI show "not configured" honestly.
 */

import {
  resolveAutoAgent,
  parseAutoAgentValue,
  AUTO_AGENT_DEFAULT,
  type AutoAgentSource,
} from "../../core/auto-agent.js";
import { editConfigField } from "../util/config-edit.js";
import { ProjectLoaderError } from "../../core/errors.js";
import { successEnvelope } from "../../core/output-formatter.js";
import type { CommandResult } from "../types.js";
import type { OutputFormat } from "../../models/types.js";

interface AutoAgentData {
  readonly autoAgent: boolean;
  readonly source: AutoAgentSource;
  /** The raw stored value, so a caller can see one being IGNORED. */
  readonly configured: unknown;
  readonly default: boolean;
}

function readData(rawConfig: Record<string, unknown>): AutoAgentData {
  const resolved = resolveAutoAgent(rawConfig);
  return {
    autoAgent: resolved.enabled,
    source: resolved.source,
    configured: Object.hasOwn(rawConfig, "autoAgent") ? rawConfig.autoAgent : null,
    default: AUTO_AGENT_DEFAULT,
  };
}

function render(data: AutoAgentData, format: OutputFormat, note?: string): CommandResult {
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(data), null, 2) };
  }
  const state = data.autoAgent ? "enabled" : "disabled";
  const origin = data.source === "config" ? "config.json" : `default (${AUTO_AGENT_DEFAULT})`;
  const lines = [`auto agent: ${state}  (from ${origin})`];
  if (note) lines.push(note);
  else if (data.source === "default" && data.configured !== null) {
    lines.push(
      `Note: config.json has autoAgent ${JSON.stringify(data.configured)}, which is not a boolean and is being ignored.`,
    );
  }
  return { output: lines.join("\n") };
}

/** `storybloq auto-agent get` -- read-only, never writes, always answers. */
export function handleAutoAgentGet(
  rawConfig: Record<string, unknown>,
  format: OutputFormat,
): CommandResult {
  return render(readData(rawConfig), format);
}

/** `storybloq auto-agent set <true|false>`. */
export async function handleAutoAgentSet(
  root: string,
  value: string,
  format: OutputFormat,
): Promise<CommandResult> {
  const parsed = parseAutoAgentValue(value);
  if (parsed === null) {
    throw new ProjectLoaderError(
      "invalid_input",
      `auto-agent must be a boolean: got "${value}". Use true/false (1/0, yes/no and on/off are also accepted).`,
    );
  }
  const raw = await editConfigField(root, (r) => {
    r.autoAgent = parsed;
  });
  return render(readData(raw), format, `Auto agent ${parsed ? "enabled" : "disabled"}.`);
}

/** `storybloq auto-agent clear` -- drop the stored value, back to the default. */
export async function handleAutoAgentClear(
  root: string,
  format: OutputFormat,
): Promise<CommandResult> {
  const raw = await editConfigField(root, (r) => {
    delete r.autoAgent;
  });
  return render(
    readData(raw),
    format,
    `Auto agent setting cleared; now the default (${AUTO_AGENT_DEFAULT}).`,
  );
}
