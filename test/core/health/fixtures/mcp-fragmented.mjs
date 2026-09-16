import { RESULT, serve } from "./_serve.mjs";
serve((msg) => {
  if (msg.method !== "initialize") return;
  const text = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: RESULT }) + "\n";
  const third = Math.floor(text.length / 3);
  process.stdout.write(text.slice(0, third));
  setTimeout(() => process.stdout.write(text.slice(third, 2 * third)), 40);
  setTimeout(() => process.stdout.write(text.slice(2 * third)), 80);
});
