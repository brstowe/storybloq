/**
 * ISS-1152: the quiet-machine check for gate-bearing runs.
 *
 * Concurrent test runners on one machine produce rotating timeouts and a
 * shifting failure set (ISS-887, ISS-901, ISS-932, ISS-1095), so every
 * gate-bearing run is preceded by this check. The check is therefore a
 * MEASUREMENT the gates rest on, and a measurement that reads like data while
 * establishing nothing is the exact failure this repo keeps paying for (L-103).
 *
 * Three ways it has been wrong for real, all three pinned below:
 *  1. `pgrep -f vitest` matches a waiting script's own wrapper.
 *  2. Narrowing to `vitest.mjs` misses `npm exec vitest`, reporting QUIET during
 *     a live run. The dangerous direction.
 *  3. The checker matches its own grep, so it can NEVER report quiet. This one
 *     cost 72 minutes during ISS-1132 and never failed loudly, because being
 *     permanently BUSY only ever wastes time.
 *
 * The matcher's rule is structural, not a blocklist: the EXECUTABLE must be a
 * node binary, and it is taken from `ps -o comm=` rather than parsed out of the
 * flattened command line. The shell, ps, awk and grep all carry the search
 * pattern in their own argv and none of them is node, so the checker cannot see
 * itself. An earlier attempt to recover the executable by string-splitting the
 * command instead broke in BOTH directions at once, and the paired fixtures for
 * that pair of failures are below.
 *
 * Fixtures feed exact process listings, in the same canonical four-field form
 * the script builds from two `ps` reads:
 *
 *     pid <TAB> ppid <TAB> comm <TAB> command
 *
 * TAB separated because both `comm` and `command` can contain spaces. Two live
 * tests spawn real processes and two stub `ps` on PATH, so the fixture seam is
 * not the only path under test.
 */

import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "..", "..", "scripts", "quiet-check.sh");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

interface Result {
  stdout: string;
  stderr: string;
  code: number;
}

async function invoke(args: string[], env: NodeJS.ProcessEnv): Promise<Result> {
  try {
    const { stdout, stderr } = await run(SCRIPT, args, { env });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? -1 };
  }
}

/** One canonical listing row. `comm` and `command` may both contain spaces. */
function row(pid: number, ppid: number, comm: string, command: string): string {
  return [pid, ppid, comm, command].join("\t");
}

/** A row for a plain executable that runs itself with no extra arguments. */
function plain(pid: number, ppid: number, path: string, args = ""): string {
  return row(pid, ppid, path, args ? `${path} ${args}` : path);
}

/**
 * A `ps` on PATH standing in for the real binary, so the production listing path
 * (three reads, the join, and every failure branch) can be driven deterministically.
 *
 * The script reads identity twice, bracketing the command read, so this stub
 * answers the identity format from a QUEUE: the first call gets `identity[0]`,
 * the second `identity[1]`, and any further call repeats the last entry. That is
 * what makes the join's race handling testable rather than merely asserted.
 *
 * Rows are written to files and emitted with `/bin/cat` rather than interpolated
 * into `printf`: an earlier stub passed rows through JSON.stringify, whose `\t`
 * escape stays LITERAL inside shell double quotes, so it emitted a one-field
 * line while claiming to emit a canonical four-field row.
 *
 * Identity rows are the real `pid ppid comm` format (space separated, comm last
 * and possibly containing spaces); command rows are `pid command`. Neither is
 * the canonical TAB format, which is what the join PRODUCES.
 *
 * The two formats are told apart by `ppid=,comm`, NOT by `comm` alone:
 * `pid=,command=` also contains the letters `comm`, and an earlier version of
 * this stub matched on that and silently answered both reads from one branch.
 * Anything else (the per-pid `ps -o ppid= -p` that walks the ancestor chain)
 * exits zero with no output.
 */
interface PsAnswer {
  rows: string[];
  exit?: number;
}

interface PsSpec {
  identity: PsAnswer[];
  command?: PsAnswer;
  /**
   * How the per-pid ancestor lookup behaves. Omitted, it is DELEGATED to the
   * real `/bin/ps`, so the ancestor walk genuinely resolves. An earlier stub
   * answered these with success and no output, which the script then read as a
   * completed chain: every listing test was passing through the very
   * incomplete-walk defect that another finding was about, and fixing that
   * defect would have broken them all.
   */
  ancestor?: PsAnswer;
}

async function psStub(spec: PsSpec): Promise<string> {
  const dir = await scratch("quiet-check-psstub-");
  const put = async (name: string, answer: PsAnswer) => {
    await writeFile(join(dir, name), answer.rows.join("\n") + (answer.rows.length ? "\n" : ""), "utf-8");
    await writeFile(join(dir, `${name}.exit`), String(answer.exit ?? 0), "utf-8");
  };
  await Promise.all(spec.identity.map((a, i) => put(`identity${i + 1}`, a)));
  await put("command", spec.command ?? { rows: [] });
  if (spec.ancestor) await put("ancestor", spec.ancestor);
  const stub = join(dir, "ps");
  await writeFile(
    stub,
    [
      "#!/bin/sh",
      `D=${JSON.stringify(dir)}`,
      'case "$*" in',
      "  *ppid=,comm*)",
      '    n=$(/bin/cat "$D/n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$D/n"',
      `    [ "$n" -gt ${spec.identity.length} ] && n=${spec.identity.length}`,
      '    /bin/cat "$D/identity$n"',
      '    exit "$(/bin/cat "$D/identity$n.exit")" ;;',
      "  *command*)",
      '    /bin/cat "$D/command"',
      '    exit "$(/bin/cat "$D/command.exit")" ;;',
      "  *)",
      ...(spec.ancestor
        ? ['    /bin/cat "$D/ancestor"', '    exit "$(/bin/cat "$D/ancestor.exit")" ;;']
        : ['    exec /bin/ps "$@" ;;']),
      "esac",
      "",
    ].join("\n"),
    "utf-8",
  );
  await chmod(stub, 0o755);
  return dir;
}

