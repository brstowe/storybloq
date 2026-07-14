import type { Argv } from "yargs";
import {
  acknowledgeBusMessage,
  busDoctor,
  busSummary,
  checkBusShip,
  exportBusThread,
  findEndpointForTask,
  getBusThread,
  initializeBus,
  joinEndpoint,
  leaveEndpoint,
  pollBus,
  retireEndpoint,
  sendBusMessage,
  setBusHookPolicy,
  updateBusThread,
  type BusClient,
  type BusEndpoint,
  type BusMessageKind,
  type BusMessageRefs,
  type BusRole,
  type BusSeverity,
  type BusSurface,
  type BusThreadKind,
  type FoldedBusThread,
} from "../../bus/index.js";
import { BusError } from "../../bus/errors.js";
import {
  currentStorybloqClient,
  normalizeClientTaskId,
  type StorybloqClient,
} from "../../autonomous/client-profile.js";
import { discoverProjectRoot } from "../../core/project-root-discovery.js";
import { ExitCode } from "../../core/output-formatter.js";
import { writeOutput } from "../run.js";

type BusFormat = "md" | "json";

interface IdentityArgs {
  readonly endpoint?: string;
  readonly client?: StorybloqClient;
  readonly taskId?: string;
}

function formatData<T>(data: T, format: BusFormat, markdown: (value: T) => string): string {
  return format === "json"
    ? JSON.stringify({ version: 1, data }, null, 2)
    : markdown(data);
}

function formatFailure(err: unknown, format: BusFormat): string {
  const code = err instanceof BusError ? err.code : "io_error";
  const message = err instanceof Error ? err.message : String(err);
  return format === "json"
    ? JSON.stringify({ version: 1, error: { code, message } }, null, 2)
    : `Error [${code}]: ${message}`;
}

async function runBus<T>(
  format: BusFormat,
  action: (root: string) => Promise<T>,
  markdown: (value: T) => string,
  unhealthy?: (value: T) => boolean,
): Promise<void> {
  const root = discoverProjectRoot();
  if (!root) {
    writeOutput(formatFailure(new BusError("not_found", "No .story/ project found."), format));
    process.exitCode = ExitCode.USER_ERROR;
    return;
  }
  try {
    const result = await action(root);
    writeOutput(formatData(result, format, markdown));
    process.exitCode = unhealthy?.(result) ? ExitCode.VALIDATION_ERROR : ExitCode.OK;
  } catch (err) {
    writeOutput(formatFailure(err, format));
    process.exitCode = err instanceof BusError && err.code === "corrupt"
      ? ExitCode.VALIDATION_ERROR
      : ExitCode.USER_ERROR;
  }
}

function resolveClient(explicit?: StorybloqClient): BusClient {
  return explicit ?? currentStorybloqClient();
}

function resolveTaskId(client: BusClient, explicit?: string): string {
  const ambient = client === "codex" ? process.env.CODEX_THREAD_ID : process.env.CLAUDE_CODE_SESSION_ID;
  const taskId = normalizeClientTaskId(explicit ?? ambient);
  if (!taskId) {
    throw new BusError(
      "invalid_input",
      `A valid ${client === "codex" ? "Codex task" : "Claude session"} id is required. Pass --task-id explicitly.`,
    );
  }
  return taskId;
}

async function resolveOwnedEndpoint(root: string, args: IdentityArgs): Promise<{ endpoint: BusEndpoint; taskId: string }> {
  const client = resolveClient(args.client);
  const taskId = resolveTaskId(client, args.taskId);
  if (args.endpoint) {
    const endpoint = await import("../../bus/endpoints.js").then((module) =>
      module.assertEndpointCaller(root, args.endpoint!, taskId),
    );
    return { endpoint, taskId };
  }
  const endpoint = await findEndpointForTask(root, client, taskId);
  if (!endpoint) {
    throw new BusError("not_found", "This task has no Bus endpoint. Run `storybloq bus join <role>` first.");
  }
  return { endpoint, taskId };
}

function identityOptions<T>(y: Argv<T>): Argv {
  return y
    .option("endpoint", { type: "string", describe: "Endpoint id; inferred from the current task when omitted" })
    .option("client", { type: "string", choices: ["claude", "codex"] as const, describe: "Client profile" })
    .option("task-id", { type: "string", describe: "Validated client task id" });
}

