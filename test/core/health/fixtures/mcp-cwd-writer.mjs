// Writes a file into its cwd at startup (the bridge writes reviews.db there)
// and answers with that cwd as the server name so the test can inspect it.
import { writeFileSync } from "node:fs";
import { RESULT, send, serve } from "./_serve.mjs";
writeFileSync(`probe-wrote-${process.argv[2]}`, "");
serve((msg) => {
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { ...RESULT, serverInfo: { name: process.cwd(), version: "1" } } });
});
