const REPO = "Storybloq/storybloq";
const API_BASE = `https://api.github.com/repos/${REPO}`;

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
  reactions: { "+1": number };
  created_at: string;
  html_url: string;
  pull_request?: unknown;
}

export interface FetchIssuesResult {
  issues: GitHubIssue[];
  rateLimitWarning: string | null;
}

export interface FetchIssuesOptions {
  category?: "bug" | "feature" | "idea";
  limit?: number;
}

export const CATEGORY_TO_LABEL: Record<string, string> = {
  bug: "bug",
  feature: "enhancement",
  idea: "idea",
};

export class FeedbackClientError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FeedbackClientError";
    this.code = code;
  }
}

export async function fetchIssues(options: FetchIssuesOptions): Promise<FetchIssuesResult> {
  const params = new URLSearchParams({
    state: "open",
    per_page: String(options.limit ?? 100),
  });

  if (options.category) {
    const label = CATEGORY_TO_LABEL[options.category] ?? options.category;
    params.set("labels", label);
  }

  const url = `${API_BASE}/issues?${params.toString()}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "storybloq-cli",
      },
    });
  } catch (err) {
    throw new FeedbackClientError(
      "network_error",
      `Failed to reach GitHub API: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!response.ok) {
    throw new FeedbackClientError(
      "api_error",
      `GitHub API returned ${response.status}`
    );
  }

  let data: GitHubIssue[];
  try {
    data = await response.json() as GitHubIssue[];
  } catch {
    throw new FeedbackClientError("parse_error", "Failed to parse GitHub API response");
  }

  data = data.filter((issue) => !issue.pull_request);

  let rateLimitWarning: string | null = null;
  const remaining = response.headers.get("X-RateLimit-Remaining");
  if (remaining !== null) {
    const n = parseInt(remaining, 10);
    if (!isNaN(n) && n < 10) {
      rateLimitWarning = `GitHub API rate limit low: ${n} requests remaining`;
    }
  }

  return { issues: data, rateLimitWarning };
}
