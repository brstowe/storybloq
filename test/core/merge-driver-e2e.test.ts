import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliPath = resolve(fileURLToPath(import.meta.url), "../../../dist/cli.js");
const driverCmd = `node ${cliPath} merge-driver %O %A %B %P`;

function createTeamRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "merge-e2e-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "merge.storybloq-json.driver", driverCmd], { cwd: dir });
  execFileSync("git", ["config", "merge.storybloq-json.name", "Storybloq JSON three-way merge"], { cwd: dir });
  const storyDir = join(dir, ".story");
  mkdirSync(join(storyDir, "tickets"), { recursive: true });
  writeFileSync(
    join(storyDir, ".gitattributes"),
    "tickets/*.json merge=storybloq-json\nconfig.json merge=storybloq-json\nroadmap.json merge=storybloq-json\n",
  );
  writeFileSync(
    join(storyDir, "config.json"),
    JSON.stringify({ version: 2, project: "test", type: "npm", language: "ts", team: { enabled: true } }, null, 2) + "\n",
  );
  return dir;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8", env: { ...process.env, GIT_MERGE_AUTOEDIT: "no" } }).trim();
}

function gitMerge(dir: string, branch: string): { exitCode: number; output: string } {
  try {
    const output = execFileSync("git", ["merge", "--no-edit", branch], { cwd: dir, encoding: "utf-8", env: { ...process.env, GIT_MERGE_AUTOEDIT: "no" } });
    return { exitCode: 0, output };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    return { exitCode: e.status ?? 1, output: e.stdout ?? "" };
  }
}

function writeTicket(dir: string, id: string, overrides: Record<string, unknown> = {}): void {
  const ticket = {
    id, title: `Ticket ${id}`, description: "", type: "task", status: "open",
    phase: "p1", order: 10, createdDate: "2026-01-01", completedDate: null,
    blockedBy: [], parentTicket: null, ...overrides,
  };
  writeFileSync(join(dir, ".story", "tickets", `${id}.json`), JSON.stringify(ticket, null, 2) + "\n");
}

const tmpDirs: string[] = [];
afterEach(() => { tmpDirs.length = 0; });

