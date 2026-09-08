/**
 * ISS-1132 item 1: `bus setup --wake idle` is refused where the gates can never
 * honour it.
 *
 * The centre of this file is the AGREEMENT TABLE. `wakePolicyRefusal` is a
 * PREDICTION about gates 2 and 3 of `attemptWake`, and a prediction that drifts
 * from the thing it predicts is worse than no prediction, because it is
 * confidently wrong in both directions. So the table asserts the helper AND the
 * real `attemptWake` for every client/surface pair.
 *
 * The table is hard-coded and UNCONDITIONAL on purpose. An earlier draft
 * iterated "every pair the refusal rejects", which reads the implementation
 * under test to decide what to test: delete a refusal branch and that pair
 * silently leaves the iteration, so the test passes over nothing. Every row here
 * is written out, and every row asserts both sides, so removing a branch fails
 * the table rather than shrinking it.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import { attemptWake, wakePolicyRefusal } from "../../src/bus/wake.js";
import type { BusClient, BusEndpoint, BusSurface } from "../../src/bus/schemas.js";
import type { WakeConnection, WakeDeps, WakeOutcome } from "../../src/bus/wake.js";
import { runBusCli } from "./cli-harness.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  roots.push(root);
  await initProject(root, { name });
  return root;
}

const ACCEPTED_VERSION = "0.0.0-test";

/**
 * Deps that would carry a wake all the way to `requested`, plus counters.
 *
 * The counters are the point for the two refused rows: gates 2 and 3 must return
 * BEFORE any dependency is touched, so "no version read, no connect" is an
 * assertion here rather than a claim in a comment.
 */
function armedDeps(threadId: string): WakeDeps & {
  readonly counts: { version: number; connect: number; turns: number };
} {
  const counts = { version: 0, connect: 0, turns: 0 };
  const connection: WakeConnection = {
    async findThread(id) {
      return { id, status: { type: "idle" } };
    },
    async loadedThreadIds() {
      return [threadId];
    },
    async startTurn() {
      counts.turns += 1;
    },
    close() {},
  };
  return {
    counts,
    deadline: Date.now() + 5000,
    acceptedVersions: [ACCEPTED_VERSION],
    async readVersion() {
      counts.version += 1;
      return ACCEPTED_VERSION;
    },
    async connect() {
      counts.connect += 1;
      return connection;
    },
    // Strictly below the batch cursor used below, so gate 4 passes.
    async readPolledSeq() {
      return 0;
    },
  };
}

function endpointFixture(client: BusClient, surface: BusSurface): BusEndpoint {
  const now = new Date().toISOString();
  return {
    schema: "storybloq-bus-endpoint/v2",
    endpointId: "11111111-1111-4111-8111-111111111111",
    client,
    surface,
    clientTaskId: "task-under-test",
    resumeHandle: null,
    projectRoot: "/tmp/does-not-matter",
    gitBranch: null,
    worktreeId: createHash("sha256").update("w").digest("hex"),
    processRef: null,
    state: "attached",
    joinedAt: now,
    lastSeenAt: now,
    wakePolicy: "idle",
    lastPolledMailboxSeq: 0,
    lastBlockedMailboxSeq: 0,
  } as BusEndpoint;
}

/**
 * Every client/surface pair, with BOTH expectations stated independently of the
 * implementation. `refusalNames` are substrings the refusal must contain, so a
 * message that refuses for the wrong stated reason still fails.
 */
const AGREEMENT_TABLE = [
  {
    label: "claude / claude_cli",
    client: "claude" as BusClient,
    surface: "claude_cli" as BusSurface,
    refused: true,
    refusalNames: ["claude", "SendMessage"],
    wake: { kind: "skipped", reason: "not-codex" } as WakeOutcome,
  },
  {
    label: "codex / codex_desktop",
    client: "codex" as BusClient,
    surface: "codex_desktop" as BusSurface,
    refused: true,
    refusalNames: ["codex_desktop"],
    wake: { kind: "skipped", reason: "surface-unreachable" } as WakeOutcome,
  },
  {
    label: "codex / codex_cli",
    client: "codex" as BusClient,
    surface: "codex_cli" as BusSurface,
    refused: false,
    refusalNames: [],
    // Not "anything other than a client or surface skip": that would be
    // satisfied by an unrelated early skip (pending-unknown, version) and would
    // never prove the fixture reaches the gates under test.
    wake: "requested" as const,
  },
] as const;

describe("ISS-1132 the setup refusal agrees with the wake gates", () => {
  for (const row of AGREEMENT_TABLE) {
    it(`agreement: ${row.label} refusal ${row.refused ? "rejects" : "accepts"} and attemptWake matches`, async () => {
      const refusal = wakePolicyRefusal(row.client, row.surface, "idle");

      if (row.refused) {
        expect(refusal).not.toBeNull();
        for (const needle of row.refusalNames) {
          expect(refusal).toContain(needle);
        }
      } else {
        expect(refusal).toBeNull();
      }

      const threadId = "22222222-2222-4222-8222-222222222222";
      const deps = armedDeps(threadId);
      const outcome = await attemptWake(
        {
          endpoint: endpointFixture(row.client, row.surface),
          batchCursor: 1,
          codexThreadId: threadId,
          wakeText: "check the bus",
        },
        deps,
      );

      if (row.refused) {
        expect(outcome).toEqual(row.wake);
        // Gates 2 and 3 must decide before anything is spawned or dialled.
        expect(deps.counts.version).toBe(0);
        expect(deps.counts.connect).toBe(0);
        expect(deps.counts.turns).toBe(0);
      } else {
        expect(outcome).toMatchObject({ kind: "requested" });
        expect(deps.counts.turns).toBe(1);
      }
    });
  }
});

