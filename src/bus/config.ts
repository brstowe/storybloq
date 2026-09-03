import { join } from "node:path";
import type { Config } from "../models/config.js";
import { BusError } from "./errors.js";
import { readTextNoFollow } from "./io.js";
import { DEFAULT_BUS_MAX_BODY_BYTES, DEFAULT_BUS_MAX_HOPS } from "./schemas.js";

export interface ResolvedBusConfig {
  readonly maxBodyBytes: number;
  readonly maxHops: number;
  readonly requireIssueForCritical: boolean;
}

export function isBusEnabled(config: Config): boolean {
  return config.features.bus === true;
}

// T-430: per-project auto-attach opt-in. Requires the Bus feature itself to be on;
// the flag alone (feature off) never auto-attaches.
export function isBusAutoAttachEnabled(config: Config): boolean {
  return isBusEnabled(config) && config.bus?.autoAttach === true;
}

// Explicit upper bound on the config read from the hook's critical path. A real .story/config.json
// is a few KB; this cap keeps a pathological or maliciously-large file from making the hook
// allocate/parse proportionally, while staying far above any legitimate config.
const CONFIG_MAX_BYTES = 256 * 1024;

// T-430: crash-proof, allocation-BOUNDED disk read for the SessionStart hook's hot path. The
// hook must stay fast and fail-open, so this reads .story/config.json via the hardened
// no-follow reader -- lstat floor + O_NOFOLLOW + O_NONBLOCK (a symlinked or FIFO-swapped path
// can never be followed or block the open) + a hard size cap -- then does a minimal parse (no
// full project load, no schema validation) and returns false on ANY error. The spawned child
// re-validates the fully-parsed config, so a false positive here is harmless (the child gates
// and removes its record); a false negative simply skips auto-attach this start.
export async function isBusAutoAttachEnabledFromDisk(root: string): Promise<boolean> {
  try {
    const raw = await readTextNoFollow(join(root, ".story", "config.json"), CONFIG_MAX_BYTES);
    const parsed = JSON.parse(raw) as { features?: { bus?: unknown }; bus?: { autoAttach?: unknown } };
    return parsed.features?.bus === true && parsed.bus?.autoAttach === true;
  } catch {
    return false;
  }
}

export function resolvedBusConfig(config: Config): ResolvedBusConfig {
  return {
    maxBodyBytes: config.bus?.maxBodyBytes ?? DEFAULT_BUS_MAX_BODY_BYTES,
    maxHops: config.bus?.maxHops ?? DEFAULT_BUS_MAX_HOPS,
    requireIssueForCritical: config.bus?.requireIssueForCritical ?? true,
  };
}

export function assertBusEnabled(config: Config): ResolvedBusConfig {
  if (!isBusEnabled(config)) {
    throw new BusError("bus_disabled", "Storybloq Bus is disabled. Run `storybloq bus setup` first.");
  }
  return resolvedBusConfig(config);
}
