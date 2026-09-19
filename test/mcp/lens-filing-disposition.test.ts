/**
 * ISS-1113: the lens auto-file path stamps `pre_existing` at birth.
 *
 * `storybloq_review_lenses_synthesize` is the one filing path that already
 * KNOWS its classification -- it splits findings into introduced and
 * pre-existing and files only the second group -- and it was throwing that
 * knowledge away at the create call. An auto-filed pre-existing finding then
 * looked exactly like ordinary work to `recommend` and to the issue sweep.
 *
 * Driven through the REAL registered tool rather than the helper beneath it,
 * for the T-489 reason: a unit test on the filing helper cannot see a helper
 * that nothing calls.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/mcp/tools.js";
import { toolSchema } from "./tool-schema-helpers.js";
import { initProject } from "../../src/core/init.js";
import { computeActionability } from "../../src/core/recommend.js";
import { loadProject } from "../../src/core/project-loader.js";

interface RegisteredTool {
  config: { inputSchema: unknown };
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

function captureTools(root: string): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (
      name: string,
      config: RegisteredTool["config"],
      handler: RegisteredTool["handler"],
    ) => tools.set(name, { config, handler }),
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return tools;
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const REVIEW_ID = "lens-disposition-1";

describe("the lens auto-file stamps pre_existing at birth (ISS-1113)", () => {
  async function synthesizeOnePreExisting(): Promise<{ root: string; issue: Record<string, unknown> }> {
    const root = await mkdtemp(join(tmpdir(), "iss1113-lens-"));
    tempDirs.push(root);
    await initProject(root, { name: "issues" });
    await writeFile(join(root, "source.ts"), "const value = risky();\n", "utf8");

    const tool = captureTools(root).get("storybloq_review_lenses_synthesize");
    if (!tool) throw new Error("storybloq_review_lenses_synthesize was not registered");
    const schema = toolSchema(tool.config.inputSchema);
    const empty = { status: "ok", findings: [], error: null, notes: null };
    const finding = {
      id: "eh-pre-existing",
      severity: "major",
      category: "unchecked-error",
      file: "source.ts",
      line: 1,
      snippet: { quote: "const value = risky();", startLine: 1 },
      description: "A pre-existing risky call is unchecked.",
      suggestion: "Handle the failure.",
      confidence: 0.95,
    };
    const args = schema.parse({
      stage: "CODE_REVIEW",
      reviewId: REVIEW_ID,
      reviewRound: 1,
      activeLenses: ["security", "error-handling", "clean-code", "concurrency"],
      skippedLenses: ["performance", "api-design", "test-quality", "accessibility", "data-safety"],
      lensResults: [
        { lens: "security", output: empty },
        { lens: "error-handling", output: { ...empty, findings: [finding] } },
        { lens: "clean-code", output: empty },
        { lens: "concurrency", output: empty },
      ],
      // The finding is in an UNCHANGED file, which is what makes the
      // classifier call it pre-existing rather than introduced.
      diff: "diff --git a/changed.ts b/changed.ts\n--- a/changed.ts\n+++ b/changed.ts\n@@ -1 +1 @@\n-old\n+new",
      changedFiles: ["changed.ts"],
    });

    const result = JSON.parse((await tool.handler(args)).content[0]!.text);
    expect(result.preExistingFindings).toHaveLength(1);
    expect(result.filedIssues).toHaveLength(1);

    const files = (await readdir(join(root, ".story", "issues"))).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const issue = JSON.parse(await readFile(join(root, ".story", "issues", files[0]!), "utf8"));
    return { root, issue };
  }

  it("writes disposition pre_existing and the review provenance", async () => {
    const { issue } = await synthesizeOnePreExisting();
    expect(issue.disposition).toBe("pre_existing");
    expect(issue.metadata).toMatchObject({
      review: {
        origin: "pre-existing",
        reviewId: REVIEW_ID,
        findingDisposition: "pre_existing",
      },
    });
  });

  /**
   * The consequence, not the field. A stamped disposition that `recommend`
   * does not act on would leave the reported defect exactly where it was.
   */
  it("is not ranked as work by recommend", async () => {
    const { root, issue } = await synthesizeOnePreExisting();
    const { state } = await loadProject(root);
    const loaded = state.issues.find((i) => i.id === issue.id);
    expect(loaded).toBeDefined();
    const actionability = computeActionability("issue", loaded!, {
      state,
      latestDispositionById: new Map(),
    });
    expect(actionability.status).toBe("pre_existing");
    expect(actionability.source).toBe("structured");
  });
});
