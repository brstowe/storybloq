#!/usr/bin/env node
// Incremental copy of storybloq state into the harness logs dir so a timeout or cancel still
// leaves the latest session state on the host.
//
// Every snapshot is copied into its own numbered directory (<dest>/.story.<n>) and published by
// swapping the <dest>/.story symlink with a single atomic rename, so a reader always sees a
// complete snapshot: either the previous one or the new one, never a partial copy and never a
// gap. last-snapshot is written only after a successful publish. Runs on the pinned Node runtime
// (task images need not ship python). Usage:
//   telemetry-copier.cjs <workdir> <dest> [--once] [--interval SECONDS]
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const KEEP = 2;

function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Temp file plus atomic replace: a failed write can never leave last-snapshot empty.
function writeStamp(dest) {
  const final = path.join(dest, "last-snapshot");
  const tmp = final + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, now() + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, final);
}

function copyTree(src, dst) {
  fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, errorOnExist: false, force: true });
}

function logError(dest, phase, exc) {
  try {
    fs.appendFileSync(path.join(dest, "copier-errors.log"), `${now()} ${phase} failed: ${exc && exc.name}: ${exc && exc.message}\n`);
  } catch (_) {
    // nothing else to do
  }
}

// Best-effort removal: a permission or I/O error here must never escape, so a failed cleanup
// or prune can neither hide the original failure nor stop the periodic copier.
function removeQuietly(dest, phase, target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (exc) {
    logError(dest, phase, exc);
    return false;
  }
}

function snapshot(workdir, dest) {
  const src = path.join(workdir, ".story");
  let st;
  try {
    st = fs.statSync(src);
  } catch (_) {
    return true; // nothing to copy yet
  }
  if (!st.isDirectory()) return true;
  fs.mkdirSync(dest, { recursive: true });
  const n = Date.now();
  const newDir = path.join(dest, `.story.${n}`);
  const tmpDir = newDir + ".partial";
  let published = false;
  try {
    if (!removeQuietly(dest, "stale-partial removal", tmpDir)) return false;
    copyTree(src, tmpDir);
    fs.renameSync(tmpDir, newDir); // complete copy now exists under its final name
    const tmpLink = path.join(dest, `.story.link.${n}`);
    fs.symlinkSync(path.basename(newDir), tmpLink);
    fs.renameSync(tmpLink, path.join(dest, ".story")); // atomic publish (replaces the old symlink)
    published = true;
    writeStamp(dest);
  } catch (exc) {
    logError(dest, published ? "stamp" : "copy", exc); // the original failure is logged first
    removeQuietly(dest, "cleanup", tmpDir);
    if (!published) removeQuietly(dest, "cleanup", newDir); // never delete a directory the link already points at
    return false;
  }
  // prune older snapshots, never the one currently linked
  const current = fs.readlinkSync(path.join(dest, ".story"));
  const olds = fs
    .readdirSync(dest)
    .filter((d) => d.startsWith(".story.") && !d.endsWith(".partial") && !d.includes("link") && d !== current)
    .sort();
  const prune = olds.length > KEEP ? olds.slice(0, olds.length - KEEP) : [];
  for (const d of prune) removeQuietly(dest, "prune", path.join(dest, d));
  return true;
}

// The periodic entry point never lets an exception out: the next interval always runs.
function snapshotGuarded(workdir, dest) {
  try {
    return snapshot(workdir, dest);
  } catch (exc) {
    logError(dest, "snapshot", exc);
    return false;
  }
}

function main(argv) {
  const [workdir, dest] = argv;
  const once = argv.includes("--once");
  let interval = 30;
  const i = argv.indexOf("--interval");
  if (i >= 0) interval = parseFloat(argv[i + 1]);
  const ok = snapshotGuarded(workdir, dest);
  if (once) return ok ? 0 : 1;
  setInterval(() => snapshotGuarded(workdir, dest), interval * 1000);
  return null;
}

const rc = main(process.argv.slice(2));
if (rc !== null) process.exit(rc);
