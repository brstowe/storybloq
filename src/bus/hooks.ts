import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { loadProject } from "../core/project-loader.js";
import { assertBusEnabled } from "./config.js";
import { BusError } from "./errors.js";
import { durableWrite, readJsonNoFollow } from "./io.js";
import { withHardenedLock } from "./lock.js";
import { resolveBusPaths } from "./paths.js";
import type { BusClient } from "./schemas.js";

const BusHookPolicySchema = z.object({
  schema: z.literal("storybloq-bus-hook-policy/v1"),
  claude: z.boolean(),
  codex: z.boolean(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export type BusHookPolicy = z.infer<typeof BusHookPolicySchema>;

function defaultPolicy(): BusHookPolicy {
  return {
    schema: "storybloq-bus-hook-policy/v1",
    claude: false,
    codex: false,
    updatedAt: new Date(0).toISOString(),
  };
}

export async function readBusHookPolicy(root: string): Promise<BusHookPolicy> {
  const paths = await resolveBusPaths(root, false);
  try {
    return await readJsonNoFollow(join(paths.busRoot, "hook-policy.json"), BusHookPolicySchema);
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") return defaultPolicy();
    throw err;
  }
}

export async function setBusHookPolicy(
  root: string,
  clients: readonly BusClient[],
  enabled: boolean,
): Promise<BusHookPolicy> {
  assertBusEnabled((await loadProject(root)).state.config);
  const paths = await resolveBusPaths(root, true);
  return withHardenedLock(join(paths.locks, "hook-policy.lock"), async () => {
    const current = await readBusHookPolicy(paths.projectRoot);
    const next = BusHookPolicySchema.parse({
      ...current,
      ...Object.fromEntries(clients.map((client) => [client, enabled])),
      updatedAt: new Date().toISOString(),
    });
    await durableWrite(join(paths.busRoot, "hook-policy.json"), JSON.stringify(next, null, 2) + "\n");
    return next;
  });
}

export async function isBusHookDeliveryEnabled(root: string, client: BusClient): Promise<boolean> {
  try {
    const config = JSON.parse(await readFile(join(root, ".story", "config.json"), "utf-8")) as {
      features?: { bus?: unknown };
    };
    if (config.features?.bus !== true) return false;
    return (await readBusHookPolicy(root))[client];
  } catch {
    return false;
  }
}
