// Shared scaffolding for the T-509 MCP fixture servers: newline-delimited
// JSON-RPC over stdio. `handle(msg, send)` decides how to answer.
export const RESULT = {
  protocolVersion: "2024-11-05",
  capabilities: { tools: {} },
  serverInfo: { name: "fixture-bridge", version: "9.9.9" },
};

export function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

export function serve(handle) {
  let buf = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handle(msg);
    }
  });
  // A descendant that shrugs off SIGTERM, for the group-liveness test.
  if (process.env.SB_IGNORE_SIGTERM) process.on("SIGTERM", () => {});
  // Stay alive like a real server until the parent tears us down.
  setInterval(() => {}, 1_000);
}
