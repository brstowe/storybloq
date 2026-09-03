/**
 * T-424: Best-effort desktop notifications for limit auto-resume moments
 * (resumed, gave-up, alive-but-blocked, approvals-blocked, plain-reset).
 *
 * macOS: osascript `display notification`. Linux: notify-send. Anything else
 * (or any failure): silent no-op -- a notification must never break the waker
 * or a hook path. Fire-and-forget: the child is detached and never awaited.
 */

import { spawn } from "node:child_process";

const DEFAULT_TITLE = "Storybloq";
const MAX_LEN = 500;

/** Strip control chars + length-bound; the message reaches a shellless spawn but stays display-clean. */
function sanitize(text: string, max = MAX_LEN): string {
  // Truncate on the code-POINT array (before join), never on the joined string:
  // slicing a UTF-16 string at `max` code units can split an astral character
  // (emoji, etc.) and emit an unpaired surrogate. Array.from yields whole code
  // points, so slice(0, max) always cuts on a character boundary.
  return Array.from(text)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .slice(0, max)
    .join("");
}

/** AppleScript double-quoted string literal (backslash + quote escapes). */
function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * True means "spawn REQUESTED", not "notifier ran": a missing executable
 * surfaces later through the ignored error event (ENOENT is async in Node).
 * Notifications are best-effort by design, so nothing awaits the result.
 */
function fireAndForget(cmd: string, args: string[]): boolean {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export interface NotifyDeps {
  platform?: NodeJS.Platform;
  exec?: (cmd: string, args: string[]) => boolean;
}

/**
 * Send a desktop notification. Returns true when a notifier process was
 * spawned (NOT that the user saw it -- there is no feedback channel).
 */
export function sendDesktopNotification(message: string, title = DEFAULT_TITLE, deps: NotifyDeps = {}): boolean {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? fireAndForget;
  const msg = sanitize(message);
  const ttl = sanitize(title, 100);
  if (!msg) return false;

  if (platform === "darwin") {
    const script = `display notification ${appleScriptString(msg)} with title ${appleScriptString(ttl)}`;
    return exec("osascript", ["-e", script]);
  }
  if (platform === "linux") {
    return exec("notify-send", [ttl, msg]);
  }
  return false;
}
