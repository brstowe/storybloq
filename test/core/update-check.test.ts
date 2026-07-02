import { describe, it, expect } from "vitest";
import { shouldEmitUpdateBanner } from "../../src/core/update-check.js";

// ISS-736: first coverage for the banner guard. The command guard is the
// primary lock (interactive `git merge` gives the driver a real TTY).
describe("shouldEmitUpdateBanner (ISS-736)", () => {
  const tty = { stderrIsTTY: true, env: {} as Record<string, string | undefined> };

  it("suppresses for the merge-driver command even on a TTY", () => {
    expect(shouldEmitUpdateBanner({ ...tty, command: "merge-driver" })).toBe(false);
  });

  it("suppresses when stderr is not a TTY", () => {
    expect(shouldEmitUpdateBanner({ stderrIsTTY: false, env: {}, command: "status" })).toBe(false);
  });

  it("suppresses when NO_UPDATE_NOTIFIER is set", () => {
    expect(shouldEmitUpdateBanner({ ...tty, env: { NO_UPDATE_NOTIFIER: "1" }, command: "status" })).toBe(false);
  });

  it("suppresses when CI is set, including CI=false (documented choice)", () => {
    expect(shouldEmitUpdateBanner({ ...tty, env: { CI: "true" }, command: "status" })).toBe(false);
    expect(shouldEmitUpdateBanner({ ...tty, env: { CI: "false" }, command: "status" })).toBe(false);
  });

  it("emits on a TTY with a clean env and an ordinary command", () => {
    expect(shouldEmitUpdateBanner({ ...tty, command: "status" })).toBe(true);
  });

  it("empty-string env values do not suppress", () => {
    expect(shouldEmitUpdateBanner({ ...tty, env: { CI: "", NO_UPDATE_NOTIFIER: "" }, command: "status" })).toBe(true);
  });
});
