/**
 * Fork: read-modify-write of one top-level `.story/config.json` field.
 *
 * Extracted so the shortcode and auto-agent commands share one write
 * discipline rather than keeping two copies that can drift: read the file as
 * RAW JSON (so unknown top-level keys written by any other tool survive the
 * edit), mutate, validate against `ConfigSchema`, and write atomically under
 * the project lock.
 *
 * `config set-overrides` keeps its own copy of this shape on purpose -- it
 * carries the `--deep` merge contract and the duplicate-key refusal, neither of
 * which a single-field write needs.
 */

import { join } from "node:path";
import { tryReadFile } from "./file-io.js";
import { withProjectLock, atomicWrite, guardPath } from "../../core/project-loader.js";
import { ConfigSchema } from "../../models/config.js";
import { ProjectLoaderError } from "../../core/errors.js";

/**
 * Applies `mutate` to the raw config and returns the written object.
 *
 * Throws `ProjectLoaderError` on an unreadable file or a config the schema
 * rejects AFTER the edit -- the latter matters because a board can already hold
 * a config that only `.safeParse` tolerates, and this refuses to be the write
 * that makes an unrelated pre-existing problem permanent.
 */
export async function editConfigField(
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
