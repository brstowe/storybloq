import { describe, it, expect } from "vitest";
import { formatHealthResult, healthResultJson } from "../../../src/core/health/format.js";
import type { HealthResult } from "../../../src/core/health/types.js";

const result: HealthResult = {
  ranAt: "2026-09-10T12:00:00.000Z",
  cliVersion: "1.14.0",
  client: "claude",
  projectDir: "/repo/app",
  durationMs: 42,
  budgetExhausted: false,
  checks: [
    { id: "usage-window", status: "ok", message: "Fine.", advice: null, detail: {} },
    {
      id: "cli-version",
      status: "advise",
      message: "storybloq 1.14.0 is installed; 1.15.0 is published.",
      advice: "storybloq 1.14.0 is installed; 1.15.0 is published.",
      detail: {},
    },
    { id: "codex-bridge", status: "skip", message: "Codex is not installed.", advice: null, detail: { reason: "Codex is not installed" } },
    { id: "skill-version", status: "error", message: "The skill-version check failed with TypeError.", advice: null, detail: {} },
    { id: "cross-session-inbound", status: "ok", message: "Delivered.", advice: null, detail: {} },
  ],
};

describe("T-502 health formatting", () => {
  it("names the inspected directory and one line per check", () => {
    const md = formatHealthResult(result);
    expect(md).toContain("settings inspected for /repo/app");
    expect(md).toContain("[ok] usage-window: Fine.");
    expect(md).toContain("[advise] cli-version: storybloq 1.14.0 is installed; 1.15.0 is published.");
    expect(md).toContain("    fix: storybloq 1.14.0 is installed; 1.15.0 is published.");
    expect(md).toContain("[skip] codex-bridge: Codex is not installed.");
    expect(md).toContain("[error] skill-version: The skill-version check failed with TypeError.");
    expect(md).toContain("Ran in 42 ms.");
  });

  it("emits a fix line only under an advise", () => {
    expect(formatHealthResult(result).match(/ {4}fix:/g)).toHaveLength(1);
  });

  it("claims a dropped check only when one was actually skipped for the budget", () => {
    const dropped: HealthResult = {
      ...result,
      budgetExhausted: true,
      checks: [
        ...result.checks.slice(0, 4),
        {
          id: "cross-session-inbound",
          status: "skip",
          message: "Skipped.",
          advice: null,
          detail: { reason: "time budget exhausted" },
        },
      ],
    };
    expect(formatHealthResult(dropped)).toContain("the time budget was exhausted, so some checks did not run");

    const lateOnly = formatHealthResult({ ...result, budgetExhausted: true });
    expect(lateOnly).toContain("over the time budget; every selected check still ran");
    expect(lateOnly).not.toContain("did not run");
  });

  it("json is the shared {version, data} envelope with the whole result under data (ISS-1223)", () => {
    const parsed = JSON.parse(healthResultJson(result));
    // Silent no-op class: the old shape spread the result at the top level, so
    // a caller unwrapping .data like every other command got nothing.
    expect(Object.keys(parsed).sort()).toEqual(["data", "version"]);
    expect(parsed.version).toBe(1);
    expect(parsed.data.checks).toHaveLength(5);
    expect(parsed.data.projectDir).toBe("/repo/app");
    expect(parsed.data.ranAt).toBe("2026-09-10T12:00:00.000Z");
    expect(parsed.data.durationMs).toBe(result.durationMs);
    expect(parsed.data.budgetExhausted).toBe(result.budgetExhausted);
  });
});