function formatOption<T>(y: Argv<T>): Argv {
  return y.option("format", {
    type: "string",
    choices: ["md", "json"] as const,
    default: "md",
    describe: "Output format",
  });
}

function formatValue(raw: unknown): BusFormat {
  return raw === "json" ? "json" : "md";
}

function identityFrom(argv: Record<string, unknown>): IdentityArgs {
  return {
    endpoint: argv.endpoint as string | undefined,
    client: argv.client as StorybloqClient | undefined,
    taskId: argv["task-id"] as string | undefined,
  };
}

function refsFrom(argv: Record<string, unknown>): BusMessageRefs {
  const files = argv.file as string[] | undefined;
  return {
    ...(argv.issue ? { issue: argv.issue as string } : {}),
    ...(argv.ticket ? { ticket: argv.ticket as string } : {}),
    ...(argv.commit ? { commit: argv.commit as string } : {}),
    ...(argv["ci-run"] ? { ciRun: argv["ci-run"] as string } : {}),
    ...(files?.length ? { files } : {}),
  };
}

function serializedThread(folded: FoldedBusThread) {
  return {
    thread: folded.thread,
    entries: folded.entries,
    validThroughSeq: folded.validThroughSeq,
    lastHash: folded.lastHash,
    state: folded.state,
    hopCount: folded.hopCount,
    acknowledgments: Object.fromEntries(folded.acknowledgments),
    seenEvidence: [...folded.seenEvidence].sort(),
    integrity: folded.integrity,
    finding: folded.finding ?? null,
  };
}

