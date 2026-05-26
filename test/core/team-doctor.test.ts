import { describe, it, expect } from "vitest";
import { runDoctor, registerDoctorCheck, defaultChecks, type DoctorContext, type DoctorCheck } from "../../src/core/team-doctor.js";
import { makeTicket, makeIssue, makeState, makeRoadmap, makePhase, minimalConfig } from "./test-factories.js";
import type { Config } from "../../src/models/config.js";

const teamConfig: Config = { ...minimalConfig, schemaVersion: 2 };

function teamCtx(overrides?: Partial<DoctorContext>): DoctorContext {
  return {
    root: "/tmp/test-project",
    cliVersion: "1.0.0",
    isTeamMode: true,
    loadWarnings: [],
    ...overrides,
  };
}

function nonTeamCtx(): DoctorContext {
  return { root: "/tmp/test-project", cliVersion: "1.0.0", isTeamMode: false, loadWarnings: [] };
}

const state = (opts: Parameters<typeof makeState>[0]) =>
  makeState({ roadmap: makeRoadmap([makePhase({ id: "p1" })]), config: teamConfig, ...opts });

describe("runDoctor", () => {
  it("returns no findings for a clean team-mode project", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-001", createdDate: "2026-01-01" }),
      ],
    });
    const result = runDoctor(s, teamCtx());
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  it("returns info finding for non-team-mode project and skips team checks", () => {
    const s = makeState({});
    const result = runDoctor(s, nonTeamCtx());
    const teamFindings = result.findings.filter((f) => f.code !== "not_team_mode");
    expect(teamFindings).toHaveLength(0);
    const infoFinding = result.findings.find((f) => f.code === "not_team_mode");
    expect(infoFinding).toBeDefined();
    expect(infoFinding!.severity).toBe("info");
  });

  it("detects duplicate displayIds with reconcile repair", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-042", createdDate: "2026-01-15" }),
      ],
    });
    const result = runDoctor(s, teamCtx());
    const finding = result.findings.find((f) => f.code === "duplicate_display_id");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("error");
    expect(finding!.repair).not.toBeNull();
    if (finding!.repair && "command" in finding!.repair) {
      expect(finding!.repair.command).toContain("reconcile");
    }
  });

  it("warns on missing displayId in team mode", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", createdDate: "2026-01-01" }),
      ],
    });
    const result = runDoctor(s, teamCtx());
    const finding = result.findings.find((f) => f.code === "missing_display_id");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });

  it("warns on unresolvable blockedBy ref", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-001", blockedBy: ["T-999"], createdDate: "2026-01-01" }),
      ],
    });
    const result = runDoctor(s, teamCtx());
    const finding = result.findings.find((f) => f.code === "unresolvable_ref");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });

  it("warns when CLI version is below minCliVersion", () => {
    const configWithMin: Config = { ...teamConfig, team: { minCliVersion: "99.0.0" } };
    const s = makeState({ config: configWithMin, roadmap: makeRoadmap([makePhase({ id: "p1" })]) });
    const result = runDoctor(s, teamCtx({ cliVersion: "1.0.0" }));
    const finding = result.findings.find((f) => f.code === "cli_version_mismatch");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });

  it("accepts injected custom checks via registerDoctorCheck", () => {
    const customCheck: DoctorCheck = () => [
      { severity: "info", code: "custom_check", message: "Custom check ran", entity: null, repair: null },
    ];
    const originalLength = defaultChecks.length;
    registerDoctorCheck(customCheck);
    try {
      const s = state({ tickets: [] });
      const result = runDoctor(s, teamCtx());
      const finding = result.findings.find((f) => f.code === "custom_check");
      expect(finding).toBeDefined();
    } finally {
      defaultChecks.length = originalLength;
    }
  });

  it("correctly counts findings by severity", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-042", createdDate: "2026-01-15" }),
        makeTicket({ id: "t-ccc0000000000003", blockedBy: ["T-999"], createdDate: "2026-01-01" }),
      ],
    });
    const result = runDoctor(s, teamCtx());
    expect(result.errorCount).toBeGreaterThan(0);
    expect(result.errorCount + result.warningCount + result.infoCount).toBe(result.findings.length);
  });
});
