/**
 * ISS-950: the skill files have to state the coverage contract, because the
 * agent driving a lens review reads them and nothing else.
 *
 * Three facts decide whether a round is spent well, and all three are new in
 * 0.6.0: an honest skip on a change with nothing in the lens's domain is
 * COVERAGE and does not cap; a skip on an applicable change still caps and is
 * answered by re-running that lens; and `capReasons` is what the report must
 * carry, because a coverage cap and a findings cap are the same word on the
 * wire without it.
 *
 * Asserted as content rather than left to review, because a doc that silently
 * keeps the old rule teaches the behaviour this item exists to stop: an agent
 * told only that a skip caps will clear the cap the cheap way.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skill = (...parts: string[]) => readFileSync(join(pkgRoot, "src", "skill", ...parts), "utf-8");

describe("ISS-950 lens coverage is documented in the skill files", () => {
  it("review-lenses.md states the basis rule, the relabel, and the re-run remedy", () => {
    const doc = skill("review-lenses", "review-lenses.md");
    expect(doc).toContain("not-applicable");
    expect(doc).toContain("self-reported");
    expect(doc).toContain("no-submission");
    expect(doc).toContain("capReasons");
    expect(doc).toMatch(/relabel/i);
  });

  it("autonomous-mode.md says a coverage-only revise is a lens re-run, not IMPLEMENT", () => {
    const doc = skill("autonomous-mode.md");
    expect(doc).toContain("capReasons");
    expect(doc).toMatch(/coverage-only/i);
  });

  it("reference.md names capReasons on the judge tool", () => {
    expect(skill("reference.md")).toContain("capReasons");
  });
});
