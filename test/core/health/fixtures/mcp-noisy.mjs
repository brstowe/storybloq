import { RESULT, send, serve } from "./_serve.mjs";
process.stdout.write("bridge starting up\nnot json at all {\n");
serve((msg) => {
  if (msg.method !== "initialize") return;
  process.stdout.write("still noisy\n");
  send({ jsonrpc: "2.0", id: msg.id, result: RESULT });
});