describe("ISS-1132 wakePolicyRefusal accepts every policy that is not idle", () => {
  it("accepts an explicit never on every client and surface", () => {
    for (const row of AGREEMENT_TABLE) {
      expect(wakePolicyRefusal(row.client, row.surface, "never")).toBeNull();
    }
  });

  it("accepts an omitted policy on every client and surface", () => {
    for (const row of AGREEMENT_TABLE) {
      expect(wakePolicyRefusal(row.client, row.surface, undefined)).toBeNull();
    }
  });
});

async function setupJson(
  root: string,
  extra: string[],
): Promise<{ data?: Record<string, unknown>; error?: { code: string; message: string }; exitCode: number | undefined }> {
  const { stdout, exitCode } = await runBusCli(root, [
    "bus", "setup", "--format", "json", "--delivery", "poll", ...extra,
  ]);
  return { ...JSON.parse(stdout), exitCode };
}

async function walkTree(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      out.push(`${prefix}${entry.name}/`);
      out.push(...(await walkTree(join(dir, entry.name), `${prefix}${entry.name}/`)));
    } else if (entry.isFile() && !entry.isSymbolicLink()) {
      const bytes = await readFile(join(dir, entry.name));
      out.push(`${prefix}${entry.name}@${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`);
    } else {
      out.push(`${prefix}${entry.name}#${entry.isSymbolicLink() ? "symlink" : "special"}`);
    }
  }
  return out.sort();
}

