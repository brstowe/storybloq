import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTO_COMPACT_WINDOW_BOUNDS, autoCompactWindowLayers, readAutoCompactWindow, readAutoCompactWindowDiagnostic } from "../../src/core/claude-settings.js";

interface Fixture {
  root: string;
  user: string;
  write(layer: "user" | "project" | "local", body: string): void;
}

function withFixture(fn: (f: Fixture) => void): void {
  const base = mkdtempSync(join(tmpdir(), "claude-settings-"));
  const root = join(base, "project");
  const user = join(base, "home", ".claude", "settings.json");
  mkdirSync(join(root, ".claude"), { recursive: true });
  mkdirSync(join(base, "home", ".claude"), { recursive: true });
  const paths = {
    user,
    project: join(root, ".claude", "settings.json"),
    local: join(root, ".claude", "settings.local.json"),
  };
  try {
    fn({ root, user, write: (layer, body) => writeFileSync(paths[layer], body) });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const w = (n: number) => JSON.stringify({ autoCompactWindow: n });

describe("readAutoCompactWindow", () => {
  it("names the three layers in precedence order, user first", () => {
    expect(autoCompactWindowLayers("/p", "/u/settings.json").map((l) => l.source)).toEqual(["user", "project", "local"]);
  });

  it("absent everywhere is null, never a default", () => {
    withFixture((f) => {
      expect(readAutoCompactWindow(f.root, f.user)).toBeNull();
    });
  });

  it("last DEFINED layer wins: local over project over user", () => {
    withFixture((f) => {
      f.write("user", w(200_000));
      expect(readAutoCompactWindow(f.root, f.user)).toEqual({ value: 200_000, source: "user" });
      f.write("project", w(400_000));
      expect(readAutoCompactWindow(f.root, f.user)).toEqual({ value: 400_000, source: "project" });
      f.write("local", w(450_000));
      expect(readAutoCompactWindow(f.root, f.user)).toEqual({ value: 450_000, source: "local" });
    });
  });

  it("a higher layer that does not define the key does not shadow a lower one", () => {
    withFixture((f) => {
      f.write("user", w(300_000));
      f.write("local", JSON.stringify({ model: "opus" }));
      expect(readAutoCompactWindow(f.root, f.user)).toEqual({ value: 300_000, source: "user" });
    });
  });

  it("a malformed higher layer is skipped, not fatal", () => {
    withFixture((f) => {
      f.write("user", w(300_000));
      f.write("local", "{ this is not json");
      expect(readAutoCompactWindow(f.root, f.user)).toEqual({ value: 300_000, source: "user" });
    });
  });

  it("wrong type, non-integer, out-of-bounds and non-object bodies are treated as undefined", () => {
    withFixture((f) => {
      f.write("user", w(300_000));
      for (const body of [
        JSON.stringify({ autoCompactWindow: "450000" }),
        JSON.stringify({ autoCompactWindow: 450_000.5 }),
        w(AUTO_COMPACT_WINDOW_BOUNDS.min - 1),
        w(AUTO_COMPACT_WINDOW_BOUNDS.max + 1),
        JSON.stringify([450_000]),
        "null",
      ]) {
        f.write("local", body);
        expect(readAutoCompactWindow(f.root, f.user), body).toEqual({ value: 300_000, source: "user" });
      }
      f.write("local", w(AUTO_COMPACT_WINDOW_BOUNDS.min));
      expect(readAutoCompactWindow(f.root, f.user)?.value).toBe(AUTO_COMPACT_WINDOW_BOUNDS.min);
    });
  });

  it("a symlinked settings file is honoured (config is user input; readBoundedFile resolves then no-follows)", () => {
    withFixture((f) => {
      const target = join(f.root, "real-settings.json");
      writeFileSync(target, w(420_000));
      symlinkSync(target, join(f.root, ".claude", "settings.local.json"));
      expect(readAutoCompactWindow(f.root, f.user)).toEqual({ value: 420_000, source: "local" });
    });
  });

  it("a dangling symlink or a directory at a layer path reads as undefined", () => {
    withFixture((f) => {
      f.write("user", w(300_000));
      symlinkSync(join(f.root, "missing.json"), join(f.root, ".claude", "settings.local.json"));
      mkdirSync(join(f.root, ".claude", "settings.json"));
      expect(readAutoCompactWindow(f.root, f.user)).toEqual({ value: 300_000, source: "user" });
    });
  });
});

// T-502: `storybloq health` must never turn "I could not read your settings"
// into "your window is fine", so the same layers are also readable
// three-valued. The wrapper above keeps its null-collapsing contract.
describe("readAutoCompactWindowDiagnostic (T-502)", () => {
  const kinds = (root: string, user: string) =>
    readAutoCompactWindowDiagnostic(root, user).layers.map((l) => `${l.source}:${l.kind}`);

  it("returns the three layers lowest precedence first", () => {
    expect(readAutoCompactWindowDiagnostic("/p", "/u/settings.json").layers.map((l) => l.source)).toEqual([
      "user",
      "project",
      "local",
    ]);
  });

  it("a missing file is absent, not indeterminate", () => {
    withFixture((f) => {
      expect(kinds(f.root, f.user)).toEqual(["user:absent", "project:absent", "local:absent"]);
    });
  });

  it("a present file with the key unset is absent", () => {
    withFixture((f) => {
      f.write("user", JSON.stringify({ somethingElse: 1 }));
      expect(kinds(f.root, f.user)[0]).toBe("user:absent");
    });
  });

  it("a valid in-bounds integer is ok and carries the value", () => {
    withFixture((f) => {
      f.write("project", w(500_000));
      const project = readAutoCompactWindowDiagnostic(f.root, f.user).layers.find((l) => l.source === "project")!;
      expect(project.kind).toBe("ok");
      expect(project.value).toBe(500_000);
    });
  });

  it("unparseable JSON, a non-object document, a wrong type and an out-of-bounds value are all indeterminate", () => {
    for (const body of [
      "{ not json",
      "[1,2,3]",
      JSON.stringify({ autoCompactWindow: "500000" }),
      JSON.stringify({ autoCompactWindow: 1.5 }),
      w(AUTO_COMPACT_WINDOW_BOUNDS.min - 1),
      w(AUTO_COMPACT_WINDOW_BOUNDS.max + 1),
    ]) {
      withFixture((f) => {
        f.write("local", body);
        expect(kinds(f.root, f.user)[2]).toBe("local:indeterminate");
      });
    }
  });

  it("an inaccessible parent directory is indeterminate, not absent", () => {
    if (process.getuid?.() === 0) return; // root can traverse anything
    withFixture((f) => {
      const dir = join(f.root, ".claude");
      chmodSync(dir, 0o000);
      try {
        expect(kinds(f.root, f.user)[1]).toBe("project:indeterminate");
      } finally {
        chmodSync(dir, 0o700);
      }
    });
  });

  it("a symlink loop is indeterminate, and a dangling symlink is absent", () => {
    withFixture((f) => {
      const a = join(f.root, ".claude", "settings.json");
      rmSync(a, { force: true });
      symlinkSync(join(f.root, ".claude", "loop-b"), a);
      symlinkSync(a, join(f.root, ".claude", "loop-b"));
      expect(kinds(f.root, f.user)[1]).toBe("project:indeterminate");
    });
    withFixture((f) => {
      symlinkSync(join(f.root, ".claude", "missing.json"), join(f.root, ".claude", "settings.local.json"));
      expect(kinds(f.root, f.user)[2]).toBe("local:absent");
    });
  });

  it("the wrapper still takes the highest ok layer and ignores an indeterminate one above it", () => {
    withFixture((f) => {
      f.write("user", w(500_000));
      f.write("local", "{ broken");
      expect(readAutoCompactWindow(f.root, f.user)).toEqual({ value: 500_000, source: "user" });
      expect(kinds(f.root, f.user)).toEqual(["user:ok", "project:absent", "local:indeterminate"]);
    });
  });
});
