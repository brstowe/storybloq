/**
 * ISS-1137 skill-doc anchors: the two-direction liveness rule with its numbers.
 *
 * Each anchor is a clause a reader would act wrongly without. The region is
 * asserted NON-EMPTY before any anchor runs so an extractor miss cannot pass
 * vacuously (same discipline as test/bus/wake-doc-anchors.test.ts).
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(here, "..", "..", "src", "skill");

function section(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  if (start < 0) return "";
  const rest = doc.slice(start + heading.length);
  const next = rest.search(/\n#{2,3} /);
  return next < 0 ? rest : rest.slice(0, next);
}

const DUET_HEADING = "### Liveness obligations (ISS-1137)";
const DUET_ANCHORS = [
  "does not resume itself across a turn boundary",
  "Never end a turn with an intention",
  "turn ending, continue needed",
  "longer than 30 minutes owes a message",
  "notify_when_idle: true",
  "An idle notice is not a report",
  "Sixty silent minutes",
  "states the worker obligation verbatim",
] as const;

const ORCH_MARKER = "**Liveness furniture (ISS-1137).**";
const ORCH_ANCHORS = [
  "never end a turn with an intention",
  "turn ending, continue needed",
  "longer than 30 minutes owes a message",
  "notify_when_idle: true",
  "one status demand per 60 silent minutes",
] as const;

describe("ISS-1137 liveness rule is carried by the skill docs", () => {
  it("duet-mode.md carries the two-direction rule with both numbers", async () => {
    const doc = await readFile(join(SKILL_DIR, "duet-mode.md"), "utf8");
    const region = section(doc, DUET_HEADING);
    expect(region.length).toBeGreaterThan(200);
    for (const anchor of DUET_ANCHORS) expect(region, anchor).toContain(anchor);
  });

  it("orchestrator-mode.md makes the obligation dispatch furniture", async () => {
    const doc = await readFile(join(SKILL_DIR, "orchestrator-mode.md"), "utf8");
    const start = doc.indexOf(ORCH_MARKER);
    expect(start).toBeGreaterThan(-1);
    const para = doc.slice(start, doc.indexOf("\n\n", start));
    expect(para.length).toBeGreaterThan(200);
    for (const anchor of ORCH_ANCHORS) expect(para, anchor).toContain(anchor);
  });
});
