import { describe, it, expect, vi } from "vitest";
import * as pushModule from "../../../src/core/session-intel/push.js";
import * as samplerModule from "../../../src/core/session-intel/sampler.js";
import { checkUsageWindow } from "../../../src/core/health/usage-window.js";
import { ctxFor, stubDeps, PROJECT } from "./stub-deps.js";
import type { AutoCompactWindowDiagnostic } from "../../../src/core/claude-settings.js";

function layers(spec: Array<["user" | "project" | "local", "absent" | "ok" | "indeterminate", number?]>): AutoCompactWindowDiagnostic {
  return {
    layers: spec.map(([source, kind, value]) => ({
      source,
      path: `/settings/${source}.json`,
      kind,
      ...(value === undefined ? {} : { value }),
    })),
  };
}

function depsFor(diag: AutoCompactWindowDiagnostic, over: Parameters<typeof stubDeps>[0] = {}) {
  return stubDeps({ settings: { autoCompactWindow: () => diag }, ...over });
}

describe("T-502 usage-window check", () => {
  it("delegates to usageAdvisoryFrom with the highest ok layer", async () => {
    const spy = vi.spyOn(samplerModule, "usageAdvisoryFrom");
    const diag = layers([["user", "ok", 1_000_000], ["project", "absent"], ["local", "ok", 200_000]]);
    const check = await checkUsageWindow(ctxFor(), depsFor(diag));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toEqual({ window: 200_000, source: "local" });
    expect(check.status).toBe("ok");
    spy.mockRestore();
  });

  it("advises with T-501's rendered wording for an oversized window", async () => {
    const diag = layers([["user", "ok", 1_000_000], ["project", "absent"], ["local", "absent"]]);
    const check = await checkUsageWindow(ctxFor(), depsFor(diag));
    expect(check.status).toBe("advise");
    expect(check.message).toContain("Your Claude Code auto-compact window is 1,000,000 tokens, set in ~/.claude/settings.json.");
    expect(check.advice).toBe(check.message);
    expect(check.detail).toMatchObject({ window: 1_000_000, source: "user", projectDir: PROJECT });
  });

  // Mutant (f) at this seam: treating an indeterminate layer as absent reddens this.
  it("skips when a layer ABOVE the winner is unreadable, and never evaluates the rule", async () => {
    const spy = vi.spyOn(samplerModule, "usageAdvisoryFrom");
    const diag = layers([["user", "ok", 1_000_000], ["project", "absent"], ["local", "indeterminate"]]);
    const check = await checkUsageWindow(ctxFor(), depsFor(diag));
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe("unreadable: /settings/local.json");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("skips when no layer is ok and any layer is unreadable", async () => {
    const diag = layers([["user", "indeterminate"], ["project", "absent"], ["local", "absent"]]);
    const check = await checkUsageWindow(ctxFor(), depsFor(diag));
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe("unreadable: /settings/user.json");
  });

  it("evaluates from the winner when the unreadable layer sits BELOW it", async () => {
    const diag = layers([["user", "indeterminate"], ["project", "absent"], ["local", "ok", 1_000_000]]);
    const check = await checkUsageWindow(ctxFor(), depsFor(diag));
    expect(check.status).toBe("advise");
    expect(check.detail.source).toBe("local");
  });

  it("evaluates the 1M-model case from the caller sample when no window is set", async () => {
    const diag = layers([["user", "absent"], ["project", "absent"], ["local", "absent"]]);
    const check = await checkUsageWindow(ctxFor(), depsFor(diag, { callerSample: () => ({ oneMillionFlag: true }) }));
    expect(check.status).toBe("advise");
    expect(check.message).toContain("This session runs a 1M-context model");
    expect(check.detail.oneMillionFlag).toBe(true);
  });

  it("is ok with no window and no caller sample", async () => {
    const diag = layers([["user", "absent"], ["project", "absent"], ["local", "absent"]]);
    const check = await checkUsageWindow(ctxFor(), depsFor(diag));
    expect(check.status).toBe("ok");
    expect(check.message).toBe("Storybloq did not observe an autoCompactWindow setting, and this session did not report a 1M-context model.");
  });

  // Mutant (d): letting the check consume the once-per-session stamp reddens this.
  it("never consumes T-501's once-per-session usage stamp", async () => {
    const usageAdvisoryFor = vi.spyOn(pushModule, "usageAdvisoryFor");
    const statusPushesFor = vi.spyOn(pushModule, "statusPushesFor");
    const diag = layers([["user", "ok", 1_000_000], ["project", "absent"], ["local", "absent"]]);
    await checkUsageWindow(ctxFor(), depsFor(diag));
    expect(usageAdvisoryFor).not.toHaveBeenCalled();
    expect(statusPushesFor).not.toHaveBeenCalled();
    usageAdvisoryFor.mockRestore();
    statusPushesFor.mockRestore();
  });

  it("caps the caller sample at 150 ms and skips it when the budget is gone", async () => {
    const sample = vi.fn(() => ({ oneMillionFlag: null }));
    const diag = layers([["user", "ok", 200_000], ["project", "absent"], ["local", "absent"]]);
    await checkUsageWindow(ctxFor({ deadline: 90_000 }), depsFor(diag, { now: () => 1_000, callerSample: sample }));
    expect(sample.mock.calls[0]![0]).toBe(150);

    const sample2 = vi.fn(() => ({ oneMillionFlag: null }));
    await checkUsageWindow(ctxFor({ deadline: 1_000 }), depsFor(diag, { now: () => 1_000, callerSample: sample2 }));
    expect(sample2).not.toHaveBeenCalled();
  });

  it("reports ok when recommendedWindowMax is 0", async () => {
    const diag = layers([["user", "ok", 1_000_000], ["project", "absent"], ["local", "absent"]]);
    const check = await checkUsageWindow(ctxFor(), depsFor(diag, { sessionIntel: { recommendedWindowMax: 0 } }));
    expect(check.status).toBe("ok");
    expect(check.message).toContain("switched off by sessionIntel.recommendedWindowMax = 0");
  });

  it("skips under the Codex client", async () => {
    const check = await checkUsageWindow(ctxFor({ client: "codex" }), stubDeps());
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe("not applicable to Codex");
  });
});
