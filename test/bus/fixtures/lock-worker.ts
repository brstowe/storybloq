import { readFile, writeFile } from "node:fs/promises";
import { acquireHardenedLock, withHardenedLock } from "../../../src/bus/lock.js";

const [mode, lockPath, counterPath] = process.argv.slice(2);

async function main(): Promise<void> {
  if (!lockPath) throw new Error("lock path is required");
  if (mode === "holder") {
    await acquireHardenedLock(lockPath);
    process.send?.({ type: "ready" });
    await new Promise(() => undefined);
    return;
  }
  if (mode !== "contender" || !counterPath) throw new Error("invalid worker arguments");
  const seq = await withHardenedLock(lockPath, async () => {
    let current = 0;
    try {
      current = Number.parseInt(await readFile(counterPath, "utf-8"), 10) || 0;
    } catch {
      current = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(counterPath, String(current + 1), "utf-8");
    return current + 1;
  }, { timeoutMs: 15_000 });
  process.send?.({ type: "done", seq });
}

main().catch((err) => {
  process.send?.({ type: "error", message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
