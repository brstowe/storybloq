import type { Config } from "../models/config.js";
import { BusError } from "./errors.js";
import { DEFAULT_BUS_MAX_BODY_BYTES, DEFAULT_BUS_MAX_HOPS } from "./schemas.js";

export interface ResolvedBusConfig {
  readonly maxBodyBytes: number;
  readonly maxHops: number;
  readonly requireIssueForCritical: boolean;
}

export function isBusEnabled(config: Config): boolean {
  return config.features.bus === true;
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
    throw new BusError("bus_disabled", "Storybloq Bus is disabled. Run `storybloq bus init` first.");
  }
  return resolvedBusConfig(config);
}
