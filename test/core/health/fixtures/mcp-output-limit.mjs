import { serve } from "./_serve.mjs";
serve((msg) => {
  if (msg.method !== "initialize") return;
  const line = "x".repeat(1000) + "\n";
  for (let i = 0; i < 300; i += 1) process.stdout.write(line);
});
