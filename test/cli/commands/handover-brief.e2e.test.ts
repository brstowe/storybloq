/**
 * T-320 commit 2, end to end through the real built CLI.
 *
 * The unit and MCP-boundary tests prove the pieces, but neither exercises the
 * actual yargs argv wiring in register.ts (`--brief`/`--priming` -> argv.brief
 * / argv.priming -> handleHandoverLatest) or the count-cap fix -- both are
 * only implicitly checked by TypeScript, not by running the real CLI. This
 * runs against the BUILT bundle, so `npm run build` must have produced a
 * current dist/cli.js.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serializeJSON } from "../../../src/core/project-loader.js";
import { E2ECliFixture, runE2ECli } from "../../helpers/e2e-cli.js";

let fixture: E2ECliFixture;
beforeAll(async () => {
  fixture = await E2ECliFixture.create();
});
afterAll(async () => {
  await fixture.cleanup();
});

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "handover-brief-e2e-"));
  const story = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeFileSync(join(story, "config.json"), serializeJSON({
    version: 2, project: "handover-brief-e2e", type: "npm", language: "ts",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(story, "roadmap.json"), serializeJSON({
    title: "handover-brief-e2e", date: "2026-01-01",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "First." }],
    blockers: [],
  }));
  return dir;
}

function writeHandover(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, ".story", "handovers", name), body);
}

describe("T-320: handover latest --brief/--priming through the built CLI", () => {
  it("--brief returns a structured digest, not the raw body", () => {
    const dir = makeProject();
    writeHandover(dir, "2026-01-01-01-a.md", "# Handover: a\n\n## Next\n- T-910: keep going\n");
    const result = runE2ECli(fixture, ["handover", "latest", "--brief", "--format", "json"], { cwd: dir });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.data.handovers[0].form).toBe("structured");
    expect(JSON.stringify(parsed.data.handovers[0].records)).toContain("T-910");
  });

  it("--priming returns the raw body verbatim for a small handover", () => {
    const dir = makeProject();
    const body = "# Handover: a\n\n## Next\n- T-911: keep going\n";
    writeHandover(dir, "2026-01-01-01-a.md", body);
    const result = runE2ECli(fixture, ["handover", "latest", "--priming", "--format", "json"], { cwd: dir });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.data.handovers[0].form).toBe("raw");
    expect(parsed.data.handovers[0].body).toBe(body);
  });

  it("neither flag: default full-body path is unchanged", () => {
    const dir = makeProject();
    writeHandover(dir, "2026-01-01-01-a.md", "# Session Notes\nHello world");
    const result = runE2ECli(fixture, ["handover", "latest"], { cwd: dir });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Hello world");
  });

  it("--count above 10 is capped to 10 for --brief (the cross-handover budget is sized for a 10-handover window)", () => {
    const dir = makeProject();
    for (let i = 0; i < 15; i++) {
      const seq = String(i + 1).padStart(2, "0");
      writeHandover(dir, `2026-01-01-${seq}-h.md`, `# Handover: h${i}\n\n## Next\n- T-${920 + i}: keep going\n`);
    }
    const result = runE2ECli(
      fixture,
      ["handover", "latest", "--count", "20", "--brief", "--format", "json"],
      { cwd: dir },
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.data.handovers.length).toBe(10);
  });

  it("--count above 10 with NEITHER flag is not capped -- the default path never had this limit", () => {
    const dir = makeProject();
    for (let i = 0; i < 15; i++) {
      const seq = String(i + 1).padStart(2, "0");
      writeHandover(dir, `2026-01-01-${seq}-h.md`, `# Handover: h${i}\n\n## Next\n- T-${940 + i}: keep going\n`);
    }
    // Default multi-handover output is markdown content joined verbatim (not
    // a single parseable JSON document), so count planted markers directly.
    const result = runE2ECli(fixture, ["handover", "latest", "--count", "20"], { cwd: dir });
    expect(result.status).toBe(0);
    const matches = result.stdout.match(/T-9(4[0-9]|5[0-4])\b/g) ?? [];
    expect(new Set(matches).size).toBe(15);
  });
});
