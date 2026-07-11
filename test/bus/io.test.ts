import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __testing } from "../../src/bus/io.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Storybloq Bus durable IO", () => {
  it("removes its temporary file when writing fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "bus-io-"));
    roots.push(root);
    const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });

    await expect(__testing.writeDurableTemp(
      join(root, "state.json"),
      "content",
      async () => { throw failure; },
    )).rejects.toMatchObject({ code: "ENOSPC" });

    expect(await readdir(root)).toEqual([]);
  });
});