/** Runs the check with a stubbed `ps`, exercising the real listing path. */
async function withPs(spec: PsSpec): Promise<Result> {
  const dir = await psStub(spec);
  return invoke([], { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` });
}

/** Runs the check against a fixed process listing. */
async function check(rows: string[]): Promise<Result> {
  const dir = await scratch("quiet-check-");
  const file = join(dir, "ps.txt");
  await writeFile(file, rows.join("\n") + (rows.length ? "\n" : ""), "utf-8");
  return invoke([], { ...process.env, QUIET_CHECK_PS_FILE: file });
}

describe("ISS-1152 quiet-check reports a genuinely idle machine as quiet", () => {
  it("reports QUIET and exits zero when no node process is running", async () => {
    const { stdout, code } = await check([plain(101, 100, "/bin/zsh", "-l"), plain(102, 100, "/usr/sbin/cupsd")]);
    expect(stdout).toContain("QUIET");
    expect(code).toBe(0);
  });

  it("reports QUIET when ONLY the checker's own pipeline carries the pattern", async () => {
    // The bug that cost 72 minutes on ISS-1132. `grep` on that machine is a shell
    // function that execs a binary with the search pattern in its argv, so the
    // words "vitest" and "jest" appear in a live command line every time the
    // check runs. A word-matching check can never report quiet, in any machine
    // state, and it fails in the direction that never looks like a failure.
    const { stdout, code } = await check([
      row(111, 110, "/bin/zsh", "/bin/zsh -c ./quiet-check.sh # mentions vitest and jest"),
      row(112, 111, "/opt/homebrew/bin/ugrep", "ugrep -G --ignore-files --hidden vitest|jest"),
      row(113, 111, "/usr/bin/awk", "/usr/bin/awk -v self=1 /vitest/ || /jest/"),
      row(114, 110, "/bin/ps", "/bin/ps -axo pid=,ppid=,command="),
    ]);
    expect(stdout).toContain("QUIET");
    expect(code).toBe(0);
  });

  it("ignores a non-node process whose arguments name a vitest file", async () => {
    const { stdout, code } = await check([plain(201, 200, "/bin/cat", "/repo/vitest.config.ts")]);
    expect(stdout).toContain("QUIET");
    expect(code).toBe(0);
  });
});

describe("ISS-1152 quiet-check detects every real runner form", () => {
  // Each row is a form observed in the wild. The `node (vitest N)` rows are the
  // ones a `vitest.mjs|.bin/vitest` matcher misses, which is the dangerous
  // direction: it lets two gates overlap while reporting the machine idle. They
  // are also why the executable prefix cannot simply be stripped by length: a
  // process that rewrote its title no longer starts with its own comm.
  const NVM = "/Users/x/.nvm/versions/node/v22.18.0/bin/node";
  const FORMS: Array<[string, string]> = [
    // The first two are the shape a real vitest worker ACTUALLY has on macOS,
    // captured from `ps` rather than imagined: the title rewrite lands in comm
    // AS WELL AS in command, so the process is not identifiable by executable
    // path at all and the two fields are byte-identical. These fixtures used to
    // carry a real node path in comm, which is a shape that does not occur, and
    // every test built on them was green while the instrument could not see a
    // live vitest run of eleven workers.
    ["worker with a rewritten title (real macOS shape)", row(301, 300, "node (vitest 3)", "node (vitest 3)")],
    ["runner with a rewritten title (real macOS shape)", row(302, 300, "node (vitest)", "node (vitest)")],
    ["rewritten command but a resolvable comm", row(309, 300, NVM, "node (vitest 3)")],
    ["direct mjs runner", plain(303, 300, NVM, "/repo/node_modules/vitest/vitest.mjs run")],
    ["npm bootstrap", plain(304, 300, "/usr/local/bin/node", "/usr/local/lib/node_modules/npm/bin/npm-cli.js exec vitest")],
    ["bare node on PATH", row(305, 300, "node", "node /repo/node_modules/.bin/vitest run")],
    ["jest worker", plain(306, 300, NVM, "/repo/node_modules/jest-worker/build/workers/processChild.js")],
    ["jest cli", plain(307, 300, "/usr/local/bin/node", "/repo/node_modules/.bin/jest --runInBand")],
    ["tinypool forks worker", plain(308, 300, "/usr/local/bin/node", "/repo/node_modules/tinypool/dist/entry/forks.js")],
  ];

  for (const [label, line] of FORMS) {
    it(`detects ${label} and exits one`, async () => {
      const { stdout, code } = await check([line]);
      expect(stdout).toContain("BUSY");
      expect(code).toBe(1);
    });
  }

  it("prints the offending COMMAND LINE, not merely a pid", async () => {
    // A bare pid is useless during an incident: the whole point is to say WHICH
    // repository is running, so the operator can decide whether to wait.
    const { stdout } = await check([
      plain(401, 400, "/usr/local/bin/node", "/Users/x/Developer/other-repo/node_modules/vitest/vitest.mjs run"),
    ]);
    expect(stdout).toContain("401");
    expect(stdout).toContain("other-repo");
    expect(stdout).toContain("vitest.mjs");
  });

  it("reports every concurrent runner, not just the first", async () => {
    const { stdout } = await check([
      row(501, 500, "/usr/local/bin/node", "node (vitest 1)"),
      row(502, 500, "/usr/local/bin/node", "node (vitest 2)"),
      row(503, 500, "/usr/local/bin/node", "node (vitest 3)"),
    ]);
    for (const pid of ["501", "502", "503"]) expect(stdout).toContain(pid);
  });
});

describe("ISS-1152 quiet-check takes the executable from comm, never from the command string", () => {
  // The paired failures of one bad fix. An attempt to tolerate spaces in the
  // interpreter path by matching `/^.*\/node /` against the flattened command
  // broke BOTH rules at once, and each half passes the other half's fixture, so
  // only the pair pins it. This is the fix-introduces-bug shape recorded as
  // Lesson 8 in WORK_STRATEGIES.md.

  it("does NOT treat a non-node process as node because an ARGUMENT names node", async () => {
    // Rule A. Greedy matching found `/usr/bin/node ` inside the arguments and
    // accepted /bin/echo as a node binary.
    const { stdout, code } = await check([row(701, 700, "/bin/echo", "/bin/echo /usr/bin/node vitest")]);
    expect(stdout).toContain("QUIET");
    expect(code).toBe(0);
  });

  it("does NOT lose arguments after a directory named node inside a real node command", async () => {
    // Rule C, the same greedy match seen from the other side: it stripped
    // through the script pathname and searched only `runner.js`, reporting QUIET
    // with a vitest token plainly visible in argv[1].
    const { stdout, code } = await check([row(702, 700, "node", "node /tmp/vitest/node runner.js")]);
    expect(stdout).toContain("BUSY");
    expect(stdout).toContain("702");
    expect(code).toBe(1);
  });

  it("keeps both properties when the interpreter is an absolute path", async () => {
    const { stdout, code } = await check([
      plain(703, 700, "/usr/local/bin/node", "/tmp/vitest/node runner.js"),
    ]);
    expect(stdout).toContain("BUSY");
    expect(stdout).toContain("703");
    expect(code).toBe(1);
  });
});

describe("ISS-1152 quiet-check joins its ps reads without dropping a runner", () => {
  // Identity and arguments come from different `ps` formats and must be joined
  // on pid, which makes the join a race with the machine it is measuring. These
  // drive the real listing path with a stubbed `ps`, so the join, the ancestor
  // walk and every failure branch run exactly as they do in production.

  it("reports QUIET through the REAL listing path when the table is idle", async () => {
    // The production-path control. Everything below proves the join can say
    // BUSY; without this, all of it would also pass for a check wired to say
    // BUSY unconditionally, which is precisely the ISS-1132 bug. It cannot be
    // asserted against the live table from inside vitest, because the suite's
    // own sibling workers are node processes carrying a vitest token and are not
    // this script's ancestors: they are real runners and BUSY is the correct
    // answer there.
    const { stdout, code } = await withPs({
      identity: [{ rows: ["1 0 /sbin/launchd", "410 1 /bin/zsh"] }],
      command: { rows: ["1 /sbin/launchd", "410 -zsh"] },
    });
    expect(stdout).toContain("QUIET");
    expect(code).toBe(0);
  });

  it("still reports a runner that appears only in the COMMAND read", async () => {
    // A runner that starts between the identity read and the command read has a
    // command and no identity to match. An inner join drops it, and the check
    // then reports quiet because of its own timing rather than the machine's
    // state. Unresolved identity means unresolved, not absent.
    const { stdout, code } = await withPs({
      identity: [{ rows: ["1 0 /sbin/launchd"] }],
      command: { rows: ["1 /sbin/launchd", "902 /usr/local/bin/node /repo/node_modules/.bin/vitest run"] },
    });
    expect(stdout).toContain("BUSY");
    expect(stdout).toContain("902");
    expect(code).toBe(1);
  });

  it("still reports a shell that EXECS into node between the two identity reads", async () => {
    // The other half of the same race. The first identity read caught the
    // process as a shell; by the time its arguments were read it was a runner.
    // Trusting only the earlier observation reports quiet during a live run.
    const { stdout, code } = await withPs({
      identity: [{ rows: ["1 0 /sbin/launchd", "903 1 /bin/zsh"] }, { rows: ["1 0 /sbin/launchd", "903 1 /usr/local/bin/node"] }],
      command: { rows: ["1 /sbin/launchd", "903 /usr/local/bin/node /repo/node_modules/.bin/vitest run"] },
    });
    expect(stdout).toContain("BUSY");
    expect(stdout).toContain("903");
    expect(code).toBe(1);
  });

  it("keeps a REWRITTEN identity seen in only one of the two identity reads", async () => {
    // The join's own notion of "is this node" has to match the matcher's, or the
    // rule that node in EITHER read counts silently excludes the exact form that
    // made the rewritten-title miss possible. Here the first read sees the
    // worker as `node (vitest 3)` and the second sees a different identity for
    // the same pid; taking the second alone loses the runner.
    const { stdout, code } = await withPs({
      identity: [
        { rows: ["1 0 /sbin/launchd", "905 1 node (vitest 3)"] },
        { rows: ["1 0 /sbin/launchd", "905 1 /bin/zsh"] },
      ],
      command: { rows: ["1 /sbin/launchd", "905 node (vitest 3)"] },
    });
    expect(stdout).toContain("BUSY");
    expect(stdout).toContain("905");
    expect(code).toBe(1);
  });

  it("does not invent a runner from an identity read alone", async () => {
    // The control for the two above: a process present in identity but gone by
    // the command read has exited, and exiting is the one direction that is safe
    // to drop. Without this, "never drop anything" would pass by reporting
    // everything forever.
    const { stdout, code } = await withPs({
      identity: [{ rows: ["1 0 /sbin/launchd", "904 1 /usr/local/bin/node"] }],
      command: { rows: ["1 /sbin/launchd"] },
    });
    expect(stdout).toContain("QUIET");
    expect(code).toBe(0);
  });

  it("reports UNKNOWN when the identity read is not the format it expects", async () => {
    const { stdout, code } = await withPs({
      identity: [{ rows: ["not-a-pid 0 /sbin/launchd"] }],
      command: { rows: ["1 /sbin/launchd"] },
    });
    expect(stdout).toContain("UNKNOWN");
    expect(stdout).not.toContain("QUIET");
    expect(code).toBe(2);
  });
});

describe("ISS-1152 quiet-check excludes its own ancestry, at any depth", () => {
  /** Every pid from this process up to init, the chain the script must ignore. */
  async function ancestry(): Promise<number[]> {
    const chain: number[] = [];
    let pid = process.pid;
    for (let i = 0; i < 32 && pid > 1; i++) {
      chain.push(pid);
      const { stdout } = await run("ps", ["-o", "ppid=", "-p", String(pid)]).catch(() => ({ stdout: "" }));
      const next = Number.parseInt(stdout.trim(), 10);
      if (!Number.isFinite(next) || next <= 1) break;
      pid = next;
    }
    return chain;
  }

  it("ignores a node ancestor ABOVE the direct parent", async () => {
    // The exclusion depth used to be exactly one level, which held for the shell
    // pipeline but not for a node wrapper two levels up. A gate wrapper invoking
    // this through a shell then flagged its own caller and never cleared. You
    // cannot wait for the process that is waiting for you.
    const chain = await ancestry();
    expect(chain.length).toBeGreaterThan(1);
    const { stdout, code } = await check(
      chain.map((pid) => plain(pid, 1, "/usr/local/bin/node", "--runner vitest --project cpm")),
    );
    expect(stdout).toContain("QUIET");
    expect(code).toBe(0);
  });

  it("still flags an identical process that is NOT an ancestor", async () => {
    // The control. Without it the test above passes for a checker that ignores
    // everything, which would be the same bug wearing the opposite mask.
    const { stdout, code } = await check([plain(999998, 1, "/usr/local/bin/node", "--runner vitest --project cpm")]);
    expect(stdout).toContain("BUSY");
    expect(stdout).toContain("999998");
    expect(code).toBe(1);
  });
});

describe("ISS-1152 quiet-check matches precisely, not by bare substring", () => {
  it("ignores a token that appears only in the interpreter path", async () => {
    // argv[0] says nothing about what is running. A node installed under a
    // token-bearing directory would otherwise flag everything it launches.
    const { stdout, code } = await check([
      plain(601, 600, "/opt/jest-toolchain/bin/node", "-e setInterval(()=>{},1000)"),
    ]);
    expect(stdout).toContain("QUIET");
    expect(code).toBe(0);
  });

  it("ignores a package whose NAME merely contains the letters jest", async () => {
    // `majestic` is a real npm package and contains `jest` as a substring.
    const { stdout, code } = await check([row(602, 600, "node", "node /repo/node_modules/.bin/majestic --stdio")]);
    expect(stdout).toContain("QUIET");
    expect(code).toBe(0);
  });

  it("searches the WHOLE command when an argument contains a tab", async () => {
    // The canonical record is TAB separated and an argument may contain a TAB,
    // so a matcher that read only the fourth field would search the part before
    // it and call the rest quiet.
    const { stdout, code } = await check(["301\t300\tnode\tnode /repo/a\tvitest/run.js"]);
    expect(stdout).toContain("BUSY");
    expect(code).toBe(1);
  });

  it("searches a process whose identity could not be resolved", async () => {
    // An empty comm is the join's way of saying "seen in the command read only".
    // Rule A admits it deliberately: an unverified executable with a runner
    // token in its arguments is a false BUSY at worst, and a missed runner at
    // best if it is dropped.
    const { stdout, code } = await check(["301\t300\t\tnode /repo/node_modules/.bin/vitest run"]);
    expect(stdout).toContain("BUSY");
    expect(code).toBe(1);
  });

  const BARE: Array<[string, string]> = [
    ["a plain path", "/opt/jest-toolchain/bin/node"],
    ["a path containing spaces", "/Users/x/Library/Application Support/jest-tools/bin/node"],
  ];

  for (const [label, exe] of BARE) {
    it(`ignores an idle interpreter invoked with NO arguments, ${label}`, async () => {
      // A command that is nothing but its own executable has no arguments to
      // search. The prefix strip needs a trailing space and finds none, and the
      // first-token fallback removes nothing (or, for a spaced path, removes
      // only the first word and leaves the token), so an idle REPL was reported
      // BUSY on the strength of its interpreter path alone.
      const { stdout, code } = await check([row(601, 600, exe, exe)]);
      expect(stdout).toContain("QUIET");
      expect(code).toBe(0);
    });
  }

  it("REPORTS a single word that is itself a runner title, resolved OR unresolved", async () => {
    // This fixture used to assert QUIET, on the reasoning that a one-token
    // command has only an argv[0] and rule C searches argv[1..]. That reasoning
    // died with the title-rewrite discovery: a live runner can rewrite its whole
    // command to exactly `vitest`, so the lone token is not an executable name
    // being ignored, it is the entire process announcing what it is. The test
    // was pinning the false-QUIET defect in place rather than protecting the
    // executable-path exclusion it was written for.
    //
    // Both comm shapes, because they take different routes: with comm set the
    // title is a RECOGNIZED identity, with comm empty it is an unresolved one.
    // An earlier version passed the title as comm while calling itself the
    // unresolved case, so the combination that actually needed covering was
    // named in the title and absent from the assertions.
    for (const title of ["vitest", "jest", "tinypool"]) {
      for (const comm of [title, ""]) {
        const label = `${title} (comm=${comm === "" ? "unresolved" : comm})`;
        const { stdout, code } = await check([row(601, 600, comm, title)]);
        expect(stdout, label).toContain("BUSY");
        expect(code, label).toBe(1);
      }
    }
  });

  it("searches the WHOLE command of an unresolved process, argv[0] included", async () => {
    // Rule C skips argv[0] because an interpreter path says nothing about what
    // is running. That reasoning needs a known interpreter. When identity is
    // unresolved nothing is known, so there is no argv[0] worth skipping and
    // the conservative reading is to search all of it, consistent with why
    // unresolved rows are admitted in the first place.
    const { stdout, code } = await check([row(605, 600, "", "jest-worker")]);
    expect(stdout).toContain("BUSY");
    expect(code).toBe(1);
  });

  it("does NOT search a single-token command when the executable IS known", async () => {
    // The counterpart, and the control that keeps the clause above from
    // becoming "search everything". Here comm resolves to node, so the lone
    // token is a known argv[0] and there are no arguments.
    const { stdout, code } = await check([row(606, 600, "/usr/local/bin/node", "jest-worker")]);
    expect(stdout).toContain("QUIET");
    expect(code).toBe(0);
  });

  it("still ignores an unresolved single word that is NOT a runner title", async () => {
    // The control that keeps the rule from collapsing into "flag every
    // single-token command".
    const { stdout, code } = await check([row(604, 600, "", "someexe")]);
    expect(stdout).toContain("QUIET");
    expect(code).toBe(0);
  });

  it("still searches an unresolved command that DOES have arguments", async () => {
    // The control. Without it the test above passes for a checker that ignores
    // every unresolved process, which is the dropped-runner bug returning.
    const { stdout, code } = await check([row(602, 600, "", "someexe vitest run")]);
    expect(stdout).toContain("BUSY");
    expect(code).toBe(1);
  });

  it("still matches a real token at a path boundary", async () => {
    const { stdout, code } = await check([
      row(603, 600, "node", "node /repo/node_modules/jest-worker/build/workers/processChild.js"),
    ]);
    expect(stdout).toContain("BUSY");
    expect(code).toBe(1);
  });
});

describe("ISS-1152 quiet-check survives a node path containing spaces", () => {
  // Field-splitting on whitespace truncates an executable whose PATH contains a
  // space. fnm installs node under "Library/Application Support/fnm" by default,
  // and jest-worker forks every worker with process.execPath, so a field-based
  // check made EVERY jest worker on such a machine invisible: four live node
  // processes, verdict QUIET.
  const FNM = "/Users/x/Library/Application Support/fnm/node-versions/v22.18.0/installation/bin/node";

  it("detects a runner whose interpreter path contains spaces", async () => {
    const { stdout, code } = await check([plain(13324, 13321, FNM, "./node_modules/.bin/jest --maxWorkers=3")]);
    expect(stdout).toContain("BUSY");
    expect(stdout).toContain("13324");
    expect(code).toBe(1);
  });

  it("detects a WORKER whose interpreter path contains spaces", async () => {
    const { stdout, code } = await check([
      plain(13325, 13324, FNM, "/repo/node_modules/jest-worker/build/workers/processChild.js"),
    ]);
    expect(stdout).toContain("BUSY");
    expect(stdout).toContain("13325");
    expect(code).toBe(1);
  });

  it("still ignores a spaced interpreter path when only the executable carries the token", async () => {
    // Rule C has to keep holding once the interpreter may contain spaces.
    const { stdout, code } = await check([
      plain(13326, 13321, "/Users/x/Library/Application Support/jest-tools/bin/node", "-e setInterval(()=>{},1000)"),
    ]);
    expect(stdout).toContain("QUIET");
    expect(code).toBe(0);
  });
});

describe("ISS-1152 quiet-check says so when it is running inside a runner", () => {
  it("reports QUIET but NOTES an excluded ancestor that is itself a runner", async () => {
    // Excluding the ancestor is right, but silence is not: called from a
    // globalSetup, a reporter hook or a pretest step, the guard would otherwise
    // answer QUIET from inside the very run it was asked about.
    const { stdout, code } = await check([row(process.pid, 1, "/usr/local/bin/node", "node (vitest)")]);
    expect(stdout).toContain("QUIET");
    expect(stdout).toContain("NOTE");
    expect(stdout).toContain("INSIDE a test runner");
    expect(code).toBe(0);
  });
});

describe("ISS-1152 quiet-check refuses to read an unreadable process table as quiet", () => {
  // Every case here must exit exactly 2. Exit 1 would be wrong in the other
  // direction (it names a running process that was never observed) and exit 0
  // is the failure this whole file exists to prevent.

  it("reports UNKNOWN rather than QUIET when the listing comes back empty", async () => {
    // A real machine always lists at least the checker itself, so an empty
    // listing means the read failed. Reporting QUIET there would be an absence
    // read as a zero, in the one direction that corrupts a gate.
    const { stdout, stderr, code } = await check([]);
    expect(stdout).toContain("UNKNOWN");
    expect(stdout).not.toContain("QUIET");
    expect(stderr).toContain("came back empty");
    expect(code).toBe(2);
  });

  it("reports UNKNOWN when the listing source does not exist at all", async () => {
    const dir = await scratch("quiet-check-missing-");
    const { stdout, code } = await invoke([], {
      ...process.env,
      QUIET_CHECK_PS_FILE: join(dir, "does-not-exist.txt"),
    });
    expect(stdout).toContain("UNKNOWN");
    expect(stdout).not.toContain("QUIET");
    expect(code).toBe(2);
  });

  it("reports UNKNOWN when the listing emits a valid row and THEN fails", async () => {
    // The one failure shape the empty-listing guard cannot see: output that
    // LOOKS like a complete table, from a read that died partway. Nothing
    // matched in what arrived, and a check that reported QUIET there would be
    // answering about a fraction of the machine while sounding like it answered
    // about all of it. Reaching it needs a read that emits before it fails, so
    // this stubs the seam's own `cat`; it is the only `cat` on this path.
    const dir = await scratch("quiet-check-partial-");
    const payload = join(dir, "payload");
    await writeFile(payload, plain(101, 100, "/bin/zsh", "-l") + "\n", "utf-8");
    const stub = join(dir, "cat");
    // /bin/cat, and the row from a FILE: interpolating the row through
    // JSON.stringify turned its TAB into a literal backslash-t inside shell
    // double quotes, so the stub emitted a one-field line and this test would
    // have passed on the malformed-record check instead of the one it names.
    await writeFile(stub, `#!/bin/sh\n/bin/cat ${JSON.stringify(payload)}\nexit 1\n`, "utf-8");
    await chmod(stub, 0o755);
    const { stdout, stderr, code } = await invoke([], {
      ...process.env,
      QUIET_CHECK_PS_FILE: join(dir, "ps.txt"),
      PATH: `${dir}:${process.env.PATH ?? ""}`,
    });
    expect(stdout).toContain("UNKNOWN");
    expect(stdout).not.toContain("QUIET");
    expect(stderr).toContain("listing source could not be read");
    expect(code).toBe(2);
  });

  it("reports UNKNOWN when the HIT EXTRACTION cannot run", async () => {
    // Between a successful scan and the verdict there is still a pipeline, and
    // its failure has the same shape as a clean machine: no HIT lines. A check
    // that only guarded the scan printed QUIET and exited 0 here, with a live
    // runner sitting in the listing it had just read correctly.
    const dir = await scratch("quiet-check-sedfail-");
    const stub = join(dir, "sed");
    await writeFile(stub, "#!/bin/sh\nexit 1\n", "utf-8");
    await chmod(stub, 0o755);
    const file = join(dir, "ps.txt");
    await writeFile(file, row(301, 300, "/usr/local/bin/node", "node (vitest 3)") + "\n", "utf-8");
    const { stdout, code } = await invoke([], {
      ...process.env,
      QUIET_CHECK_PS_FILE: file,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
    });
    expect(stdout).toContain("UNKNOWN");
    expect(stdout).not.toContain("QUIET");
    expect(code).toBe(2);
  });

  it("reports UNKNOWN when only the BUSY extraction cannot run", async () => {
    const dir = await scratch("quiet-check-hitfail-");
    const stub = join(dir, "sed");
    await writeFile(stub, '#!/bin/sh\ncase "$*" in *HIT*) exit 1 ;; esac\nexec /usr/bin/sed "$@"\n', "utf-8");
    await chmod(stub, 0o755);
    const file = join(dir, "ps.txt");
    await writeFile(file, row(301, 300, "/usr/local/bin/node", "node (vitest 3)") + "\n", "utf-8");
    const { stdout, stderr, code } = await invoke([], {
      ...process.env,
      QUIET_CHECK_PS_FILE: file,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
    });
    expect(stdout).toContain("UNKNOWN");
    expect(stdout).not.toContain("QUIET");
    expect(stderr).toContain("busy list could not be extracted");
    expect(code).toBe(2);
  });

  it("reports UNKNOWN when only the SELF extraction cannot run", async () => {
    // Both halves of the verdict are extracted before anything is printed, and
    // each needs its own guard: sharing one would leave the second reachable
    // only through the first. The stub fails the SELF pass alone and defers to
    // the real sed otherwise.
    const dir = await scratch("quiet-check-selffail-");
    const stub = join(dir, "sed");
    await writeFile(stub, '#!/bin/sh\ncase "$*" in *SELF*) exit 1 ;; esac\nexec /usr/bin/sed "$@"\n', "utf-8");
    await chmod(stub, 0o755);
    const file = join(dir, "ps.txt");
    await writeFile(file, row(301, 300, "/usr/local/bin/node", "node (vitest 3)") + "\n", "utf-8");
    const { stdout, code } = await invoke([], {
      ...process.env,
      QUIET_CHECK_PS_FILE: file,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
    });
    expect(stdout).toContain("UNKNOWN");
    expect(code).toBe(2);
  });

  const MALFORMED: Array<[string, string]> = [
    ["a truncated record", "301\t300"],
    ["a record with no command", "301\t300\tnode"],
    ["a non-numeric pid", "abc\t300\tnode\tnode /repo/node_modules/.bin/vitest"],
    ["a non-numeric ppid", "301\tx\tnode\tnode /repo/node_modules/.bin/vitest"],
  ];

  for (const [label, bad] of MALFORMED) {
    it(`reports UNKNOWN for ${label}`, async () => {
      // Skipping unparseable records silently shrinks the machine to whatever
      // happened to parse, and then reports on that fraction in the voice of the
      // whole. A listing this matcher cannot reason about was not an observation.
      const { stdout, stderr, code } = await check([bad]);
      expect(stdout).toContain("UNKNOWN");
      expect(stdout).not.toContain("QUIET");
      expect(stderr).toContain("could not be parsed");
      expect(code).toBe(2);
    });
  }

  it("reports UNKNOWN when the MATCHER itself cannot run", async () => {
    // A read that succeeded and a matcher that died are different failures with
    // the same visible shape: no output. Only one of them means nothing matched.
    const dir = await scratch("quiet-check-awkfail-");
    const stub = join(dir, "awk");
    await writeFile(stub, "#!/bin/sh\nexit 1\n", "utf-8");
    await chmod(stub, 0o755);
    const file = join(dir, "ps.txt");
    await writeFile(file, plain(101, 100, "/bin/zsh", "-l") + "\n", "utf-8");
    const { stdout, code } = await invoke([], {
      ...process.env,
      QUIET_CHECK_PS_FILE: file,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
    });
    expect(stdout).toContain("UNKNOWN");
    expect(stdout).not.toContain("QUIET");
    expect(code).toBe(2);
  });

  // Six ways the three reads can fail, two shapes for each read. The nonzero
  // shapes all emit a plausible listing BEFORE failing, which is the dangerous
  // one: a truncated table looks exactly like a complete table of an idle
  // machine. The empty shapes fail without saying so at all. Each read is
  // covered on its own, because a guard on one read is otherwise indisting-
  // uishable from a guard on the next read down.
  const OK_ID = { rows: ["1 0 /sbin/launchd", "410 1 /bin/zsh"] };
  const OK_CMD = { rows: ["1 /sbin/launchd", "410 -zsh"] };
  const READ_FAILURES: Array<[string, PsSpec, string]> = [
    [
      "the first identity read emits rows and exits nonzero",
      { identity: [{ rows: ["1 0 /sbin/launchd", "410 1 /bin/zsh"], exit: 1 }, OK_ID], command: OK_CMD },
      "first identity read failed",
    ],
    [
      "the first identity read returns nothing",
      { identity: [{ rows: [] }, OK_ID], command: OK_CMD },
      "first identity read came back empty",
    ],
    [
      "the command read emits rows and exits nonzero",
      { identity: [OK_ID], command: { rows: ["1 /sbin/launchd", "410 -zsh"], exit: 1 } },
      "command read failed",
    ],
    [
      "the command read returns nothing",
      { identity: [OK_ID], command: { rows: [] } },
      "command read came back empty",
    ],
    [
      "the second identity read emits rows and exits nonzero",
      { identity: [OK_ID, { rows: ["1 0 /sbin/launchd", "410 1 /bin/zsh"], exit: 1 }], command: OK_CMD },
      "second identity read failed",
    ],
    [
      "the second identity read returns nothing",
      { identity: [OK_ID, { rows: [] }], command: OK_CMD },
      "second identity read came back empty",
    ],
  ];

  const ANCESTOR_FAILURES: Array<[string, PsAnswer]> = [
    ["the lookup fails", { rows: [], exit: 1 }],
    ["the lookup returns nothing", { rows: [] }],
    ["the lookup returns something that is not a pid", { rows: ["not-a-pid"] }],
  ];

  for (const [label, ancestor] of ANCESTOR_FAILURES) {
    it(`reports UNKNOWN when the ancestor walk cannot finish because ${label}`, async () => {
      // An incomplete ancestor walk looks exactly like a short one, and the
      // caller is then handed a partial exclusion list. That is how a check ends
      // up waiting on the very process that is waiting for it: the wrapper two
      // levels up is no longer recognized as its own, so it is reported as an
      // unrelated runner and --wait sits there until the deadline.
      const { stdout, stderr, code } = await withPs({
        identity: [OK_ID],
        command: OK_CMD,
        ancestor,
      });
      expect(stdout).toContain("UNKNOWN");
      expect(stdout).not.toContain("QUIET");
      expect(stderr).toContain("ancestor chain could not be read");
      expect(code).toBe(2);
    });
  }

  for (const [label, spec, reason] of READ_FAILURES) {
    it(`reports UNKNOWN when ${label}`, async () => {
      const { stdout, stderr, code } = await withPs(spec);
      expect(stdout).toContain("UNKNOWN");
      expect(stdout).not.toContain("QUIET");
      expect(code).toBe(2);
      // The reason is asserted, not just the verdict: every one of these ends in
      // the same verdict, so without naming the branch this table would be six
      // copies of whichever guard happens to fire first.
      expect(stderr).toContain(reason);
    });
  }
});

