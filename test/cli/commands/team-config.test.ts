import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleTeamConfigSet } from "../../../src/cli/commands/team-config.js";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function createProject(configOverrides: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "story-team-config-"));
  const story = join(root, ".story");
  mkdirSync(join(story, "tickets"), { recursive: true });
  mkdirSync(join(story, "issues"), { recursive: true });
  mkdirSync(join(story, "notes"), { recursive: true });
  mkdirSync(join(story, "lessons"), { recursive: true });
  writeJson(join(story, "config.json"), {
    version: 2,
    schemaVersion: 2,
    project: "test",
    type: "app",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    team: { enabled: true },
    ...configOverrides,
  });
  writeJson(join(story, "roadmap.json"), {
    title: "Test",
    date: "2026-05-26",
    phases: [],
    blockers: [],
  });
  return root;
}

describe("team config set", () => {
  it("writes through schema validation", async () => {
    const root = createProject();
    await handleTeamConfigSet(root, "requiredFeatures", "[\"merge-driver\"]", "json");
    const config = JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8"));
    expect(config.team.requiredFeatures).toEqual(["merge-driver"]);
  });

  it("rejects invalid typed values without writing them", async () => {
    const root = createProject();
    await expect(handleTeamConfigSet(root, "requiredFeatures", "\"merge-driver\"", "json")).rejects.toThrow();
    const config = JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8"));
    expect(config.team.requiredFeatures).toBeUndefined();
  });

  it("blocks writes when config has unresolved conflicts", async () => {
    const root = createProject({
      _conflicts: [{ fieldPath: "/project", kind: "field", base: "a", ours: "b", theirs: "c" }],
    });
    await expect(handleTeamConfigSet(root, "claimStalenessHours", "24", "json")).rejects.toThrow("unresolved conflicts");
  });

  // ISS-755: flipping idAllocator to git-refs must couple the
  // remote-ref-reservations capability into requiredFeatures (mirrors
  // team-init), preserving and appending to any pre-existing list.
  it("setting idAllocator to git-refs adds remote-ref-reservations to requiredFeatures (ISS-755)", async () => {
    const root = createProject({
      team: { enabled: true, requiredFeatures: ["merge-driver"] },
    });
    await handleTeamConfigSet(root, "idAllocator", "\"git-refs\"", "json");
    const config = JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8"));
    expect(config.team.idAllocator).toBe("git-refs");
    expect(config.team.requiredFeatures).toEqual(["merge-driver", "remote-ref-reservations"]);
  });

  it("setting idAllocator to git-refs is idempotent about remote-ref-reservations (ISS-755)", async () => {
    const root = createProject({
      team: { enabled: true, requiredFeatures: ["merge-driver", "remote-ref-reservations"] },
    });
    await handleTeamConfigSet(root, "idAllocator", "\"git-refs\"", "json");
    const config = JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8"));
    expect(config.team.requiredFeatures).toEqual(["merge-driver", "remote-ref-reservations"]);
  });

  it("setting idAllocator to local does not add remote-ref-reservations (ISS-755)", async () => {
    const root = createProject({
      team: { enabled: true, requiredFeatures: ["merge-driver"] },
    });
    await handleTeamConfigSet(root, "idAllocator", "\"local\"", "json");
    const config = JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8"));
    expect(config.team.requiredFeatures).toEqual(["merge-driver"]);
  });
});
