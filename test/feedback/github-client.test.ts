import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchIssues, FeedbackClientError } from "../../src/feedback/github-client.js";

function mockIssue(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: "Test issue",
    body: "Body text",
    labels: [{ name: "enhancement" }],
    reactions: { "+1": 3 },
    created_at: "2026-05-20T00:00:00Z",
    html_url: "https://github.com/Storybloq/storybloq/issues/1",
    ...overrides,
  };
}

function mockFetchResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "X-RateLimit-Remaining": "50", ...headers }),
    json: async () => body,
  } as unknown as Response;
}

describe("fetchIssues", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses response correctly", async () => {
    const issues = [
      mockIssue({ number: 1, title: "First" }),
      mockIssue({ number: 2, title: "Second" }),
      mockIssue({ number: 3, title: "Third" }),
    ];
    vi.mocked(globalThis.fetch).mockResolvedValue(mockFetchResponse(issues));

    const result = await fetchIssues({});
    expect(result.issues).toHaveLength(3);
    expect(result.issues[0].number).toBe(1);
    expect(result.issues[0].title).toBe("First");
    expect(result.issues[0].reactions["+1"]).toBe(3);
  });

  it("adds category label to query params", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mockFetchResponse([]));

    await fetchIssues({ category: "bug" });
    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toContain("labels=bug");
  });

  it("maps feature category to enhancement label", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mockFetchResponse([]));

    await fetchIssues({ category: "feature" });
    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toContain("labels=enhancement");
  });

  it("returns empty array for empty response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mockFetchResponse([]));

    const result = await fetchIssues({});
    expect(result.issues).toHaveLength(0);
  });

  it("includes rate limit warning when remaining < 10", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockFetchResponse([], 200, { "X-RateLimit-Remaining": "5" })
    );

    const result = await fetchIssues({});
    expect(result.rateLimitWarning).toBeTruthy();
  });

  it("throws FeedbackClientError on non-200 response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mockFetchResponse({}, 403));

    await expect(fetchIssues({})).rejects.toThrow(FeedbackClientError);
  });

  it("throws FeedbackClientError on network error", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(fetchIssues({})).rejects.toThrow(FeedbackClientError);
  });
});
