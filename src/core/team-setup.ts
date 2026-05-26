import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MERGE_DRIVER_VERSION = 1;
export const MERGE_DRIVER_NAME = "storybloq-json";
export const MERGE_DRIVER_CMD = "storybloq merge-driver %O %A %B %P";
export const MERGE_DRIVER_DISPLAY_NAME = "Storybloq JSON three-way merge";

const BLOCK_BEGIN = "# storybloq-merge-begin";
const BLOCK_END = "# storybloq-merge-end";

const GITATTRIBUTES_PATTERNS = [
  "tickets/*.json merge=storybloq-json",
  "issues/*.json merge=storybloq-json",
  "notes/*.json merge=storybloq-json",
  "lessons/*.json merge=storybloq-json",
  "config.json merge=storybloq-json",
  "roadmap.json merge=storybloq-json",
];

async function findGitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
    return stdout.trim();
  } catch {
    throw new Error("Not inside a git repository");
  }
}

export async function installMergeDriver(gitRoot: string): Promise<void> {
  await execFileAsync(
    "git", ["config", "--local", `merge.${MERGE_DRIVER_NAME}.driver`, MERGE_DRIVER_CMD],
    { cwd: gitRoot, timeout: 5000 },
  );
  await execFileAsync(
    "git", ["config", "--local", `merge.${MERGE_DRIVER_NAME}.name`, MERGE_DRIVER_DISPLAY_NAME],
    { cwd: gitRoot, timeout: 5000 },
  );
}

export async function writeGitattributes(storyDir: string): Promise<void> {
  const filePath = join(storyDir, ".gitattributes");
  let existing = "";
  if (existsSync(filePath)) {
    existing = readFileSync(filePath, "utf-8");
  }

  const blockContent = [BLOCK_BEGIN, ...GITATTRIBUTES_PATTERNS, BLOCK_END].join("\n");

  const beginIdx = existing.indexOf(BLOCK_BEGIN);
  const endIdx = existing.indexOf(BLOCK_END);

  let result: string;
  if (beginIdx !== -1 && endIdx !== -1) {
    const before = existing.substring(0, beginIdx);
    const after = existing.substring(endIdx + BLOCK_END.length);
    result = before + blockContent + after;
  } else {
    if (existing.length > 0 && !existing.endsWith("\n")) {
      existing += "\n";
    }
    result = existing + blockContent + "\n";
  }

  writeFileSync(filePath, result, "utf-8");
}

export async function updateConfigVersion(storyDir: string): Promise<void> {
  const configPath = join(storyDir, "config.json");
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as Record<string, unknown>;

  if (!config.team || typeof config.team !== "object") {
    config.team = {};
  }
  (config.team as Record<string, unknown>).mergeDriverVersion = MERGE_DRIVER_VERSION;

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export interface SetupResult {
  driverInstalled: boolean;
  gitattributesWritten: boolean;
  versionUpdated: boolean;
  gitRoot: string;
}

export async function teamSetup(root: string): Promise<SetupResult> {
  const storyDir = join(root, ".story");
  if (!existsSync(storyDir)) {
    throw new Error("No .story/ directory found");
  }

  const configPath = join(storyDir, "config.json");
  if (!existsSync(configPath)) {
    throw new Error("No .story/config.json found");
  }

  const gitRoot = await findGitRoot(root);

  await installMergeDriver(gitRoot);
  await writeGitattributes(storyDir);
  await updateConfigVersion(storyDir);

  return {
    driverInstalled: true,
    gitattributesWritten: true,
    versionUpdated: true,
    gitRoot,
  };
}

export interface CheckResult {
  ok: boolean;
  issues: string[];
}

export async function checkMergeDriverSetup(root: string): Promise<CheckResult> {
  const issues: string[] = [];
  const storyDir = join(root, ".story");

  let gitRoot: string;
  try {
    gitRoot = await findGitRoot(root);
  } catch {
    issues.push("Not inside a git repository");
    return { ok: false, issues };
  }

  try {
    const { stdout } = await execFileAsync(
      "git", ["config", "--local", "--get", `merge.${MERGE_DRIVER_NAME}.driver`],
      { cwd: gitRoot, timeout: 5000 },
    );
    if (stdout.trim() !== MERGE_DRIVER_CMD) {
      issues.push(`Merge driver command mismatch: expected "${MERGE_DRIVER_CMD}", got "${stdout.trim()}"`);
    }
  } catch {
    issues.push("Merge driver not configured in local git config");
  }

  const attrsPath = join(storyDir, ".gitattributes");
  if (!existsSync(attrsPath)) {
    issues.push(".story/.gitattributes not found");
  } else {
    const content = readFileSync(attrsPath, "utf-8");
    if (!content.includes(BLOCK_BEGIN) || !content.includes(BLOCK_END)) {
      issues.push(".story/.gitattributes missing managed merge block");
    }
  }

  const configPath = join(storyDir, "config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      const team = config.team as Record<string, unknown> | undefined;
      const configVersion = team?.mergeDriverVersion;
      if (configVersion !== MERGE_DRIVER_VERSION) {
        issues.push(`Merge driver version mismatch: config has ${configVersion}, current is ${MERGE_DRIVER_VERSION}`);
      }
    } catch {
      issues.push("Failed to read config.json");
    }
  }

  return { ok: issues.length === 0, issues };
}
