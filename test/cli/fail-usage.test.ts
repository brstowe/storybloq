import { describe, it, expect } from "vitest";
import yargs from "yargs";
import {
  buildUsageInfo,
  truncateHelpText,
  FAIL_USAGE_HELP_BYTE_BUDGET,
  type FailUsageYargs,
  type FailUsageOptionsSource,
} from "../../src/cli/fail-usage.js";

/**
 * ISS-1189: unit coverage for the help-text block parser and truncation
 * helper, built directly against real yargs instances (per the
 * team-allocator-help.test.ts precedent) rather than against index.ts's
 * non-exported, side-effecting runCli(). Named-mutant and end-to-end
 * coverage of the actual .fail() wiring lives in fail-usage.e2e.test.ts.
 */

/**
 * yargs resets its internal usage/options state once a parse's callback has
 * run, so `getDescriptions()`/`.help()` must be read SYNCHRONOUSLY inside the
 * `.fail()` callback -- exactly what buildUsageInfo() does in production.
 * Verified directly: stashing the raw `y` and calling `.getDescriptions()`
 * on it AFTER the parse's own callback fires returns only `version`/`help`,
 * silently dropping every command-specific option. This helper therefore
 * computes the UsageInfo (and, where needed, the raw help text) inside the
 * callback and hands back the already-built result, never the live `y`.
 *
 * Also mirrors production's `cli.locale("en"); cli.wrap(null);` (ISS-1189
 * Codex round 1), forced on `built` right before generating help text, so a
 * `build` callback that sets its own `.locale()`/`.wrap()` -- simulating a
 * non-English environment or a narrow terminal -- exercises that override
 * exactly as src/cli/index.ts does.
 */
async function captureFail(
  build: (y: ReturnType<typeof yargs>) => ReturnType<typeof yargs>,
  args: string[],
): Promise<{ usage: ReturnType<typeof buildUsageInfo>; helpText: string }> {
  let captured: { usage: ReturnType<typeof buildUsageInfo>; helpText: string } | null = null;
  // `built` mirrors production's outer `cli`: it is a full, unrestricted
  // Argv instance (unlike the `y` .fail() hands its callback), so its
  // getOptions().choices is what supplies buildUsageInfo's choices, exactly
  // as src/cli/index.ts sources them from its own outer `cli` variable.
  const built = build(yargs(args).scriptName("storybloq").strict().demandCommand(1).help());
  const parser = built
    .fail((_msg, _err, y) => {
      built.locale("en");
      built.wrap(null);
      const failUsage = y as unknown as FailUsageYargs;
      const helpText = failUsage.help();
      const optionsSource = built as unknown as FailUsageOptionsSource;
      captured = { usage: buildUsageInfo(helpText, failUsage.getDescriptions(), optionsSource), helpText };
    })
    .exitProcess(false);
  await new Promise<void>((resolve) => {
    parser.parse(args, () => resolve());
  });
  if (captured === null) throw new Error("command did not fail");
  return captured;
}

describe("buildUsageInfo: the four ISS-1189 repro shapes", () => {
  it("ruling create: missing required options lists every required flag", async () => {
    const { usage } = await captureFail(
      (yy) =>
        yy.command("create", "Create a ruling", (c) =>
          c
            .option("text", { type: "string", describe: "Ruling text", demandOption: true })
            .option("attribution", {
              type: "string",
              describe: "Who made the ruling",
              demandOption: true,
              choices: ["owner-direct", "pen-relayed"],
            })
            .option("date", { type: "string", describe: "Date of the ruling", demandOption: true }),
        ),
      ["create"],
    );
    expect(usage.command).toBe("storybloq create");
    const flags = usage.required.map((r) => r.flag).sort();
    expect(flags).toEqual(["attribution", "date", "text"]);
    const attribution = usage.required.find((r) => r.flag === "attribution")!;
    expect(attribution.description).toBe("Who made the ruling");
    expect(attribution.choices).toEqual(["owner-direct", "pen-relayed"]);
  });

  it("lesson create: missing required options", async () => {
    const { usage } = await captureFail(
      (yy) =>
        yy.command("create", "Create a lesson", (c) =>
          c
            .option("title", { type: "string", describe: "Lesson title", demandOption: true })
            .option("content", { type: "string", describe: "Lesson content", demandOption: true }),
        ),
      ["create"],
    );
    expect(usage.required.map((r) => r.flag).sort()).toEqual(["content", "title"]);
  });

  it("ticket create without --type: required list is uniform, not just the violated flag", async () => {
    const { usage } = await captureFail(
      (yy) =>
        yy.command("create", "Create a ticket", (c) =>
          c
            .option("title", { type: "string", describe: "Ticket title", demandOption: true })
            .option("type", { type: "string", describe: "Ticket type", demandOption: true, choices: ["task", "bug"] }),
        ),
      ["create", "--title", "x"],
    );
    // Both required flags appear even though only --type was actually missing.
    expect(usage.required.map((r) => r.flag).sort()).toEqual(["title", "type"]);
    expect(usage.required.find((r) => r.flag === "type")!.choices).toEqual(["task", "bug"]);
  });

  it("issue update without an id: positional required entries are found too", async () => {
    const { usage } = await captureFail(
      (yy) =>
        yy.command("update <id>", "Update an issue", (c) =>
          c
            .positional("id", { type: "string", describe: "Issue id" })
            .option("title", { type: "string", describe: "New title" }),
        ),
      ["update"],
    );
    expect(usage.command).toBe("storybloq update <id>");
    expect(usage.required.map((r) => r.flag)).toEqual(["id"]);
  });
});

