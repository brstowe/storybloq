import { describe, it, expect, vi } from "vitest";
import { runHealth, HEALTH_TOTAL_BUDGET_MS, BUDGET_REASON, GLOBAL_DISABLED_REASON, PROJECT_DISABLED_REASON } from "../../../src/core/health/run.js";
import { HEALTH_CHECK_IDS } from "../../../src/core/health/types.js";
import { allChecksOn, ctxFor, stubDeps } from "./stub-deps.js";

const ids = (result: { checks: readonly { id: string }[] }) => result.checks.map((c) => c.id);

describe("T-502 runHealth", () => {
  it("runs the six checks in the fixed order", async () => {
    const result = await runHealth(ctxFor(), stubDeps());
    expect(ids(result)).toEqual([...HEALTH_CHECK_IDS]);
    expect(result.cliVersion).toBe("1.14.0");
    expect(result.client).toBe("claude");
    expect(result.projectDir).toBe(ctxFor().projectDir);
    expect(result.ranAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("isolates a throwing check and a rejecting check to their own ids", async () => {
    const deps = stubDeps({
      settings: {
        autoCompactWindow: () => {
          throw new TypeError("boom");
        },
      },
      versionCache: { read: () => null, refresh: () => Promise.reject(new RangeError("nope")) },
    });
    const result = await runHealth(ctxFor(), deps);
    const byId = new Map(result.checks.map((c) => [c.id, c]));
    expect(byId.get("usage-window")!.status).toBe("error");
    expect(byId.get("usage-window")!.message).toBe("The usage-window check failed with TypeError.");
    expect(byId.get("cli-version")!.status).toBe("error");
    expect(byId.get("cli-version")!.detail.reason).toBe("RangeError");
    for (const id of ["codex-bridge", "skill-version", "cross-session-inbound"]) {
      expect(byId.get(id)!.status).not.toBe("error");
    }
  });

  it("only filters and preserves the fixed order", async () => {
    const result = await runHealth(ctxFor(), stubDeps(), { only: ["cross-session-inbound", "cli-version"] });
    expect(ids(result)).toEqual(["cli-version", "cross-session-inbound"]);
  });

  it("an unknown or empty only list runs everything", async () => {
    const result = await runHealth(ctxFor(), stubDeps(), { only: [] });
    expect(ids(result)).toEqual([...HEALTH_CHECK_IDS]);
  });

  it("a disabled project config produces six skips that stay in the list", async () => {
    const config = { ...allChecksOn(), enabled: false };
    const result = await runHealth(ctxFor({ config }), stubDeps());
    expect(result.checks).toHaveLength(6);
    for (const check of result.checks) {
      expect(check.status).toBe("skip");
      expect(check.detail.reason).toBe(PROJECT_DISABLED_REASON);
    }
  });

  it("honours a single per-check toggle", async () => {
    const config = allChecksOn();
    const result = await runHealth(
      ctxFor({ config: { ...config, checks: { ...config.checks, "codex-bridge": false } } }),
      stubDeps(),
    );
    const bridge = result.checks.find((c) => c.id === "codex-bridge")!;
    expect(bridge.detail.reason).toBe(PROJECT_DISABLED_REASON);
    expect(result.checks.find((c) => c.id === "cli-version")!.detail.reason).not.toBe(PROJECT_DISABLED_REASON);
  });

  it("the global kill switch produces six skips with the global reason", async () => {
    const deps = stubDeps({ globalConfig: () => ({ healthCheck: { enabled: false } }) });
    const result = await runHealth(ctxFor(), deps);
    for (const check of result.checks) {
      expect(check.detail.reason).toBe(GLOBAL_DISABLED_REASON);
    }
  });

  it("the global switch outranks the project switch when both are set", async () => {
    const deps = stubDeps({ globalConfig: () => ({ healthCheck: { enabled: false } }) });
    const result = await runHealth(ctxFor({ config: { ...allChecksOn(), enabled: false } }), deps);
    expect(result.checks[0]!.detail.reason).toBe(GLOBAL_DISABLED_REASON);
  });

  it("a throwing globalConfig is treated as enabled", async () => {
    const deps = stubDeps({
      globalConfig: () => {
        throw new Error("nope");
      },
    });
    const result = await runHealth(ctxFor(), deps);
    expect(result.checks[0]!.detail.reason).not.toBe(GLOBAL_DISABLED_REASON);
  });

  it("skips the checks whose turn begins after the deadline and reports budgetExhausted", async () => {
    // The clock is advanced INSIDE the third check (codex-bridge's probe), so
    // checks four and five find the deadline already gone.
    let clock = 1_000;
    const deps = stubDeps({
      now: () => clock,
      run: () => {
        clock = 9_999;
        return { kind: "enoent" };
      },
    });
    const result = await runHealth(ctxFor({ deadline: 5_000 }), deps);
    const skipped = result.checks.filter((c) => c.detail.reason === BUDGET_REASON);
    expect(skipped.map((c) => c.id)).toEqual(["skill-version", "cross-session-inbound", "hook-duplicates"]);
    expect(skipped[0]!.message).toBe("Skipped: the 5 second health budget was exhausted before this check ran.");
    expect(result.budgetExhausted).toBe(true);
  });

  it("reports budgetExhausted with no skips when only the last check overran", async () => {
    // The clock is advanced by the LAST check's settings read (hook-duplicates;
    // cross-session-inbound, the other reader, is switched off here), so every
    // check started inside the budget and only the run as a whole overran.
    let clock = 1_000;
    const deps = stubDeps({
      now: () => clock,
      readFile: () => {
        clock = 99_999;
        return { kind: "absent" };
      },
    });
    const config = allChecksOn();
    const result = await runHealth(ctxFor({ deadline: 5_000, config: { ...config, checks: { ...config.checks, "cross-session-inbound": false } } }), deps);
    expect(result.checks.some((c) => c.detail.reason === BUDGET_REASON)).toBe(false);
    expect(result.budgetExhausted).toBe(true);
    expect(result.durationMs).toBe(98_999);
  });

  it("passes only-cli-version the remaining budget as its fetch timeout", async () => {
    const refresh = vi.fn(async () => null);
    const deps = stubDeps({ now: () => 1_000, versionCache: { read: () => null, refresh } });
    await runHealth(ctxFor({ deadline: 1_300 }), deps, { only: ["cli-version"] });
    expect(refresh.mock.calls[0]![0]!.timeoutMs).toBe(300);
  });

  it("never hands a check more than its own cap", async () => {
    const refresh = vi.fn(async () => null);
    const spawn = vi.fn(() => ({ kind: "enoent" }) as const);
    const sample = vi.fn(() => null);
    const deps = stubDeps({
      now: () => 1_000,
      run: spawn,
      callerSample: sample,
      versionCache: { read: () => null, refresh },
      settings: { autoCompactWindow: () => ({ layers: [{ source: "user", path: "/u", kind: "ok", value: 200_000 }] }) },
    });
    await runHealth(ctxFor({ deadline: 1_000 + HEALTH_TOTAL_BUDGET_MS }), deps);
    expect(sample.mock.calls[0]![0]).toBeLessThanOrEqual(150);
    expect(refresh.mock.calls[0]![0]!.timeoutMs).toBeLessThanOrEqual(2000);
    expect(spawn.mock.calls[0]![2]).toBeLessThanOrEqual(2000);
  });

  it("HEALTH_TOTAL_BUDGET_MS is the agreed 5 s total", () => {
    expect(HEALTH_TOTAL_BUDGET_MS).toBe(5000);
  });
});
