import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { teamInit } from "../../src/core/team-init.js";
import { STORY_GITIGNORE_ENTRIES } from "../../src/core/init.js";

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "team-init-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

function writeConfig(root: string, config: Record<string, unknown>): void {
  const storyDir = join(root, ".story");
  mkdirSync(storyDir, { recursive: true });
  for (const dir of ["tickets", "issues", "handovers", "notes", "lessons"]) {
    mkdirSync(join(storyDir, dir), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf-8");
  writeFileSync(
    join(storyDir, "roadmap.json"),
    JSON.stringify({
      title: "test",
      date: "2026-01-01",
      phases: [{ id: "p0", label: "PHASE 0", name: "Setup", description: "Setup." }],
      blockers: [],
    }, null, 2) + "\n",
    "utf-8",
  );
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    project: "test",
    type: "npm",
    language: "ts",
    features: {
      tickets: true,
      issues: true,
      handovers: true,
      roadmap: true,
      reviews: true,
    },
    ...overrides,
  };
}

function readConfig(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8"));
}

describe("T-366: team-init", () => {
  // ISS-751: team-init must stamp schemaVersion 3, not 2. Published 1.4.4 clients
  // accept 2 silently (partial reads); they hard-fail on 3 for both reads and
  // writes, which is the whole point of the old-client fence.
  it("sets schemaVersion to 3 (ISS-751 old-client fence)", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig());
    const result = await teamInit(root, {});
    const config = readConfig(root);
    expect(config.schemaVersion).toBe(3);
    expect(result.schemaVersionSet).toBe(true);
  });

  it("upgrades an existing schemaVersion-2 team repo to 3 and reports schemaVersionSet (ISS-751)", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig({ schemaVersion: 2, team: { enabled: true } }));
    // Deliberate: re-running team init on a pre-fence (schemaVersion 2) team repo
    // is the 2 -> 3 migration path, so schemaVersionSet MUST report true here.
    const result = await teamInit(root, {});
    expect(result.schemaVersionSet).toBe(true);
    expect(readConfig(root).schemaVersion).toBe(3);
  });

  it("idempotent at 3: second run reports schemaVersionSet false and keeps 3 (ISS-751)", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig());
    await teamInit(root, {});
    const second = await teamInit(root, {});
    expect(second.schemaVersionSet).toBe(false);
    expect(readConfig(root).schemaVersion).toBe(3);
  });

  it("sets team defaults", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig());
    await teamInit(root, {});
    const config = readConfig(root);
    const team = config.team as Record<string, unknown>;
    expect(team).toBeDefined();
    expect(team.claimStalenessHours).toBe(48);
    expect(team.idAllocator).toBe("local");
  });

  it("preserves existing config fields", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig({
      customField: "preserved",
      recipe: "coding",
    }));
    await teamInit(root, {});
    const config = readConfig(root);
    expect(config.customField).toBe("preserved");
    expect(config.recipe).toBe("coding");
    expect(config.project).toBe("test");
  });

  it("preserves existing team fields", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig({
      team: { minCliVersion: "2.0.0", idAllocator: "git-refs" },
    }));
    await teamInit(root, {});
    const config = readConfig(root);
    const team = config.team as Record<string, unknown>;
    expect(team.minCliVersion).toBe("2.0.0");
    expect(team.idAllocator).toBe("git-refs");
  });

  it("installs merge driver", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig());
    await teamInit(root, {});
    const driver = execFileSync("git", ["config", "--local", "--get", "merge.storybloq-json.driver"], { cwd: root, encoding: "utf-8" }).trim();
    expect(driver).toBe("storybloq merge-driver %O %A %B %P");
  });

  it("writes gitattributes", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig());
    await teamInit(root, {});
    const attrs = readFileSync(join(root, ".story", ".gitattributes"), "utf-8");
    expect(attrs).toContain("tickets/*.json merge=storybloq-json");
  });

  // ISS-754: a legacy project upgraded to team mode must get the ephemeral
  // gitignore, or sessions/, snapshots/, status.json (absolute paths incl.
  // the username) become committed to the shared team repo.
  it("ensures .story/.gitignore with every ephemeral entry on a legacy project (ISS-754)", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig());
    expect(existsSync(join(root, ".story", ".gitignore"))).toBe(false);
    await teamInit(root, {});
    const content = readFileSync(join(root, ".story", ".gitignore"), "utf-8");
    for (const entry of STORY_GITIGNORE_ENTRIES) {
      expect(content).toContain(entry);
    }
  });

  it("preserves custom .gitignore lines and appends only missing entries (ISS-754)", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig());
    // Exact-entry fixtures: matching is trimmed-line equality, so use the
    // canonical forms for the already-present subset.
    writeFileSync(
      join(root, ".story", ".gitignore"),
      "my-custom-dir/\nsnapshots/\nstatus.json\nsessions/\n",
      "utf-8",
    );
    await teamInit(root, {});
    const content = readFileSync(join(root, ".story", ".gitignore"), "utf-8");
    expect(content).toContain("my-custom-dir/");
    expect(content.match(/^snapshots\/$/gm)).toHaveLength(1);
    expect(content).toContain("federation-cache.json");
    expect(content).toContain("channel-inbox/");
  });

  it("writes the running CLI version as minCliVersion (ISS-748)", async () => {
    vi.stubEnv("STORYBLOQ_VERSION", "7.7.7");
    try {
      const root = createTempGitRepo();
      writeConfig(root, baseConfig());
      await teamInit(root, {});
      const team = readConfig(root).team as Record<string, unknown>;
      // ISS-748: the broken relative require read the workspace-root manifest and
      // wrote its version; the value must come from the CLI's own version instead.
      expect(team.minCliVersion).toBe("7.7.7");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails if no .story/ dir", async () => {
    const root = createTempGitRepo();
    await expect(teamInit(root, {})).rejects.toThrow();
  });

  it("idempotent: second run preserves state", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig());
    await teamInit(root, {});
    const first = readConfig(root);
    await teamInit(root, {});
    const second = readConfig(root);
    expect(second.schemaVersion).toBe(first.schemaVersion);
    expect((second.team as Record<string, unknown>).claimStalenessHours)
      .toBe((first.team as Record<string, unknown>).claimStalenessHours);
  });

  it("accepts custom options", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig());
    await teamInit(root, { claimStalenessHours: 24, idAllocator: "git-refs" });
    const config = readConfig(root);
    const team = config.team as Record<string, unknown>;
    expect(team.claimStalenessHours).toBe(24);
    expect(team.idAllocator).toBe("git-refs");
  });

  // ISS-755: the git-refs allocator is only safe when every writer supports
  // remote-ref reservations, so choosing it must couple the capability into
  // requiredFeatures -- including when requiredFeatures pre-existed.
  describe("git-refs capability coupling (ISS-755)", () => {
    it("teamInit with idAllocator git-refs requires merge-driver AND remote-ref-reservations", async () => {
      const root = createTempGitRepo();
      writeConfig(root, baseConfig());
      await teamInit(root, { idAllocator: "git-refs" });
      const team = readConfig(root).team as Record<string, unknown>;
      expect(team.requiredFeatures).toContain("merge-driver");
      expect(team.requiredFeatures).toContain("remote-ref-reservations");
    });

    it("default/local allocator does NOT add remote-ref-reservations", async () => {
      const root = createTempGitRepo();
      writeConfig(root, baseConfig());
      await teamInit(root, {});
      const team = readConfig(root).team as Record<string, unknown>;
      expect(team.requiredFeatures).not.toContain("remote-ref-reservations");
    });

    it("pre-existing requiredFeatures are preserved and appended to (even though they were not undefined)", async () => {
      const root = createTempGitRepo();
      writeConfig(root, baseConfig({
        team: {
          enabled: true,
          idAllocator: "git-refs",
          requiredFeatures: ["merge-driver", "tombstones"],
        },
      }));
      await teamInit(root, {});
      const team = readConfig(root).team as Record<string, unknown>;
      expect(team.requiredFeatures).toEqual(["merge-driver", "tombstones", "remote-ref-reservations"]);
    });

    it("re-run is idempotent (no duplicate remote-ref-reservations)", async () => {
      const root = createTempGitRepo();
      writeConfig(root, baseConfig());
      await teamInit(root, { idAllocator: "git-refs" });
      await teamInit(root, {});
      const team = readConfig(root).team as Record<string, unknown>;
      const occurrences = (team.requiredFeatures as string[]).filter((f) => f === "remote-ref-reservations");
      expect(occurrences).toHaveLength(1);
    });
  });
});
