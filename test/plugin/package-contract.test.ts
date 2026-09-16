/**
 * T-509 part 1: codex-claude-bridge is bundled as an OPTIONAL dependency,
 * pinned exactly. Under optionalDependencies npm skips the package when its
 * native module fails to build and the install still succeeds; under
 * dependencies the same failure would break every install of storybloq.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf-8")) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

describe("codex-claude-bridge bundling (T-509)", () => {
  it("lives under optionalDependencies with an exact version pin", () => {
    const pin = pkg.optionalDependencies?.["codex-claude-bridge"];
    // The exact vetted release: a bump is a deliberate edit here and in RELEASE.md.
    expect(pin).toBe("1.8.0");
  });
  it("is never a hard or peer dependency", () => {
    expect(pkg.dependencies?.["codex-claude-bridge"]).toBeUndefined();
    expect(pkg.peerDependencies?.["codex-claude-bridge"]).toBeUndefined();
  });
});

/**
 * T-507 commit D: the Mods runtime ships in the npm package so
 * `storybloq setup-skill` can copy it from the installed CLI. The kit tests
 * beside the runtime files do not ship: the client would never run them and
 * they import "claude-code/testing", which the package does not carry.
 */
describe("the Mods runtime ships with the package (T-507 D)", () => {
  const files = (pkg as { files?: string[] }).files ?? [];

  it("names the plugin manifest and the hooks runtime files in `files`, and excludes the kit tests", () => {
    expect(files).toContain("plugins/storybloq/.claude-plugin/plugin.json");
    expect(files).toContain("plugins/storybloq/hooks/hooks.json");
    expect(files).toContain("plugins/storybloq/hooks/*.ts");
    expect(files).toContain("!plugins/storybloq/hooks/*.test.ts");
  });

  it("every runtime file the copy needs exists in the repository", () => {
    const hooks = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "storybloq", "hooks");
    for (const name of ["hooks.json", "mod.ts", "client-api.ts", "install.ts", "sidebar.ts", "sidebar-projection.ts"]) {
      expect(existsSync(join(hooks, name)), name).toBe(true);
    }
  });
});
