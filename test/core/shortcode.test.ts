/**
 * FORK: the shortcode -- a board's terse handle, defaulting to its directory
 * name and overridable in config.json.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHORTCODE_MAX_LENGTH,
  deriveShortcodeFromDir,
  isValidShortcode,
  resolveShortcode,
  shortcodeRefusal,
  slugifyShortcode,
} from "../../src/core/shortcode.js";
import { ConfigSchema } from "../../src/models/config.js";
import { handleShortcodeGet, handleShortcodeSet, handleShortcodeClear } from "../../src/cli/commands/shortcode.js";

const REAL_CONFIG = {
  version: 2,
  schemaVersion: 2,
  project: "p",
  type: "npm",
  language: "unknown",
  features: { handovers: true, issues: true, reviews: true, roadmap: true, tickets: true },
};

function scratch(name: string): string {
  const parent = mkdtempSync(join(tmpdir(), "shortcode-"));
  const dir = join(parent, name);
  mkdirSync(join(dir, ".story"), { recursive: true });
  writeFileSync(
    join(dir, ".story", "config.json"),
    JSON.stringify({ ...REAL_CONFIG, project: name }, null, 2) + "\n",
  );
  // The write path takes the project lock, which needs a real board under it.
  writeFileSync(
    join(dir, ".story", "roadmap.json"),
    JSON.stringify(
      {
        title: name,
        date: "2026-01-01",
        blockers: [],
        phases: [{ id: "p0", label: "PHASE 0", name: "Setup", description: "Initial project setup." }],
      },
      null,
      2,
    ) + "\n",
  );
  for (const sub of ["tickets", "issues", "handovers", "lessons", "notes"]) {
    mkdirSync(join(dir, ".story", sub), { recursive: true });
  }
  return dir;
}

function readConfig(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8")) as Record<string, unknown>;
}

describe("shortcode validation", () => {
  it("accepts lowercase slugs", () => {
    for (const ok of ["bia-crm", "backinaction", "dawn-custom", "app2", "a1", "x-y-z"]) {
      expect(shortcodeRefusal(ok), ok).toBeNull();
      expect(isValidShortcode(ok), ok).toBe(true);
    }
  });

  it("refuses uppercase, underscores, edge hyphens, and out-of-range lengths", () => {
    for (const bad of ["BIA", "bia_crm", "-bia", "bia-", "a", "", "bia crm", "bia.crm", "b".repeat(33)]) {
      expect(shortcodeRefusal(bad), bad).not.toBeNull();
      expect(isValidShortcode(bad), bad).toBe(false);
    }
  });

  it("names uppercase specifically, since that is the likely mistake", () => {
    expect(shortcodeRefusal("BIA-CRM")).toMatch(/lowercase/);
  });

  it("refuses surrounding whitespace rather than silently trimming it", () => {
    // Trimming would make `set " bia"` and `set "bia"` the same command while
    // the config file recorded different bytes.
    expect(shortcodeRefusal(" bia")).toMatch(/whitespace/);
    expect(shortcodeRefusal("bia ")).toMatch(/whitespace/);
  });

  it("accepts exactly the boundary lengths", () => {
    expect(shortcodeRefusal("ab")).toBeNull();
    expect(shortcodeRefusal("b".repeat(SHORTCODE_MAX_LENGTH))).toBeNull();
    expect(shortcodeRefusal("b".repeat(SHORTCODE_MAX_LENGTH + 1))).not.toBeNull();
  });
});

describe("slugifyShortcode", () => {
  it("slugifies the shapes a real directory name takes", () => {
    expect(slugifyShortcode("My Cool Bloq")).toBe("my-cool-bloq");
    expect(slugifyShortcode("Back In Action")).toBe("back-in-action");
    expect(slugifyShortcode("bia_reports")).toBe("bia-reports");
    expect(slugifyShortcode("__weird__name__")).toBe("weird-name");
  });

  it("strips accents rather than dropping the letter", () => {
    expect(slugifyShortcode("café-app")).toBe("cafe-app");
  });

  it("returns null when nothing usable survives", () => {
    expect(slugifyShortcode("!!!")).toBeNull();
    expect(slugifyShortcode("a")).toBeNull();
    expect(slugifyShortcode("")).toBeNull();
  });

  it("never emits a trailing hyphen after the length cut", () => {
    const long = `${"a".repeat(SHORTCODE_MAX_LENGTH)}-tail`;
    const slug = slugifyShortcode(long)!;
    expect(slug.endsWith("-")).toBe(false);
    expect(isValidShortcode(slug)).toBe(true);
  });

  it("produces something the validator accepts, for every input it accepts", () => {
    for (const input of ["My Cool Bloq", "bia_reports", "café-app", "A--B", "2026 plans"]) {
      const slug = slugifyShortcode(input);
      if (slug !== null) expect(isValidShortcode(slug), `${input} -> ${slug}`).toBe(true);
    }
  });
});

describe("resolveShortcode", () => {
  it("derives from the directory when no override is stored", () => {
    const root = scratch("bia-crm");
    expect(resolveShortcode(root, {})).toEqual({ shortcode: "bia-crm", source: "directory" });
  });

  it("slugifies a directory name that is not already a slug", () => {
    const root = scratch("My Cool Bloq");
    expect(resolveShortcode(root, {})).toEqual({ shortcode: "my-cool-bloq", source: "directory" });
  });

  it("prefers a valid override", () => {
    const root = scratch("ugly-dir-name");
    expect(resolveShortcode(root, { shortcode: "bia" })).toEqual({ shortcode: "bia", source: "config" });
  });

  it("FAILS OPEN to the directory when the override is invalid", () => {
    // The whole reason the schema declares a bare string: a bad character must
    // not be able to brick a board that still has to open.
    const root = scratch("bia-crm");
    expect(resolveShortcode(root, { shortcode: "BAD!" })).toEqual({
      shortcode: "bia-crm",
      source: "directory",
    });
  });

  it("fails open for a non-string override too", () => {
    const root = scratch("bia-crm");
    for (const junk of [42, true, null, {}, []]) {
      expect(resolveShortcode(root, { shortcode: junk })).toEqual({
        shortcode: "bia-crm",
        source: "directory",
      });
    }
  });

  it("returns null when the directory yields nothing and no override is set", () => {
    const root = scratch("x");
    expect(resolveShortcode(root, {})).toBeNull();
    // ...but an override still wins in that same directory.
    expect(resolveShortcode(root, { shortcode: "bia" })?.shortcode).toBe("bia");
  });

  it("agrees with deriveShortcodeFromDir on the directory half", () => {
    const root = scratch("bia-reports");
    expect(resolveShortcode(root, {})?.shortcode).toBe(deriveShortcodeFromDir(root));
  });
});

describe("ConfigSchema shortcode field", () => {
  const base = REAL_CONFIG;

  it("accepts a config with no shortcode (every pre-feature board)", () => {
    expect(ConfigSchema.safeParse(base).success).toBe(true);
  });

  it("carries a valid shortcode through parse rather than stripping it", () => {
    const parsed = ConfigSchema.parse({ ...base, shortcode: "bia-crm" }) as { shortcode?: string };
    expect(parsed.shortcode).toBe("bia-crm");
  });

  it("does NOT throw on a malformed shortcode -- parse must never brick a load", () => {
    // project-loader calls .parse, not .safeParse. A regex here would make this
    // throw and take every command with it.
    expect(() => ConfigSchema.parse({ ...base, shortcode: "BAD!" })).not.toThrow();
  });

  it("does NOT throw on a NON-STRING shortcode either (regression)", () => {
    // This shipped broken: the field was declared `z.string().optional()`,
    // which passes a malformed STRING through and throws on everything else.
    // `"shortcode": 42` made every command on that board fail with
    // `Validation failed for .story/config.json: Expected string, received
    // number`. The field is `z.unknown()` now and the reader does the checking.
    for (const junk of [42, true, null, {}, []]) {
      expect(
        () => ConfigSchema.parse({ ...base, shortcode: junk }),
        JSON.stringify(junk),
      ).not.toThrow();
    }
  });
});

describe("shortcode get/set/clear", () => {
  it("get reports the derived default and the directory source", async () => {
    const root = scratch("bia-crm");
    const json = JSON.parse(handleShortcodeGet(root, readConfig(root), "json").output) as {
      data: { shortcode: string; source: string; configured: string | null; derived: string };
    };
    expect(json.data).toEqual({
      shortcode: "bia-crm",
      source: "directory",
      configured: null,
      derived: "bia-crm",
    });
  });

  it("set records the override and get reports it as config-sourced", async () => {
    const root = scratch("ugly");
    await handleShortcodeSet(root, "bia", "md");
    expect(readConfig(root).shortcode).toBe("bia");
    const json = JSON.parse(handleShortcodeGet(root, readConfig(root), "json").output) as {
      data: { shortcode: string; source: string; derived: string };
    };
    expect(json.data.shortcode).toBe("bia");
    expect(json.data.source).toBe("config");
    // The derivation is still reported, so a caller can offer "reset to this".
    expect(json.data.derived).toBe("ugly");
  });

  it("set refuses an invalid value and leaves config untouched", async () => {
    const root = scratch("bia-crm");
    await expect(handleShortcodeSet(root, "BAD!", "md")).rejects.toThrow(/lowercase/);
    expect(readConfig(root).shortcode).toBeUndefined();
  });

  it("clear removes the override and returns to the directory default", async () => {
    const root = scratch("bia-crm");
    await handleShortcodeSet(root, "other", "md");
    await handleShortcodeClear(root, "md");
    expect(readConfig(root).shortcode).toBeUndefined();
    const json = JSON.parse(handleShortcodeGet(root, readConfig(root), "json").output) as {
      data: { shortcode: string; source: string };
    };
    expect(json.data).toMatchObject({ shortcode: "bia-crm", source: "directory" });
  });

  it("clear on a board that never had an override is a no-op, not an error", async () => {
    const root = scratch("bia-crm");
    await handleShortcodeClear(root, "md");
    expect(readConfig(root).shortcode).toBeUndefined();
  });

  it("preserves every other config key across a set and a clear", async () => {
    const root = scratch("bia-crm");
    const configPath = join(root, ".story", "config.json");
    const before = readConfig(root);
    // An unknown top-level key stands in for anything the schema does not name.
    writeFileSync(configPath, JSON.stringify({ ...before, somethingCustom: { keep: true } }, null, 2) + "\n");

    await handleShortcodeSet(root, "bia", "md");
    expect(readConfig(root).somethingCustom).toEqual({ keep: true });
    await handleShortcodeClear(root, "md");
    const after = readConfig(root);
    expect(after.somethingCustom).toEqual({ keep: true });
    expect(after.project).toBe(before.project);
    expect(after.features).toEqual(before.features);
  });

  it("get surfaces an ignored override instead of hiding it", () => {
    const root = scratch("bia-crm");
    const md = handleShortcodeGet(root, { ...readConfig(root), shortcode: "BAD!" }, "md").output;
    expect(md).toContain("bia-crm");
    expect(md).toMatch(/ignored/);
  });
});
