/**
 * T-509: one formatter for every dynamic argument that is DISPLAYED as part of
 * a command the user is expected to paste, or passed through a shell on win32.
 * Bare-safe tokens stay as they are so ordinary paths read naturally.
 *
 * cmd.exe expands `%NAME%` (and `!NAME!` under delayed expansion) even inside
 * double quotes and offers no escape for either on a command line, and an
 * embedded double quote flips cmd.exe's own quoting state regardless of the
 * CRT-level escaping the target program will apply, so `a"&whoami&"b` would
 * run `whoami`. A value containing `%`, `!` or `"` therefore cannot be made
 * safe for a win32 shell launch; `winShellArgv` refuses such an argv and the
 * caller reports it instead.
 */
const SAFE_POSIX = /^[A-Za-z0-9_\-./:@%+=,~]+$/;
const SAFE_WIN32 = /^[A-Za-z0-9_\-./:@+=,~\\]+$/;

export function shellArg(value: string, platform: NodeJS.Platform = process.platform): string {
  const win = platform === "win32";
  // A leading tilde would expand; a leading hyphen is a flag and reads as one.
  if (value.length > 0 && (win ? SAFE_WIN32 : SAFE_POSIX).test(value) && !value.startsWith("~")) return value;
  if (win) return `"${winQuoteBody(value)}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The body of a double-quoted win32 argument per the CRT argv rules that
 * node.exe and every MSVC program apply: a run of backslashes right before a
 * quote is doubled and the quote escaped; a run right before the closing
 * quote is doubled; every other backslash is literal.
 */
function winQuoteBody(value: string): string {
  let out = "";
  let backslashes = 0;
  for (const ch of value) {
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      out += "\\".repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return out + "\\".repeat(backslashes * 2);
}

/** True when cmd.exe could rewrite the value: variable expansion, or a quote that changes its quoting state. */
export function cmdExpands(value: string): boolean {
  return value.includes("%") || value.includes("!") || value.includes('"');
}

/**
 * The argv to hand a win32 shell launch (`shell: true`, needed for npm .cmd
 * shims), or null when any argument could be expanded by cmd.exe.
 */
export function winShellArgv(args: readonly string[]): string[] | null {
  if (args.some(cmdExpands)) return null;
  return args.map((a) => shellArg(a, "win32"));
}
