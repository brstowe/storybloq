import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHandoverBrief,
  PRIMING_RAW_BODY_MAX_BYTES,
  type HandoverBriefEntry,
} from "../../src/core/handover-brief.js";

/**
 * T-320 commit 2: cross-handover orchestrator built on commit 1's shared
 * parser (markdown-sections.ts). Uses real temp files (readHandover reads
 * from disk) rather than mocking, matching this module's own I/O boundary.
 */

const tmpDirs: string[] = [];

async function makeHandoversDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "handover-brief-"));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf-8");
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

const SMALL_HANDOVER = `# Handover: small

## Next
- T-001: finish the thing
`;

function paddedHandover(id: string, padBytes: number): string {
  // A single continuation bullet plus enough trailing filler prose (kept out
  // of any recognized section so it does not create extra records) to push
  // the raw body to a specific byte size.
  const filler = "x".repeat(Math.max(0, padBytes));
  return `# Handover: ${id}\n\n## Next\n- ${id}: keep going\n\n${filler}\n`;
}

describe("buildHandoverBrief: default-off boundary", () => {
  it("returns a structured entry for brief:true", async () => {
    const dir = await makeHandoversDir({ "h1.md": SMALL_HANDOVER });
    const result = await buildHandoverBrief(dir, ["h1.md"], { brief: true, priming: false });
    expect(result.handovers).toHaveLength(1);
    const entry = result.handovers[0] as HandoverBriefEntry;
    expect(entry.form).toBe("structured");
    if (entry.form === "structured") {
      expect(entry.records.map((r) => r.id)).toContain("T-001");
    }
  });
});

describe("buildHandoverBrief: priming trigger boundary (pen ruling: 12000 exact stays raw)", () => {
  it("stays raw when the body is exactly PRIMING_RAW_BODY_MAX_BYTES", async () => {
    // Build a body whose exact byte length is the trigger constant.
    const base = paddedHandover("T-100", 0);
    const pad = PRIMING_RAW_BODY_MAX_BYTES - byteLength(base);
    const body = paddedHandover("T-100", pad);
    expect(byteLength(body)).toBe(PRIMING_RAW_BODY_MAX_BYTES);

    const dir = await makeHandoversDir({ "h1.md": body });
    const result = await buildHandoverBrief(dir, ["h1.md"], { brief: false, priming: true });
    const entry = result.handovers[0] as HandoverBriefEntry;
    expect(entry.form).toBe("raw");
    if (entry.form === "raw") expect(entry.body).toBe(body);
  });

  it("downgrades to structured at one byte over the trigger", async () => {
    const base = paddedHandover("T-100", 0);
    const pad = PRIMING_RAW_BODY_MAX_BYTES - byteLength(base) + 1;
    const body = paddedHandover("T-100", pad);
    expect(byteLength(body)).toBe(PRIMING_RAW_BODY_MAX_BYTES + 1);

    const dir = await makeHandoversDir({ "h1.md": body });
    const result = await buildHandoverBrief(dir, ["h1.md"], { brief: false, priming: true });
    const entry = result.handovers[0] as HandoverBriefEntry;
    expect(entry.form).toBe("structured");
  });

  it("stays raw for a small body under priming, byte for byte", async () => {
    const dir = await makeHandoversDir({ "h1.md": SMALL_HANDOVER });
    const result = await buildHandoverBrief(dir, ["h1.md"], { brief: false, priming: true });
    const entry = result.handovers[0] as HandoverBriefEntry;
    expect(entry.form).toBe("raw");
    if (entry.form === "raw") expect(entry.body).toBe(SMALL_HANDOVER);
  });
});

describe("buildHandoverBrief: both flags set", () => {
  it("structured wins even for a small body (brief overrides priming's raw path)", async () => {
    const dir = await makeHandoversDir({ "h1.md": SMALL_HANDOVER });
    const result = await buildHandoverBrief(dir, ["h1.md"], { brief: true, priming: true });
    const entry = result.handovers[0] as HandoverBriefEntry;
    expect(entry.form).toBe("structured");
  });
});

describe("buildHandoverBrief: default mode is not this module's concern", () => {
  it("neither flag set still parses nothing -- both forms only ever trigger via brief or priming", async () => {
    const dir = await makeHandoversDir({ "h1.md": SMALL_HANDOVER });
    const result = await buildHandoverBrief(dir, ["h1.md"], { brief: false, priming: false });
    const entry = result.handovers[0] as HandoverBriefEntry;
    expect(entry.form).toBe("raw");
  });
});

