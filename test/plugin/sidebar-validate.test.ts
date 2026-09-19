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

/** The eight events the Mod hooks, from the pinned names in client-api.ts. */
const EXPECTED_HOOKS = [
  EVENTS.uiRender,
  EVENTS.sessionStart,
  EVENTS.turnComplete,
  EVENTS.toolCall,
  EVENTS.sessionCompact,
  EVENTS.uiClose,
  EVENTS.configSet,
  EVENTS.promptSubmit,
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

/**
 * ISS-1241: how the installed client compares to the pin.
 *
 * The old check was `version.startsWith(CLIENT_API_VERSION)`, a string PREFIX
 * test rather than a version comparison, so every client auto-update left this
 * suite permanently red (2.1.274 pinned, machine on 2.1.277). A suite that is
 * always one-red trains everyone to read "1 failed" as normal, which is how a
 * real regression gets waved through.
 *
 * Three outcomes, and the asymmetry is the point:
 *   - OLDER installed than the pin: "fail", unconditionally. The pin claims the
 *     contract was read from an API this machine does not have, so the lists it
 *     pins may describe surface that does not exist here.
 *   - NEWER installed: "skip", because the Mod is not wrong, the pin is merely
 *     behind. `STORYBLOQ_CLIENT_API_PIN_STRICT=1` turns it back into "fail" so
 *     the release gate cannot let the pin rot.
 *   - Unparseable either side: "fail". An unreadable version is not a pass.
 *
 * Compared numerically per component, never lexicographically: 2.1.9 precedes
 * 2.1.10, and 2.2.0 follows 2.1.999. Hand-rolled rather than via `semver`,
 * which is present only TRANSITIVELY here; importing it would be an undeclared
 * dependency that disappears on any dependency update, which is a worse trade
 * than comparing three integers.
 */
export type PinVerdict = "ok" | "skip" | "fail";

export interface PinVersion {
  readonly parts: readonly number[];
  /** The `-alpha.1` of `2.1.277-alpha.1`, or "" for a plain release. */
  readonly prerelease: string;
}

export function parsePinVersion(text: string): PinVersion | null {
  // The `-` is required before a prerelease, because `claude --version` prints
  // `2.1.277 (Claude Code)`: without it every real version string would look
  // like it carried a suffix.
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(text.trim());
  if (match === null) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? "",
  };
}

export function pinVerdict(installedText: string, pinText: string, strict: boolean): PinVerdict {
  const installed = parsePinVersion(installedText);
  const pinned = parsePinVersion(pinText);
  if (installed === null || pinned === null) return "fail";
  for (let i = 0; i < 3; i += 1) {
    if (installed.parts[i]! < pinned.parts[i]!) return "fail";
    if (installed.parts[i]! > pinned.parts[i]!) return strict ? "fail" : "skip";
  }
  // Same triple. Under semver a prerelease is strictly OLDER than its release,
  // so `2.1.277-alpha` against a `2.1.277` pin is the older case and must fail;
  // treating the two as equal was a fail-OPEN in the one direction this check
  // exists to catch. Two different prereleases are not ordered here on purpose:
  // guessing at `alpha` versus `beta` would be a second way to be wrong, so an
  // unequal pair fails closed.
  if (installed.prerelease === pinned.prerelease) return "ok";
  if (installed.prerelease !== "" && pinned.prerelease === "") return "fail";
  if (installed.prerelease === "" && pinned.prerelease !== "") return strict ? "fail" : "skip";
  return "fail";
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

  it("hooks exactly the eight events the design names", () => {
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

  it("was read from the client version the pin names", (ctx) => {
    const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
    const strict = process.env.STORYBLOQ_CLIENT_API_PIN_STRICT === "1";
    const verdict = pinVerdict(version, CLIENT_API_VERSION, strict);
    if (verdict === "skip") {
      // The client moved ahead of the pin. Everything this file actually
      // protects -- the hooks list, the calls list, the forbidden calls --
      // asserted hard above regardless of version; what is unproven is only
      // that the pin was read from THIS client, so this one assertion stands
      // down rather than reporting a failure the Mod did not cause.
      console.warn(
        `client-api.ts pins ${CLIENT_API_VERSION} but this machine runs ${version}: re-read the API and update the pin. Set STORYBLOQ_CLIENT_API_PIN_STRICT=1 to make this fail (the release gate does).`,
      );
      ctx.skip();
      return;
    }
    expect(
      verdict,
      `client-api.ts pins ${CLIENT_API_VERSION} but this machine runs ${version}; re-read the API and update the pin`,
    ).toBe("ok");
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

describe("ISS-1241 client version pin verdict", () => {
  it("passes on an exact match", () => {
    expect(pinVerdict("2.1.274 (Claude Code)", "2.1.274", false)).toBe("ok");
  });

  it("FAILS when the installed client is older than the pin", () => {
    // The pin would be describing an API this machine does not have.
    expect(pinVerdict("2.1.273 (Claude Code)", "2.1.274", false)).toBe("fail");
    // Strict changes nothing here: the older case is unconditional.
    expect(pinVerdict("2.1.273 (Claude Code)", "2.1.274", true)).toBe("fail");
  });

  it("skips when the installed client is newer, and fails under strict", () => {
    expect(pinVerdict("2.1.277 (Claude Code)", "2.1.274", false)).toBe("skip");
    expect(pinVerdict("2.1.277 (Claude Code)", "2.1.274", true)).toBe("fail");
  });

  it("orders numerically, not lexicographically", () => {
    // The bug the old `startsWith` check could never catch.
    expect(pinVerdict("2.1.10", "2.1.9", false)).toBe("skip");
    expect(pinVerdict("2.1.9", "2.1.10", false)).toBe("fail");
    expect(pinVerdict("2.2.0", "2.1.999", false)).toBe("skip");
    expect(pinVerdict("2.1.999", "2.2.0", false)).toBe("fail");
    expect(pinVerdict("10.0.0", "9.9.9", false)).toBe("skip");
  });

  it("fails closed on anything it cannot parse", () => {
    expect(pinVerdict("not a version", "2.1.274", false)).toBe("fail");
    expect(pinVerdict("2.1.274", "unreleased", false)).toBe("fail");
    expect(pinVerdict("", "2.1.274", false)).toBe("fail");
  });

  it("parses the shape `claude --version` actually prints", () => {
    expect(parsePinVersion("2.1.277 (Claude Code)")).toEqual({ parts: [2, 1, 277], prerelease: "" });
    // ` (Claude Code)` must NOT read as a prerelease, or every real version
    // string on this machine would look suffixed.
    expect(parsePinVersion("2.1.277-alpha.1 (Claude Code)")).toEqual({ parts: [2, 1, 277], prerelease: "-alpha.1" });
  });

  it("treats a prerelease as OLDER than its release", () => {
    // Semver: 2.1.277-alpha precedes 2.1.277. Reading them as equal would pass
    // an older client against a release pin, which is the fail-open this whole
    // assertion exists to prevent.
    expect(pinVerdict("2.1.277-alpha (Claude Code)", "2.1.277", false)).toBe("fail");
    expect(pinVerdict("2.1.277 (Claude Code)", "2.1.277-alpha", false)).toBe("skip");
    expect(pinVerdict("2.1.277 (Claude Code)", "2.1.277-alpha", true)).toBe("fail");
    // Two different prereleases are not ordered; fail closed rather than guess.
    expect(pinVerdict("2.1.277-beta", "2.1.277-alpha", false)).toBe("fail");
    expect(pinVerdict("2.1.277-alpha", "2.1.277-alpha", false)).toBe("ok");
  });
});
