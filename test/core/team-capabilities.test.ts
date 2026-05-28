import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { SUPPORTED_TEAM_FEATURES, assertTeamWriteCapabilities } from "../../src/core/team-capabilities.js";
import type { Config } from "../../src/models/config.js";

// The canonical team-feature vocabulary lives in ONE checked-in file,
// test/fixtures/team-features.json. ISS-684: both the TS SUPPORTED_TEAM_FEATURES
// (asserted here) and the Swift Config.TeamCapabilities.supportedFeatures (asserted
// in TeamModeFieldTests against this same file) are pinned to it, so the two
// implementations cannot silently diverge -- passing both suites requires both to
// equal the fixture, hence each other.
const CANONICAL_TEAM_FEATURES = JSON.parse(
  readFileSync(new URL("../fixtures/team-features.json", import.meta.url), "utf8"),
) as string[];

function teamConfig(requiredFeatures: string[]): Config {
  return {
    version: 2,
    schemaVersion: 2,
    project: "t",
    type: "npm",
    language: "ts",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    team: { enabled: true, requiredFeatures },
  } as unknown as Config;
}

describe("SUPPORTED_TEAM_FEATURES vocabulary (ISS-684)", () => {
  it("matches the canonical list exactly (pins TS<->Swift parity)", () => {
    expect([...SUPPORTED_TEAM_FEATURES].sort()).toEqual([...CANONICAL_TEAM_FEATURES].sort());
  });

  it("does not contain the stale spec-example alias 'display-id-reconcile'", () => {
    // N-059's example config used display-id-reconcile; the canonical feature is
    // 'reconcile'. This guards against re-introducing the diverged alias.
    expect(SUPPORTED_TEAM_FEATURES.has("display-id-reconcile")).toBe(false);
    expect(SUPPORTED_TEAM_FEATURES.has("reconcile")).toBe(true);
  });
});

describe("assertTeamWriteCapabilities requiredFeatures gate", () => {
  it("passes when all required features are supported", () => {
    expect(() => assertTeamWriteCapabilities(teamConfig(["merge-driver", "reconcile"]))).not.toThrow();
  });

  it("throws when a required feature is unsupported", () => {
    expect(() => assertTeamWriteCapabilities(teamConfig(["merge-driver", "warp-drive"])))
      .toThrow(/unsupported team feature/i);
  });

  it("does not gate a non-team config", () => {
    const solo = { ...teamConfig([]), team: undefined } as unknown as Config;
    expect(() => assertTeamWriteCapabilities(solo)).not.toThrow();
  });
});
