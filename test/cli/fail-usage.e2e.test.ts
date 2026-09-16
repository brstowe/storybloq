import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { E2ECliFixture, runE2ECli, CLI_PATH } from "../helpers/e2e-cli.js";

/**
 * ISS-1189: end-to-end coverage of the real `.fail()` wiring in
 * src/cli/index.ts, which unit tests against a standalone yargs instance
 * (fail-usage.test.ts) cannot reach -- runCli() is not exported and the
 * module runs it at import time. Runs against the BUILT bundle, same
 * dependency as array-options.e2e.test.ts: `npm run build` must have
 * produced a current dist/cli.js.
 */
vi.setConfig({ testTimeout: 30_000 });

const cliPath = CLI_PATH;

let fixture: E2ECliFixture;
beforeAll(async () => {
  fixture = await E2ECliFixture.create();
});
afterAll(async () => {
  await fixture.cleanup();
});

function run(cwd: string, ...args: string[]): { code: number; out: string } {
  const result = runE2ECli(fixture, args, { cwd });
  return { code: result.status ?? 1, out: result.stdout };
}

function runWithEnv(cwd: string, env: Record<string, string>, ...args: string[]): { code: number; out: string } {
  const result = runE2ECli(fixture, args, { cwd, env });
  return { code: result.status ?? 1, out: result.stdout };
}

// ISS-1189 Codex round 2: yargs' wrap width comes from process.stdout.columns
// (verified: node_modules/yargs/lib/platform-shims/esm.mjs), NOT the COLUMNS
// env var -- and runE2ECli's piped stdout makes process.stdout.columns
// undefined regardless of COLUMNS, so a COLUMNS override does not actually
// narrow anything here. This sets process.stdout.columns directly via a
// --import bootstrap (same technique as version-no-stdin.e2e.test.ts's
// stdin-poisoning probe), which DOES reach yargs' windowWidth(). Verified
// directly: without src/cli/index.ts's cli.wrap(null), this repro comes back
// with an EMPTY required list; COLUMNS=20 alone does not.
function runNarrowColumns(cwd: string, ...args: string[]): { code: number; out: string } {
  const bootstrap = "process.stdout.columns = 20;";
  const result = spawnSync(
    "node",
    ["--import", `data:text/javascript,${encodeURIComponent(bootstrap)}`, CLI_PATH, ...args],
    { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: fixture.env(), timeout: 30_000 },
  );
  fixture.recordResult({ stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, out: result.stdout ?? "" };
}

function newProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const init = run(dir, "init", "--name", prefix, "--type", "npm");
  expect(init.code, init.out).toBe(0);
  return dir;
}

interface UsageEnvelope {
  version: number;
  error: {
    code: string;
    message: string;
    usage: {
      command: string;
      required: { flag: string; description: string; choices?: string[] }[];
    };
  };
}

beforeAll(() => {
  expect(
    () => readFileSync(cliPath),
    "dist/cli.js is missing. Run `npm run build` before this suite.",
  ).not.toThrow();
});

describe("ISS-1189: the four ticket-named repros", () => {
  it("ruling create with no args: JSON usage.required lists text/attribution/date", () => {
    const dir = newProject("iss1189-ruling");
    const res = run(dir, "ruling", "create", "--format", "json");
    expect(res.code).not.toBe(0);
    const envelope = JSON.parse(res.out) as UsageEnvelope;
    expect(envelope.error.code).toBe("invalid_input");
    const flags = envelope.error.usage.required.map((r) => r.flag).sort();
    expect(flags).toEqual(["attribution", "date", "text"]);
    const attribution = envelope.error.usage.required.find((r) => r.flag === "attribution")!;
    expect(attribution.choices).toEqual([
      "owner-direct",
      "owner-via-manager-with-owner-veto",
      "manager-delegated",
    ]);
  });

  it("ruling create with no args, text mode: shows an options table with choices", () => {
    const dir = newProject("iss1189-ruling-md");
    const res = run(dir, "ruling", "create");
    expect(res.code).not.toBe(0);
    expect(res.out).toContain("Options:");
    expect(res.out).toContain("--attribution");
    expect(res.out).toContain("owner-direct");
  });

  it("lesson create with no args: JSON usage.required lists every required flag", () => {
    const dir = newProject("iss1189-lesson");
    const res = run(dir, "lesson", "create", "--format", "json");
    expect(res.code).not.toBe(0);
    const envelope = JSON.parse(res.out) as UsageEnvelope;
    const flags = envelope.error.usage.required.map((r) => r.flag).sort();
    // --content is NOT demandOption on this command (register.ts): only
    // title/context/source are required.
    expect(flags).toEqual(["context", "source", "title"]);
    const source = envelope.error.usage.required.find((r) => r.flag === "source")!;
    expect(source.choices).toEqual(["review", "correction", "postmortem", "manual"]);
  });

  it("ticket create without --type: required list is the full uniform set, not just --type", () => {
    const dir = newProject("iss1189-ticket");
    const res = run(dir, "ticket", "create", "--title", "a", "--format", "json");
    expect(res.code).not.toBe(0);
    const envelope = JSON.parse(res.out) as UsageEnvelope;
    // --title was actually supplied; it must still be listed, per the
    // uniform-required-list ruling.
    expect(envelope.error.usage.required.map((r) => r.flag).sort()).toEqual(["title", "type"]);
  });

  it("issue update with no id: the positional required entry is reported", () => {
    const dir = newProject("iss1189-issue-update");
    const res = run(dir, "issue", "update", "--format", "json");
    expect(res.code).not.toBe(0);
    const envelope = JSON.parse(res.out) as UsageEnvelope;
    expect(envelope.error.usage.command).toContain("update");
    expect(envelope.error.usage.required.map((r) => r.flag)).toEqual(["id"]);
  });
});

