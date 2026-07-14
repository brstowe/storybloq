import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { ensureGitignoreEntries } from "../core/init.js";
import { withProjectLock, writeConfigUnlocked } from "../core/project-loader.js";
import { canonicalHash } from "./canonical.js";
import { BusError } from "./errors.js";
import { durableCreate, readJsonNoFollow } from "./io.js";
import {
  assertBusLayout,
  assertBusIgnoreFileSafe,
  assertBusRuntimeIgnored,
  busRuntimeExists,
  createBusPathsForInitialization,
  resolveBusPaths,
  type BusPaths,
} from "./paths.js";

export const BusInstanceSchema = z.object({
  schema: z.literal("storybloq-bus-instance/v1"),
  instanceId: z.string().uuid(),
  projectRootHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export interface InitializeBusResult {
  readonly enabled: boolean;
  readonly existing: boolean;
  readonly instanceId: string;
  readonly restartRequired: boolean;
}

async function readBusInstanceAtPaths(paths: BusPaths): Promise<z.infer<typeof BusInstanceSchema>> {
  const instance = await readJsonNoFollow(join(paths.busRoot, "instance.json"), BusInstanceSchema);
  if (instance.projectRootHash !== canonicalHash(paths.projectRoot)) {
    throw new BusError("conflict", "Bus instance belongs to a different canonical project root");
  }
  return instance;
}

export async function readBusInstance(root: string): Promise<z.infer<typeof BusInstanceSchema>> {
  return readBusInstanceAtPaths(await resolveBusPaths(root));
}

export async function resolveInitializedBusPaths(root: string): Promise<BusPaths> {
  const paths = await resolveBusPaths(root);
  if (!await busRuntimeExists(paths.busRoot)) {
    throw new BusError("not_found", "Bus is not initialized in this checkout. Run `storybloq bus init` first.");
  }
  await assertBusLayout(paths);
  try {
    await readBusInstanceAtPaths(paths);
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") {
      throw new BusError("corrupt", "Bus runtime is missing instance.json. Run `storybloq bus doctor` for details.", err);
    }
    throw err;
  }
  return paths;
}

export async function initializeBus(root: string): Promise<InitializeBusResult> {
  let enabledNow = false;
  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const storyRoot = join(root, ".story");
    await assertBusIgnoreFileSafe(storyRoot);
    await ensureGitignoreEntries(join(storyRoot, ".gitignore"), ["bus/"]);
    await assertBusRuntimeIgnored(storyRoot);
    if (state.config.features.bus !== true) {
      await writeConfigUnlocked({
        ...state.config,
        features: { ...state.config.features, bus: true },
      }, root);
      enabledNow = true;
    }
  });

  const paths = await createBusPathsForInitialization(root);
  const instancePath = join(paths.busRoot, "instance.json");
  try {
    const existing = await readBusInstance(paths.projectRoot);
    return { enabled: true, existing: true, instanceId: existing.instanceId, restartRequired: enabledNow };
  } catch (err) {
    if (!(err instanceof BusError) || err.code !== "not_found") throw err;
  }

  const instance = BusInstanceSchema.parse({
    schema: "storybloq-bus-instance/v1",
    instanceId: randomUUID(),
    projectRootHash: canonicalHash(paths.projectRoot),
    createdAt: new Date().toISOString(),
  });
  await durableCreate(instancePath, JSON.stringify(instance, null, 2) + "\n");
  return { enabled: true, existing: false, instanceId: instance.instanceId, restartRequired: enabledNow };
}
