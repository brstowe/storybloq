/**
 * ISS-1113 (the 1.15.3 slice): three new non-actionable dispositions, set at
 * the moment an issue is FILED, and honoured by every consumer that decides
 * whether an issue is work.
 *
 * The vocabulary already existed (ISS-1154 put `escalate_only`, `owner_gated`
 * and `duplicate` on `IssueSchema.disposition`). What did not exist was any
 * WRITER: `handleIssueCreate` had no `disposition` and no `metadata` on its
 * input and wrote a fixed field list, so the three filing paths the ruling
 * names could not have set one even if they had wanted to. That is the half
 * this file covers; the queue-side half (which producer wins when two of them
 * describe the same finding) is in
 * `test/autonomous/deferral-disposition.test.ts`.
 *
 * Two pins here are load-bearing rather than incidental:
 *
 *  - The create with no disposition and no metadata must produce a file
 *    byte-identical to what it produces today. An additive field that quietly
 *    appears as `null` on every issue ever filed is not additive.
 *  - `issueCreateFingerprint` digests a LITERAL expected hash. The recovery
 *    path recomputes that digest and quarantines a record that does not match
 *    (`pending-artifacts.ts`), so a digest that moves turns every record
 *    written by an older build into `malformed-record` on resume. A pinned
 *    hash is the only thing that makes such a move visible rather than silent.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IssueSchema } from "../../src/models/issue.js";
import {
  NON_ACTIONABLE_DISPOSITIONS,
  isNonActionableDisposition,
} from "../../src/core/issue-disposition.js";
import { computeActionability } from "../../src/core/recommend.js";
import { formatStatus } from "../../src/core/output-formatter.js";
import { handleIssueCreate } from "../../src/cli/commands/issue.js";
import { initProject } from "../../src/core/init.js";
import { CliValidationError } from "../../src/cli/helpers.js";
import { issueCreateFingerprint, readIssueCreatePayload } from "../../src/autonomous/pending-artifacts.js";
import { makeIssue, makeState } from "./test-factories.js";

const NEW_DISPOSITIONS = ["pre_existing", "accepted_out_of_scope", "forced_landing"] as const;
const ISS1154_DISPOSITIONS = ["escalate_only", "owner_gated", "duplicate"] as const;

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

async function newProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "iss1113-"));
  tmpDirs.push(root);
  await initProject(root, { name: "test" });
  return root;
}

function baseCreateArgs(overrides: Record<string, unknown> = {}) {
  return {
    title: "A filed finding",
    severity: "medium",
    impact: "Something a reviewer saw.",
    components: ["core"],
    relatedTickets: [],
    location: [],
    ...overrides,
  } as Parameters<typeof handleIssueCreate>[0];
}

async function soleIssueFile(root: string): Promise<Record<string, unknown>> {
  const dir = join(root, ".story", "issues");
  const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  expect(names).toHaveLength(1);
  return JSON.parse(await readFile(join(dir, names[0]!), "utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

describe("IssueSchema.disposition carries the three new values (ISS-1113)", () => {
  it.each(NEW_DISPOSITIONS)("accepts %s", (disposition) => {
    const parsed = IssueSchema.safeParse({ ...makeIssue({ id: "ISS-001" }), disposition });
    expect(parsed.success).toBe(true);
  });

  /**
   * The ISS-1154 three are asserted alongside them because this change EXTENDS
   * one enum rather than adding a second field, and a replacement that dropped
   * the originals would otherwise pass every other test in this file.
   */
  it.each(ISS1154_DISPOSITIONS)("still accepts the ISS-1154 value %s", (disposition) => {
    const parsed = IssueSchema.safeParse({ ...makeIssue({ id: "ISS-001" }), disposition });
    expect(parsed.success).toBe(true);
  });

  it("still refuses a value that is not in the enum", () => {
    const parsed = IssueSchema.safeParse({
      ...makeIssue({ id: "ISS-001" }),
      disposition: "not_a_disposition",
    });
    expect(parsed.success).toBe(false);
  });

  it("lists exactly the six non-actionable values, in one place", () => {
    expect([...NON_ACTIONABLE_DISPOSITIONS].sort()).toEqual(
      [...ISS1154_DISPOSITIONS, ...NEW_DISPOSITIONS].sort(),
    );
    expect(isNonActionableDisposition(undefined)).toBe(false);
    expect(isNonActionableDisposition(null)).toBe(false);
    expect(isNonActionableDisposition("not_a_disposition")).toBe(false);
    for (const d of NON_ACTIONABLE_DISPOSITIONS) expect(isNonActionableDisposition(d)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

describe("handleIssueCreate writes a disposition and review provenance (ISS-1113)", () => {
  it("writes both when they are supplied", async () => {
    const root = await newProject();
    await handleIssueCreate(
      baseCreateArgs({
        disposition: "pre_existing",
        metadata: { review: { origin: "pre-existing", reviewId: "r-7", findingDisposition: "pre_existing" } },
      }),
      "json",
      root,
    );
    const issue = await soleIssueFile(root);
    expect(issue.disposition).toBe("pre_existing");
    expect(issue.metadata).toEqual({
      review: { origin: "pre-existing", reviewId: "r-7", findingDisposition: "pre_existing" },
    });
  });

  /**
   * The backward-compat pin. Not "the fields are absent" -- the WHOLE record is
   * compared against one written by the same call without the new inputs, so a
   * writer that emits `disposition: null` or `metadata: {}` on every ordinary
   * create fails here even though both would satisfy a field-by-field check.
   */
  it("writes an issue byte-identical to today's when neither is supplied", async () => {
    const root = await newProject();
    await handleIssueCreate(baseCreateArgs(), "json", root);
    const issue = await soleIssueFile(root);
    expect(Object.keys(issue)).not.toContain("disposition");
    expect(Object.keys(issue)).not.toContain("metadata");
    // `discoveredDate` is the only clock-derived field and it is date-only, so
    // the record is otherwise fully determined by the inputs.
    expect(issue).toEqual({
      id: "ISS-001",
      title: "A filed finding",
      status: "open",
      severity: "medium",
      components: ["core"],
      impact: "Something a reviewer saw.",
      resolution: null,
      location: [],
      discoveredDate: issue.discoveredDate,
      resolvedDate: null,
      relatedTickets: [],
      phase: null,
    });
  });

  it("refuses a disposition outside the enum and writes nothing", async () => {
    const root = await newProject();
    await expect(
      handleIssueCreate(baseCreateArgs({ disposition: "not_a_disposition" }), "json", root),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      handleIssueCreate(baseCreateArgs({ disposition: "not_a_disposition" }), "json", root),
    ).rejects.toBeInstanceOf(CliValidationError);
    const names = (await readdir(join(root, ".story", "issues"))).filter((n) => n.endsWith(".json"));
    expect(names).toEqual([]);
  });

  it.each([
    ["an array", ["not", "a", "bag"]],
    ["a string", "review"],
    ["a number", 7],
    ["null", null],
  ])("refuses metadata that is %s, and writes nothing", async (_label, metadata) => {
    const root = await newProject();
    await expect(
      handleIssueCreate(baseCreateArgs({ metadata } as never), "json", root),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const names = (await readdir(join(root, ".story", "issues"))).filter((n) => n.endsWith(".json"));
    expect(names).toEqual([]);
  });

  it("accepts an empty metadata object, since the contents are nobody's business here", async () => {
    const root = await newProject();
    await handleIssueCreate(baseCreateArgs({ metadata: {} }), "json", root);
    expect((await soleIssueFile(root)).metadata).toEqual({});
  });

  it("accepts every value the enum carries, including the ISS-1154 three", async () => {
    for (const disposition of NON_ACTIONABLE_DISPOSITIONS) {
      const root = await newProject();
      await handleIssueCreate(baseCreateArgs({ disposition }), "json", root);
      expect((await soleIssueFile(root)).disposition).toBe(disposition);
    }
  });
});

// ---------------------------------------------------------------------------
// The consumers
// ---------------------------------------------------------------------------

describe("computeActionability treats the three new values as non-actionable (ISS-1113)", () => {
  function verdict(disposition?: string) {
    const issue = makeIssue({ id: "ISS-001", ...(disposition ? { disposition } : {}) } as never);
    return computeActionability("issue", issue, {
      state: makeState({ issues: [issue] }),
      latestDispositionById: new Map(),
    });
  }

  it.each(NEW_DISPOSITIONS)("excludes %s with a structured verdict", (disposition) => {
    const a = verdict(disposition);
    expect(a.status).toBe(disposition);
    expect(a.source).toBe("structured");
  });

  it("still ranks an issue that carries no disposition", () => {
    expect(verdict().status).toBe("actionable");
  });
});

describe("the open-issue count keeps its published meaning (ISS-1113)", () => {
  /**
   * `openIssues` IS `activeIssueCount`, and `ISSUE_FLOW_SEMANTICS.open`
   * publishes that equality; federation's scanner, its cache and the
   * backlog-pressure ratio in `recommend` all read the same number. Narrowing
   * it to mean "actionable" would change federation recommendations silently,
   * so the count is ADDED beside it rather than redefined.
   */
  it("counts a non-actionable issue as open, and excludes it from the actionable subset", () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001" }),
        makeIssue({ id: "ISS-002", disposition: "pre_existing" } as never),
        makeIssue({ id: "ISS-003", disposition: "forced_landing" } as never),
        makeIssue({ id: "ISS-004", disposition: "owner_gated" } as never),
        makeIssue({ id: "ISS-005", status: "resolved" }),
      ],
    });
    expect(state.activeIssueCount).toBe(4);
    expect(state.actionableOpenIssueCount).toBe(1);
  });

  it("is identical to the open count when nothing carries a disposition", () => {
    const state = makeState({
      issues: [makeIssue({ id: "ISS-001" }), makeIssue({ id: "ISS-002" })],
    });
    expect(state.actionableOpenIssueCount).toBe(state.activeIssueCount);
  });

  function statusPayload(state: ReturnType<typeof makeState>, compact: boolean): Record<string, unknown> {
    const parsed = JSON.parse(
      formatStatus(
        state, "json", [], [], undefined, [], undefined, [],
        { items: [], warnings: [] }, compact,
      ),
    ) as { data?: Record<string, unknown> } & Record<string, unknown>;
    return parsed.data ?? parsed;
  }

  /**
   * Through `formatStatus` rather than the field alone: a count that never
   * reaches the status surface is a count nobody reads, and the JSON payload
   * is what the skill and the Mac app consume.
   */
  it("reports both numbers in the full status payload", () => {
    const payload = statusPayload(withMixedIssues(), false);
    expect(payload.openIssues).toBe(3);
    expect(payload.actionableOpenIssues).toBe(1);
  });

  /**
   * And NOT in the compact one. T-320 pinned that payload's key list as an
   * exact contract (`status-roster.test.ts` compares `Object.keys` to it
   * verbatim), so a field added here would fail that test rather than merely
   * enlarge a payload -- and widening another ticket's reduced shape is not
   * this slice's call to make. The markdown line carries the number for a
   * reader in both shapes, and nothing reads it programmatically.
   */
  it("leaves the compact payload's pinned key list alone", () => {
    const payload = statusPayload(withMixedIssues(), true);
    expect(payload.openIssues).toBe(3);
    expect(Object.keys(payload)).not.toContain("actionableOpenIssues");
  });

  it("names the non-actionable ones in the markdown status, and only when there are some", () => {
    const md = formatStatus(withMixedIssues(), "md");
    expect(md).toContain("2 non-actionable, not ranked as work");

    const clean = formatStatus(
      makeState({ issues: [makeIssue({ id: "ISS-001" })] }),
      "md",
    );
    expect(clean).not.toContain("non-actionable");
  });
});