describe("buildHandoverBrief: filename admission gate", () => {
  it("skips a handover whose JSON-escaped filename exceeds 300 bytes", async () => {
    // The admission check runs BEFORE any read, so the oversized name never
    // needs to exist on disk (real filesystems cap filenames well under 300
    // bytes anyway -- this name is deliberately longer than any real file
    // could be, to prove the gate never attempts to open it).
    const longName = "a".repeat(310) + ".md";
    const dir = await makeHandoversDir({ "h1.md": SMALL_HANDOVER });
    const result = await buildHandoverBrief(dir, ["h1.md", longName], { brief: true, priming: false });
    expect(result.handovers.map((h) => h.filename)).toEqual(["h1.md"]);
    expect(result.skippedHandovers).toBe(1);
  });
});

describe("buildHandoverBrief: missing handover tolerance (pen finding: one ENOENT must not fail the whole window)", () => {
  it("drops a listed-but-missing file from the window instead of throwing, and counts it", async () => {
    const dir = await makeHandoversDir({ "h1.md": SMALL_HANDOVER });
    // "h2.md" is listed (as the state scan would list it) but was never
    // written -- e.g. deleted or renamed between the scan and this read.
    const result = await buildHandoverBrief(dir, ["h1.md", "h2.md"], { brief: false, priming: true });
    expect(result.handovers.map((h) => h.filename)).toEqual(["h1.md"]);
    expect(result.missingHandovers).toBe(1);
  });

  it("returns an empty window (not a throw) when every listed file is missing", async () => {
    const dir = await makeHandoversDir({});
    const result = await buildHandoverBrief(dir, ["ghost.md"], { brief: false, priming: true });
    expect(result.handovers).toEqual([]);
    expect(result.missingHandovers).toBe(1);
  });
});