describe("ISS-1152 quiet-check --wait", () => {
  async function wait(rows: string[], args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Result & { file: string }> {
    const dir = await scratch("quiet-check-wait-");
    const file = join(dir, "ps.txt");
    await writeFile(file, rows.join("\n") + (rows.length ? "\n" : ""), "utf-8");
    const result = await invoke(args, { ...process.env, QUIET_CHECK_PS_FILE: file, ...extra });
    return { ...result, file };
  }

  /**
   * Like wait(), but COUNTS the scans by interposing a `cat` that records each
   * read of the listing before delegating to the real one.
   *
   * The script's own "after Ns" line cannot stand in for this. It is the
   * script's claim about itself, so a version that printed it immediately and
   * exited would satisfy any assertion made against it. Wall-clock time cannot
   * stand in for it either: bash's SECONDS is truncated against epoch
   * boundaries rather than measured from the assignment, so it can read 2 after
   * barely a second of real time, and a lower bound tuned to the reported value
   * fails on a correct script. The number of reads is the behaviour itself.
   */
  async function waitCounting(rows: string[], args: string[], extra: NodeJS.ProcessEnv = {}) {
    const dir = await scratch("quiet-check-count-");
    const file = join(dir, "ps.txt");
    await writeFile(file, rows.join("\n") + (rows.length ? "\n" : ""), "utf-8");
    const counter = join(dir, "reads");
    const stub = join(dir, "cat");
    await writeFile(stub, `#!/bin/sh\necho r >> ${JSON.stringify(counter)}\nexec /bin/cat "$@"\n`, "utf-8");
    await chmod(stub, 0o755);
    const started = Date.now();
    const result = await invoke(args, {
      ...process.env,
      QUIET_CHECK_PS_FILE: file,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      ...extra,
    });
    const reads = (await readFile(counter, "utf-8").catch(() => "")).split("\n").filter(Boolean).length;
    return { ...result, reads, elapsed: Date.now() - started };
  }

  const IDLE = [plain(101, 100, "/bin/zsh", "-l")];
  const RUNNER = [row(301, 300, "/usr/local/bin/node", "node (vitest 3)")];

  it("returns immediately with exit zero when already quiet", async () => {
    const { stdout, code } = await wait(IDLE, ["--wait", "30"]);
    expect(stdout).toContain("QUIET");
    expect(code).toBe(0);
  });

  it("polls and exits zero once the machine actually goes quiet", async () => {
    // The success path of the loop, which a timeout-only test never enters: with
    // timeout 0 the loop breaks before it ever sleeps, so a --wait that could
    // not observe a transition would still have passed.
    const dir = await scratch("quiet-check-transition-");
    const file = join(dir, "ps.txt");
    await writeFile(file, RUNNER.join("\n") + "\n", "utf-8");
    // Renamed into place rather than rewritten: a scan that read the file
    // between truncation and the replacing write would see an empty listing and
    // answer UNKNOWN, failing this test for a reason that is not about the
    // script. The promise is retained so cleanup cannot race an in-flight write.
    let transition: Promise<void> | undefined;
    const flip = setTimeout(() => {
      transition = (async () => {
        const next = `${file}.next`;
        await writeFile(next, IDLE.join("\n") + "\n", "utf-8");
        await rename(next, file);
      })();
    }, 1200);
    try {
      const { stdout, code } = await invoke(["--wait", "60"], {
        ...process.env,
        QUIET_CHECK_PS_FILE: file,
        QUIET_CHECK_POLL_SECONDS: "1",
      });
      expect(stdout).toMatch(/QUIET after [1-9]\d*s/);
      expect(code).toBe(0);
      expect(stdout).not.toContain("BUSY");
    } finally {
      clearTimeout(flip);
      await transition?.catch(() => undefined);
    }
  }, 30_000);

  it("keeps polling while the runner persists, then exits one", async () => {
    // A --wait that exited 0 on timeout would be the worst possible bug here:
    // every caller would proceed believing the machine idle.
    const { stdout, code, reads, elapsed } = await waitCounting(RUNNER, ["--wait", "2"], {
      QUIET_CHECK_POLL_SECONDS: "1",
    });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(stdout).toMatch(/STILL BUSY after [2-9]\d*s/);
    expect(stdout).toContain("301");
    expect(code).toBe(1);
  }, 30_000);

  it("exits non-zero on an immediate timeout and names what is still running", async () => {
    const { stdout, code } = await wait(RUNNER, ["--wait", "0"]);
    expect(stdout).toContain("STILL BUSY");
    expect(stdout).toContain("301");
    expect(code).toBe(1);
  });

  it("refuses a zero polling interval rather than spinning to the deadline", async () => {
    // A zero interval makes the loop sleep for no time, so a persistent BUSY
    // burns the machine without ever reaching its timeout.
    const { stderr, code } = await wait(RUNNER, ["--wait", "5"], { QUIET_CHECK_POLL_SECONDS: "0" });
    expect(code).toBe(2);
    expect(stderr).toContain("QUIET_CHECK_POLL_SECONDS");
  });

  it("reports UNKNOWN when the wait itself is interrupted", async () => {
    // A sleep that fails means the wait did not happen. Continuing the loop
    // would spin, and treating it as elapsed time would report a deadline that
    // was never actually waited out.
    const dir = await scratch("quiet-check-sleepfail-");
    const stub = join(dir, "sleep");
    await writeFile(stub, "#!/bin/sh\nexit 1\n", "utf-8");
    await chmod(stub, 0o755);
    const file = join(dir, "ps.txt");
    await writeFile(file, RUNNER.join("\n") + "\n", "utf-8");
    const { stdout, stderr, code } = await invoke(["--wait", "60"], {
      ...process.env,
      QUIET_CHECK_PS_FILE: file,
      QUIET_CHECK_POLL_SECONDS: "1",
      PATH: `${dir}:${process.env.PATH ?? ""}`,
    });
    expect(stdout).toContain("UNKNOWN");
    // Named, like every other failure branch. This one reported the generic
    // process-table diagnosis for a while, because it passed its reason to a
    // helper that had stopped taking one: an accurate verdict wearing the wrong
    // explanation, which is the shape that survives review by looking right.
    expect(stderr).toContain("the wait was interrupted");
    expect(code).toBe(2);
  }, 30_000);

  it("does not overshoot a timeout shorter than the polling interval", async () => {
    // Elapsed time used to be a tally of intended sleeps, so `--wait 1` with the
    // default interval slept five seconds and reported one. Each nap is now
    // capped at the time actually left.
    const started = Date.now();
    const { stdout, code } = await wait(RUNNER, ["--wait", "1"], { QUIET_CHECK_POLL_SECONDS: "30" });
    expect(code).toBe(1);
    expect(stdout).toMatch(/STILL BUSY after [1-9]\d*s/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it("accepts a timeout written with a leading zero, on the path that does arithmetic", async () => {
    // Digits are not yet a number bash will subtract: `08` is octal to the
    // arithmetic evaluator, so an accepted value crashed at the first deadline
    // check instead of producing the promised exit code. The deadline is only
    // computed once a scan comes back BUSY, so an idle listing never reaches the
    // subtraction and would pass this while broken. The listing therefore starts
    // busy and goes quiet, which forces the arithmetic and then the success
    // path, without spending the eight seconds the timeout names.
    const dir = await scratch("quiet-check-octal-");
    const file = join(dir, "ps.txt");
    await writeFile(file, RUNNER.join("\n") + "\n", "utf-8");
    let transition: Promise<void> | undefined;
    const flip = setTimeout(() => {
      transition = (async () => {
        const next = `${file}.next`;
        await writeFile(next, IDLE.join("\n") + "\n", "utf-8");
        await rename(next, file);
      })();
    }, 1200);
    try {
      const { stdout, stderr, code } = await invoke(["--wait", "08"], {
        ...process.env,
        QUIET_CHECK_PS_FILE: file,
        QUIET_CHECK_POLL_SECONDS: "1",
      });
      expect(stderr).not.toMatch(/unbound variable|value too great|syntax error/);
      expect(stdout).toMatch(/QUIET after [1-9]\d*s/);
      expect(code).toBe(0);
    } finally {
      clearTimeout(flip);
      await transition?.catch(() => undefined);
    }
  }, 30_000);

  it("refuses a polling interval that is not a number at all", async () => {
    const { stderr, code } = await wait(RUNNER, ["--wait", "5"], { QUIET_CHECK_POLL_SECONDS: "abc" });
    expect(code).toBe(2);
    expect(stderr).toContain("QUIET_CHECK_POLL_SECONDS");
  });

  it("refuses a polling interval of 00", async () => {
    // Slips past a literal comparison against 0 while still meaning zero.
    const { stderr, code } = await wait(RUNNER, ["--wait", "5"], { QUIET_CHECK_POLL_SECONDS: "00" });
    expect(code).toBe(2);
    expect(stderr).toContain("QUIET_CHECK_POLL_SECONDS");
  });

  it("refuses a timeout too large to be a duration", async () => {
    const { stderr, code } = await wait(IDLE, ["--wait", "99999999999999999999"]);
    expect(code).toBe(2);
    expect(stderr).toContain("usage: quiet-check.sh");
  });

  const BAD: Array<[string, string[]]> = [
    ["a non-numeric timeout", ["--wait", "abc"]],
    ["a negative timeout", ["--wait", "-5"]],
    ["a missing timeout", ["--wait"]],
    ["an unknown option", ["--bogus"]],
    ["a bare positional argument", ["600"]],
  ];

  for (const [label, args] of BAD) {
    it(`refuses ${label} with usage and exit two`, async () => {
      // An unvalidated timeout skipped the loop entirely and printed STILL BUSY
      // on a completely idle machine: a false busy manufactured by a typo, and
      // indistinguishable in a log from a real one. Unknown options ran a
      // one-shot check silently, so a caller that asked to wait did not.
      const { stdout, stderr, code } = await wait(IDLE, args);
      expect(code).toBe(2);
      expect(stderr).toContain("usage: quiet-check.sh");
      expect(stdout).not.toContain("STILL BUSY");
      expect(stdout).not.toContain("QUIET");
    });
  }
});

describe("ISS-1152 quiet-check works against the real process table", () => {
  /** The pids named in the BUSY block, which ends at the first NOTE line. */
  function busyEntries(stdout: string): Array<{ pid: string; command: string }> {
    const lines = stdout.split("\n");
    const start = lines.findIndex((l) => l.startsWith("BUSY"));
    if (start === -1) return [];
    const entries: Array<{ pid: string; command: string }> = [];
    for (const line of lines.slice(start + 1)) {
      const m = /^ {2}(\d+) {2}(.*)$/.exec(line);
      if (!m) break;
      entries.push({ pid: m[1], command: m[2] });
    }
    return entries;
  }

  /** Spawns a node process that rewrites its title and SIGNALS when it has. */
  async function spawnTitled(title: string) {
    const dir = await scratch("quiet-check-title-");
    const ready = join(dir, "ready");
    const marker = join(dir, "titled.cjs");
    await writeFile(
      marker,
      `process.title = ${JSON.stringify(title)};\n` +
        `require("fs").writeFileSync(${JSON.stringify(ready)}, "1");\n` +
        `setTimeout(() => {}, 15000);\n`,
      "utf-8",
    );
    const child = spawn(process.execPath, [marker], { stdio: "ignore", detached: false });
    // Waiting on the process's own signal, not on a fixed delay: a sleep long
    // enough today is a race tomorrow, and the whole point of this test is that
    // the rewrite has definitely happened before anything is observed.
    for (let i = 0; i < 200; i++) {
      if (await readFile(ready, "utf-8").then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return child;
  }

  const TITLES = ["node (vitest 99)", "vitest", "jest"];

  for (const title of TITLES) {
    it(`detects a REAL process whose title was rewritten to ${title}`, async () => {
      // The shape every vitest worker on this machine actually has, and the one
      // the fixtures got wrong. A peer caught this against a live run.
      //
      // The comm/command assertions are the point, not decoration: the fixtures
      // were invalidated by ASSUMING what ps reports for such a process, so this
      // reads both real formats and pins the relationship. Without them this
      // test would still pass on a platform where comm kept the node path,
      // leaving the exact assumption that failed unverified all over again.
      const child = await spawnTitled(title);
      try {
        const pid = String(child.pid);
        const comm = (await run("ps", ["-o", "comm=", "-p", pid])).stdout.trim();
        const command = (await run("ps", ["-o", "command=", "-p", pid])).stdout.trim();
        expect(comm, "ps -o comm= should report the REWRITTEN title, not the node path").toBe(title);
        expect(command, "ps -o command= should report the rewritten title too").toBe(title);

        const { stdout, code } = await invoke([], process.env);
        const mine = busyEntries(stdout).find((e) => e.pid === pid);
        expect(mine, `child ${pid} (${title}) not in BUSY block of:\n${stdout}`).toBeDefined();
        expect(code).toBe(1);
      } finally {
        child.kill("SIGKILL");
      }
    }, 20_000);
  }

  it("detects a REAL node process whose arguments name vitest", async () => {
    // The fixture seam must not be the only path that works. This spawns an
    // actual node process, so the two `ps` reads and their join are exercised
    // end to end. The assertions read the BUSY block specifically: asserting the
    // pid anywhere in stdout would also pass if the child had been swallowed
    // into the excluded-ancestor NOTE, which is the opposite verdict.
    const dir = await scratch("quiet-check-live-");
    const marker = join(dir, "vitest.mjs");
    await writeFile(marker, "setTimeout(() => {}, 10000);\n", "utf-8");
    const child = spawn(process.execPath, [marker], { stdio: "ignore", detached: false });
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const { stdout, code } = await invoke([], process.env);
      const entries = busyEntries(stdout);
      const mine = entries.find((e) => e.pid === String(child.pid));
      expect(mine, `child ${child.pid} not in BUSY block of:\n${stdout}`).toBeDefined();
      expect(mine?.command).toContain(marker);
      expect(code).toBe(1);
    } finally {
      child.kill("SIGKILL");
    }
  }, 20_000);

  it("stops naming a real process once it has exited", async () => {
    // Narrow on purpose: this asserts only that the marker leaves the BUSY block
    // when its process does. It is NOT the control for a permanently-BUSY
    // checker, because the live table cannot be quiet while this suite is
    // running; that control is the stubbed-ps QUIET test above, which drives the
    // same production listing path.
    const dir = await scratch("quiet-check-live-quiet-");
    const marker = join(dir, "vitest.mjs");
    await writeFile(marker, "setTimeout(() => {}, 300);\n", "utf-8");
    const child = spawn(process.execPath, [marker], { stdio: "ignore", detached: false });
    await new Promise((resolve) => child.on("exit", resolve));
    const { stdout, code } = await invoke([], process.env);
    // An empty BUSY block is also what UNKNOWN, a crash and an empty stdout look
    // like, and none of those observed anything. The verdict has to be a real
    // one before its contents mean anything.
    expect(code === 0 || code === 1).toBe(true);
    expect(stdout).toMatch(/^(QUIET|BUSY)/m);
    expect(busyEntries(stdout).some((e) => e.command.includes(marker))).toBe(false);
  }, 20_000);
});
