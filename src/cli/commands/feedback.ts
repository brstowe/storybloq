import { spawn } from "node:child_process";
import { fetchIssues, FeedbackClientError } from "../../feedback/github-client.js";
import type { OutputFormat } from "../../models/types.js";
import { ExitCode, successEnvelope } from "../../core/output-formatter.js";
import type { CommandResult } from "../types.js";

const REPO_URL = "https://github.com/Storybloq/storybloq";

const CATEGORY_TO_LABEL: Record<string, string> = {
  bug: "bug",
  feature: "enhancement",
  idea: "idea",
};

function labelToCategory(labels: { name: string }[]): string {
  for (const l of labels) {
    if (l.name === "bug") return "bug";
    if (l.name === "enhancement") return "feature";
    if (l.name === "idea") return "idea";
  }
  return "-";
}

function relativeDate(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }

  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export async function handleFeedbackOpen(): Promise<CommandResult> {
  openBrowser(`${REPO_URL}/issues`);
  return { output: `Opened ${REPO_URL}/issues`, exitCode: ExitCode.OK };
}

export async function handleFeedbackList(
  options: { category?: "bug" | "feature" | "idea" },
  format: OutputFormat,
): Promise<CommandResult> {
  try {
    const result = await fetchIssues(options);

    if (format === "json") {
      return {
        output: JSON.stringify(successEnvelope({
          issues: result.issues.map((i) => ({
            number: i.number,
            title: i.title,
            category: labelToCategory(i.labels),
            votes: i.reactions["+1"],
            date: i.created_at,
            url: i.html_url,
          })),
          rateLimitWarning: result.rateLimitWarning,
        }), null, 2),
        exitCode: ExitCode.OK,
      };
    }

    if (result.issues.length === 0) {
      let msg = "No feedback found.";
      if (result.rateLimitWarning) msg += `\n\n${result.rateLimitWarning}`;
      return { output: msg, exitCode: ExitCode.OK };
    }

    const rows = result.issues.map((i) =>
      `| ${i.number} | ${i.title} | ${labelToCategory(i.labels)} | ${i.reactions["+1"]} | ${relativeDate(i.created_at)} |`
    );

    let output = "# Community Feedback\n\n";
    output += "| # | Title | Category | Votes | Date |\n";
    output += "|---|-------|----------|-------|------|\n";
    output += rows.join("\n");

    if (result.rateLimitWarning) {
      output += `\n\n> ${result.rateLimitWarning}`;
    }

    return { output, exitCode: ExitCode.OK };
  } catch (err) {
    if (err instanceof FeedbackClientError) {
      return { output: `Error: ${err.message}`, exitCode: ExitCode.USER_ERROR };
    }
    throw err;
  }
}

export function buildCreateURL(title: string, category?: string, body?: string): string {
  const params = new URLSearchParams();
  params.set("title", title);

  const version = process.env.npm_package_version ?? "unknown";
  const footer = `\n\n---\n*Submitted via \`storybloq feedback create\`*\nCLI version: ${version}\nPlatform: ${process.platform}\nNode: ${process.version}`;
  params.set("body", (body ?? "") + footer);

  if (category) {
    const label = CATEGORY_TO_LABEL[category] ?? category;
    params.set("labels", label);
  }

  return `${REPO_URL}/issues/new?${params.toString()}`;
}

export async function handleFeedbackCreate(
  title: string,
  category: string | undefined,
  body: string | undefined,
): Promise<CommandResult> {
  const trimmed = title.trim();
  if (!trimmed) {
    return { output: "Error: Title is required", exitCode: ExitCode.USER_ERROR };
  }

  const url = buildCreateURL(trimmed, category, body);
  openBrowser(url);
  return { output: `Opening browser to create feedback...\n${url}`, exitCode: ExitCode.OK };
}

export async function handleFeedbackVote(issueNumber: number): Promise<CommandResult> {
  if (!issueNumber || issueNumber <= 0) {
    return { output: "Error: Issue number must be a positive integer", exitCode: ExitCode.USER_ERROR };
  }

  const url = `${REPO_URL}/issues/${issueNumber}`;
  openBrowser(url);
  return { output: `Opening issue #${issueNumber} to vote...\n${url}`, exitCode: ExitCode.OK };
}
