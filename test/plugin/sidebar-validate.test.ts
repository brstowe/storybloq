import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CALLS, EVENTS, CLIENT_API_VERSION } from "../../plugins/storybloq/hooks/client-api.js";

/**
 * T-508: what the ledger sidebar Mod hooks and calls, read from the client
 * rather than from our own reading of our own source.
 *
 * `claude plugin validate` scans a hooks module and everything it imports and
 * prints two lists: the events it hooks and the calls it makes on `$`. That
 * printed list IS the read-only contract. A `$.fs.write` added anywhere in the
 * sidebar's graph shows up in it, which is the mutant M-FS-WRITE; so would a
 * `$.process.run` or a `$.mcp.call`, the other two ways this Mod could stop
 * being read-only.
 *
 * The scan is static and needs no session, no network and no authentication,
 * but it does need the client on PATH. Where it is absent (a CI box with no
 * Claude Code) the check cannot run and says so rather than passing quietly.
 */

const PLUGIN_DIR = join(__dirname, "..", "..", "plugins", "storybloq");

/** The six events the Mod hooks, from the pinned names in client-api.ts. */
const EXPECTED_HOOKS = [
  EVENTS.uiRender,
  EVENTS.sessionStart,
  EVENTS.turnComplete,
  EVENTS.toolCall,
  EVENTS.sessionCompact,
  EVENTS.uiClose,
];

/**
 * The calls the Mod makes, taken from the pin rather than restated here.
 *
 * `client-api.ts` is the documentary list and this is the reading the client
 * itself produces, so asserting one against the other is the whole point: a
 * call added to the Mod and not to the pin fails, and so does a pin that
 * declares a call the Mod does not make. `$.ui.close` was in that list until
 * the sidebar landed and it turned out the Mod only HOOKS `ui.close`; the
 * person closes the pane, the Mod never does.
 */
const EXPECTED_CALLS = [...CALLS.sidebar].sort();

const FORBIDDEN_CALLS = ["$.fs.write", "$.process.run", "$.mcp.call"];

function clientAvailable(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates the plugin as the client will load it, at its real path.
 *
 * It once validated a repaired COPY, because `mod.ts` was another session's
 * file and had not wired the sidebar in yet. That wiring landed with T-507, so
 * the fallback is gone: a copy that validates proves nothing about the plugin
 * the client actually loads, and the day the real wiring broke the copy would
 * still have passed.
 */
function validateOutput(): string {
  return execFileSync("claude", ["plugin", "validate", PLUGIN_DIR], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1" },
  });
}

/**
 * "a, b (via f), c" to ["a", "b", "c"]: the scan names where a call came from.
 * The label carries the module name because "Validating hooks: <path>" is also
 * a line with "hooks:" in it, and it comes first.
 */
function listAfter(output: string, label: string): string[] {
  const line = output.split("\n").find((row) => row.includes(`${label}:`));
  if (line === undefined) return [];
  const after = line.slice(line.indexOf(`${label}:`) + label.length + 1);
  // "(via readHeader, startScan)" carries a comma of its own, so the
  // parenthetical goes before the split, not after it.
  return after
    .replace(/\s*\(via[^)]*\)/g, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const available = clientAvailable();

describe("sidebar Mod contract, as the client scans it (T-508)", () => {
  if (!available) {
    it("needs the claude client on PATH to read the contract", () => {
      expect.fail(
        "claude is not on PATH, so `claude plugin validate` cannot be run and the Mod's hooks and calls are unchecked",
      );
    });
    return;
  }

  const output = validateOutput();

  it("passes the client's own validation", () => {
    expect(output).toContain("Validation passed");
  });

  it("hooks exactly the six events the design names", () => {
    expect(listAfter(output, "mod.ts hooks")).toEqual(EXPECTED_HOOKS);
  });

  it("makes exactly the calls the pinned list declares", () => {
    expect(listAfter(output, "mod.ts calls").slice().sort()).toEqual(EXPECTED_CALLS);
  });

  it("makes no call that could write, run or reach a server", () => {
    // M-FS-WRITE: add a $.fs.write anywhere in the sidebar's graph and this
    // fails, because the scan follows imports.
    const calls = listAfter(output, "mod.ts calls");
    for (const forbidden of FORBIDDEN_CALLS) {
      expect(calls, `the sidebar is read-only and must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("was read from the client version the pin names", () => {
    const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
    expect(
      version.startsWith(CLIENT_API_VERSION),
      `client-api.ts pins ${CLIENT_API_VERSION} but this machine runs ${version}; re-read the API and update the pin`,
    ).toBe(true);
  });

  it("declares the Mod on by default (T-516)", () => {
    // Owner ruling for 1.15: the dashboard ships on, so a session that loads
    // the plugin with nothing configured draws it.
    const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8")) as {
      userConfig?: { sidebar?: { default?: unknown } };
    };
    expect(manifest.userConfig?.sidebar?.default).toBe(true);
  });

  it("registers the Mod behind the option, reading an absent option as on", () => {
    // The manifest defaults the option on, and this is the other half of
    // that: the wiring still reads the option, so turning it off in
    // /plugin configure is obeyed. M-SIDEBAR-ALWAYS-ON drops the condition
    // and a user who turned the dashboard off gets it back anyway.
    const mod = readFileSync(join(PLUGIN_DIR, "hooks", "mod.ts"), "utf8");
    expect(mod).toContain('import { registerSidebar } from "./sidebar.js";');
    expect(mod).toContain('const sidebar = options["sidebar"] !== false;');
    expect(mod).toContain("if (sidebar) registerSidebar(on, options);");
    // And nowhere else: one registration, one gate.
    expect(mod.split("registerSidebar(on").length - 1).toBe(1);
  });

  it("ships the Mod's own tests beside it", () => {
    expect(existsSync(join(PLUGIN_DIR, "hooks", "sidebar.test.ts"))).toBe(true);
  });
});
