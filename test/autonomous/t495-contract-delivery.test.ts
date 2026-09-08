/**
 * T-495 WRITER, D1 and D2: the contract's content hash, and the delivery
 * record that says which contract text a reviewer actually received.
 *
 * The measurement this ticket exists to produce is a capping rate. A finding
 * that names no principle is capped, and a reviewer who never RECEIVED the
 * principle list produces exactly the same finding as one who read the list and
 * declined to name anything. Without a delivery record the two are one number,
 * and that number would be read as evidence about reviewer behaviour when half
 * of it may be evidence about plumbing. That is this ticket's declared failure
 * class: an absence reading as a zero.
 *
 * Every test below names the WRONG IMPLEMENTATION it refuses, because a test
 * that only asserts the right answer passes over the wrong one whenever the
 * wrong one happens to agree on the fixture.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReviewContract } from "../../src/autonomous/review-contract.js";
import {
  appendContractDelivery,
  readContractDeliveries,
  resolveDelivery,
  type ContractDeliveryEntry,
} from "../../src/autonomous/principle-policy-report.js";
import { buildReviewContextPacket } from "../../src/autonomous/review-context-packet.js";
import { packageContext } from "../../src/autonomous/lens-harness/context-packager.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "t495-delivery-"));
  dirs.push(root);
  return root;
}

function newSessionDir(): string {
  const root = newRoot();
  const dir = join(root, ".story", "sessions", "s1");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const CONTRACT = [
  "# Review contract",
  "",
  "## Robustness",
  "",
  "Behaves under the inputs it will meet.",
  "",
  "Blocking: blocking",
  "",
].join("\n");

function entry(over: Partial<ContractDeliveryEntry> = {}): ContractDeliveryEntry {
  return {
    sessionId: "sess-1",
    target: "T-001",
    itemAttemptId: "att-1",
    stage: "code",
    generation: 1,
    roundNum: 2,
    leg: "packet",
    reviewMdIncluded: true,
    omissionReason: null,
    contentHash: "hash-A",
    sourceChars: 100,
    sourceBytes: 100,
    deliveredChars: 100,
    truncated: false,
    truncatedAtChars: null,
    timestamp: "2026-09-10T00:00:00.000Z",
    ...over,
  };
}

// ── D1: the contract's own hash ──────────────────────────────────

describe("T-495 D1: contentHash on ReviewContract, at parse", () => {
  it("T21a: hashes the source bytes of the same read the text came from", () => {
    const root = newRoot();
    writeFileSync(join(root, "REVIEW.md"), CONTRACT, "utf-8");
    const contract = loadReviewContract(root);
    const expected = createHash("sha256").update(Buffer.from(CONTRACT, "utf-8")).digest("hex");
    expect(contract.contentHash).toBe(expected);
    // The text and the hash come from ONE read. A second read at a call site
    // could hash a file that changed in between, and the record would then name
    // a contract the reviewer never got.
    expect(contract.text).toBe(CONTRACT);
  });

  it("T21: contentHash is null when REVIEW.md is absent, never the empty-string hash", () => {
    const contract = loadReviewContract(newRoot());
    expect(contract.status).toBe("absent");
    expect(contract.contentHash).toBeNull();
    // Refuses hashing "": that hash is a real, stable, equal-to-itself value,
    // so two projects with no contract would agree on a baseline and read as
    // having received the same one.
    const emptyHash = createHash("sha256").update(Buffer.from("", "utf-8")).digest("hex");
    expect(contract.contentHash).not.toBe(emptyHash);
  });

  it("T21b: contentHash is null when the file is unreadable, which is not absence", () => {
    const root = newRoot();
    // A directory at the path: readFileSync fails with EISDIR, not ENOENT.
    mkdirSync(join(root, "REVIEW.md"));
    const contract = loadReviewContract(root);
    expect(contract.status).toBe("unparseable");
    expect(contract.contentHash).toBeNull();
  });

  it("T20: sourceBytes counts BYTES and the char count is separate", () => {
    const root = newRoot();
    // Two characters, four bytes. A test over ASCII cannot tell the two apart.
    const text = `${CONTRACT}\n\nNote: 你好\n`;
    writeFileSync(join(root, "REVIEW.md"), text, "utf-8");
    const contract = loadReviewContract(root);
    expect(contract.text!.length).toBe(text.length);
    expect(Buffer.byteLength(text, "utf-8")).toBeGreaterThan(text.length);
    expect(contract.contentHash)
      .toBe(createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex"));
  });
});

// ── D2: the delivery record ──────────────────────────────────────

describe("T-495 D2: the delivery log round-trips", () => {
  it("appends one JSONL line per call and reads them back in order", () => {
    const dir = newSessionDir();
    expect(appendContractDelivery(dir, entry({ roundNum: 1 })).ok).toBe(true);
    expect(appendContractDelivery(dir, entry({ roundNum: 2 })).ok).toBe(true);
    const raw = readFileSync(join(dir, "contract-delivery.jsonl"), "utf-8");
    expect(raw.trimEnd().split("\n")).toHaveLength(2);
    const read = readContractDeliveries(dir);
    expect(read.readFailed).toBe(false);
    expect(read.entries.map((e) => e.roundNum)).toEqual([1, 2]);
  });

  it("reports an absent log as absent, not as a read failure", () => {
    const read = readContractDeliveries(newSessionDir());
    expect(read.entries).toEqual([]);
    // The distinction is load-bearing downstream: a read FAILURE is a degraded
    // record naming its failedAt, while an absent log is null-delivery.
    expect(read.readFailed).toBe(false);
  });

  it("skips an unparseable line rather than losing the whole log", () => {
    const dir = newSessionDir();
    appendContractDelivery(dir, entry({ roundNum: 1 }));
    writeFileSync(join(dir, "contract-delivery.jsonl"),
      `${readFileSync(join(dir, "contract-delivery.jsonl"), "utf-8")}{not json\n`, "utf-8");
    appendContractDelivery(dir, entry({ roundNum: 3 }));
    expect(readContractDeliveries(dir).entries.map((e) => e.roundNum)).toEqual([1, 3]);
  });
});

describe("T-495 D2: an unreadable line is not a line that is not there", () => {
  // Every test here exists because the corresponding FIX had no test and its
  // mutant survived the gate. A fix nothing can fail on establishes nothing,
  // which is this ticket's subject applied to its own repair.

  const KEY2 = {
    sessionId: "sess-1", target: "T-001", itemAttemptId: "att-1",
    stage: "code", generation: 1, roundNum: 2,
  };

  it("counts a torn line, and a torn line makes a surviving match AMBIGUOUS", () => {
    const dir = newSessionDir();
    appendContractDelivery(dir, entry());
    writeFileSync(join(dir, "contract-delivery.jsonl"),
      `${readFileSync(join(dir, "contract-delivery.jsonl"), "utf-8")}{not json\n`, "utf-8");

    const log = readContractDeliveries(dir);
    expect(log.entries).toHaveLength(1);
    expect(log.unreadableLines).toBe(1);
    // The unreadable line COULD be a second, contradicting observation for this
    // key, so uniqueness among the lines that parsed is not uniqueness in the
    // log. Calling the survivor `exact` certifies a delivery that may have been
    // contradicted by the line nobody could read.
    expect(resolveDelivery(log.entries, KEY2, log.unreadableLines > 0).binding)
      .toBe("ambiguous");
    // And with a fully readable log the same entry binds exactly, so the
    // difference is the unreadable line and nothing else.
    expect(resolveDelivery(log.entries, KEY2, false).binding).toBe("exact");
  });

  it("a JSON `null` line is counted unreadable rather than entering the entries", () => {
    // Measured: a bare `null` is VALID JSON, so a cast admits it, and the very
    // next `.sessionId` access throws -- degrading a round whose own
    // measurement was fine. Codex found it.
    const dir = newSessionDir();
    appendContractDelivery(dir, entry());
    writeFileSync(join(dir, "contract-delivery.jsonl"),
      `${readFileSync(join(dir, "contract-delivery.jsonl"), "utf-8")}null\n`, "utf-8");
    const log = readContractDeliveries(dir);
    expect(log.entries).toHaveLength(1);
    expect(log.unreadableLines).toBe(1);
    expect(() => resolveDelivery(log.entries, KEY2)).not.toThrow();
  });

  it("a STRING `reviewMdIncluded` is rejected, because a truthy string is not a boolean", () => {
    // `"false"` is truthy. Under a cast, a round whose contract was dropped
    // reads as an exact delivery, which is the false positive the whole
    // measurement rests on not making.
    const dir = newSessionDir();
    const bad = { ...entry(), reviewMdIncluded: "false" };
    writeFileSync(join(dir, "contract-delivery.jsonl"), `${JSON.stringify(bad)}\n`, "utf-8");
    const log = readContractDeliveries(dir);
    expect(Boolean("false")).toBe(true);
    expect(log.entries).toHaveLength(0);
    expect(log.unreadableLines).toBe(1);
    expect(resolveDelivery(log.entries, KEY2, log.unreadableLines > 0).binding)
      .not.toBe("exact");
  });

  it("an incomplete line NAMING another item attempt is absent, not weak", () => {
    // A contradiction in any identity field present on BOTH sides disqualifies
    // the line. `target` and `generation` were checked and `itemAttemptId` was
    // not, so a structurally incomplete line explicitly naming a different
    // attempt was reported as a weak observation of this one. Codex found it.
    const otherAttempt = entry({ generation: null, itemAttemptId: "att-OTHER" });
    expect(resolveDelivery([otherAttempt], KEY2).binding).toBe("absent");
    // The same line with a MATCHING attempt is a genuine weak observation, so
    // the rejection above is about the contradiction and not about the shape.
    const sameAttempt = entry({ generation: null, itemAttemptId: "att-1" });
    expect(resolveDelivery([sameAttempt], KEY2).binding).toBe("weak");
  });

  it("a COMPLETE line for another target is ABSENT here, not a weak observation of this round", () => {
    // Weak means a line that could not carry the whole key, like the lens leg.
    // A complete line naming a different target is evidence about ANOTHER
    // round; reporting it as a weak observation of this one attributes a
    // missing observation to the wrong failure class, so the coverage number
    // quietly describes something else. Codex found it.
    const other = entry({ target: "T-002" });
    expect(resolveDelivery([other], KEY2).binding).toBe("absent");
    const otherGen = entry({ generation: 9 });
    expect(resolveDelivery([otherGen], KEY2).binding).toBe("absent");
  });
});

describe("T-495 D2: binding a round to its delivery line", () => {
  const KEY = {
    sessionId: "sess-1", target: "T-001", itemAttemptId: "att-1",
    stage: "code", generation: 1, roundNum: 2,
  };

  it("T6: binds `exact` only on a unique FULL-key match", () => {
    // The true line plus three near misses, each differing in exactly one key
    // field. A stage-only match, a last-wins match, and any key omitting
    // `target` or `generation` all bind one of the decoys.
    const lines = [
      entry(),
      entry({ generation: 2 }),
      entry({ roundNum: 3 }),
      entry({ target: "T-002" }),
    ];
    const got = resolveDelivery(lines, KEY);
    expect(got.binding).toBe("exact");
    expect(got.entry).not.toBeNull();
    expect(got.entry!.generation).toBe(1);
    expect(got.entry!.target).toBe("T-001");
    expect(got.entry!.roundNum).toBe(2);
  });

  it("T6b: dropping `target` from the key would bind a different item's line", () => {
    // Stated as its own case because it is the mutant, not a variation: with
    // `target` out of the key, the decoy below is a full match and the result
    // is `ambiguous` at best and the WRONG line at worst.
    const lines = [entry(), entry({ target: "T-002" })];
    const got = resolveDelivery(lines, KEY);
    expect(got.binding).toBe("exact");
    expect(got.entry!.target).toBe("T-001");
  });

  it("T7b: two IDENTICAL lines for one key collapse, because a re-entry is not a conflict", () => {
    // MEASURED, not assumed. A stage's `enter()` runs again on any re-entry (a
    // bounced payload, a resume, a compaction recovery) and rebuilds the same
    // packet at the same round, so two identical lines is a NORMAL path. Under
    // a count-only rule every re-entered round became permanently
    // delivery-ineligible and the reader reported a coverage gap that did not
    // exist -- the same false reading this ticket removes, from the other side.
    const got = resolveDelivery([entry(), entry({ timestamp: "2026-09-11T00:00:00.000Z" })], KEY);
    expect(got.binding).toBe("exact");
    expect(got.entry).not.toBeNull();
  });

  it("T7: two lines matching one key that DISAGREE are `ambiguous` and neither is chosen", () => {
    const lines = [entry({ contentHash: "hash-A" }), entry({ contentHash: "hash-B" })];
    const got = resolveDelivery(lines, KEY);
    expect(got.binding).toBe("ambiguous");
    // Refuses last-wins, which would silently report hash-B as the delivered
    // contract on a retried round.
    expect(got.entry).toBeNull();
  });

  it("T8: a null key field NEVER matches as a wildcard, so a lens line binds `weak`", () => {
    // The lens leg carries no target and no generation by construction, so a
    // wildcard rule binds it to whatever round asks. Weak is its own state and
    // is ineligible for every delivery-bound metric.
    const lens = entry({ leg: "lens", target: null, generation: null, itemAttemptId: null });
    const got = resolveDelivery([lens], KEY);
    expect(got.binding).toBe("weak");
    expect(got.entry).toBeNull();
  });

  it("T8b: a null on the KEY side is not a wildcard either", () => {
    const got = resolveDelivery([entry()], { ...KEY, target: null });
    expect(got.binding).not.toBe("exact");
    expect(got.entry).toBeNull();
  });

  it("binds `absent` when no line matches at all", () => {
    expect(resolveDelivery([], KEY).binding).toBe("absent");
    expect(resolveDelivery([entry({ roundNum: 9 })], KEY).binding).toBe("absent");
  });

  it("T9c: a matching line that omitted the contract binds `omitted-by-fit`, not `exact`", () => {
    const got = resolveDelivery(
      [entry({ reviewMdIncluded: false, omissionReason: "budget-fit", contentHash: "hash-A" })],
      KEY,
    );
    expect(got.binding).toBe("omitted-by-fit");
    // The line is still returned: the round has a delivery observation, and it
    // says the contract did not arrive. That is evidence, not a missing record.
    expect(got.entry).not.toBeNull();
    expect(got.entry!.reviewMdIncluded).toBe(false);
  });
});

// ── D2: the packet leg emits after the packet is CHOSEN ──────────

describe("T-495 D2: the packet leg records what the CHOSEN packet carried", () => {
  function packetFixture(opts: {
    readonly rules: boolean;
    readonly review: boolean;
    readonly budget: number;
  }): { sessionDir: string; root: string } {
    const root = newRoot();
    const sessionDir = join(root, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    if (opts.rules) writeFileSync(join(root, "RULES.md"), "# Rules\n\nSome rules.\n", "utf-8");
    if (opts.review) writeFileSync(join(root, "REVIEW.md"), CONTRACT, "utf-8");
    return { sessionDir, root };
  }

  function build(root: string, sessionDir: string, budget: number) {
    // RETURNS the packet. A helper that discards it cannot compare the recorded
    // metadata against what was actually packaged, which is the only comparison
    // that establishes the record identifies the delivered text.
    return buildReviewContextPacket({
      sessionDir, projectRoot: root, target: "T-001", stage: "code",
      generation: 1, roundNum: 2, budget, captureDirective: "capture",
      sessionId: "sess-1", itemAttemptId: "att-1",
    });
  }

  it("T9d: a packet that KEPT the contract records reviewMdIncluded true with its hash", () => {
    const { root, sessionDir } = packetFixture({ rules: true, review: true, budget: 100_000 });
    const packet = build(root, sessionDir, 100_000);
    const [rec] = readContractDeliveries(sessionDir).entries;
    expect(rec).toBeDefined();
    expect(rec!.leg).toBe("packet");
    expect(rec!.reviewMdIncluded).toBe(true);
    expect(rec!.contentHash).toBe(loadReviewContract(root).contentHash);
    expect(packet.text).toContain(CONTRACT);
    // This route drops WHOLE sections; it never cuts inside one.
    expect(rec!.truncated).toBe(false);
    expect(rec!.truncatedAtChars).toBeNull();
  });

  it("T9: a packet whose fit DROPPED the section records reviewMdIncluded false", () => {
    // Recording delivery at the file READ reports `true` here: the file was
    // read, hashed, and then removed by the fit. That is the defect.
    const { root, sessionDir } = packetFixture({ rules: true, review: true, budget: 1 });
    build(root, sessionDir, 1);
    const [rec] = readContractDeliveries(sessionDir).entries;
    expect(rec).toBeDefined();
    expect(rec!.reviewMdIncluded).toBe(false);
    expect(rec!.omissionReason).not.toBeNull();
  });

  it("T9b: RULES.md present and REVIEW.md absent records reviewMdIncluded false", () => {
    // `projectRulesBody` builds ONE section from both files, so section
    // presence is not contract presence. Deriving one from the other records a
    // delivered contract for a packet that carried only RULES.md.
    const { root, sessionDir } = packetFixture({ rules: true, review: false, budget: 100_000 });
    build(root, sessionDir, 100_000);
    const [rec] = readContractDeliveries(sessionDir).entries;
    expect(rec).toBeDefined();
    expect(rec!.reviewMdIncluded).toBe(false);
    expect(rec!.contentHash).toBeNull();
    // And it contributes no truncation observation, so nothing about the
    // absent file can be read as a measurement of it.
    expect(rec!.truncated).toBe(false);
  });

  it("records the full key, so the round that asked can bind it exactly", () => {
    const { root, sessionDir } = packetFixture({ rules: true, review: true, budget: 100_000 });
    build(root, sessionDir, 100_000);
    const [rec] = readContractDeliveries(sessionDir).entries;
    expect(rec).toMatchObject({
      sessionId: "sess-1", target: "T-001", itemAttemptId: "att-1",
      stage: "code", generation: 1, roundNum: 2,
    });
  });
});

// ── D2: the lens leg, which is the only route that truncates ─────

describe("T-495 D2: the lens leg records truncation as its OWN signal", () => {
  /** Read the real budget out of the packager rather than assuming one. */
  function reviewBudget(): number {
    const src = readFileSync(
      join(process.cwd(), "src", "autonomous", "lens-harness", "context-packager.ts"),
      "utf-8",
    );
    const m = /^const REVIEW_BUDGET = (\d+);$/m.exec(src);
    if (m === null) throw new Error("REVIEW_BUDGET moved; update this test rather than lapsing it");
    return Number(m[1]);
  }

  function lensFixture(reviewText: string | null): { root: string; sessionDir: string } {
    const root = newRoot();
    const sessionDir = join(root, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(root, "RULES.md"), "# Rules\n", "utf-8");
    if (reviewText !== null) writeFileSync(join(root, "REVIEW.md"), reviewText, "utf-8");
    return { root, sessionDir };
  }

  /**
   * Returns BOTH the packaged context and the delivery entry. A helper that
   * discards the context lets a test assert the recorded metadata while the
   * prompt carried something else entirely, which is the very split this
   * measurement exists to close. Codex found it.
   */
  function run(root: string, sessionDir: string) {
    const ctx = packageContext({
      stage: "CODE_REVIEW" as never,
      diff: "diff", changedFiles: [], activeLenses: ["security"],
      ticketDescription: "t", projectRoot: root, tokenBudgetPerLens: 10_000,
      sessionDir, sessionId: "sess-1", roundNum: 3,
    });
    return { ctx, rec: readContractDeliveries(sessionDir).entries[0] };
  }

  it("T19: a truncated contract is `truncated`, and its hash still names the SOURCE", () => {
    const budget = reviewBudget();
    // ONE character past the budget. A source 500 over satisfies
    // `deliveredChars < sourceChars` even when `deliveredChars` wrongly counts
    // the truncation NOTICE, so the loose fixture passed over a real
    // mis-measurement; Codex found it. At exactly one over, the notice would
    // push the count above the source and the assertions below would fail.
    // The last character is a DISTINCT marker, so a prompt that carried the
    // whole file can be told from one cut at the budget. Without it, a record
    // reporting truncation is consistent with a prompt that truncated nothing.
    const long = `${CONTRACT}${"x".repeat(budget - CONTRACT.length)}Z`;
    expect(long.length).toBe(budget + 1);
    const { root, sessionDir } = lensFixture(long);
    const { ctx, rec: maybe } = run(root, sessionDir);
    const rec = maybe!;
    // What the LENS actually received: the exact budget-length prefix, the
    // truncation notice, and NOT the marker past the budget.
    expect(ctx.projectRules).toContain(long.slice(0, budget));
    expect(ctx.projectRules).toContain(`[REVIEW.md truncated at ${budget} characters]`);
    expect(ctx.projectRules).not.toContain("Z");
    expect(rec.leg).toBe("lens");
    expect(rec.truncated).toBe(true);
    expect(rec.truncatedAtChars).toBe(budget);
    // EXACTLY the budget: characters of REVIEW.md that reached the prompt, with
    // the rendered truncation notice excluded because it is not contract text.
    expect(rec.deliveredChars).toBe(budget);
    expect(rec.sourceChars).toBe(budget + 1);
    // The SOURCE hash, not a hash of the delivered slice. Hashing the slice
    // would make every truncated round look like a DIFFERENT contract, losing
    // the fact that it was the right one cut short -- and the reader would
    // report a hash mismatch, which means something else entirely.
    expect(rec.contentHash).toBe(loadReviewContract(root).contentHash);
  });

  it("an untruncated contract on the same leg is not marked truncated", () => {
    const { root, sessionDir } = lensFixture(CONTRACT);
    const { ctx, rec } = run(root, sessionDir);
    expect(ctx.projectRules).toContain(CONTRACT);
    expect(ctx.projectRules).not.toContain("truncated at");
    expect(rec!.truncated).toBe(false);
    expect(rec!.truncatedAtChars).toBeNull();
    expect(rec!.deliveredChars).toBe(CONTRACT.length);
  });

  it("T20: sourceChars is CHARACTERS and sourceBytes is BYTES", () => {
    // Two characters, six bytes. Over pure ASCII the two are equal and a test
    // cannot tell a correct implementation from `raw.length` reported as bytes.
    const text = `${CONTRACT}\n\nNote: 你好\n`;
    const { root, sessionDir } = lensFixture(text);
    const rec = run(root, sessionDir).rec!;
    expect(rec.sourceChars).toBe(text.length);
    expect(rec.sourceBytes).toBe(Buffer.byteLength(text, "utf-8"));
    expect(rec.sourceBytes!).toBeGreaterThan(rec.sourceChars!);
  });

  it("T8c: the lens record carries NO target and NO generation, so it can only bind weak", () => {
    const { root, sessionDir } = lensFixture(CONTRACT);
    const rec = run(root, sessionDir).rec!;
    expect(rec.target).toBeNull();
    expect(rec.generation).toBeNull();
    // Stated as a binding, not just as two nulls: the consequence is that this
    // observation is counted and never used, which is what stops one surviving
    // lens line from binding to whatever round asks.
    expect(resolveDelivery([rec], {
      sessionId: "sess-1", target: "T-001", itemAttemptId: null,
      stage: "code", generation: 1, roundNum: 3,
    }).binding).toBe("weak");
  });

  it("writes nothing at all when there is no session to write to", () => {
    const { root, sessionDir } = lensFixture(CONTRACT);
    packageContext({
      stage: "CODE_REVIEW" as never,
      diff: "diff", changedFiles: [], activeLenses: ["security"],
      ticketDescription: "t", projectRoot: root, tokenBudgetPerLens: 10_000,
    });
    expect(readContractDeliveries(sessionDir).entries).toEqual([]);
  });
});
