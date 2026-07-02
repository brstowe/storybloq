import { existsSync } from "node:fs";
import { join } from "node:path";
import { teamSetup } from "./team-setup.js";
import { currentCliVersion } from "./team-capabilities.js";
import { withProjectLock, writeConfigUnlocked } from "./project-loader.js";
import { TEAM_SCHEMA_VERSION } from "./errors.js";

export interface TeamInitOptions {
  claimStalenessHours?: number;
  idAllocator?: "local" | "git-refs";
}

export interface TeamInitResult {
  schemaVersionSet: boolean;
  teamConfigured: boolean;
  mergeDriverInstalled: boolean;
  gitattributesWritten: boolean;
}

export async function teamInit(root: string, opts: TeamInitOptions): Promise<TeamInitResult> {
  const storyDir = join(root, ".story");
  if (!existsSync(storyDir)) {
    throw new Error("No .story/ directory found");
  }

  const configPath = join(storyDir, "config.json");
  if (!existsSync(configPath)) {
    throw new Error("No .story/config.json found");
  }

  const setupResult = await teamSetup(root);

  let schemaUpgraded = false;
  await withProjectLock(root, { strict: false }, async ({ state }) => {
    const config = { ...state.config, team: { ...(state.config.team ?? {}) } };

    // ISS-751: stamp the team schema version (3), not 2. Published <= 1.4.4
    // clients accept 2 (silent partial reads in mixed-version teams) but
    // hard-fail on 3 for both reads and writes, making the old-client fence
    // real. Idempotent at 3; re-running on a pre-fence schemaVersion-2 team
    // repo is the deliberate 2 -> 3 upgrade path (schemaVersionSet = true).
    const prevSchema = typeof config.schemaVersion === "number" ? config.schemaVersion : 1;
    schemaUpgraded = prevSchema < TEAM_SCHEMA_VERSION;
    if (schemaUpgraded) {
      config.schemaVersion = TEAM_SCHEMA_VERSION;
    }

    config.team.enabled = true;

    if (config.team.claimStalenessHours === undefined) {
      config.team.claimStalenessHours = opts.claimStalenessHours ?? 48;
    }
    if (config.team.idAllocator === undefined) {
      config.team.idAllocator = opts.idAllocator ?? "local";
    }
    if (config.team.requiredFeatures === undefined) {
      config.team.requiredFeatures = ["merge-driver"];
    }
    // ISS-755: the git-refs allocator is only safe when every writer supports
    // remote-ref reservations, so the capability must be fenced via
    // requiredFeatures whenever the effective allocator is git-refs.
    // DELIBERATELY different from the initialize-only-when-undefined defaults
    // above: this ensure APPLIES EVEN WHEN requiredFeatures PRE-EXISTED
    // (append if missing, idempotent). Do not "fix" it to the undefined-only
    // pattern -- an existing requiredFeatures list without the reservation
    // fence would let old clients allocate IDs locally against a git-refs
    // team and collide.
    if (
      config.team.idAllocator === "git-refs" &&
      !config.team.requiredFeatures.includes("remote-ref-reservations")
    ) {
      config.team.requiredFeatures = [...config.team.requiredFeatures, "remote-ref-reservations"];
    }
    if (config.team.minCliVersion === undefined) {
      // Non-critical: version gate is best-effort (ISS-748: shared resolver, not a
      // relative require that reads the wrong manifest from dist builds)
      const version = currentCliVersion();
      if (version !== null) {
        config.team.minCliVersion = version;
      }
    }

    await writeConfigUnlocked(config, root);
  });

  return {
    schemaVersionSet: schemaUpgraded,
    teamConfigured: true,
    mergeDriverInstalled: setupResult.driverInstalled,
    gitattributesWritten: setupResult.gitattributesWritten,
  };
}