describe("buildHandoverBrief: cross-handover budget (newest never demoted)", () => {
  it("keeps the newest handover in structured form even when older ones must demote to index-only", async () => {
    // Ten handovers, each forced structured, each padded to sit near the
    // per-handover 1,600-byte cap so the 14,200-byte cross-handover budget
    // (10 x ~1600 = ~16,000) cannot hold all ten in full form.
    const files: Record<string, string> = {};
    const filenames: string[] = [];
    for (let i = 0; i < 10; i++) {
      const name = `h${String(i).padStart(2, "0")}.md`;
      filenames.push(name);
      // Many bullets, each with a long rationale sentence, push each
      // handover's own structured form up near its 1,600-byte cap (commit
      // 1's selectBoundedRecords already enforces that per-handover) -- ten
      // of those summed comfortably exceeds the 14,200-byte cross-handover
      // budget, which is what this test needs to actually bind.
      const bullets = Array.from({ length: 10 }, (_, j) =>
        `- T-${100 * (i + 1) + j}: keep going. because this is a long rationale sentence padding out the record. `,
      ).join("\n");
      files[name] = `# Handover: ${name}\n\n## Next\n${bullets}\n`;
    }
    const dir = await makeHandoversDir(files);

    const result = await buildHandoverBrief(dir, filenames, { brief: true, priming: false });
    expect(result.handovers).toHaveLength(10);
    expect(result.handovers[0]!.form).toBe("structured");

    const forms = result.handovers.map((h) => h.form);
    const demotedCount = forms.filter((f) => f === "index-only").length;
    // With this fixture the cross-handover budget must actually bind (the
    // fixture is deliberately oversized for it); if this assertion ever
    // fails because the module's byte accounting changed, the fixture size
    // needs revisiting, not this invariant.
    expect(demotedCount).toBeGreaterThan(0);
    expect(forms.every((f) => f === "structured" || f === "index-only")).toBe(true);

    // The actual byte promise: the structured slice (H) is respected, not
    // just "something got demoted." Sum every entry exactly as
    // structuredEntryBytes would (filename + form + records/index).
    const structuredBytes = result.handovers.reduce((sum, h) => {
      if (h.form === "raw") return sum;
      const body = h.form === "structured" ? { records: h.records, index: h.index } : { index: h.index };
      return sum + Buffer.byteLength(JSON.stringify({ filename: h.filename, form: h.form, ...body }), "utf-8");
    }, 0);
    expect(structuredBytes).toBeLessThanOrEqual(14_200);
  });

  it("T-498 commit 2: continuationCandidates on handovers[0] does not change handovers 1-9's demotion boundary or consume the 14,200-byte structured budget", async () => {
    // Reuses the EXACT fixture from the test above ("keeps the newest
    // handover in structured form..."), byte for byte. Measured empirically
    // (a scratch tsx script against this same fixture, pre-T-498) BEFORE any
    // T-498 commit 2 code touched budget accounting: demotedCount = 2 (the
    // two OLDEST handovers, indices 8 and 9, demote to index-only; indices
    // 0-7 stay structured) and structuredBytes = 13,092 (under the
    // 14,200-byte cap). This test pins both numbers and proves they are
    // UNCHANGED now that `continuationCandidates` is threaded onto
    // handovers[0] -- the plan's named mutant (c) is exactly a regression
    // that would move continuationCandidates' bytes INTO this sum instead
    // of its own separate 800-byte reserve, which would change one or both
    // of these pinned numbers.
    const files: Record<string, string> = {};
    const filenames: string[] = [];
    for (let i = 0; i < 10; i++) {
      const name = `h${String(i).padStart(2, "0")}.md`;
      filenames.push(name);
      const bullets = Array.from({ length: 10 }, (_, j) =>
        `- T-${100 * (i + 1) + j}: keep going. because this is a long rationale sentence padding out the record. `,
      ).join("\n");
      files[name] = `# Handover: ${name}\n\n## Next\n${bullets}\n`;
    }
    const dir = await makeHandoversDir(files);

    const result = await buildHandoverBrief(dir, filenames, { brief: true, priming: false });
    expect(result.handovers).toHaveLength(10);

    const forms = result.handovers.map((h) => h.form);
    const demotedCount = forms.filter((f) => f === "index-only").length;
    expect(demotedCount).toBe(2);
    expect(forms.slice(0, 8).every((f) => f === "structured")).toBe(true);
    expect(forms.slice(8)).toEqual(["index-only", "index-only"]);

    const structuredBytes = result.handovers.reduce((sum, h) => {
      if (h.form === "raw") return sum;
      const body = h.form === "structured" ? { records: h.records, index: h.index } : { index: h.index };
      return sum + Buffer.byteLength(JSON.stringify({ filename: h.filename, form: h.form, ...body }), "utf-8");
    }, 0);
    expect(structuredBytes).toBe(13_092);
    expect(structuredBytes).toBeLessThanOrEqual(14_200);

    // continuationCandidates itself: present only on handovers[0], and its
    // own JSON-serialized bytes fit its separate 800-byte reserve.
    const first = result.handovers[0]!;
    expect(first.form).toBe("structured");
    if (first.form !== "structured") throw new Error("unreachable");
    expect(first.continuationCandidates).toBeDefined();
    const candidatesBytes = Buffer.byteLength(JSON.stringify(first.continuationCandidates), "utf-8");
    expect(candidatesBytes).toBeLessThanOrEqual(800);

    // None of handovers[1..9] carry continuationCandidates -- decision 1
    // scopes it to the newest handover only.
    for (const h of result.handovers.slice(1)) {
      if (h.form === "structured") {
        expect(h.continuationCandidates).toBeUndefined();
      }
    }
  });

  it("T-498 commit 2 (Codex round 1 finding: the wider fixture above has too much slack to actually exercise mutant (c)): a tighter fixture where the demotion boundary sits close enough to 14,200 that charging continuationCandidates' bytes into the shared budget would force an additional demotion", async () => {
    // Same construction as the wider fixture, sized (9 bullets/handover, a
    // doubled rationale sentence) so the retained structured total leaves
    // only 617 bytes of margin under 14,200 -- less than handovers[0]'s own
    // measured continuationCandidates size (666 bytes on this exact
    // fixture). Both numbers were measured empirically (a scratch tsx
    // script against this exact fixture) BEFORE this test was written:
    // demotedCount = 1 (only the oldest handover, index 9, demotes) and
    // structuredBytes = 13,583. A regression that charged
    // continuationCandidates against the shared 14,200-byte budget instead
    // of its own separate reserve would push handovers[0]'s effective cost
    // from ~1,600 to ~2,266 bytes, consuming the 617-byte margin and forcing
    // at least one more handover to demote -- which would change
    // `demotedCount` and fail this test.
    const files: Record<string, string> = {};
    const filenames: string[] = [];
    for (let i = 0; i < 10; i++) {
      const name = `h${String(i).padStart(2, "0")}.md`;
      filenames.push(name);
      const bullets = Array.from({ length: 9 }, (_, j) =>
        `- T-${100 * (i + 1) + j}: keep going. ` +
        "because this is a long rationale sentence padding out the record. ".repeat(2),
      ).join("\n");
      files[name] = `# Handover: ${name}\n\n## Next\n${bullets}\n`;
    }
    const dir = await makeHandoversDir(files);

    const result = await buildHandoverBrief(dir, filenames, { brief: true, priming: false });
    const forms = result.handovers.map((h) => h.form);
    const demotedCount = forms.filter((f) => f === "index-only").length;
    expect(demotedCount).toBe(1);
    expect(forms.slice(0, 9).every((f) => f === "structured")).toBe(true);
    expect(forms[9]).toBe("index-only");

    const structuredBytes = result.handovers.reduce((sum, h) => {
      if (h.form === "raw") return sum;
      const body = h.form === "structured" ? { records: h.records, index: h.index } : { index: h.index };
      return sum + Buffer.byteLength(JSON.stringify({ filename: h.filename, form: h.form, ...body }), "utf-8");
    }, 0);
    expect(structuredBytes).toBe(13_583);
    expect(14_200 - structuredBytes).toBeLessThan(800);

    const first = result.handovers[0]!;
    if (first.form !== "structured") throw new Error("unreachable");
    const candidatesBytes = Buffer.byteLength(JSON.stringify(first.continuationCandidates), "utf-8");
    // The margin left in the shared budget is smaller than what
    // continuationCandidates itself costs -- exactly the condition under
    // which mutant (c) would visibly change demotedCount/structuredBytes.
    expect(candidatesBytes).toBeGreaterThan(14_200 - structuredBytes);
  });

  it("lets an older, smaller entry stay structured after an earlier larger one demotes (no false starvation from a strict suffix rule)", async () => {
    // Entry 0 (newest) is huge -- forced full regardless of budget. Entries
    // 1..8 are each independently large enough that entry 0 alone should not
    // be able to push ALL of them to index-only if the algorithm is doing a
    // real per-entry fit check rather than a blanket "everything after a
    // demotion is also demoted" rule. Entry 9 (oldest) is tiny, so once the
    // bigger middle entries have been priced in, it should still fit in full.
    const files: Record<string, string> = {};
    const filenames: string[] = [];
    const bigBullets = (n: number) =>
      Array.from({ length: n }, (_, j) => `- T-${j}: keep going, a longish rationale sentence padding this out. `).join("\n");
    for (let i = 0; i < 9; i++) {
      const name = `h${String(i).padStart(2, "0")}.md`;
      filenames.push(name);
      files[name] = `# Handover: ${name}\n\n## Next\n${bigBullets(10)}\n`;
    }
    const tinyName = "h09.md";
    filenames.push(tinyName);
    files[tinyName] = `# Handover: ${tinyName}\n\n## Next\n- T-999: tiny\n`;

    const dir = await makeHandoversDir(files);
    const result = await buildHandoverBrief(dir, filenames, { brief: true, priming: false });
    const last = result.handovers[result.handovers.length - 1]!;
    expect(last.filename).toBe(tinyName);
    // With this exact fixture, h08 (second-oldest, still large) demotes to
    // index-only, and h09 (oldest, tiny) still lands structured -- verified
    // empirically before writing this assertion, not assumed. Without this
    // check the test would also pass if EVERY entry stayed structured (a
    // demotion never actually happening at all), which proves nothing about
    // starvation.
    const secondToLast = result.handovers[result.handovers.length - 2]!;
    expect(secondToLast.form).toBe("index-only");
    // The tiny oldest entry is not starved into index-only purely because
    // an earlier (non-adjacent) entry demoted -- the suffix-reserve check
    // prices in only the ACTUAL index-only cost of what remains, not the
    // full cost of every earlier entry.
    expect(last.form).toBe("structured");
  });
});

