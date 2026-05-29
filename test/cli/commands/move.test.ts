import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTicketMove } from "../../../src/cli/commands/move.js";
import { initProject } from "../../../src/core/init.js";
import { validateRank } from "../../../src/core/fractional-index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeTeamProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "move-test-"));
  dirs.push(dir);
  await initProject(dir, { name: "move-test" });
  const configPath = join(dir, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.team = { ...(config.team ?? {}), enabled: true };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return dir;
}

async function writeTicket(
  dir: string,
  id: string,
  rank: string,
  order: number,
): Promise<void> {
  const ticket = {
    id,
    title: `Ticket ${id}`,
    description: "",
    type: "task",
    status: "open",
    phase: null,
    order,
    createdDate: "2026-01-01",
    completedDate: null,
    blockedBy: [],
    rank,
  };
  await writeFile(
    join(dir, ".story", "tickets", `${id}.json`),
    JSON.stringify(ticket, null, 2) + "\n",
    "utf-8",
  );
}

async function rankOf(dir: string, id: string): Promise<string | undefined> {
  const raw = JSON.parse(await readFile(join(dir, ".story", "tickets", `${id}.json`), "utf-8"));
  return raw.rank;
}

describe("handleTicketMove (ISS-688: duplicate sibling ranks)", () => {
  it("moves --after a target whose next sibling has an equal rank (no io_error)", async () => {
    const dir = await makeTeamProject();
    // T-002 and T-003 share rank "a1V" (duplicate ranks are spec-allowed). Moving
    // T-001 after T-002 used to throw midpoint("a1V","a1V") -> opaque io_error.
    await writeTicket(dir, "T-001", "a0", 10);
    await writeTicket(dir, "T-002", "a1V", 20);
    await writeTicket(dir, "T-003", "a1V", 30);

    const result = await handleTicketMove("T-001", dir, { after: "T-002", format: "json" });
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(true);
    const newRank = parsed.data.rank as string;
    expect(validateRank(newRank)).toBe(true);
    // Placed after the target's (duplicated) rank group.
    expect(newRank > "a1V").toBe(true);
    expect(await rankOf(dir, "T-001")).toBe(newRank);
  });

  it("moves --before a target whose previous sibling has an equal rank", async () => {
    const dir = await makeTeamProject();
    await writeTicket(dir, "T-001", "z0", 10);
    await writeTicket(dir, "T-002", "a1V", 20);
    await writeTicket(dir, "T-003", "a1V", 30);

    // siblings sorted by rank: T-002("a1V"), T-003("a1V"), T-001("z0").
    // Move T-001 before T-003 -> prev is T-002 with the same rank "a1V".
    const result = await handleTicketMove("T-001", dir, { before: "T-003", format: "json" });
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(true);
    const newRank = parsed.data.rank as string;
    expect(validateRank(newRank)).toBe(true);
    expect(newRank < "a1V").toBe(true);
  });

  it("--after a duplicate group lands before the next distinct sibling, not past it", async () => {
    const dir = await makeTeamProject();
    // Group "a1V","a1V" is bounded above by the distinct "a1W". Moving T-001 after
    // the first "a1V" must land in ("a1V","a1W), never past "a1W".
    await writeTicket(dir, "T-001", "z0", 10);
    await writeTicket(dir, "T-002", "a1V", 20);
    await writeTicket(dir, "T-003", "a1V", 30);
    await writeTicket(dir, "T-004", "a1W", 40);

    const result = await handleTicketMove("T-001", dir, { after: "T-002", format: "json" });
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(true);
    const newRank = parsed.data.rank as string;
    expect(newRank > "a1V").toBe(true);
    expect(newRank < "a1W").toBe(true);
  });

  it("--before a duplicate group lands after the previous distinct sibling, not past it", async () => {
    const dir = await makeTeamProject();
    // Group "a1V","a1V" bounded below by distinct "a1A". Moving T-001 before the
    // second "a1V" must land in ("a1A","a1V), never below "a1A".
    await writeTicket(dir, "T-001", "z0", 10);
    await writeTicket(dir, "T-002", "a1A", 20);
    await writeTicket(dir, "T-003", "a1V", 30);
    await writeTicket(dir, "T-004", "a1V", 40);

    const result = await handleTicketMove("T-001", dir, { before: "T-004", format: "json" });
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(true);
    const newRank = parsed.data.rank as string;
    expect(newRank > "a1A").toBe(true);
    expect(newRank < "a1V").toBe(true);
  });

  it("still slots strictly between two distinct sibling ranks", async () => {
    const dir = await makeTeamProject();
    await writeTicket(dir, "T-001", "z0", 10);
    await writeTicket(dir, "T-002", "a0", 20);
    await writeTicket(dir, "T-003", "a2", 30);

    const result = await handleTicketMove("T-001", dir, { after: "T-002", format: "json" });
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(true);
    const newRank = parsed.data.rank as string;
    expect(newRank > "a0").toBe(true);
    expect(newRank < "a2").toBe(true);
  });
});