describe("G-2: end-to-end git merge driver", () => {
  it("clean merge: one-sided title change through actual git merge", () => {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    writeTicket(dir, "T-001", { title: "Base Title" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    git(dir, "checkout", "-b", "branch-a");
    writeTicket(dir, "T-001", { title: "Title From A" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "change on A");

    git(dir, "checkout", "main");
    git(dir, "checkout", "-b", "branch-b");
    writeTicket(dir, "T-001", { title: "Base Title", description: "Added by B" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "change on B");

    gitMerge(dir, "branch-a");

    const merged = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(merged.title).toBe("Title From A");
    expect(merged.description).toBe("Added by B");
    expect(merged._conflicts).toBeUndefined();
  });

  it("conflict merge: both sides change title, _conflicts emitted", () => {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    writeTicket(dir, "T-001", { title: "Base Title" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    git(dir, "checkout", "-b", "branch-a");
    writeTicket(dir, "T-001", { title: "Title From A" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "change on A");

    git(dir, "checkout", "main");
    git(dir, "checkout", "-b", "branch-b");
    writeTicket(dir, "T-001", { title: "Title From B" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "change on B");

    gitMerge(dir, "branch-a");

    const merged = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(Array.isArray(merged._conflicts)).toBe(true);
    expect(merged._conflicts.length).toBeGreaterThan(0);
    expect(merged._conflicts[0].field).toBe("title");
  });

  it("commutative merge: both sides add different blockers", () => {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    writeTicket(dir, "T-001", { blockedBy: ["T-010"] });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    git(dir, "checkout", "-b", "branch-a");
    writeTicket(dir, "T-001", { blockedBy: ["T-010", "T-020"] });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "add blocker on A");

    git(dir, "checkout", "main");
    git(dir, "checkout", "-b", "branch-b");
    writeTicket(dir, "T-001", { blockedBy: ["T-010", "T-030"] });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "add blocker on B");

    gitMerge(dir, "branch-a");

    const merged = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(merged._conflicts).toBeUndefined();
    const sortedBlockers = [...merged.blockedBy].sort();
    expect(sortedBlockers).toEqual(["T-010", "T-020", "T-030"]);
  });

  it("config.json merge through git", () => {
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");

    git(dir, "checkout", "-b", "branch-a");
    const cfgA = JSON.parse(readFileSync(join(dir, ".story", "config.json"), "utf-8"));
    cfgA.language = "python";
    writeFileSync(join(dir, ".story", "config.json"), JSON.stringify(cfgA, null, 2) + "\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "change language on A");

    git(dir, "checkout", "main");
    git(dir, "checkout", "-b", "branch-b");
    const cfgB = JSON.parse(readFileSync(join(dir, ".story", "config.json"), "utf-8"));
    cfgB.project = "renamed";
    writeFileSync(join(dir, ".story", "config.json"), JSON.stringify(cfgB, null, 2) + "\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "change project on B");

    gitMerge(dir, "branch-a");

    const merged = JSON.parse(readFileSync(join(dir, ".story", "config.json"), "utf-8"));
    expect(merged.language).toBe("python");
    expect(merged.project).toBe("renamed");
  });

  it("add/add: independently created entity with no common ancestor auto-resolves via driver", () => {
    // Regression for the empty-%O bug: an add/add has no merge base, so git
    // passes an empty ancestor file. The driver must treat that as base {} and
    // still merge (here a commutative blockedBy union) rather than bailing to a
    // raw `CONFLICT (add/add)`.
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    writeTicket(dir, "T-001");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base (no T-002)");

    git(dir, "checkout", "-b", "branch-a");
    writeTicket(dir, "T-002", { blockedBy: ["T-010", "T-020"] });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "create T-002 on A");

    git(dir, "checkout", "main");
    git(dir, "checkout", "-b", "branch-b");
    writeTicket(dir, "T-002", { blockedBy: ["T-010", "T-030"] });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "create T-002 on B");

    const { exitCode } = gitMerge(dir, "branch-a");

    const raw = readFileSync(join(dir, ".story", "tickets", "T-002.json"), "utf-8");
    expect(raw).not.toContain("<<<<<<<");
    const merged = JSON.parse(raw);
    expect(merged._conflicts).toBeUndefined();
    expect([...merged.blockedBy].sort()).toEqual(["T-010", "T-020", "T-030"]);
    expect(exitCode).toBe(0);
  });

  it("add/add: divergent entity sharing an id surfaces structured _conflicts, not raw markers", () => {
    // Two branches independently create T-002 with different content (the
    // displayId-collision shape). Before the empty-%O fix this surfaced as a
    // raw git add/add conflict; now the driver writes a structured _conflicts
    // block the user can resolve.
    const dir = createTeamRepo();
    tmpDirs.push(dir);
    writeTicket(dir, "T-001");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base (no T-002)");

    git(dir, "checkout", "-b", "branch-a");
    writeTicket(dir, "T-002", { title: "From A" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "create T-002 on A");

    git(dir, "checkout", "main");
    git(dir, "checkout", "-b", "branch-b");
    writeTicket(dir, "T-002", { title: "From B" });
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "create T-002 on B");

    const { exitCode } = gitMerge(dir, "branch-a");

    const raw = readFileSync(join(dir, ".story", "tickets", "T-002.json"), "utf-8");
    expect(raw).not.toContain("<<<<<<<");
    const merged = JSON.parse(raw);
    expect(Array.isArray(merged._conflicts)).toBe(true);
    expect(merged._conflicts.some((c: { field: string }) => c.field === "title")).toBe(true);
    // Structured conflict must still leave the merge unresolved (git exit 1).
    expect(exitCode).toBe(1);
  });
});
