#!/usr/bin/env node
// Create the one storybloq ticket from the uploaded instruction file, passing the text as an
// argv value (no shell substitution, bytes preserved). Prints the ticket id. Runs on the pinned
// Node runtime the adapter installs in every container (task images need not ship python).
"use strict";
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const path = process.argv[2];
const text = fs.readFileSync(path, "utf8");
const first = text.split(/\r?\n/).find((line) => line.trim()) || "task";
const title = first.trim().slice(0, 120);
const r = spawnSync("storybloq", ["ticket", "create", "--type", "task", "--title", title, "--description", text, "--format", "json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (r.error) {
  process.stderr.write(String(r.error) + "\n");
  process.exit(127);
}
if (r.status !== 0) {
  process.stderr.write(r.stderr || "");
  process.exit(r.status === null ? 1 : r.status);
}
let out;
try {
  out = JSON.parse(r.stdout);
} catch (e) {
  process.stderr.write("ticket create printed no JSON: " + r.stdout.slice(0, 300));
  process.exit(3);
}
const data = out && out.data !== undefined ? out.data : out;
const tid = (data && (data.displayId || data.id)) || (data && data.item && data.item.displayId);
if (!tid) {
  process.stderr.write("no ticket id in: " + r.stdout.slice(0, 300));
  process.exit(3);
}
process.stdout.write(String(tid) + "\n");
