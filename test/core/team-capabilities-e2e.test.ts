import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ISS-748 regression suite. Runs against the BUILT bundle: `npm run build` must
// have produced a current dist/cli.js before this file can pass (same dependency
// as merge-driver-e2e.test.ts). The dist bundle must resolve its OWN baked version
// for the team minCliVersion write gate, in both a monorepo checkout and a real
// node_modules install layout, where the old relative ../../package.json resolution
// read the wrong file (workspace root) or nothing at all (installed package).

const pkgRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const cliPath = join(pkgRoot, "dist", "cli.js");
const bakedVersion = (JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
  version: string;
}).version;

function runCli(cliJs: string, cwd: string, ...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("node", [cliJs, ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function createTeamProject(minCliVersion: string): string {
  const dir = mkdtempSync(join(tmpdir(), "teamcap-e2e-"));
  const story = join(dir, ".story");
  for (const d of ["tickets", "issues", "handovers", "notes", "lessons"]) {
    mkdirSync(join(story, d), { recursive: true });
  }
  writeFileSync(
    join(story, "config.json"),
    JSON.stringify(
      {
        version: 2,
        schemaVersion: 2,
        project: "teamcap-e2e",
        type: "npm",
        language: "ts",
        features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
        team: { enabled: true, minCliVersion },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(story, "roadmap.json"),
    JSON.stringify(
      {
        title: "teamcap-e2e",
        date: "2026-01-01",
        phases: [{ id: "p0", label: "PHASE 0", name: "Setup", description: "Setup." }],
        blockers: [],
      },
      null,
      2,
    ) + "\n",
  );
  return dir;
}

describe("ISS-748: dist bundle resolves its own version for the team write gate", () => {
  it("monorepo context: write succeeds when minCliVersion equals the CLI's own version", () => {
    const dir = createTeamProject(bakedVersion);
    const r = runCli(cliPath, dir, "ticket", "create", "--title", "probe", "--type", "task");
    expect(r.out).not.toContain("Cannot verify");
    expect(r.code).toBe(0);
  });

  it("gate still fires and reports the real resolved version when below minimum", () => {
    const dir = createTeamProject("999.0.0");
    const r = runCli(cliPath, dir, "ticket", "create", "--title", "probe", "--type", "task");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("999.0.0");
    // Pins the resolved-version path: on the broken build this reported 0.0.1
    // (workspace root manifest) or "Cannot verify" instead.
    expect(r.out).toContain(`current CLI is ${bakedVersion}`);
  });

  it("real install layout (node_modules/@storybloq/storybloq/dist) resolves without ../../package.json", () => {
    const stage = mkdtempSync(join(tmpdir(), "teamcap-install-"));
    const pkgDir = join(stage, "node_modules", "@storybloq", "storybloq");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    copyFileSync(cliPath, join(pkgDir, "dist", "cli.js"));
    copyFileSync(join(pkgRoot, "package.json"), join(pkgDir, "package.json"));
    // The bundle externalizes runtime deps (zod, yargs, ...), so a real install has
    // them under the package's node_modules; borrow the workspace's. The property
    // under test is preserved: ../../package.json from dist/ is still absent.
    symlinkSync(join(pkgRoot, "node_modules"), join(pkgDir, "node_modules"), "dir");

    const dir = createTeamProject(bakedVersion);
    const r = runCli(join(pkgDir, "dist", "cli.js"), dir, "ticket", "create", "--title", "probe", "--type", "task");
    expect(r.out).not.toContain("Cannot verify");
    expect(r.code).toBe(0);
  });

  it("team doctor surfaces the real resolved version on a mismatched project", () => {
    const dir = createTeamProject("999.0.0");
    const r = runCli(cliPath, dir, "team", "doctor", "--format", "json");
    // The load-time version gate fires before runDoctor, so the doctor's own
    // cli_version_mismatch finding is unreachable in this state (filed as its own
    // issue); what MUST hold is that the dist bundle resolved its real version.
    // On the broken build this reported the workspace-root version (0.0.1) or
    // "Cannot verify" instead.
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("999.0.0");
    expect(r.out).toContain(`current CLI is ${bakedVersion}`);
  });
});

describe("ISS-753/ISS-758: CLI error paths propagate a nonzero process exit code", () => {
  it("ticket move with a nonexistent ticket exits 1", () => {
    const dir = createTeamProject(bakedVersion);
    const r = runCli(cliPath, dir, "ticket", "move", "T-999", "--after", "T-001");
    expect(r.code).toBe(1);
    expect(r.out).toContain("not found");
  });

  it("gc with a garbage --retention-days exits 1", () => {
    const dir = createTeamProject(bakedVersion);
    const r = runCli(cliPath, dir, "gc", "--retention-days", "garbage");
    expect(r.code).toBe(1);
    expect(r.out).toContain("retention-days");
  });
});
