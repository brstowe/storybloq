/** T-424: desktop notification helper (platform routing + sanitization). */
import { describe, it, expect } from "vitest";
import { sendDesktopNotification } from "../../src/core/notify.js";

function capture(): { calls: Array<{ cmd: string; args: string[] }>; exec: (cmd: string, args: string[]) => boolean } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return {
    calls,
    exec: (cmd, args) => {
      calls.push({ cmd, args });
      return true;
    },
  };
}

describe("sendDesktopNotification", () => {
  it("uses osascript on macOS with quote-escaped AppleScript", () => {
    const { calls, exec } = capture();
    const ok = sendDesktopNotification('Limit "reset" now', "Storybloq", { platform: "darwin", exec });
    expect(ok).toBe(true);
    expect(calls[0]?.cmd).toBe("osascript");
    expect(calls[0]?.args[0]).toBe("-e");
    expect(calls[0]?.args[1]).toContain('display notification "Limit \\"reset\\" now"');
    expect(calls[0]?.args[1]).toContain('with title "Storybloq"');
  });

  it("uses notify-send on Linux", () => {
    const { calls, exec } = capture();
    expect(sendDesktopNotification("hello", "Title", { platform: "linux", exec })).toBe(true);
    expect(calls[0]).toEqual({ cmd: "notify-send", args: ["Title", "hello"] });
  });

  it("is a no-op on unsupported platforms", () => {
    const { calls, exec } = capture();
    expect(sendDesktopNotification("hello", "Title", { platform: "win32", exec })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("strips control characters and drops empty messages", () => {
    const { calls, exec } = capture();
    expect(sendDesktopNotification("\u0000\u001b\u0007", "T", { platform: "darwin", exec })).toBe(false);
    expect(calls).toHaveLength(0);

    sendDesktopNotification("ok\u0007bell", "T", { platform: "darwin", exec });
    expect(calls[0]?.args[1]).toContain('"okbell"');
  });

  it("truncates on a code-point boundary, never splitting an astral character", () => {
    // The 500-char cap falls exactly on an emoji: 499 ASCII, then "😀" (2 UTF-16
    // code units), then trailing padding that must be dropped. UTF-16 slicing
    // would keep a lone high surrogate; code-point slicing keeps the emoji whole.
    const { calls, exec } = capture();
    const msg = "a".repeat(499) + "\u{1F600}" + "b".repeat(50);
    expect(sendDesktopNotification(msg, "T", { platform: "darwin", exec })).toBe(true);
    const out = calls[0]!.args[1]!;
    expect(out.isWellFormed()).toBe(true); // no unpaired surrogate
    expect(out).toContain("\u{1F600}"); // the emoji survived intact
    expect(out).not.toContain("b"); // trailing padding was truncated away
  });
});
