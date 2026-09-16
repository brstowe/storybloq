import { describe, it, expect } from "vitest";
import { buildLessonDigest, parseLessonDigestSelector } from "../../src/core/lessons.js";
import { CliValidationError } from "../../src/cli/helpers.js";
import { makeLesson } from "./test-factories.js";

describe("buildLessonDigest", () => {
  it("returns empty string for no lessons", () => {
    expect(buildLessonDigest([])).toBe("");
  });

  it("returns empty string when all lessons are non-active", () => {
    const lessons = [
      makeLesson({ id: "L-001", status: "deprecated" }),
      makeLesson({ id: "L-002", status: "superseded" }),
    ];
    expect(buildLessonDigest(lessons)).toBe("");
  });

  it("includes active lessons in output", () => {
    const lessons = [
      makeLesson({ id: "L-001", title: "Always review", content: "Multi-round reviews." }),
    ];
    const result = buildLessonDigest(lessons);
    expect(result).toContain("# Lessons Learned");
    expect(result).toContain("**Always review**");
    expect(result).toContain("Multi-round reviews.");
  });

  it("excludes non-active lessons", () => {
    const lessons = [
      makeLesson({ id: "L-001", title: "Active one", status: "active" }),
      makeLesson({ id: "L-002", title: "Deprecated one", status: "deprecated" }),
    ];
    const result = buildLessonDigest(lessons);
    expect(result).toContain("Active one");
    expect(result).not.toContain("Deprecated one");
  });

  it("sorts by reinforcements descending", () => {
    const lessons = [
      makeLesson({ id: "L-001", title: "Low", reinforcements: 1, tags: ["process"] }),
      makeLesson({ id: "L-002", title: "High", reinforcements: 5, tags: ["process"] }),
    ];
    const result = buildLessonDigest(lessons);
    const highIdx = result.indexOf("**High**");
    const lowIdx = result.indexOf("**Low**");
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it("groups by first tag", () => {
    const lessons = [
      makeLesson({ id: "L-001", title: "Review lesson", tags: ["review"] }),
      makeLesson({ id: "L-002", title: "Process lesson", tags: ["process"] }),
    ];
    const result = buildLessonDigest(lessons);
    expect(result).toContain("## review");
    expect(result).toContain("## process");
  });

  it("uses 'general' group for tagless lessons", () => {
    const lessons = [
      makeLesson({ id: "L-001", title: "No tags", tags: [] }),
    ];
    const result = buildLessonDigest(lessons);
    expect(result).toContain("## general");
  });

  it("shows reinforcement count for reinforced lessons", () => {
    const lessons = [
      makeLesson({ id: "L-001", title: "Reinforced", reinforcements: 3 }),
    ];
    const result = buildLessonDigest(lessons);
    expect(result).toContain("(×3)");
  });

  it("does not show reinforcement count for zero reinforcements", () => {
    const lessons = [
      makeLesson({ id: "L-001", title: "Fresh", reinforcements: 0 }),
    ];
    const result = buildLessonDigest(lessons);
    expect(result).not.toContain("(×");
  });

  it("starts with # heading (H1) -- callers downgrade for context digest", () => {
    const lessons = [
      makeLesson({ id: "L-001", title: "Test" }),
    ];
    const result = buildLessonDigest(lessons);
    expect(result).toMatch(/^# Lessons Learned/);
    // Context digest in guide.ts applies .replace(/^# /m, "## ") to downgrade to H2
    const downgraded = result.replace(/^# /m, "## ");
    expect(downgraded).toMatch(/^## Lessons Learned/);
    expect(downgraded).not.toMatch(/^# /m); // no remaining H1
  });

  describe("parseLessonDigestSelector (T-320 commit 5)", () => {
    it("parses a phase selector", () => {
      expect(parseLessonDigestSelector("phase:hardening")).toEqual({ namespace: "phase", value: "hardening" });
    });

    it("normalizes a component selector's name (lowercase, punctuation/whitespace to one hyphen)", () => {
      expect(parseLessonDigestSelector("component:CLI Status!!")).toEqual({ namespace: "component", value: "cli-status" });
    });

    it("parses an item selector using the display or canonical id", () => {
      expect(parseLessonDigestSelector("item:T-320")).toEqual({ namespace: "item", value: "t-320" });
    });

    it("rejects an unknown namespace", () => {
      expect(() => parseLessonDigestSelector("bogus:x")).toThrow(CliValidationError);
    });

    it("rejects a malformed selector with no namespace separator", () => {
      expect(() => parseLessonDigestSelector("no-colon-here")).toThrow(CliValidationError);
    });

    it("rejects a selector whose value normalizes to empty", () => {
      expect(() => parseLessonDigestSelector("component:!!!")).toThrow(CliValidationError);
    });
  });

  describe("buildLessonDigest: limit and select (T-320 commit 5, additive)", () => {
    it("no-argument output is byte-identical to a literal captured expectation, not just self-consistent (backward compatibility)", () => {
      // Codex R1: comparing buildLessonDigest(lessons) to
      // buildLessonDigest(lessons, undefined) is trivially true by
      // construction (same code path) and cannot detect a change to
      // grouping, ordering, or formatting. This pins the exact literal
      // output for a case with two groups, an untagged lesson, and a
      // reinforced lesson.
      const lessons = [
        makeLesson({ id: "L-001", title: "Reinforced review", content: "Multi-round reviews.", tags: ["process"], reinforcements: 3, createdDate: "2026-01-01" }),
        makeLesson({ id: "L-002", title: "Fresh review", content: "Second pass matters.", tags: ["process"], reinforcements: 0, createdDate: "2026-02-01" }),
        makeLesson({ id: "L-003", title: "No tags", content: "Untagged content.", tags: [], reinforcements: 1, createdDate: "2026-01-15" }),
      ];
      const expected = [
        "# Lessons Learned",
        "",
        "## process",
        "",
        "- **Reinforced review** (×3): Multi-round reviews.",
        "- **Fresh review**: Second pass matters.",
        "",
        "## general",
        "",
        "- **No tags** (×1): Untagged content.",
      ].join("\n");
      expect(buildLessonDigest(lessons)).toBe(expected);
      expect(buildLessonDigest(lessons)).toBe(buildLessonDigest(lessons, undefined));
    });

    it("select: [] with no limit is the legacy branch -- same as no arguments", () => {
      const lessons = [makeLesson({ id: "L-001", title: "Always review", tags: ["process"] })];
      expect(buildLessonDigest(lessons, { select: [] })).toBe(buildLessonDigest(lessons));
    });

    it("limit alone caps to a one-line-per-lesson limited form, ranked by reinforcement desc then lesson id asc", () => {
      const lessons = [
        makeLesson({ id: "L-003", title: "Third", reinforcements: 2 }),
        makeLesson({ id: "L-001", title: "First", reinforcements: 5 }),
        makeLesson({ id: "L-002", title: "Tied-a", reinforcements: 2 }),
      ];
      const result = buildLessonDigest(lessons, { limit: 2 });
      expect(result).not.toContain("# Lessons Learned");
      const lines = result.split("\n").filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("L-001");
      // L-002 and L-003 tie on reinforcements (2); lesson id ascending breaks the tie.
      expect(lines[1]).toContain("L-002");
    });

    it("limit boundary: limit larger than the active count returns everything", () => {
      const lessons = [makeLesson({ id: "L-001", title: "Only one" })];
      const result = buildLessonDigest(lessons, { limit: 50 });
      expect(result.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1);
    });

    it("limit boundary: limit of 0 returns nothing", () => {
      const lessons = [makeLesson({ id: "L-001", title: "Only one" })];
      expect(buildLessonDigest(lessons, { limit: 0 })).toBe("");
    });

    describe("limit validation (Codex R1 finding 2 -- one contract for CLI and MCP)", () => {
      const lessons = [makeLesson({ id: "L-001", title: "Only one" })];

      it("rejects a negative limit", () => {
        expect(() => buildLessonDigest(lessons, { limit: -1 })).toThrow(CliValidationError);
      });

      it("rejects a fractional limit", () => {
        expect(() => buildLessonDigest(lessons, { limit: 1.5 })).toThrow(CliValidationError);
      });

      it("rejects a non-finite limit", () => {
        expect(() => buildLessonDigest(lessons, { limit: Infinity })).toThrow(CliValidationError);
        expect(() => buildLessonDigest(lessons, { limit: NaN })).toThrow(CliValidationError);
      });

      it("accepts zero and positive integers", () => {
        expect(() => buildLessonDigest(lessons, { limit: 0 })).not.toThrow();
        expect(() => buildLessonDigest(lessons, { limit: 5 })).not.toThrow();
      });
    });

    it("select matches by normalized tag", () => {
      const lessons = [
        makeLesson({ id: "L-001", title: "Matches", tags: ["cli-status"] }),
        makeLesson({ id: "L-002", title: "No match", tags: ["other"] }),
      ];
      const result = buildLessonDigest(lessons, { select: ["component:CLI Status"] });
      expect(result).toContain("L-001");
      expect(result).not.toContain("L-002");
    });

    it("select matches by whole-token context match, case and punctuation insensitive", () => {
      const lessons = [
        makeLesson({ id: "L-001", title: "Matches via context", tags: [], context: "Regression traced to T-320's compact path." }),
        makeLesson({ id: "L-002", title: "No match", tags: [], context: "Unrelated to anything." }),
      ];
      const result = buildLessonDigest(lessons, { select: ["item:t-320"] });
      expect(result).toContain("L-001");
      expect(result).not.toContain("L-002");
    });

    it("select does not do substring matching -- a token embedded in a longer word is not a whole-token match", () => {
      const lessons = [
        makeLesson({ id: "L-001", title: "Substring only", tags: [], context: "See T-3200 for background." }),
      ];
      const result = buildLessonDigest(lessons, { select: ["item:t-320"] });
      expect(result).not.toContain("L-001");
    });

    it("no cross-namespace collisions: a namespaced tag only matches its own namespace, not a different one sharing the same bare value", () => {
      const lessons = [
        makeLesson({ id: "L-001", title: "Phase-tagged", tags: ["phase:hardening"] }),
      ];
      const matchesOwnNamespace = buildLessonDigest(lessons, { select: ["phase:hardening"] });
      expect(matchesOwnNamespace).toContain("L-001");
      const matchesOtherNamespace = buildLessonDigest(lessons, { select: ["component:hardening"] });
      expect(matchesOtherNamespace).not.toContain("L-001");
    });

    it("falls back to the top `limit` by reinforcement when the selector matches nothing", () => {
      const lessons = [
        makeLesson({ id: "L-002", title: "Second", reinforcements: 1, tags: ["other"] }),
        makeLesson({ id: "L-001", title: "First", reinforcements: 9, tags: ["other"] }),
      ];
      const result = buildLessonDigest(lessons, { select: ["item:nonexistent"], limit: 1 });
      expect(result).toContain("L-001");
      expect(result).not.toContain("L-002");
    });

    it("select ignores superseded lessons (only active lessons are ever considered)", () => {
      const lessons = [
        makeLesson({ id: "L-001", title: "Superseded", status: "superseded", tags: ["cli-status"] }),
        makeLesson({ id: "L-002", title: "Active", tags: ["cli-status"] }),
      ];
      const result = buildLessonDigest(lessons, { select: ["component:cli-status"] });
      expect(result).toContain("L-002");
      expect(result).not.toContain("Superseded");
    });

    it("select is case- and punctuation-insensitive on the raw selector value", () => {
      const lessons = [
        makeLesson({ id: "L-001", title: "Match", tags: ["cli-status"] }),
      ];
      const result = buildLessonDigest(lessons, { select: ["component:  CLI___Status  "] });
      expect(result).toContain("L-001");
    });

    it("rejects a malformed select entry (propagates parseLessonDigestSelector's error)", () => {
      expect(() => buildLessonDigest([makeLesson({ id: "L-001" })], { select: ["not-namespaced"] })).toThrow(CliValidationError);
    });

    describe("tag/context normalization parity (Codex R1 finding 1)", () => {
      it("matches a tag that was never itself normalized (space-separated)", () => {
        const lessons = [makeLesson({ id: "L-001", title: "Match", tags: ["Mac OS"] })];
        const result = buildLessonDigest(lessons, { select: ["component:Mac_OS"] });
        expect(result).toContain("L-001");
      });

      it("matches a tag that was never itself normalized (underscore-separated)", () => {
        const lessons = [makeLesson({ id: "L-001", title: "Match", tags: ["Mac_OS"] })];
        const result = buildLessonDigest(lessons, { select: ["component:Mac OS"] });
        expect(result).toContain("L-001");
      });

      it("matches an already-normalized (hyphenated) tag", () => {
        const lessons = [makeLesson({ id: "L-001", title: "Match", tags: ["mac-os"] })];
        const result = buildLessonDigest(lessons, { select: ["component:Mac_OS"] });
        expect(result).toContain("L-001");
      });

      it("matches context written with spaces even though the selector normalizes to hyphens", () => {
        const lessons = [
          makeLesson({ id: "L-001", title: "Match", tags: [], context: "Reproduced on Mac OS only." }),
        ];
        const result = buildLessonDigest(lessons, { select: ["component:Mac_OS"] });
        expect(result).toContain("L-001");
      });

      it("matches context written with underscores even though the selector normalizes to hyphens", () => {
        const lessons = [
          makeLesson({ id: "L-001", title: "Match", tags: [], context: "Reproduced on Mac_OS only." }),
        ];
        const result = buildLessonDigest(lessons, { select: ["component:Mac OS"] });
        expect(result).toContain("L-001");
      });

      it("a namespaced tag with case/punctuation variants still resolves to the same namespaced key", () => {
        const lessons = [makeLesson({ id: "L-001", title: "Match", tags: ["Phase: Hardening"] })];
        const result = buildLessonDigest(lessons, { select: ["phase:hardening"] });
        expect(result).toContain("L-001");
      });

      it("Codex R1 round 2 regression: a namespaced tag's flattened form does not leak into an unrelated namespace's bare-value match", () => {
        const lessons = [
          makeLesson({ id: "L-001", title: "Should not match", tags: ["phase:hardening"], context: "Unrelated." }),
        ];
        // Without this fix, normalizing "phase:hardening" as one string
        // collapses to "phase-hardening", which equals this selector's bare
        // value -- an unintended cross-namespace collision.
        const result = buildLessonDigest(lessons, { select: ["component:phase-hardening"] });
        expect(result).not.toContain("L-001");
      });

      it("Codex R1 round 2 regression: a bare hyphenated tag does not satisfy a namespaced selector whose value is only a suffix of it", () => {
        const lessons = [
          makeLesson({ id: "L-001", title: "Should not match", tags: ["phase-hardening"], context: "Unrelated." }),
        ];
        const result = buildLessonDigest(lessons, { select: ["phase:hardening"] });
        expect(result).not.toContain("L-001");
      });
    });
  });
});