export function registerBusCommand(yargs: Argv): Argv {
  return yargs.command(
    "bus",
    "Local agent-to-agent coordination",
    (y) => y
      .command(
        "init",
        "Enable the Storybloq Bus for this project",
        (y2) => formatOption(y2),
        async (argv) => {
          const format = formatValue(argv.format);
          await runBus(format, initializeBus, (result) => {
            const restart = result.restartRequired ? " Restart connected MCP clients to load the Bus tools." : "";
            return `Storybloq Bus is enabled. Instance: ${result.instanceId}.${restart}`;
          });
        },
      )
      .command(
        "join <role>",
        "Bind this client task to one Bus role",
        (y2) => formatOption(y2
          .positional("role", { type: "string", choices: ["implementer", "reviewer"] as const, demandOption: true })
          .option("client", { type: "string", choices: ["claude", "codex"] as const })
          .option("task-id", { type: "string", describe: "Validated client task id" })
          .option("surface", {
            type: "string",
            choices: ["claude_cli", "codex_cli", "codex_desktop"] as const,
            describe: "Client surface when process ancestry cannot determine it",
          })
          .option("replace", { type: "boolean", default: false, describe: "Replace a positively proven-offline endpoint" })),
        async (argv) => {
          const format = formatValue(argv.format);
          await runBus(format, async (root) => {
            const client = resolveClient(argv.client as StorybloqClient | undefined);
            return joinEndpoint(root, {
              role: argv.role as BusRole,
              client,
              clientTaskId: resolveTaskId(client, argv["task-id"] as string | undefined),
              surface: argv.surface as BusSurface | undefined,
              replace: argv.replace as boolean,
            });
          }, ({ endpoint, existing }) =>
            `${existing ? "Using" : "Joined"} ${endpoint.role} endpoint ${endpoint.endpointId} (${endpoint.surface}).`);
        },
      )
      .command(
        "leave",
        "Retire the endpoint owned by this task",
        (y2) => formatOption(identityOptions(y2)),
        async (argv) => {
          const format = formatValue(argv.format);
          await runBus(format, async (root) => {
            const owned = await resolveOwnedEndpoint(root, identityFrom(argv as Record<string, unknown>));
            return leaveEndpoint(root, owned.endpoint.endpointId, owned.taskId);
          }, (endpoint) => `Left ${endpoint.role} endpoint ${endpoint.endpointId}.`);
        },
      )
      .command(
        "endpoint",
        "Endpoint administration",
        (y2) => y2.command(
          "retire <endpoint-id>",
          "Force-retire an irrecoverably unknown endpoint",
          (y3) => formatOption(y3
            .positional("endpoint-id", { type: "string", demandOption: true })
            .option("force", { type: "boolean", default: false, demandOption: true })
            .option("reason", { type: "string", demandOption: true })),
          async (argv) => {
            const format = formatValue(argv.format);
            if (argv.force !== true) {
              writeOutput(formatFailure(new BusError("invalid_input", "Endpoint retirement requires --force."), format));
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            await runBus(format, (root) => retireEndpoint(
              root,
              argv["endpoint-id"] as string,
              argv.reason as string,
            ), (endpoint) => `Retired ${endpoint.role} endpoint ${endpoint.endpointId}: ${endpoint.retiredReason}`);
          },
        ).demandCommand(1, "Specify: retire"),
        () => {},
      )
      .command(
        "hooks",
        "Enable or disable guarded live Bus delivery",
        (y2) => y2
          .command(
            "enable",
            "Opt this project into guarded SessionStart and Stop delivery",
            (y3) => formatOption(y3.option("client", {
              type: "string",
              choices: ["claude", "codex", "all"] as const,
              default: currentStorybloqClient(),
            })),
            async (argv) => {
              const format = formatValue(argv.format);
              await runBus(format, async (root) => {
                const selected = argv.client as "claude" | "codex" | "all";
                const clients: BusClient[] = selected === "all" ? ["claude", "codex"] : [selected];
                const setup = await import("./setup-skill.js");
                if (clients.includes("claude")) {
                  const migrated = await setup.enableClaudeBusHooks();
                  if (migrated.skipped) {
                    throw new BusError("io_error", "Claude hooks could not be upgraded. Run `storybloq setup --client claude` first.");
                  }
                }
                if (clients.includes("codex")) {
                  const refreshed = await setup.refreshExistingCodexHooks();
                  const counts = await setup.countCodexStorybloqHooks();
                  if (refreshed.skipped || counts.PreCompact === 0 || counts.SessionStart === 0 || counts.Stop === 0) {
                    throw new BusError("io_error", "Codex hooks are incomplete. Run `storybloq setup --client codex`, review `/hooks`, then retry.");
                  }
                }
                return setBusHookPolicy(root, clients, true);
              }, (policy) => `Bus hook delivery enabled. Claude: ${policy.claude ? "on" : "off"}; Codex: ${policy.codex ? "on" : "off"}.`);
            },
          )
          .command(
            "disable",
            "Disable live Bus delivery for this project",
            (y3) => formatOption(y3.option("client", {
              type: "string",
              choices: ["claude", "codex", "all"] as const,
              default: currentStorybloqClient(),
            })),
            async (argv) => {
              const format = formatValue(argv.format);
              await runBus(format, (root) => {
                const selected = argv.client as "claude" | "codex" | "all";
                const clients: BusClient[] = selected === "all" ? ["claude", "codex"] : [selected];
                return setBusHookPolicy(root, clients, false);
              }, (policy) => `Bus hook delivery disabled. Claude: ${policy.claude ? "on" : "off"}; Codex: ${policy.codex ? "on" : "off"}.`);
            },
          )
          .demandCommand(1, "Specify: enable or disable"),
        () => {},
      )
      .command(
        "send",
        "Send a Bus message or reply",
        (y2) => formatOption(identityOptions(y2)
          .option("thread", { type: "string", describe: "Existing thread id for a reply" })
          .option("thread-kind", { type: "string", choices: ["issue_notice", "question", "coordination", "patch_request"] as const })
          .option("predecessor-thread", { type: "string", describe: "Resolved predecessor thread id" })
          .option("to", { type: "string", choices: ["implementer", "reviewer"] as const, demandOption: true })
          .option("kind", { type: "string", choices: ["issue_notice", "question", "reply", "status", "patch_request", "claim", "release"] as const, demandOption: true })
          .option("severity", { type: "string", choices: ["critical", "high", "medium", "low", "info"] as const, default: "info" })
          .option("body", { type: "string", demandOption: true })
          .option("idempotency-key", { type: "string", demandOption: true })
          .option("in-reply-to", { type: "string" })
          .option("issue", { type: "string" })
          .option("ticket", { type: "string" })
          .option("commit", { type: "string" })
          .option("ci-run", { type: "string" })
          .option("file", { type: "string", array: true })),
        async (argv) => {
          const format = formatValue(argv.format);
          await runBus(format, async (root) => {
            const values = argv as Record<string, unknown>;
            const owned = await resolveOwnedEndpoint(root, identityFrom(values));
            return sendBusMessage(root, {
              endpointId: owned.endpoint.endpointId,
              clientTaskId: owned.taskId,
              threadId: values.thread as string | undefined,
              threadKind: values["thread-kind"] as BusThreadKind | undefined,
              predecessorThreadId: values["predecessor-thread"] as string | undefined,
              toRole: values.to as BusRole,
              messageKind: values.kind as BusMessageKind,
              severity: values.severity as BusSeverity,
              body: values.body as string,
              refs: refsFrom(values),
              inReplyTo: values["in-reply-to"] as string | undefined,
              idempotencyKey: values["idempotency-key"] as string,
            });
          }, (result) => result.parked
            ? `Thread ${result.threadId} parked at hop ${result.hopCount}.`
            : `${result.replayed ? "Replayed" : "Sent"} message ${result.messageId} in thread ${result.threadId}.`);
        },
      )
      .command(
        "poll",
        "Read unacknowledged messages addressed to this role",
        (y2) => formatOption(identityOptions(y2).option("limit", { type: "number", default: 20 })),
        async (argv) => {
          const format = formatValue(argv.format);
          await runBus(format, async (root) => {
            const owned = await resolveOwnedEndpoint(root, identityFrom(argv as Record<string, unknown>));
            return pollBus(root, {
              endpointId: owned.endpoint.endpointId,
              clientTaskId: owned.taskId,
              limit: argv.limit as number,
            });
          }, (result) => {
            if (result.messages.length === 0) return "No pending Bus messages.";
            return result.messages.map((envelope) => [
              `[${envelope.mailboxSeq}] ${envelope.sender.role} ${envelope.message.severity} ${envelope.message.kind}`,
              `Thread: ${envelope.threadId} | Message: ${envelope.message.messageId}`,
              envelope.message.body,
            ].join("\n")).join("\n\n");
          });
        },
      )
      .command(
        "ack <message-id>",
        "Acknowledge one addressed message",
        (y2) => formatOption(identityOptions(y2)
          .positional("message-id", { type: "string", demandOption: true })
          .option("disposition", { type: "string", choices: ["accepted", "rejected", "deferred"] as const, demandOption: true })
          .option("reason", { type: "string" })),
        async (argv) => {
          const format = formatValue(argv.format);
          await runBus(format, async (root) => {
            const owned = await resolveOwnedEndpoint(root, identityFrom(argv as Record<string, unknown>));
            return acknowledgeBusMessage(root, {
              endpointId: owned.endpoint.endpointId,
              clientTaskId: owned.taskId,
              messageId: argv["message-id"] as string,
              disposition: argv.disposition as "accepted" | "rejected" | "deferred",
              reason: argv.reason as string | undefined,
            });
          }, (result) => `${result.replayed ? "Already acknowledged" : "Acknowledged"} in thread ${result.threadId}.`);
        },
      )
      .command(
        "thread",
        "Read or update a Bus thread",
        (y2) => y2
          .command(
            "show <thread-id>",
            "Show an integrity-verified participant thread",
            (y3) => formatOption(identityOptions(y3).positional("thread-id", { type: "string", demandOption: true })),
            async (argv) => {
              const format = formatValue(argv.format);
              await runBus(format, async (root) => {
                const owned = await resolveOwnedEndpoint(root, identityFrom(argv as Record<string, unknown>));
                return serializedThread(await getBusThread(root, {
                  endpointId: owned.endpoint.endpointId,
                  clientTaskId: owned.taskId,
                  threadId: argv["thread-id"] as string,
                }));
              }, (thread) => [
                `Thread ${thread.thread.threadId}: ${thread.thread.kind}`,
                `State: ${thread.state} | Integrity: ${thread.integrity} | Hops: ${thread.hopCount}`,
                `Entries: ${thread.validThroughSeq}`,
              ].join("\n"));
            },
          )
          .command(
            "update <thread-id>",
            "Park, resolve, or reopen a participant thread",
            (y3) => formatOption(identityOptions(y3)
              .positional("thread-id", { type: "string", demandOption: true })
              .option("action", { type: "string", choices: ["park", "resolve", "reopen"] as const, demandOption: true })
              .option("reason", { type: "string" })
              .option("resolution", { type: "string" })
              .option("commit", { type: "string" })
              .option("ci-run", { type: "string" })),
            async (argv) => {
              const format = formatValue(argv.format);
              await runBus(format, async (root) => {
                const owned = await resolveOwnedEndpoint(root, identityFrom(argv as Record<string, unknown>));
                const evidence = argv.commit || argv["ci-run"]
                  ? { ...(argv.commit ? { commit: argv.commit as string } : {}), ...(argv["ci-run"] ? { ciRun: argv["ci-run"] as string } : {}) }
                  : undefined;
                return serializedThread(await updateBusThread(root, {
                  endpointId: owned.endpoint.endpointId,
                  clientTaskId: owned.taskId,
                  threadId: argv["thread-id"] as string,
                  action: argv.action as "park" | "resolve" | "reopen",
                  reason: argv.reason as string | undefined,
                  resolution: argv.resolution as string | undefined,
                  evidence,
                }));
              }, (thread) => `Thread ${thread.thread.threadId} is ${thread.state}.`);
            },
          )
          .demandCommand(1, "Specify: show or update"),
        () => {},
      )
      .command(
        "status",
        "Show concise Bus state",
        (y2) => formatOption(y2),
        async (argv) => {
          const format = formatValue(argv.format);
          await runBus(format, busSummary, (summary) =>
            summary.initialized
              ? `Bus: ${summary.endpoints} endpoints, ${summary.pendingMessages} pending, ${summary.openThreads} open, ${summary.parkedThreads} parked, ${summary.quarantined} quarantined. Hooks: Claude ${summary.hookDelivery.claude ? "on" : "off"}, Codex ${summary.hookDelivery.codex ? "on" : "off"}.`
              : "Bus is enabled but not initialized in this checkout. Run `storybloq bus init` to participate.");
        },
      )
      .command(
        "doctor",
        "Validate Bus storage, endpoint, and mailbox integrity",
        (y2) => formatOption(y2),
        async (argv) => {
          const format = formatValue(argv.format);
          await runBus(format, busDoctor, (result) => result.healthy
            ? result.summary.initialized
              ? "Storybloq Bus is healthy."
              : "Storybloq Bus is enabled but not initialized in this checkout. Run `storybloq bus init` to participate."
            : `Storybloq Bus has ${result.findings.length} finding(s):\n${result.findings.map((finding) => `- ${finding}`).join("\n")}`,
          (result) => !result.healthy);
        },
      )
      .command(
        "check",
        "Run Bus release gates",
        (y2) => formatOption(y2.option("ship", { type: "boolean", default: false, demandOption: true })),
        async (argv) => {
          const format = formatValue(argv.format);
          if (argv.ship !== true) {
            writeOutput(formatFailure(new BusError("invalid_input", "Only `storybloq bus check --ship` is supported."), format));
            process.exitCode = ExitCode.USER_ERROR;
            return;
          }
          await runBus(format, checkBusShip, (result) => result.clear
            ? "Bus ship gate is clear."
            : `Bus ship gate blocked:\n${result.blockers.map((blocker) => `- ${blocker}`).join("\n")}`,
          (result) => !result.clear);
        },
      )
      .command(
        "export <thread-id>",
        "Explicitly export one Bus transcript",
        (y2) => y2
          .positional("thread-id", { type: "string", demandOption: true })
          .option("format", { type: "string", choices: ["md", "json"] as const, default: "md" }),
        async (argv) => {
          const format = formatValue(argv.format);
          await runBus(format, async (root) => {
            const value = await exportBusThread(root, argv["thread-id"] as string, format);
            return format === "json" ? JSON.parse(value) as unknown : value;
          }, (value) => typeof value === "string" ? value : JSON.stringify(value, null, 2));
        },
      )
      .demandCommand(1, "Specify a Bus subcommand")
      .strict(),
    () => {},
  );
}
