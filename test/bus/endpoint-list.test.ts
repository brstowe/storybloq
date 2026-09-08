/**
 * ISS-1132 item 2: `bus endpoint list` surfaces per-endpoint wake configuration
 * and the LAST wake outcome.
 *
 * The telemetry source is the ENDPOINT (`lastWakeAt` / `lastWakeResult`), not the
 * thread wake entries. `wake-runner.ts:381` returns before `appendWakeEntry` on
 * every skip, so the thread sink contains only `requested` and `failed:*` and
 * none of the nine skip reasons. Those skips are exactly the "why did my wake not
 * fire" cases, so a listing built on thread entries could not answer the question
 * it exists for. The skip-outcome test below is the direct proof: it is
 * unpassable if the source is ever moved to the thread entries.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import { initializeBus } from "../../src/bus/index.js";
import type { BusClient, BusEndpoint, BusSurface } from "../../src/bus/schemas.js";
import { runBusCli } from "./cli-harness.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  roots.push(root);
  await initProject(root, { name });
  await initializeBus(root);
  return root;
}

/**
 * Writes an endpoint record straight to the registry.
 *
 * Deliberately not `joinEndpoint`: the capacity rule caps a project at two active
 * endpoints, and several cases below need more than two, or need fields
 * (`lastWakeResult`, `retiredAt`) that no join path produces.
 */
async function writeEndpoint(
  root: string,
  overrides: Partial<BusEndpoint> & { client: BusClient; surface: BusSurface },
): Promise<string> {
  const endpointId = overrides.endpointId ?? randomUUID();
  const now = new Date().toISOString();
  const record = {
    schema: "storybloq-bus-endpoint/v2",
    endpointId,
    clientTaskId: `task-${endpointId.slice(0, 8)}`,
    resumeHandle: null,
    projectRoot: root,
    gitBranch: null,
    worktreeId: createHash("sha256").update(root).digest("hex"),
    processRef: null,
    state: "attached",
    joinedAt: now,
    lastSeenAt: now,
    wakePolicy: "never",
    lastPolledMailboxSeq: 0,
    lastBlockedMailboxSeq: 0,
    // Required-but-nullable in BusEndpointSchema. Omitting them makes the record
    // fail to parse, which listEndpoints reports as a FINDING and drops, so every
    // assertion below would run against an empty fleet.
    retiredAt: null,
    retiredReason: null,
    successionId: randomUUID(),
    ...overrides,
    endpointId,
  };
  await writeFile(
    join(root, ".story", "bus", "endpoints", `${endpointId}.json`),
    JSON.stringify(record, null, 2),
    "utf-8",
  );
  return endpointId;
}

interface ListRow {
  endpointId: string;
  client: string;
  surface: string;
  wakePolicy: string;
  wakeSupported: boolean;
  clientSessionName: string | null;
  retiredAt: string | null;
  lastWakeAt: string | null;
  lastWakeResult: string | null;
}

async function listJson(root: string): Promise<{ endpoints: ListRow[]; findings: string[] }> {
  const { stdout } = await runBusCli(root, ["bus", "endpoint", "list", "--format", "json"]);
  return JSON.parse(stdout).data;
}

async function listText(root: string): Promise<string> {
  return (await runBusCli(root, ["bus", "endpoint", "list"])).stdout;
}

