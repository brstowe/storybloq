// A launcher (think npx) that hands the protocol to a grandchild and waits.
// The grandchild pid is written to $SB_GRANDCHILD_PID_FILE for the test.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const child = spawn(process.execPath, [fileURLToPath(new URL("./mcp-healthy.mjs", import.meta.url)), ...process.argv.slice(2)], { stdio: "inherit" });
if (process.env.SB_GRANDCHILD_PID_FILE) writeFileSync(process.env.SB_GRANDCHILD_PID_FILE, String(child.pid));
child.on("exit", (code) => process.exit(code ?? 0));
