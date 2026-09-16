import { send, serve } from "./_serve.mjs";
serve((msg) => { if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: "yes" }); });
