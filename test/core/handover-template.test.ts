import { describe, it, expect } from "vitest";
import {
  HANDOVER_TEMPLATE_MARKER,
  computeCarriedForward,
  extractDateFromHandoverFilename,
  hasCarriedForwardHeading,
  parseCarriedForwardSection,
  parseOverrideBody,
  renderHandoverTemplate,
  renderOverrideLine,
  type CarriedForwardEntry,
} from "../../src/core/handover-template.js";
import type { TrajectoryEntry } from "../../src/core/markdown-sections.js";

function entry(overrides: Partial<TrajectoryEntry> = {}): TrajectoryEntry {
  return {
    id: "T-100",
    occurrenceCount: 1,
    firstSeenInWindow: "2026-06-01-01-session.md",
    latest: "2026-06-10-01-session.md",
    latestDisposition: "continuation",
    ...overrides,
  };
}

describe("extractDateFromHandoverFilename", () => {
  it("extracts the leading ISO date from a sequential filename", () => {
    expect(extractDateFromHandoverFilename("2026-06-01-01-session.md")).toBe("2026-06-01");
  });

  it("extracts the leading ISO date from a team-mode filename", () => {
    expect(extractDateFromHandoverFilename("2026-06-01-153000-ab12cd34-session.md")).toBe(
      "2026-06-01",
    );
  });

  it("returns null for a filename with no leading date", () => {
    expect(extractDateFromHandoverFilename("session.md")).toBeNull();
  });
});

describe("computeCarriedForward", () => {
  it("includes an id whose latest disposition is still open", () => {
    const result = computeCarriedForward([entry()], []);
    expect(result).toEqual([{ id: "T-100", label: "T-100", since: "2026-06-01" }]);
  });

  it("excludes a shipped id", () => {
    const result = computeCarriedForward(
      [entry({ latestDisposition: "shipped" })],
      [],
    );
    expect(result).toEqual([]);
  });

  it("keeps an earlier previously-recorded date instead of a later fresh derivation", () => {
    const previous: CarriedForwardEntry[] = [
      { id: "T-100", label: "old label", since: "2026-01-01" },
    ];
    const result = computeCarriedForward(
      [entry({ firstSeenInWindow: "2026-06-01-01-session.md" })],
      previous,
    );
    expect(result).toEqual([{ id: "T-100", label: "old label", since: "2026-01-01" }]);
  });

  it("adopts a fresher date when the previously-recorded one is later", () => {
    const previous: CarriedForwardEntry[] = [
      { id: "T-100", label: "old label", since: "2026-08-01" },
    ];
    const result = computeCarriedForward(
      [entry({ firstSeenInWindow: "2026-01-01-01-session.md" })],
      previous,
    );
    expect(result[0]!.since).toBe("2026-01-01");
  });

  it("falls back to a current label when no previous entry exists", () => {
    const result = computeCarriedForward(
      [entry()],
      [],
      new Map([["T-100", "keep working on the thing"]]),
    );
    expect(result[0]!.label).toBe("keep working on the thing");
  });

  it("skips an entry whose firstSeenInWindow has no parseable date", () => {
    const result = computeCarriedForward([entry({ firstSeenInWindow: "no-date-here" })], []);
    expect(result).toEqual([]);
  });
});

describe("parseOverrideBody", () => {
  it("parses a well-formed override body", () => {
    expect(parseOverrideBody("recommended=T-1 worked=T-2 because=owner said so")).toEqual({
      recommended: "T-1",
      worked: "T-2",
      because: "owner said so",
    });
  });

  it("rejects a body missing because=", () => {
    expect(parseOverrideBody("recommended=T-1 worked=T-2")).toBeNull();
  });

  it("rejects a body with an empty because=", () => {
    expect(parseOverrideBody("recommended=T-1 worked=T-2 because=")).toBeNull();
  });

  it("rejects a recommended value that is not a valid id token", () => {
    expect(parseOverrideBody("recommended=not-an-id worked=T-2 because=reason")).toBeNull();
  });

  it("rejects a worked value that is not a valid id token", () => {
    expect(parseOverrideBody("recommended=T-1 worked=nope because=reason")).toBeNull();
  });

  it("round-trips through renderOverrideLine", () => {
    const parsed = parseOverrideBody("recommended=ISS-5 worked=T-9 because=field evidence")!;
    expect(renderOverrideLine(parsed)).toBe(
      "Override: recommended=ISS-5 worked=T-9 because=field evidence",
    );
  });
});

describe("parseCarriedForwardSection / hasCarriedForwardHeading", () => {
  it("parses bullets rendered by renderHandoverTemplate back into entries", () => {
    const carriedForward: CarriedForwardEntry[] = [
      { id: "T-42", label: "keep the lights on", since: "2026-04-01" },
      { id: "ISS-7", label: "investigate flake", since: "2026-05-02" },
    ];
    const markdown = renderHandoverTemplate({ carriedForward });
    expect(parseCarriedForwardSection(markdown)).toEqual(carriedForward);
    expect(hasCarriedForwardHeading(markdown)).toBe(true);
  });

  it("returns an empty array and false when there is no Carried forward heading", () => {
    const markdown = "# Session Handover\n\n## Worker state\n\n- doing things\n";
    expect(parseCarriedForwardSection(markdown)).toEqual([]);
    expect(hasCarriedForwardHeading(markdown)).toBe(false);
  });

  it("reports the heading present even when the section has no matching bullets", () => {
    const markdown = renderHandoverTemplate({ carriedForward: [] });
    expect(hasCarriedForwardHeading(markdown)).toBe(true);
    expect(parseCarriedForwardSection(markdown)).toEqual([]);
  });
});

describe("renderHandoverTemplate", () => {
  it("includes the marker as the first line", () => {
    const markdown = renderHandoverTemplate({ carriedForward: [] });
    expect(markdown.startsWith(HANDOVER_TEMPLATE_MARKER)).toBe(true);
  });

  it("renders every recognized category heading", () => {
    const markdown = renderHandoverTemplate({ carriedForward: [] });
    for (const heading of ["Worker state", "Blocked", "Owner rulings", "Carried forward", "Shipped"]) {
      expect(markdown).toContain(`## ${heading}`);
    }
  });

  it("renders an override line when one is provided", () => {
    const markdown = renderHandoverTemplate({
      carriedForward: [],
      override: { recommended: "T-1", worked: "T-2", because: "field evidence" },
    });
    expect(markdown).toContain("Override: recommended=T-1 worked=T-2 because=field evidence");
  });

  it("omits any Override line when none is provided", () => {
    const markdown = renderHandoverTemplate({ carriedForward: [] });
    expect(markdown).not.toContain("Override:");
  });
});
