import { RESULT, send, serve } from "./_serve.mjs";
serve((msg) => {
  if (msg.method !== "initialize") return;
  send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hi" } });
  send({ jsonrpc: "2.0", id: msg.id === 7 ? 8 : 7, result: { protocolVersion: "1999-01-01" } });
  send({ jsonrpc: "2.0", id: msg.id, result: RESULT });
});
