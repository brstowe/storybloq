import { describe, it, expect } from "vitest";
import { codexSurfaceForCommand } from "../../src/bus/endpoints.js";

// ISS-1166: with the app-server daemon running, a Codex CLI thread's tool shells
// are children of `codex app-server --listen unix://...`. That process is the
// daemon (reachable over its control socket, wake-capable), not the ChatGPT.app
// child, which is started WITHOUT --listen. The detector must tell them apart.
describe("ISS-1166 codex surface classification from the ancestor command line", () => {
  it("a plain codex TUI ancestor is codex_cli", () => {
    expect(codexSurfaceForCommand("/opt/homebrew/bin/codex")).toBe("codex_cli");
    expect(codexSurfaceForCommand("codex --model gpt-6")).toBe("codex_cli");
  });

  it("the daemon (app-server WITH --listen) hosts CLI threads: codex_cli", () => {
    expect(
      codexSurfaceForCommand("/Users/x/.codex/packages/standalone/current/codex app-server --listen unix:///Users/x/.codex/app-server-control/app-server-control.sock"),
    ).toBe("codex_cli");
    expect(codexSurfaceForCommand("codex app-server daemon --listen unix://sock")).toBe("codex_cli");
  });

  it("an app-server WITHOUT --listen is the ChatGPT.app child: codex_desktop", () => {
    expect(codexSurfaceForCommand("/Applications/ChatGPT.app/Contents/Resources/codex app-server")).toBe("codex_desktop");
    expect(codexSurfaceForCommand("codex app-server --some-other-flag")).toBe("codex_desktop");
  });

  it("--listen only counts as a standalone flag, not a substring", () => {
    expect(codexSurfaceForCommand("codex app-server --listener-name x")).toBe("codex_desktop");
    expect(codexSurfaceForCommand("codex app-server --listen=unix://sock")).toBe("codex_cli");
  });
});
