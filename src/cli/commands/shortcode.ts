/**
 * Fork feature: `storybloq shortcode get|set|clear`.
 *
 * The board's terse handle. `get` always answers (deriving from the project
 * directory when nothing is stored); `set` records an override; `clear` drops
 * the override and returns the board to its directory-derived default.
 *
 * A dedicated command group rather than a key under `config set-overrides`,
 * which is `recipeOverrides`-only, or `team config set`, which is team mode.
 * The shortcode is a top-level identity field and gets a top-level surface --
 * the one the dashboard shells out to.
 */

import { join } from "node:path";
import { tryReadFile } from "../util/file-io.js";
import { withProjectLock, atomicWrite, guardPath } from "../../core/project-loader.js";
import { ConfigSchema } from "../../models/config.js";
import { ProjectLoaderError } from "../../core/errors.js";
import {
  resolveShortcode,
  shortcodeRefusal,
  deriveShortcodeFromDir,
  type ShortcodeSource,
} from "../../core/shortcode.js";
import { successEnvelope } from "../../core/output-formatter.js";
import type { CommandResult } from "../types.js";
import type { OutputFormat } from "../../models/types.js";

interface ShortcodeData {
  readonly shortcode: string | null;
  readonly source: ShortcodeSource | null;
  /** The override as stored, so a caller can see an IGNORED one. */
  readonly configured: string | null;
  /** What the directory alone would give, whatever the override says. */
  readonly derived: string | null;
}

function render(data: ShortcodeData, format: OutputFormat, note?: string): CommandResult {
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(data), null, 2) };
  }
  if (data.shortcode === null) {
    return {
      output:
        "No shortcode: this project's directory name does not slugify to a usable one. Set one with `storybloq shortcode set <value>`.",
    };
  }
  const origin = data.source === "config" ? "config.json" : "project directory";
  const lines = [`${data.shortcode}  (from ${origin})`];
  if (note) lines.push(note);
  else if (data.source === "directory" && data.configured !== null) {
    lines.push(
      `Note: config.json has shortcode "${data.configured}", which is not valid and is being ignored.`,
    );
  }
  return { output: lines.join("\n") };
}

function readData(root: string, rawConfig: { readonly shortcode?: unknown }): ShortcodeData {
  const resolved = resolveShortcode(root, rawConfig);
  const configured = typeof rawConfig.shortcode === "string" ? rawConfig.shortcode : null;
  return {
    shortcode: resolved?.shortcode ?? null,
    source: resolved?.source ?? null,
    configured,
    derived: deriveShortcodeFromDir(root),
  };
}

/** `storybloq shortcode get` -- read-only, never writes, always answers. */
export function handleShortcodeGet(
  root: string,
  config: { readonly shortcode?: unknown },
  format: OutputFormat,
): CommandResult {
  return render(readData(root, config), format);
}

/**
 * Reads config.json as RAW JSON, applies `mutate`, validates and writes
 * atomically under the project lock -- the same discipline as
 * `config set-overrides`, so unknown top-level keys survive a shortcode edit.
 */
async function writeConfig(
  root: string,
  mutate: (raw: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  let out: Record<string, unknown> = {};
  await withProjectLock(root, { strict: false }, async () => {
    const configPath = join(root, ".story", "config.json");
    const readResult = tryReadFile(configPath);
    if (!readResult.ok) {
      throw new ProjectLoaderError(
        "io_error",
        `Cannot read config: ${readResult.error.message}`,
        readResult.error,
      );
    }
    const raw = JSON.parse(readResult.content) as Record<string, unknown>;
    mutate(raw);

    const validated = ConfigSchema.safeParse(raw);
    if (!validated.success) {
      const message = validated.error.issues.map((i) => i.message).join("; ");
      throw new ProjectLoaderError("invalid_input", `Invalid config after edit: ${message}`);
    }

    await guardPath(configPath, root);
    await atomicWrite(configPath, JSON.stringify(raw, null, 2) + "\n");
    out = raw;
  });
  return out;
}

/** `storybloq shortcode set <value>`. */
export async function handleShortcodeSet(
  root: string,
  value: string,
  format: OutputFormat,
): Promise<CommandResult> {
  const refusal = shortcodeRefusal(value);
  if (refusal !== null) throw new ProjectLoaderError("invalid_input", refusal);

  const raw = await writeConfig(root, (r) => {
    r.shortcode = value;
  });
  return render(readData(root, raw), format, `Shortcode set to "${value}".`);
}

/** `storybloq shortcode clear` -- drop the override, fall back to the directory. */
export async function handleShortcodeClear(
  root: string,
  format: OutputFormat,
): Promise<CommandResult> {
  const raw = await writeConfig(root, (r) => {
    delete r.shortcode;
  });
  const data = readData(root, raw);
  const note =
    data.shortcode === null
      ? undefined
      : `Shortcode override cleared; now "${data.shortcode}" from the project directory.`;
  return render(data, format, note);
}
