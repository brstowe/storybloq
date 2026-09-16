#!/usr/bin/env tsx
/**
 * Regenerates `src/skill/reference.md` from the COMMANDS/MCP_TOOLS registry.
 *
 * The checked-in file is generated, never hand-edited, and
 * `test/cli/commands/reference.test.ts`'s drift check is the gate: it
 * compares the file byte-for-byte against `handleReference("md")`. This
 * script is that one command, so a registry change never has to be
 * transcribed by hand.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleReference } from "../src/cli/commands/reference.js";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "src", "skill", "reference.md");
writeFileSync(target, handleReference("md") + "\n");
process.stdout.write(`regenerated ${target}\n`);