describe("buildHandoverBrief: trajectory", () => {
  it("includes ids from structured handovers in the trajectory list", async () => {
    const dir = await makeHandoversDir({
      "h1.md": "# Handover: h1\n\n## Next\n- T-200: step one\n",
      "h2.md": "# Handover: h2\n\n## Next\n- T-200: step one continued\n",
    });
    const result = await buildHandoverBrief(dir, ["h1.md", "h2.md"], { brief: true, priming: false });
    const entry = result.trajectory.find((t) => t.id === "T-200");
    expect(entry).toBeDefined();
    expect(entry!.occurrenceCount).toBe(2);
  });

  it("caps the trajectory list to 1,600 serialized bytes with hundreds of unique ids", async () => {
    const lines: string[] = ["# Handover: many\n", "\n## Next\n"];
    for (let i = 0; i < 400; i++) {
      lines.push(`- T-${1000 + i}: item number ${i}\n`);
    }
    const dir = await makeHandoversDir({ "h1.md": lines.join("") });
    const result = await buildHandoverBrief(dir, ["h1.md"], { brief: true, priming: false });
    expect(byteLength(JSON.stringify(result.trajectory))).toBeLessThanOrEqual(1600);
    // With 400 unique ids, the cap must actually have dropped some.
    expect(result.trajectory.length).toBeLessThan(400);
  });
});