describe("ISS-1132 bus endpoint list", () => {
  it("reports an empty registry as empty and exits zero, not as an error", async () => {
    const root = await project("iss1132-list-empty");
    const { stdout, exitCode } = await runBusCli(root, ["bus", "endpoint", "list", "--format", "json"]);
    expect(exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout).data.endpoints).toEqual([]);
  });

  it("carries every wake field in JSON", async () => {
    const root = await project("iss1132-list-json");
    const id = await writeEndpoint(root, {
      client: "codex",
      surface: "codex_cli",
      wakePolicy: "idle",
      clientSessionName: "peer-session",
      lastWakeAt: "2026-09-05T10:00:00.000Z",
      lastWakeResult: "requested",
    } as Partial<BusEndpoint> & { client: BusClient; surface: BusSurface });

    const { endpoints } = await listJson(root);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toMatchObject({
      endpointId: id,
      client: "codex",
      surface: "codex_cli",
      wakePolicy: "idle",
      wakeSupported: true,
      clientSessionName: "peer-session",
      retiredAt: null,
      lastWakeAt: "2026-09-05T10:00:00.000Z",
      lastWakeResult: "requested",
    });
  });

  it("renders every field on its own labelled line in text", async () => {
    // Whole lines, not loose substrings. The earlier form asserted only that the
    // words appeared somewhere, so deleting the support line or the timestamp
    // suffix left it green.
    const root = await project("iss1132-list-text");
    const id = await writeEndpoint(root, {
      client: "codex",
      surface: "codex_cli",
      wakePolicy: "idle",
      lastWakeAt: "2026-09-05T10:00:00.000Z",
      lastWakeResult: "requested",
    } as Partial<BusEndpoint> & { client: BusClient; surface: BusSurface });

    const text = await listText(root);
    expect(text).toContain(`endpoint ${id}`);
    expect(text).toContain("client: codex (codex_cli)");
    expect(text).toContain("wake policy: idle");
    expect(text).toContain("wake supported: yes (client and surface only)");
    expect(text).toContain("last wake: requested at 2026-09-05T10:00:00.000Z");
  });

  it("renders the support line as no for an endpoint the gates would reject", async () => {
    const root = await project("iss1132-list-text-unsupported");
    await writeEndpoint(root, { client: "claude", surface: "claude_cli" });
    expect(await listText(root)).toContain("wake supported: no (client and surface only)");
  });

  it("prints absent for missing wake telemetry, never a fabricated value", async () => {
    const root = await project("iss1132-list-absent");
    await writeEndpoint(root, { client: "codex", surface: "codex_cli", wakePolicy: "idle" });

    const { endpoints } = await listJson(root);
    expect(endpoints[0]!.lastWakeAt).toBeNull();
    expect(endpoints[0]!.lastWakeResult).toBeNull();

    const text = await listText(root);
    // Anchored to its OWN line. A bare "absent" is also produced by the
    // session-name line, so the loose form would pass while this line said
    // anything at all.
    expect(text).toContain("last wake: absent");
    // The three values an absence must never be dressed up as.
    expect(text).not.toContain("last wake: never");
    expect(text).not.toContain("last wake: 0");
    expect(text).not.toContain("last wake: requested");
  });

  it("shows an endpoint whose last outcome was a SKIP", async () => {
    // The load-bearing test for the telemetry source. A skip never reaches
    // appendWakeEntry, so an implementation reading thread wake entries returns
    // nothing here and this test cannot pass.
    const root = await project("iss1132-list-skip");
    await writeEndpoint(root, {
      client: "codex",
      surface: "codex_cli",
      wakePolicy: "idle",
      lastWakeAt: "2026-09-05T11:00:00.000Z",
      lastWakeResult: "skipped:ownership-unproven",
    } as Partial<BusEndpoint> & { client: BusClient; surface: BusSurface });

    const { endpoints } = await listJson(root);
    expect(endpoints[0]!.lastWakeResult).toBe("skipped:ownership-unproven");
    expect(await listText(root)).toContain("skipped:ownership-unproven");
  });

  it("reproduces lastWakeResult verbatim rather than normalising it", async () => {
    const root = await project("iss1132-list-verbatim");
    for (const stored of ["failed:version", "skipped:already-polled-through-batch", "skipped:active-turn"]) {
      const id = await writeEndpoint(root, {
        client: "codex",
        surface: "codex_cli",
        wakePolicy: "idle",
        lastWakeResult: stored,
      } as Partial<BusEndpoint> & { client: BusClient; surface: BusSurface });
      const { endpoints } = await listJson(root);
      const row = endpoints.find((e) => e.endpointId === id);
      expect(row?.lastWakeResult, `stored ${stored} must survive intact`).toBe(stored);
    }
  });

  it("surfaces registry findings instead of reporting an empty fleet", async () => {
    const root = await project("iss1132-list-findings");
    await writeEndpoint(root, { client: "codex", surface: "codex_cli" });
    // Filename that does not match the record's endpointId: listEndpoints records
    // a finding and drops the record.
    const stray = {
      ...JSON.parse(
        await readFile(
          join(root, ".story", "bus", "endpoints", `${(await listJson(root)).endpoints[0]!.endpointId}.json`),
          "utf-8",
        ),
      ),
      endpointId: randomUUID(),
    };
    await writeFile(
      join(root, ".story", "bus", "endpoints", "not-the-id.json"),
      JSON.stringify(stray, null, 2),
      "utf-8",
    );

    const { findings } = await listJson(root);
    expect(findings.length).toBeGreaterThan(0);
    expect(await listText(root)).toContain("not-the-id.json");
  });

  it("reports findings AND the empty fleet when every record is corrupt", async () => {
    // The case the command exists for. With no valid endpoint left, a renderer
    // that returned early on an empty list before printing findings would show a
    // clean empty fleet over a registry that is entirely unreadable.
    const root = await project("iss1132-list-all-corrupt");
    await writeFile(
      join(root, ".story", "bus", "endpoints", "broken.json"),
      "{ not json at all",
      "utf-8",
    );

    const { endpoints, findings } = await listJson(root);
    expect(endpoints).toEqual([]);
    expect(findings.length).toBeGreaterThan(0);

    const text = await listText(root);
    expect(text).toContain("broken.json");
    expect(text).toContain("No endpoints.");
  });

  it("computes wakeSupported from static client and surface eligibility, not the stored policy", async () => {
    // Six rows, expectations written literally. The two `never` rows on an
    // otherwise eligible or ineligible endpoint are what catch an implementation
    // that passes endpoint.wakePolicy instead of the literal "idle": under that
    // bug claude/never and codex_desktop/never both flip to true.
    const cases: Array<[BusClient, BusSurface, "never" | "idle", boolean]> = [
      ["claude", "claude_cli", "never", false],
      ["claude", "claude_cli", "idle", false],
      ["codex", "codex_desktop", "never", false],
      ["codex", "codex_desktop", "idle", false],
      ["codex", "codex_cli", "never", true],
      ["codex", "codex_cli", "idle", true],
    ];
    for (const [client, surface, wakePolicy, expected] of cases) {
      const root = await project(`iss1132-supported-${client}-${surface}-${wakePolicy}`);
      await writeEndpoint(root, { client, surface, wakePolicy } as Partial<BusEndpoint> & {
        client: BusClient;
        surface: BusSurface;
      });
      const { endpoints } = await listJson(root);
      expect(
        endpoints[0]!.wakeSupported,
        `${client}/${surface} stored ${wakePolicy} should be ${expected}`,
      ).toBe(expected);
    }
  });

  it("renders clientSessionName absent when unset and verbatim when set", async () => {
    const root = await project("iss1132-list-session-name");
    await writeEndpoint(root, { client: "codex", surface: "codex_cli" });
    expect((await listJson(root)).endpoints[0]!.clientSessionName).toBeNull();
    // Anchored to its own line: the endpoint above also has no wake telemetry,
    // so a bare "absent" is satisfied by the last-wake line and says nothing
    // about this one. M21 survived the loose form.
    expect(await listText(root)).toContain("session name: absent");

    const withName = await project("iss1132-list-session-name-set");
    await writeEndpoint(withName, {
      client: "codex",
      surface: "codex_cli",
      clientSessionName: "peer-abc",
    } as Partial<BusEndpoint> & { client: BusClient; surface: BusSurface });
    expect((await listJson(withName)).endpoints[0]!.clientSessionName).toBe("peer-abc");
    expect(await listText(withName)).toContain("peer-abc");
  });

  it("lists a retired endpoint and marks it, never silently dropping it", async () => {
    // listEndpoints returns retired records and every existing caller filters
    // them out. A listing that inherited that filter would show an empty fleet
    // to someone whose endpoint was retired, which is the absence-as-zero shape
    // this command exists to remove.
    const root = await project("iss1132-list-retired");
    const id = await writeEndpoint(root, {
      client: "codex",
      surface: "codex_cli",
      retiredAt: "2026-09-04T09:00:00.000Z",
      retiredReason: "superseded",
    } as unknown as Partial<BusEndpoint> & { client: BusClient; surface: BusSurface });

    const { endpoints } = await listJson(root);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]!.endpointId).toBe(id);
    expect(endpoints[0]!.retiredAt).toBe("2026-09-04T09:00:00.000Z");
    expect(await listText(root)).toContain("retired");
  });
});