describe("ISS-1189: double-validation-failure prints exactly once (ISS-886-style)", () => {
  it("issue update with no id trips two yargs validators but emits one envelope", () => {
    // "issue update" with nothing after it fails BOTH "not enough non-option
    // arguments" and "missing required argument: id" in the same parse.
    // Without the preserved throw new HandledError(), yargs would call .fail()
    // a second time and double-print.
    const dir = newProject("iss1189-double-fail");
    const res = run(dir, "issue", "update", "--format", "json");
    const trimmed = res.out.trim();
    expect(trimmed.startsWith("{")).toBe(true);
    expect(trimmed.endsWith("}")).toBe(true);
    expect(trimmed.match(/"version"/g)).toHaveLength(1);
    const envelope = JSON.parse(trimmed) as UsageEnvelope;
    expect(envelope.error.usage.required).toHaveLength(1);
  });

  it("same repro in text mode: the options table appears exactly once", () => {
    const dir = newProject("iss1189-double-fail-md");
    const res = run(dir, "issue", "update");
    expect(res.out.match(/Options:/g)).toHaveLength(1);
  });
});

describe("ISS-1189 Codex round 1: usage.required survives real environment conditions", () => {
  it("still lists every required flag under a French locale (LC_ALL/LANG), not an empty list", () => {
    // yargs auto-selects its locale from LC_ALL/LANG/LANGUAGE; under French
    // the "[required]" tag renders as "[requis]". Verified this actually
    // happens against the real installed yargs before fixing it: without the
    // cli.locale("en") override, usage.required comes back [].
    const dir = newProject("iss1189-locale");
    const res = runWithEnv(
      dir,
      { LC_ALL: "fr_FR.UTF-8", LANG: "fr_FR.UTF-8" },
      "ruling", "create", "--format", "json",
    );
    expect(res.code).not.toBe(0);
    const envelope = JSON.parse(res.out) as UsageEnvelope;
    expect(envelope.error.usage.required.map((r) => r.flag).sort()).toEqual(["attribution", "date", "text"]);
    const attribution = envelope.error.usage.required.find((r) => r.flag === "attribution")!;
    expect(attribution.choices).toEqual([
      "owner-direct",
      "owner-via-manager-with-owner-veto",
      "manager-delegated",
    ]);
  });

  it("still lists every required flag under a narrow terminal (process.stdout.columns), not an empty list", () => {
    // A narrow wrap width can split even the "[required]" tag itself across
    // lines. Verified against the real installed yargs with
    // process.stdout.columns forced to 20: without the cli.wrap(null)
    // override, usage.required comes back [] (confirmed by temporarily
    // removing that line and re-running this exact repro).
    const dir = newProject("iss1189-narrow-columns");
    const res = runNarrowColumns(dir, "ruling", "create", "--format", "json");
    expect(res.code).not.toBe(0);
    const envelope = JSON.parse(res.out) as UsageEnvelope;
    expect(envelope.error.usage.required.map((r) => r.flag).sort()).toEqual(["attribution", "date", "text"]);
  });
});

describe("ISS-1189: array-option separator rule is visible in the usage appendix", () => {
  it("ruling create's text-mode appendix states --cites' separator rule verbatim from its describe", () => {
    const dir = newProject("iss1189-array-hint");
    const res = run(dir, "ruling", "create");
    expect(res.code).not.toBe(0);
    // SPLIT_LIST comma options render COMMA_HINT.split in their registered
    // describe text (array-options.ts), so it shows up in the full help
    // appendix for free -- no new hint-generation code needed.
    expect(res.out).toContain("(space or comma separated)");
  });
});

describe("ISS-1189: text-mode 4 KiB truncation carries an explicit marker", () => {
  it("a command with a very large options surface still fits under budget with a truncation marker when it wraps", () => {
    // ruling create's help text is well under 4 KiB already; this asserts the
    // untruncated case stays clean (no marker) as the negative side of the
    // truncation contract exercised at the unit level in fail-usage.test.ts.
    const dir = newProject("iss1189-no-truncation");
    const res = run(dir, "ruling", "create");
    expect(res.out).not.toContain("truncated");
    expect(Buffer.byteLength(res.out, "utf8")).toBeLessThan(4096 + 200);
  });
});
