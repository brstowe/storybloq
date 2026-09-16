// Sends its own ping REQUEST with id 1 (request ids are independent per
// direction) before the initialize answer, and only answers initialize once
// the client has responded to the ping.
import { RESULT, send, serve } from "./_serve.mjs";
let pending = null;
serve((msg) => {
  if (msg.method === "initialize") {
    pending = msg.id;
    send({ jsonrpc: "2.0", id: 1, method: "ping" });
    return;
  }
  if (msg.method === undefined && msg.id === 1 && pending !== null && "result" in msg) {
    send({ jsonrpc: "2.0", id: pending, result: RESULT });
    pending = null;
  }
});