/** Project-local hook settings, or null when setup has not written any. */
async function readSettings(root: string): Promise<string | null> {
  const path = join(root, ".claude", "settings.local.json");
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("ISS-1132 bus setup refuses an unhonourable wake policy", () => {
  it("refuses --wake idle on a claude endpoint, naming the client and the tier that applies", async () => {
    const root = await project("iss1132-refuse-claude");
    const result = await setupJson(root, [
      "--client", "claude", "--surface", "claude_cli", "--task-id", "t", "--wake", "idle",
    ]);
    expect(result.error?.code).toBe("invalid_input");
    expect(result.error?.message).toContain("claude");
    expect(result.error?.message).toContain("SendMessage");
    // `?? 0` matters: exitCode is `number | undefined`, so the bare form is
    // satisfied by `undefined` and would survive removing the non-zero assignment.
    expect(result.exitCode ?? 0).not.toBe(0);
  });

  it("refuses --wake idle on a codex_desktop endpoint, naming the surface", async () => {
    const root = await project("iss1132-refuse-desktop");
    const result = await setupJson(root, [
      "--client", "codex", "--surface", "codex_desktop", "--task-id", "t", "--wake", "idle",
    ]);
    expect(result.error?.code).toBe("invalid_input");
    expect(result.error?.message).toContain("codex_desktop");
    // `?? 0` matters: exitCode is `number | undefined`, so the bare form is
    // satisfied by `undefined` and would survive removing the non-zero assignment.
    expect(result.exitCode ?? 0).not.toBe(0);
  });

  it("accepts --wake idle on a codex_cli endpoint and PERSISTS the policy", async () => {
    const root = await project("iss1132-accept-cli");
    const result = await setupJson(root, [
      "--client", "codex", "--surface", "codex_cli", "--task-id", "t", "--wake", "idle",
    ]);
    expect(result.error).toBeUndefined();

    // Re-read from disk. An exit code proves the command did not throw, never
    // that the policy was written.
    const dir = join(root, ".story", "bus", "endpoints");
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const stored = JSON.parse(await readFile(join(dir, files[0]!), "utf-8"));
    expect(stored.wakePolicy).toBe("idle");
  });

  it("accepts --wake never on every client and surface, including the refused pairs", async () => {
    for (const [client, surface] of [
      ["claude", "claude_cli"],
      ["codex", "codex_desktop"],
      ["codex", "codex_cli"],
    ] as const) {
      const root = await project(`iss1132-never-${surface}`);
      const result = await setupJson(root, [
        "--client", client, "--surface", surface, "--task-id", "t", "--wake", "never",
      ]);
      expect(result.error, `${client}/${surface} should accept --wake never`).toBeUndefined();
    }
  });

  it("leaves an existing idle policy untouched when --wake is omitted, on EVERY pair", async () => {
    // Parameterised across all three pairs, including the two the refusal
    // rejects. The helper-level tests cannot catch a CALL-SITE regression that
    // validates the endpoint's STORED policy instead of the omitted argument:
    // that would reject a rerun on an existing Claude or desktop endpoint that
    // someone had already opted in, despite the preservation contract.
    for (const [client, surface] of [
      ["claude", "claude_cli"],
      ["codex", "codex_desktop"],
      ["codex", "codex_cli"],
    ] as const) {
      const root = await project(`iss1132-omit-${surface}`);
      await setupJson(root, [
        "--client", client, "--surface", surface, "--task-id", "t", "--wake", "never",
      ]);
      const dir = join(root, ".story", "bus", "endpoints");
      const file = join(dir, (await readdir(dir))[0]!);
      // Opt in by writing the registry directly: --wake idle is refused for two
      // of these pairs, which is exactly why the stored value must be reachable
      // some other way to test preservation.
      const record = JSON.parse(await readFile(file, "utf-8"));
      await writeFile(file, JSON.stringify({ ...record, wakePolicy: "idle" }, null, 2), "utf-8");

      const rerun = await setupJson(root, [
        "--client", client, "--surface", surface, "--task-id", "t",
      ]);
      expect(rerun.error, `${client}/${surface} rerun without --wake must be accepted`).toBeUndefined();
      expect(
        JSON.parse(await readFile(file, "utf-8")).wakePolicy,
        `${client}/${surface} stored idle must survive a rerun without --wake`,
      ).toBe("idle");
    }
  });

  it("leaves an existing idle policy untouched when --wake is omitted", async () => {
    // Seeded with an EXISTING idle policy on purpose. Asserting "unchanged" over
    // an endpoint whose policy was never set proves nothing: the default is
    // already `never`, so an accidental reset would be invisible.
    const root = await project("iss1132-omitted");
    await setupJson(root, [
      "--client", "codex", "--surface", "codex_cli", "--task-id", "t", "--wake", "idle",
    ]);
    const dir = join(root, ".story", "bus", "endpoints");
    const file = join(dir, (await readdir(dir))[0]!);
    expect(JSON.parse(await readFile(file, "utf-8")).wakePolicy).toBe("idle");

    const rerun = await setupJson(root, [
      "--client", "codex", "--surface", "codex_cli", "--task-id", "t",
    ]);
    expect(rerun.error).toBeUndefined();
    expect(JSON.parse(await readFile(file, "utf-8")).wakePolicy).toBe("idle");
  });
});

describe("ISS-1132 a refused setup mutates nothing", () => {
  it("creates no runtime at all on a fresh project", async () => {
    // The strongest available signal, because it is NOT idempotent: a refusal
    // that fired after initializeBus would leave .story/bus/ behind and enable
    // features.bus, neither of which a later rerun could undo silently.
    const root = await project("iss1132-zero-fresh");
    const configBefore = await readFile(join(root, ".story", "config.json"), "utf-8");
    const storyBefore = await walkTree(join(root, ".story"));
    const settingsBefore = await readSettings(root);

    const result = await setupJson(root, [
      "--client", "claude", "--surface", "claude_cli", "--task-id", "t", "--wake", "idle",
    ]);
    expect(result.error?.code).toBe("invalid_input");

    expect(await pathExists(join(root, ".story", "bus"))).toBe(false);
    expect(await readFile(join(root, ".story", "config.json"), "utf-8")).toBe(configBefore);
    const config = JSON.parse(configBefore);
    expect(config.features?.bus).not.toBe(true);
    // The WHOLE ledger, not just the runtime and config: the preflight contract
    // covers "config/runtime/hook-policy/ledger", and snapshotting three of the
    // four would leave a write to the fourth undetected.
    expect(await walkTree(join(root, ".story"))).toEqual(storyBefore);
    expect(await readSettings(root)).toBe(settingsBefore);
  });

  it("changes no byte of an already-set-up project", async () => {
    const root = await project("iss1132-zero-existing");
    // Set up as codex_cli so the runtime, endpoint record, config and .gitignore
    // all already exist and an idempotent rewrite could otherwise hide a mutation.
    await setupJson(root, [
      "--client", "codex", "--surface", "codex_cli", "--task-id", "t", "--wake", "never",
    ]);

    const configBefore = await readFile(join(root, ".story", "config.json"), "utf-8");
    const gitignoreBefore = await readFile(join(root, ".story", ".gitignore"), "utf-8");
    // The complete ledger tree, which subsumes .story/bus and also covers every
    // ticket, issue, session and hook-policy file the preflight promises not to
    // touch.
    const treeBefore = await walkTree(join(root, ".story"));
    const settingsBefore = await readSettings(root);

    const result = await setupJson(root, [
      "--client", "codex", "--surface", "codex_desktop", "--task-id", "t2", "--wake", "idle",
    ]);
    expect(result.error?.code).toBe("invalid_input");

    expect(await readFile(join(root, ".story", "config.json"), "utf-8")).toBe(configBefore);
    expect(await readFile(join(root, ".story", ".gitignore"), "utf-8")).toBe(gitignoreBefore);
    expect(await walkTree(join(root, ".story"))).toEqual(treeBefore);
    expect(await readSettings(root)).toBe(settingsBefore);
  });
});
