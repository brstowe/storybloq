import { describe, expect, it } from "vitest";
import { cmdExpands, shellArg, winShellArgv } from "../../src/core/shell-arg.js";

describe("shellArg", () => {
  it("leaves a plain path alone", () => {
    expect(shellArg("/usr/lib/node_modules/x/dist/index.js", "darwin")).toBe("/usr/lib/node_modules/x/dist/index.js");
  });
  it("single-quotes spaces, dollars, backticks and quotes on POSIX", () => {
    expect(shellArg("/Users/a b/dist/index.js", "linux")).toBe("'/Users/a b/dist/index.js'");
    expect(shellArg("$HOME/x", "linux")).toBe("'$HOME/x'");
    expect(shellArg("`id`", "linux")).toBe("'`id`'");
    expect(shellArg("it's", "linux")).toBe(`'it'\\''s'`);
  });
  it("keeps a flag bare, quotes a leading tilde and an empty string", () => {
    expect(shellArg("-y", "linux")).toBe("-y");
    expect(shellArg("~/x", "linux")).toBe("'~/x'");
    expect(shellArg("", "linux")).toBe("''");
  });
  it("double-quotes on win32 per CRT argv rules: backslashes before a quote or the end are doubled, quotes are backslash-escaped", () => {
    expect(shellArg("C:\\Users\\a b\\index.js", "win32")).toBe('"C:\\Users\\a b\\index.js"');
    expect(shellArg('say "hi"', "win32")).toBe('"say \\"hi\\""');
    // A spaced path ending in a backslash: the trailing backslash is doubled so it cannot escape the closing quote.
    expect(shellArg("C:\\Program Files\\", "win32")).toBe('"C:\\Program Files\\\\"');
    // Backslashes before an embedded quote are doubled, then the quote is escaped.
    expect(shellArg('a b\\"c', "win32")).toBe('"a b\\\\\\"c"');
    // Backslashes NOT before a quote are left alone (they are literal in CRT parsing).
    expect(shellArg("a b\\c\\d", "win32")).toBe('"a b\\c\\d"');
    expect(shellArg("C:/plain/index.js", "win32")).toBe("C:/plain/index.js");
    expect(shellArg("C:\\plain\\index.js", "win32")).toBe("C:\\plain\\index.js");
    expect(shellArg("a&b", "win32")).toBe('"a&b"');
  });
  it("winShellArgv quotes each argument and refuses percent or exclamation anywhere", () => {
    expect(winShellArgv(["node", "C:\\Users\\!bob!\\index.js"])).toBeNull();
    expect(winShellArgv(["wow!"])).toBeNull();
    expect(cmdExpands("plain")).toBe(false);
    expect(cmdExpands("a!b")).toBe(true);
    expect(winShellArgv(["mcp", "add", "x", "--", "node", "C:\\Users\\a b\\index.js"])).toEqual(["mcp", "add", "x", "--", "node", '"C:\\Users\\a b\\index.js"']);
    expect(winShellArgv(["node", "C:\\Users\\%USERNAME%\\index.js"])).toBeNull();
    expect(winShellArgv(["100%"])).toBeNull();
    // An embedded double quote flips cmd.exe's quoting state no matter how the
    // CRT escaping reads, so `&whoami&` would run: refused outright.
    expect(winShellArgv(["node", 'a"&whoami&"b'])).toBeNull();
    expect(cmdExpands('x"y')).toBe(true);
  });
});
