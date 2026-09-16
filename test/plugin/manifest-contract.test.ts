/**
 * ISS-834: contract tests for the Codex plugin-marketplace packaging.
 *
 * Version-sync: `plugin.json`'s version must move in lockstep with
 * `package.json`'s -- verified empirically that `marketplace.json` carries
 * no version field Codex reads, so this is a two-file check, not three
 * (probe (b), run 10).
 *
 * LICENSE/NOTICE byte-identity: PolyForm Shield's redistribution clause
 * requires both files travel with the software; the plugin directory ships
 * its own copies so it carries them even if extracted independently of the
 * rest of the repo, and this test fails loudly if a canonical-file edit
 * isn't propagated to the copy.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Plain x.y.z only: the plugin manifest must never carry a prerelease or
// build suffix that package.json does not, and `toBe(undefined)` on two
// missing fields must not read as "in sync".
const PLAIN_SEMVER = /^\d+\.\d+\.\d+$/;

describe("plugin.json version stays in sync with package.json (ISS-834)", () => {
  it("matches package.json's version exactly, and both are real plain semver strings", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8")) as { version?: unknown };
    const plugin = JSON.parse(
      readFileSync(join(pkgRoot, "plugins", "storybloq", ".codex-plugin", "plugin.json"), "utf-8"),
    ) as { version?: unknown };
    expect(typeof pkg.version).toBe("string");
    expect(typeof plugin.version).toBe("string");
    expect(pkg.version).toMatch(PLAIN_SEMVER);
    expect(plugin.version).toMatch(PLAIN_SEMVER);
    expect(plugin.version).toBe(pkg.version);
  });

  it("marketplace.json carries no version field of its own and lists exactly the storybloq plugin", () => {
    const marketplace = JSON.parse(
      readFileSync(join(pkgRoot, ".agents", "plugins", "marketplace.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(marketplace).not.toHaveProperty("version");
    const plugins = marketplace.plugins as Array<Record<string, unknown>>;
    // An empty plugins array would satisfy a for-loop of negative assertions
    // while publishing a marketplace that installs nothing: pin the shape.
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins).toHaveLength(1);
    const entry = plugins[0]!;
    expect(entry.name).toBe("storybloq");
    expect(entry).not.toHaveProperty("version");
    expect(entry.source).toEqual({ source: "local", path: "./plugins/storybloq" });
  });
});

describe("plugin LICENSE/NOTICE are byte-identical to canonical (ISS-834)", () => {
  it("LICENSE matches", () => {
    const canonical = readFileSync(join(pkgRoot, "LICENSE"));
    const copy = readFileSync(join(pkgRoot, "plugins", "storybloq", "LICENSE"));
    expect(copy.equals(canonical)).toBe(true);
  });

  it("NOTICE matches", () => {
    const canonical = readFileSync(join(pkgRoot, "NOTICE"));
    const copy = readFileSync(join(pkgRoot, "plugins", "storybloq", "NOTICE"));
    expect(copy.equals(canonical)).toBe(true);
  });
});

describe("plugin.json license matches package.json's declared license (ISS-834 R2)", () => {
  it("both declare PolyForm-Shield-1.0.0", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8")) as { license: string };
    const plugin = JSON.parse(
      readFileSync(join(pkgRoot, "plugins", "storybloq", ".codex-plugin", "plugin.json"), "utf-8"),
    ) as { license: string };
    expect(plugin.license).toBe(pkg.license);
    expect(plugin.license).toBe("PolyForm-Shield-1.0.0");
  });
});

// T-505: the same directory is also a Claude Code plugin (.claude-plugin/
// plugin.json carries the function-hooks module for the Mods). It moves in
// the same lockstep as the Codex manifest, and it must point at a hooks.json
// that names exactly one module, which is what the client admits.
describe("the Claude plugin manifest stays in lockstep and names one hooks module (T-505)", () => {
  const claudeManifest = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(pkgRoot, "plugins", "storybloq", ".claude-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;

  it("version and license match package.json", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8")) as { version: string; license: string };
    const plugin = claudeManifest();
    expect(plugin.version).toMatch(PLAIN_SEMVER);
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.license).toBe(pkg.license);
    expect(plugin.name).toBe("storybloq");
  });

  it("hooks points at hooks/hooks.json, which names exactly one module that exists", () => {
    const plugin = claudeManifest();
    expect(plugin.hooks).toBe("./hooks/hooks.json");
    const hooksJson = JSON.parse(readFileSync(join(pkgRoot, "plugins", "storybloq", "hooks", "hooks.json"), "utf-8")) as { modules?: unknown };
    expect(hooksJson.modules).toEqual(["../hooks/mod.ts"]);
    expect(existsSync(join(pkgRoot, "plugins", "storybloq", "hooks", "mod.ts"))).toBe(true);
  });

  it("every Mod option is a boolean, and the dashboard defaults to on (T-516)", () => {
    const userConfig = claudeManifest().userConfig as Record<string, { type?: unknown; default?: unknown; title?: unknown }>;
    expect(Object.keys(userConfig).sort()).toEqual(["sidebar"]);
    for (const [name, option] of Object.entries(userConfig)) {
      expect(option.type, name).toBe("boolean");
      expect(typeof option.default, name).toBe("boolean");
      expect(typeof option.title, name).toBe("string");
    }
    // T-516 owner ruling: the dashboard ships ON in 1.15, so a normal session
    // draws it with nothing configured. `default` is the only switch a client
    // that hands userConfig defaults through reads, so pin its value.
    expect(userConfig.sidebar!.default).toBe(true);
    // "experimental" came off the title in the same ruling.
    expect(String(userConfig.sidebar!.title).toLowerCase()).not.toContain("experimental");
  });
});