function withMixedIssues() {
  return makeState({
    issues: [
      makeIssue({ id: "ISS-001" }),
      makeIssue({ id: "ISS-002", disposition: "pre_existing" } as never),
      makeIssue({ id: "ISS-003", disposition: "owner_gated" } as never),
      makeIssue({ id: "ISS-004", status: "resolved" }),
    ],
  });
}

// ---------------------------------------------------------------------------
// The recovery-record digest
// ---------------------------------------------------------------------------

describe("issueCreateFingerprint covers the new fields without moving (ISS-1113/ISS-1221)", () => {
  const PIN_PAYLOAD = {
    title: "Pin payload",
    severity: "medium",
    impact: "A payload written before the disposition slice.",
    components: ["core"],
    relatedTickets: [],
    location: ["src/core/x.ts:1"],
    dedupeKey: "iss1113:pin:1",
    phase: "p1",
  } as const;

  /**
   * Captured from the implementation BEFORE this change and hard-coded, which
   * is the point: `resolveIssueCreatePayload` recomputes this digest and
   * quarantines a record whose stored fingerprint does not match, so a digest
   * that moves turns every pending `issue_create` record written by an older
   * build into `malformed-record` on resume. Digesting the two new keys
   * unconditionally is exactly that move, and this is what catches it.
   */
  const PIN_WITH_PHASE = "22555f5a3fdb1f8d42a42c6093b20924";
  const PIN_WITHOUT_PHASE = "b29a3ec705033a986f044b6f9a47b37d";

  it("digests a pre-slice payload to exactly the value it digested before", () => {
    expect(issueCreateFingerprint({ ...PIN_PAYLOAD })).toBe(PIN_WITH_PHASE);
    const noPhase: Record<string, unknown> = { ...PIN_PAYLOAD };
    delete noPhase.phase;
    expect(issueCreateFingerprint(noPhase)).toBe(PIN_WITHOUT_PHASE);
  });

  it("digests a payload carrying a disposition differently from one without", () => {
    const withDisposition = issueCreateFingerprint({ ...PIN_PAYLOAD, disposition: "pre_existing" });
    expect(withDisposition).not.toBeNull();
    expect(withDisposition).not.toBe(PIN_WITH_PHASE);
  });

  it("distinguishes one disposition from another, and metadata from none", () => {
    const a = issueCreateFingerprint({ ...PIN_PAYLOAD, disposition: "pre_existing" });
    const b = issueCreateFingerprint({ ...PIN_PAYLOAD, disposition: "forced_landing" });
    expect(a).not.toBe(b);
    const withMeta = issueCreateFingerprint({
      ...PIN_PAYLOAD,
      metadata: { review: { origin: "pre-existing" } },
    });
    expect(withMeta).not.toBe(PIN_WITH_PHASE);
  });

  /**
   * `metadata` is a free-form bag of arbitrary depth read off disk, and the
   * digest walks it. A top-level-only guard (`ownFields`) copies nested values
   * by reference, so each of these reaches the serializer and takes the
   * RECOVERING SESSION down instead of quarantining one record -- a getter is
   * invoked, a cycle recurses until the stack gives out, a BigInt throws in
   * JSON.stringify. Quarantine (null) is the required answer, and it must be
   * the same answer on both sides or a payload the reader accepts could never
   * match its own fingerprint.
   */
  describe("a metadata bag that cannot be canonicalized quarantines rather than throwing", () => {
    function cases(): [string, unknown][] {
      const cyclic: Record<string, unknown> = { review: {} };
      (cyclic.review as Record<string, unknown>).self = cyclic;
      const nestedGetter = {
        review: Object.defineProperty({}, "origin", {
          get() { throw new Error("nested getter invoked"); },
          enumerable: true,
          configurable: true,
        }),
      };
      return [
        ["a nested getter", nestedGetter],
        ["a cycle", cyclic],
        ["a nested BigInt", { review: { count: 1n } }],
        ["a nested function", { review: { fn: () => 1 } }],
        ["a nested NaN", { review: { score: Number.NaN } }],
        ["an array at the top", [{ review: {} }]],
        ["a string at the top", "review"],
      ];
    }

    it.each(cases())("the digest refuses %s", (_label, metadata) => {
      expect(() => issueCreateFingerprint({ ...PIN_PAYLOAD, metadata })).not.toThrow();
      expect(issueCreateFingerprint({ ...PIN_PAYLOAD, metadata })).toBeNull();
    });

    it.each(cases())("the reader refuses %s, the same way", (_label, metadata) => {
      expect(() => readIssueCreatePayload({ ...PIN_PAYLOAD, metadata })).not.toThrow();
      expect(readIssueCreatePayload({ ...PIN_PAYLOAD, metadata })).toBeNull();
    });

    it("a plain nested bag is accepted by both, and survives the read intact", () => {
      const metadata = { review: { origin: "pre-existing", depth: { a: [1, 2, "x"] } } };
      expect(issueCreateFingerprint({ ...PIN_PAYLOAD, metadata })).not.toBeNull();
      expect(readIssueCreatePayload({ ...PIN_PAYLOAD, metadata })?.metadata).toEqual(metadata);
    });

    it("an empty bag is still distinguishable from no bag at all", () => {
      expect(issueCreateFingerprint({ ...PIN_PAYLOAD, metadata: {} })).not.toBe(PIN_WITH_PHASE);
    });
  });

  /**
   * The tamper case, and the reason the fields are digested at all rather than
   * left out: a stored record whose disposition is edited after the fact must
   * stop matching its own recorded fingerprint.
   */
  it("stops matching when a stored disposition is edited after the fact", () => {
    const stored = { ...PIN_PAYLOAD, disposition: "accepted_out_of_scope" };
    const recorded = issueCreateFingerprint(stored);
    expect(recorded).not.toBeNull();
    const tampered = { ...stored, disposition: "pre_existing" };
    expect(issueCreateFingerprint(tampered)).not.toBe(recorded);
  });
});
