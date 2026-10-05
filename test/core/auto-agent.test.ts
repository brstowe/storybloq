/**
 * FORK: the per-board auto-agent switch -- a boolean, default false, a flag
 * only.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_AGENT_DEFAULT,
  parseAutoAgentValue,
  resolveAutoAgent,
} from "../../src/core/auto-agent.js";
import { ConfigSchema } from "../../src/models/config.js";
import {
  handleAutoAgentGet,
  handleAutoAgentSet,
  handleAutoAgentClear,
} from "../../src/cli/commands/auto-agent.js";

const REAL_CONFIG = {
  version: 2,
  schemaVersion: 2,
  project: "p",
  type: "npm",
  language: "unknown",
  features: { handovers: true, issues: true, reviews: true, roadmap: true, tickets: true },
};

function scratch(name = "board"): string {
  const parent = mkdtempSync(join(tmpdir(), "auto-agent-"));
  const dir = join(parent, name);
  mkdirSync(join(dir, ".story"), { recursive: true });
  writeFileSync(
    join(dir, ".story", "config.json"),
    JSON.stringify({ ...REAL_CONFIG, project: name }, null, 2) + "\n",
  );
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

describe("resolveAutoAgent", () => {
  it("defaults to false when the key is absent", () => {
    expect(AUTO_AGENT_DEFAULT).toBe(false);
    expect(resolveAutoAgent({})).toEqual({ enabled: false, source: "default" });
  });

  it("reads a real boolean and marks it config-sourced", () => {
    expect(resolveAutoAgent({ autoAgent: true })).toEqual({ enabled: true, source: "config" });
    expect(resolveAutoAgent({ autoAgent: false })).toEqual({ enabled: false, source: "config" });
  });

  it("FAILS CLOSED on anything that is not a boolean", () => {
    for (const junk of ["true", "false", 1, 0, null, {}, [], "yes"]) {
      expect(resolveAutoAgent({ autoAgent: junk }), JSON.stringify(junk)).toEqual({
        enabled: false,
        source: "default",
      });
    }
  });

  it('never lets the truthy string "false" read as enabled', () => {
    // The one direction this switch must not fail in: Boolean("false") is true,
    // so a coercing reader would turn a hand-edited "off" into "on".
    expect(resolveAutoAgent({ autoAgent: "false" }).enabled).toBe(false);
  });
});

describe("parseAutoAgentValue", () => {
  it("accepts the spellings a person or a script types", () => {
    for (const t of ["true", "TRUE", " true ", "1", "yes", "on", "enable", "enabled"]) {
      expect(parseAutoAgentValue(t), t).toBe(true);
    }
    for (const f of ["false", "FALSE", "0", "no", "off", "disable", "disabled"]) {
      expect(parseAutoAgentValue(f), f).toBe(false);
    }
  });

  it("returns null for anything else, so the caller refuses rather than guessing", () => {
    for (const bad of ["", "maybe", "2", "truthy", "o", "null"]) {
      expect(parseAutoAgentValue(bad), bad).toBeNull();
    }
  });
});

describe("ConfigSchema autoAgent field", () => {
  it("accepts a config with no autoAgent", () => {
    expect(ConfigSchema.safeParse(REAL_CONFIG).success).toBe(true);
  });

  it("carries a boolean through parse rather than stripping it", () => {
    const parsed = ConfigSchema.parse({ ...REAL_CONFIG, autoAgent: true }) as { autoAgent?: unknown };
    expect(parsed.autoAgent).toBe(true);
  });

  it("does NOT throw on a non-boolean -- parse must never brick a load", () => {
    // project-loader calls .parse, not .safeParse. z.boolean() here would make
    // `"autoAgent": "yes"` fatal to every command on that board.
    for (const junk of ["yes", 42, null, {}, []]) {
      expect(() => ConfigSchema.parse({ ...REAL_CONFIG, autoAgent: junk }), JSON.stringify(junk)).not.toThrow();
    }
  });
});

describe("auto-agent get/set/clear", () => {
  it("get reports the default on a board that has never set one", () => {
    const root = scratch();
    const json = JSON.parse(handleAutoAgentGet(readConfig(root), "json").output) as {
      data: { autoAgent: boolean; source: string; configured: unknown; default: boolean };
    };
    expect(json.data).toEqual({ autoAgent: false, source: "default", configured: null, default: false });
  });

  it("set true stores a real boolean, not a string", async () => {
    const root = scratch();
    await handleAutoAgentSet(root, "true", "md");
    expect(readConfig(root).autoAgent).toBe(true);
  });

  it("set false stores explicit false, distinguishable from absent", async () => {
    const root = scratch();
    await handleAutoAgentSet(root, "false", "md");
    expect(readConfig(root).autoAgent).toBe(false);
    const json = JSON.parse(handleAutoAgentGet(readConfig(root), "json").output) as {
      data: { autoAgent: boolean; source: string };
    };
    // Same behaviour as the default, but a different story about intent.
    expect(json.data).toMatchObject({ autoAgent: false, source: "config", configured: false });
  });

  it("clear is not the same as set false: it removes the key entirely", async () => {
    const root = scratch();
    await handleAutoAgentSet(root, "false", "md");
    expect(Object.hasOwn(readConfig(root), "autoAgent")).toBe(true);
    await handleAutoAgentClear(root, "md");
    expect(Object.hasOwn(readConfig(root), "autoAgent")).toBe(false);
    const json = JSON.parse(handleAutoAgentGet(readConfig(root), "json").output) as {
      data: { source: string };
    };
    expect(json.data.source).toBe("default");
  });

  it("set refuses an unparseable value and leaves config untouched", async () => {
    const root = scratch();
    await expect(handleAutoAgentSet(root, "maybe", "md")).rejects.toThrow(/must be a boolean/);
    expect(Object.hasOwn(readConfig(root), "autoAgent")).toBe(false);
  });

  it("clear on a board that never had a value is a no-op, not an error", async () => {
    const root = scratch();
    await handleAutoAgentClear(root, "md");
    expect(Object.hasOwn(readConfig(root), "autoAgent")).toBe(false);
  });

  it("preserves every other config key across a set and a clear", async () => {
    const root = scratch();
    const configPath = join(root, ".story", "config.json");
    const before = readConfig(root);
    writeFileSync(configPath, JSON.stringify({ ...before, somethingCustom: { keep: true } }, null, 2) + "\n");

    await handleAutoAgentSet(root, "true", "md");
    expect(readConfig(root).somethingCustom).toEqual({ keep: true });
    await handleAutoAgentClear(root, "md");
    const after = readConfig(root);
    expect(after.somethingCustom).toEqual({ keep: true });
    expect(after.project).toBe(before.project);
  });

  it("get surfaces an ignored non-boolean instead of hiding it", () => {
    const root = scratch();
    const md = handleAutoAgentGet({ ...readConfig(root), autoAgent: "yes" }, "md").output;
    expect(md).toContain("disabled");
    expect(md).toMatch(/ignored/);
  });

  it("set true then set false round-trips without leaving a stale value", async () => {
    const root = scratch();
    await handleAutoAgentSet(root, "on", "md");
    expect(readConfig(root).autoAgent).toBe(true);
    await handleAutoAgentSet(root, "off", "md");
    expect(readConfig(root).autoAgent).toBe(false);
  });
});