describe("buildUsageInfo: block-parsing edge cases", () => {
  it("finds a required option whose describe text wraps across multiple help lines", async () => {
    const longDescribe =
      "A very long description that will definitely wrap across multiple lines in a non-tty " +
      "context because it exceeds the terminal width by a large margin of padding characters";
    const { usage } = await captureFail(
      (yy) =>
        yy.command("create", "Create a thing", (c) =>
          c.option("attribution", {
            type: "string",
            describe: longDescribe,
            demandOption: true,
            choices: ["self", "peer", "system"],
          }),
        ),
      ["create"],
    );
    const entry = usage.required.find((r) => r.flag === "attribution");
    expect(entry).toBeDefined();
    expect(entry!.description).toBe(longDescribe);
    expect(entry!.choices).toEqual(["self", "peer", "system"]);
  });

  it("does not create a phantom required entry from the literal text [required] mid-describe", async () => {
    const { usage } = await captureFail(
      (yy) =>
        yy.command("create", "Create a thing", (c) =>
          c
            .option("text", { type: "string", describe: "Text content", demandOption: true })
            .option("optional-thing", {
              type: "string",
              describe: "Not required, contains the literal text [required] in the middle of describe",
            }),
        ),
      ["create"],
    );
    // Only --text is actually required; --optional-thing must not appear even
    // though its describe text contains the literal substring "[required]".
    expect(usage.required.map((r) => r.flag)).toEqual(["text"]);
  });

  it("ISS-1189 Codex round 1: still finds every required flag under a non-English locale", async () => {
    // Simulates the real failure: yargs auto-selects its locale from
    // LC_ALL/LANG/LANGUAGE, and under French the "[required]" tag renders as
    // "[requis]". captureFail's cli.locale("en") override (mirroring
    // production) must win over this build-time .locale("fr").
    const { usage } = await captureFail(
      (yy) =>
        yy.locale("fr").command("create", "Create a ruling", (c) =>
          c.option("text", { type: "string", describe: "Ruling text", demandOption: true }),
        ),
      ["create"],
    );
    expect(usage.required.map((r) => r.flag)).toEqual(["text"]);
  });

  it("ISS-1189 Codex round 1: still finds every required flag under a narrow wrap width", async () => {
    // Simulates a real narrow terminal (or an explicit .wrap() call): at
    // wrap(20), even the "[required]" tag itself splits across lines
    // ("[required" / "]"). captureFail's cli.wrap(null) override (mirroring
    // production) must win over this build-time .wrap(20).
    const { usage } = await captureFail(
      (yy) =>
        yy.wrap(20).command("create", "Create a thing", (c) =>
          c.option("text", {
            type: "string",
            describe: "Text content that is long enough to wrap at width 20",
            demandOption: true,
          }),
        ),
      ["create"],
    );
    expect(usage.required.map((r) => r.flag)).toEqual(["text"]);
  });
});

describe("truncateHelpText", () => {
  it("leaves short help text untouched", () => {
    const result = truncateHelpText("short help text", FAIL_USAGE_HELP_BYTE_BUDGET);
    expect(result).toEqual({ text: "short help text", truncated: false });
  });

  it("truncates to the byte budget and appends an explicit truncation marker", () => {
    const long = "x".repeat(FAIL_USAGE_HELP_BYTE_BUDGET * 2);
    const result = truncateHelpText(long, FAIL_USAGE_HELP_BYTE_BUDGET);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(FAIL_USAGE_HELP_BYTE_BUDGET);
    expect(result.text).toMatch(/truncated/i);
    expect(result.text.endsWith("truncated; run with --help for the full option list)")).toBe(true);
  });

  it("does not leave a replacement-character artifact from a mid-codepoint byte cut", () => {
    // Each "é" is 2 UTF-8 bytes; choosing a budget that lands mid-codepoint
    // exercises the U+FFFD cleanup without depending on exact byte math.
    const long = "é".repeat(3000);
    const result = truncateHelpText(long, 4001);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("�");
  });
});
