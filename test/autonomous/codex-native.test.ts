import { afterEach, describe, expect, it } from "vitest";

describe("client-specific review backends", () => {
  const originalClient = process.env.STORYBLOQ_CLIENT;

  afterEach(() => {
    if (originalClient === undefined) {
      delete process.env.STORYBLOQ_CLIENT;
    } else {
      process.env.STORYBLOQ_CLIENT = originalClient;
    }
  });

  it("keeps reviewBackends scoped to Claude sessions", async () => {
    const { reviewBackendsForClient } = await import("../../src/autonomous/stages/codex-native.js");
    process.env.STORYBLOQ_CLIENT = "claude";

    const backends = reviewBackendsForClient({
      reviewBackends: ["codex", "agent"],
      codexReviewBackends: ["lenses"],
    });

    expect(backends).toEqual(["codex", "agent"]);
  });

  it("uses codexReviewBackends for Codex sessions and defaults to lenses", async () => {
    const { reviewBackendsForClient } = await import("../../src/autonomous/stages/codex-native.js");
    process.env.STORYBLOQ_CLIENT = "codex";

    expect(reviewBackendsForClient({
      reviewBackends: ["codex", "agent"],
      codexReviewBackends: ["lenses"],
    })).toEqual(["lenses"]);

    expect(reviewBackendsForClient({
      reviewBackends: ["codex", "agent"],
    })).toEqual(["lenses"]);
  });
});
