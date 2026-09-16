import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BRIDGE_MCP_NAME,
  manualBridgeAdd,
  registerBridgeMcp,
  type BridgeExec,
  type BridgeExecResult,
} from "../../../src/cli/commands/setup-skill.js";
import type { BundledBridge } from "../../../src/core/bridge-resolve.js";

/**
 * T-509 part 2: setup registers the bundled codex-claude-bridge with Claude
 * Code as `codex-bridge` at user scope, by absolute entry path, with no cwd.
 * One test per outcome. A foreign entry under that name is never touched.
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tempDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "sb-bridge-reg-")));
  dirs.push(d);
  return d;
}

function installed(dir: string): Extract<BundledBridge, { kind: "installed" }> {
  const packageDir = join(dir, "node_modules", "codex-claude-bridge");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  writeFileSync(join(packageDir, "dist", "index.js"), "// bridge\n");
  return { kind: "installed", packageDir, entry: join(packageDir, "dist", "index.js"), version: "1.8.0" };
}

function fakeExec(result: BridgeExecResult): { exec: BridgeExec; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    exec: (file, args) => {
      calls.push([file, ...args]);
      return result;
    },
  };
}

function harness(result: BridgeExecResult = { kind: "ok" }) {
  const { exec, calls } = fakeExec(result);
  const lines: string[] = [];
  return { exec, calls, lines, log: (l: string) => { lines.push(l); } };
}

describe("registerBridgeMcp", () => {
  it("absent bundle: skipped, nothing executed", () => {
    const dir = tempDir();
    const h = harness();
    const out = registerBridgeMcp({ bundled: { kind: "absent" }, claudeJsonPath: join(dir, ".claude.json"), exec: h.exec, log: h.log });
    expect(out).toBe("skipped");
    expect(h.calls).toEqual([]);
    expect(h.lines.join("\n")).toContain("Codex review bridge skipped: codex-claude-bridge did not install (optional dependency; see README)");
  });

  it("unusable bundle: skipped with the reason and the reinstall command, nothing executed", () => {
    const dir = tempDir();
    const h = harness();
    const out = registerBridgeMcp({
      bundled: { kind: "unusable", reason: "entry file missing: /x/dist/index.js" },
      claudeJsonPath: join(dir, ".claude.json"),
      exec: h.exec,
      log: h.log,
    });
    expect(out).toBe("unusable");
    expect(h.calls).toEqual([]);
    const text = h.lines.join("\n");
    expect(text).toContain("installed but unusable (entry file missing: /x/dist/index.js)");
    expect(text).toContain("npm install -g @storybloq/storybloq@latest");
  });

  it("no ~/.claude.json: registers by absolute entry path at user scope with no cwd", () => {
    const dir = tempDir();
    const bundled = installed(dir);
    const h = harness();
    const out = registerBridgeMcp({ bundled, claudeJsonPath: join(dir, ".claude.json"), exec: h.exec, log: h.log });
    expect(out).toBe("registered");
    expect(h.calls).toEqual([["claude", "mcp", "add", BRIDGE_MCP_NAME, "-s", "user", "--", "node", bundled.entry]]);
    expect(h.calls[0]!.some((a) => a.includes("cwd"))).toBe(false);
    expect(h.lines.join("\n")).toContain("Codex review bridge registered as codex-bridge (bundled 1.8.0)");
  });

  it("file present without the key: registers", () => {
    const dir = tempDir();
    const bundled = installed(dir);
    const path = join(dir, ".claude.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { storybloq: { command: "storybloq", args: ["--mcp"] } } }));
    const h = harness();
    expect(registerBridgeMcp({ bundled, claudeJsonPath: path, exec: h.exec, log: h.log })).toBe("registered");
    expect(h.calls).toHaveLength(1);
  });

  it("matching entry (through a symlinked path): exists, nothing executed", () => {
    const dir = tempDir();
    const bundled = installed(dir);
    const link = join(dir, "link");
    symlinkSync(join(dir, "node_modules"), link);
    const path = join(dir, ".claude.json");
    writeFileSync(path, JSON.stringify({
      mcpServers: { [BRIDGE_MCP_NAME]: { command: "/usr/local/bin/node", args: [join(link, "codex-claude-bridge", "dist", "index.js")] } },
    }));
    const h = harness();
    expect(registerBridgeMcp({ bundled, claudeJsonPath: path, exec: h.exec, log: h.log })).toBe("exists");
    expect(h.calls).toEqual([]);
    expect(h.lines.join("\n")).toContain("Codex review bridge already registered as codex-bridge");
  });

  it("matching command and args but with a cwd: foreign (the no-cwd contract), file untouched", () => {
    const dir = tempDir();
    const bundled = installed(dir);
    const path = join(dir, ".claude.json");
    const before = JSON.stringify({ mcpServers: { [BRIDGE_MCP_NAME]: { command: "node", args: [bundled.entry], cwd: "/somewhere" } } });
    writeFileSync(path, before);
    const h = harness();
    expect(registerBridgeMcp({ bundled, claudeJsonPath: path, exec: h.exec, log: h.log })).toBe("foreign");
    expect(h.calls).toEqual([]);
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(h.lines.join("\n")).toContain("with a cwd");
  });

  it("foreign entry: left byte-identical, names scope, command and args, and the two steps", () => {
    const dir = tempDir();
    const bundled = installed(dir);
    const path = join(dir, ".claude.json");
    const before = JSON.stringify({ mcpServers: { [BRIDGE_MCP_NAME]: { command: "npx", args: ["-y", "codex-claude-bridge@latest"] } } }, null, 2);
    writeFileSync(path, before);
    const h = harness();
    expect(registerBridgeMcp({ bundled, claudeJsonPath: path, exec: h.exec, log: h.log })).toBe("foreign");
    expect(h.calls).toEqual([]);
    expect(readFileSync(path, "utf-8")).toBe(before);
    const text = h.lines.join("\n");
    expect(text).toContain("user scope");
    expect(text).toContain("npx -y codex-claude-bridge@latest");
    expect(text).toContain("claude mcp remove codex-bridge -s user");
    expect(text).toContain("storybloq setup-skill");
  });

  it("malformed ~/.claude.json: unverifiable, not added, file byte-identical, manual command shown", () => {
    const dir = tempDir();
    const bundled = installed(dir);
    const path = join(dir, ".claude.json");
    writeFileSync(path, "{ not json");
    const h = harness();
    expect(registerBridgeMcp({ bundled, claudeJsonPath: path, exec: h.exec, log: h.log })).toBe("unverifiable");
    expect(h.calls).toEqual([]);
    expect(readFileSync(path, "utf-8")).toBe("{ not json");
    const text = h.lines.join("\n");
    expect(text).toContain("could not be read (unparseable)");
    expect(text).toContain(`claude mcp add codex-bridge -s user -- node ${bundled.entry}`);
  });

  it("claude answers 'already exists' with a matching entry written meanwhile: exists", () => {
    const dir = tempDir();
    const bundled = installed(dir);
    const path = join(dir, ".claude.json");
    const calls: string[][] = [];
    const exec: BridgeExec = (file, args) => {
      calls.push([file, ...args]);
      writeFileSync(path, JSON.stringify({ mcpServers: { [BRIDGE_MCP_NAME]: { command: "node", args: [bundled.entry] } } }));
      return { kind: "failed", status: 1, stderr: "MCP server codex-bridge already exists in user config\n" };
    };
    const lines: string[] = [];
    expect(registerBridgeMcp({ bundled, claudeJsonPath: path, exec, log: (l) => { lines.push(l); } })).toBe("exists");
    expect(calls).toHaveLength(1);
  });

  it("claude answers 'already exists' but the re-read shows a foreign entry: foreign, file untouched", () => {
    const dir = tempDir();
    const bundled = installed(dir);
    const path = join(dir, ".claude.json");
    const foreign = JSON.stringify({ mcpServers: { [BRIDGE_MCP_NAME]: { command: "npx", args: ["-y", "codex-claude-bridge@latest"] } } });
    let calls = 0;
    const exec: BridgeExec = () => {
      calls += 1;
      writeFileSync(path, foreign);
      return { kind: "failed", status: 1, stderr: "already exists" };
    };
    const lines: string[] = [];
    expect(registerBridgeMcp({ bundled, claudeJsonPath: path, exec, log: (l) => { lines.push(l); } })).toBe("foreign");
    expect(calls).toBe(1);
    expect(readFileSync(path, "utf-8")).toBe(foreign);
    expect(lines.join("\n")).toContain("claude mcp remove codex-bridge -s user");
  });

  it("manual command shell-quotes an entry path with a space", () => {
    const dir = tempDir();
    const spaced = join(dir, "with space", "node_modules", "codex-claude-bridge", "dist", "index.js");
    mkdirSync(join(dir, "with space", "node_modules", "codex-claude-bridge", "dist"), { recursive: true });
    writeFileSync(spaced, "");
    const bundled: BundledBridge = { kind: "installed", packageDir: join(dir, "with space"), entry: spaced, version: "1.8.0" };
    const h = harness({ kind: "enoent" });
    registerBridgeMcp({ bundled, claudeJsonPath: join(dir, ".claude.json"), exec: h.exec, log: h.log });
    expect(h.lines.join("\n")).toContain(`-- node '${spaced}'`);
  });

  it("manual command on win32: quoted for a plain path, a JSON edit for a path cmd.exe would expand", () => {
    expect(manualBridgeAdd("C:\\Users\\a b\\index.js", "C:\\Users\\a b\\.claude.json", "win32")).toBe('claude mcp add codex-bridge -s user -- node "C:\\Users\\a b\\index.js"');
    const edit = manualBridgeAdd("C:\\Users\\%u%\\index.js", "C:\\Users\\x\\.claude.json", "win32");
    expect(edit).not.toContain("claude mcp add");
    expect(edit).toContain('"args":["C:\\\\Users\\\\%u%\\\\index.js"]');
    expect(manualBridgeAdd("/u/bang!/index.js", "/u/.claude.json", "linux")).toBe("claude mcp add codex-bridge -s user -- node '/u/bang!/index.js'");
  });

  it("claude answers 'already exists' but the re-read is malformed: unverifiable", () => {
    const dir = tempDir();
    const bundled = installed(dir);
    const path = join(dir, ".claude.json");
    const exec: BridgeExec = () => {
      writeFileSync(path, "garbage");
      return { kind: "failed", status: 1, stderr: "already exists" };
    };
    const lines: string[] = [];
    expect(registerBridgeMcp({ bundled, claudeJsonPath: path, exec, log: (l) => { lines.push(l); } })).toBe("unverifiable");
  });

  it("claude CLI missing: failed with the manual command", () => {
    const dir = tempDir();
    const bundled = installed(dir);
    const h = harness({ kind: "enoent" });
    expect(registerBridgeMcp({ bundled, claudeJsonPath: join(dir, ".claude.json"), exec: h.exec, log: h.log })).toBe("failed");
    const text = h.lines.join("\n");
    expect(text).toContain("`claude` CLI not found");
    expect(text).toContain(`claude mcp add codex-bridge -s user -- node ${bundled.entry}`);
  });

  it("other non-zero exit: failed with the first stderr line and the manual command", () => {
    const dir = tempDir();
    const bundled = installed(dir);
    const h = harness({ kind: "failed", status: 2, stderr: "boom: first line\nsecond line" });
    expect(registerBridgeMcp({ bundled, claudeJsonPath: join(dir, ".claude.json"), exec: h.exec, log: h.log })).toBe("failed");
    const text = h.lines.join("\n");
    expect(text).toContain("boom: first line");
    expect(text).not.toContain("second line");
    expect(text).toContain(`claude mcp add codex-bridge -s user -- node ${bundled.entry}`);
  });
});
