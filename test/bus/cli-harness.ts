import yargs from "yargs";
import { registerBusCommand } from "../../src/cli/commands/bus.js";

// Drives the real `storybloq bus <sub>` yargs command tree in-process. runBus in
// bus.ts discovers the project via process.cwd(), so the harness chdirs into the
// root, captures stdout, restores cwd + exit code, and returns the output. Never
// use --delivery live in tests: the live path mutates the real ~/.claude and
// ~/.codex hook files. Poll delivery skips all hook mutation.
export async function runBusCli(
  root: string,
  args: string[],
): Promise<{ stdout: string; exitCode: number | undefined }> {
  const chunks: string[] = [];
  // Save the UNBOUND original and restore exactly it in finally. Binding it here and
  // restoring the bound copy would permanently rebind process.stdout.write to a wrapper
  // (the original method identity would be lost after the first harness run). The shim
  // captures and delegates to the original via `.call(process.stdout, ...)` so its
  // backpressure return value stays honest.
  const origWrite = process.stdout.write;
  const origCwd = process.cwd();
  const origExit = process.exitCode;
  (process.stdout.write as unknown) = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(String(chunk));
    return (origWrite as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  };
  let exitCode: number | undefined;
  try {
    process.chdir(root);
    process.exitCode = undefined;
    const parser = registerBusCommand(yargs(args)).exitProcess(false).fail(false);
    await parser.parseAsync();
    exitCode = process.exitCode;
  } finally {
    process.stdout.write = origWrite;
    process.chdir(origCwd);
    process.exitCode = origExit;
  }
  return { stdout: chunks.join(""), exitCode };
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function containsUuid(text: string): boolean {
  return UUID_RE.test(text);
}
