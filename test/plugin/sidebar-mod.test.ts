/**
 * ISS-1239: the sidebar Mod must address the ledger from a root pinned at
 * `session.start`, not from the session's live working directory.
 *
 * WHY THIS FILE EXISTS AT ALL. `sidebar-projection.test.ts` covers the pure
 * projection function; nothing drove `sidebar.ts` itself. The bug is not in
 * the counting, it is in the addressing, so it is invisible to a projection
 * test: the numbers are right and the Mod reads the wrong directory. This is
 * the first harness that runs the Mod through a fake `$`.
 *
 * THE FAKE IS THE WHOLE POINT. `FakeFs` resolves a RELATIVE path against a
 * mutable `cwd` and an ABSOLUTE path not at all, which is exactly what the
 * client does and exactly what the bug depends on. Moving `fs.cwd` between
 * two polls is `cd` happening in the session. A Mod that addresses the ledger
 * relatively silently reads an empty directory and clears the board; one that
 * pinned its root does not notice the move at all.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { registerSidebar, IDLE_POLL_TICKS } from "../../plugins/storybloq/hooks/sidebar.js";

const PANE_ID = "storybloq";

type Handler = ($: any, e: any, next: (e: any) => unknown) => unknown;

/** A recorded `$.fs` call: the path exactly as the Mod asked for it. */
interface FsCall {
  readonly op: string;
  readonly path: string;
}

class FakeFs {
  cwd = "/repo";
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  readonly calls: FsCall[] = [];
  /** path (as resolved) -> errno to throw instead of answering. */
  readonly failures = new Map<string, string>();

  /**
   * Relative against the CURRENT cwd, absolute not at all: what the client
   * does, and what the bug depends on. `.` and `..` segments are collapsed
   * because a real host resolves them, and a fake that did not would quietly
   * make a relative path look like a miss rather than a hit.
   */
  private resolve(path: string): string {
    const joined = path.startsWith("/") ? path : `${this.cwd}/${path}`;
    const out: string[] = [];
    for (const segment of joined.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") out.pop();
      else out.push(segment);
    }
    return `/${out.join("/")}`;
  }

  private guard(resolved: string): void {
    const code = this.failures.get(resolved);
    if (code === undefined) return;
    const error = new Error(`${code}: fake refusal at ${resolved}`) as Error & { code: string };
    error.code = code;
    throw error;
  }

  addFile(path: string, content: string): void {
    this.files.set(path, content);
    let dir = path.slice(0, path.lastIndexOf("/"));
    while (dir.length > 0) {
      this.dirs.add(dir);
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  }

  addDir(path: string): void {
    this.dirs.add(path);
  }

  async exists(path: string): Promise<boolean> {
    this.calls.push({ op: "exists", path });
    const resolved = this.resolve(path);
    this.guard(resolved);
    return this.files.has(resolved) || this.dirs.has(resolved);
  }

  async read(path: string): Promise<string> {
    this.calls.push({ op: "read", path });
    const resolved = this.resolve(path);
    this.guard(resolved);
    const content = this.files.get(resolved);
    if (content === undefined) {
      const error = new Error(`ENOENT: no such file ${resolved}`) as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    }
    return content;
  }

  async list(path: string): Promise<{ name: string; kind: string }[]> {
    this.calls.push({ op: "list", path });
    const resolved = this.resolve(path);
    this.guard(resolved);
    if (!this.dirs.has(resolved)) {
      const error = new Error(`ENOENT: no such directory ${resolved}`) as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    }
    const prefix = `${resolved}/`;
    const names = new Set<string>();
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/")) {
        names.add(file.slice(prefix.length));
      }
    }
    return [...names].sort().map((name) => ({ name, kind: "file" }));
  }

  async stat(path: string): Promise<{ mtimeMs: number }> {
    this.calls.push({ op: "stat", path });
    const resolved = this.resolve(path);
    this.guard(resolved);
    if (!this.files.has(resolved) && !this.dirs.has(resolved)) {
      const error = new Error(`ENOENT: no such path ${resolved}`) as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    }
    return { mtimeMs: 1 };
  }

  /** Every ledger path the Mod asked for that was not absolute. */
  relativeLedgerCalls(): FsCall[] {
    return this.calls.filter((call) => call.path.includes(".story") && !call.path.startsWith("/"));
  }
}

function ticket(id: string, status: string): string {
  return JSON.stringify({
    id,
    displayId: id,
    title: `Ticket ${id}`,
    type: "task",
    status,
    phase: "p1",
    order: 1,
  });
}

function issue(id: string, severity: string): string {
  return JSON.stringify({ id, displayId: id, title: `Issue ${id}`, severity, status: "open" });
}

/** A ledger at `root` with two tickets and one issue. */
function seedLedger(fs: FakeFs, root: string, marker = "T-001"): void {
  fs.addDir(`${root}/.story`);
  fs.addDir(`${root}/.story/handovers`);
  fs.addFile(`${root}/.story/config.json`, JSON.stringify({ project: `proj-${root}` }));
  fs.addFile(
    `${root}/.story/roadmap.json`,
    JSON.stringify({ phases: [{ id: "p1", name: "Phase One" }] }),
  );
  fs.addFile(`${root}/.story/tickets/${marker}.json`, ticket(marker, "inprogress"));
  fs.addFile(`${root}/.story/tickets/T-002.json`, ticket("T-002", "open"));
  fs.addFile(`${root}/.story/issues/ISS-001.json`, issue("ISS-001", "high"));
}

class Harness {
  readonly fs = new FakeFs();
  readonly handlers = new Map<string, Handler>();
  readonly logs: string[] = [];
  readonly store = new Map<string, unknown>();
  private timers: (() => void)[] = [];
  readonly $: any;

  constructor() {
    const fs = this.fs;
    this.$ = {
      fs: {
        exists: (p: string) => fs.exists(p),
        read: (p: string) => fs.read(p),
        list: (p: string) => fs.list(p),
        stat: (p: string) => fs.stat(p),
      },
      store: {
        get: async (key: string) => this.store.get(key),
        set: async (key: string, value: unknown) => void this.store.set(key, value),
      },
      ui: {
        open: async () => undefined,
        log: (line: string) => void this.logs.push(line),
        invalidate: () => undefined,
        resolve: () => ({
          Box: (props: any) => ({ node: "Box", ...props }),
          Text: (props: any) => ({ node: "Text", ...props }),
        }),
      },
      clock: {
        every: (_ms: number, cb: () => void) => {
          this.timers.push(cb);
          return () => undefined;
        },
      },
      config: { list: async () => [] },
      settings: { read: async () => ({}) },
      session: { usage: async () => ({}) },
    };

    const on = ((event: string, hook: Handler) => {
      this.handlers.set(event, hook);
      return { catch: () => undefined };
    }) as any;
    registerSidebar(on, {});
  }

  async fire(event: string, payload: Record<string, unknown> = {}): Promise<void> {
    const handler = this.handlers.get(event);
    if (handler === undefined) throw new Error(`no handler for ${event}`);
    await handler(this.$, payload, (e: any) => e);
  }

  async start(cwd: string): Promise<void> {
    this.fs.cwd = cwd;
    await this.fire("session.start", { surface: "terminal", isInteractive: true, cwd });
  }

  /** Drains the chunked scan. */
  async settle(rounds = 40): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      for (const timer of [...this.timers]) timer();
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** The pane's drawn tree, as a comparable string. */
  render(): string {
    const handler = this.handlers.get("ui.render");
    if (handler === undefined) throw new Error("no ui.render handler");
    const node = handler(
      this.$,
      { component: "Pane", requestId: PANE_ID, props: { bodyColumns: 160 } },
      (e: any) => e,
    );
    return JSON.stringify(node);
  }
}

describe("ISS-1239: the ledger root is pinned at session.start", () => {
  let h: Harness;

  beforeEach(() => {
    h = new Harness();
  });

  it("1. survives a cd: the board is byte-identical after the cwd moves away", async () => {
    seedLedger(h.fs, "/repo");
    h.fs.addDir("/repo/sub");
    await h.start("/repo");
    await h.settle();
    const before = h.render();
    expect(before).toContain("T-001");

    // The bug, exactly: the user runs `cd sub`.
    h.fs.cwd = "/repo/sub";
    await h.settle();
    await h.fire("turn.complete", {});
    await h.settle();

    expect(h.render()).toBe(before);
  });

  it("2. survives a one-shot `cd X && cmd`: a single move between two polls", async () => {
    seedLedger(h.fs, "/repo");
    h.fs.addDir("/repo/sub");
    await h.start("/repo");
    await h.settle();
    const before = h.render();

    // No event between the move and the next poll, which is what a compound
    // command looks like from inside the session. The idle poll is the ONLY
    // thing that runs here, so it has to be allowed to actually fire: it does
    // so once every IDLE_POLL_TICKS, and settling for fewer ticks than that
    // would make this test pass on the broken code by never looking.
    h.fs.cwd = "/repo/sub";
    await h.settle(IDLE_POLL_TICKS + 5);

    expect(h.render()).toBe(before);
  });

  it("3. a nested ledger under the new cwd never wins over the pinned root", async () => {
    seedLedger(h.fs, "/repo", "T-001");
    seedLedger(h.fs, "/repo/sub", "T-999");
    await h.start("/repo");
    await h.settle();

    h.fs.cwd = "/repo/sub";
    await h.settle();
    await h.fire("turn.complete", {});
    await h.settle();

    const drawn = h.render();
    expect(drawn).toContain("T-001");
    expect(drawn).not.toContain("T-999");
  });

  it("4a. a REFUSED tickets directory does not empty the board", async () => {
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    expect(h.render()).toContain("T-001");

    // Not deleted: unreadable. The records are still real.
    h.fs.failures.set("/repo/.story/tickets", "EACCES");
    await h.fire("turn.complete", {});
    await h.settle();

    expect(h.render()).toContain("T-001");
  });

  it("4b. a DELETED tickets directory still clears the board", async () => {
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    expect(h.render()).toContain("T-001");

    // Genuinely gone. Without this the fix would trade a board that wrongly
    // shows zeros for one that wrongly shows phantoms.
    for (const path of [...h.fs.files.keys()]) {
      if (path.startsWith("/repo/.story/tickets/")) h.fs.files.delete(path);
    }
    h.fs.dirs.delete("/repo/.story/tickets");
    await h.fire("turn.complete", {});
    await h.settle();

    expect(h.render()).not.toContain("T-001");
  });

  it("5a. a project with no ledger draws nothing and reports no error", async () => {
    h.fs.addDir("/repo");
    await h.start("/repo");
    await h.settle();

    expect(h.render()).not.toContain("Storybloq");
    expect(h.logs.join("\n")).toContain("no .story directory here");
    // A project that never ran init is not a failure, so it must not be
    // reported as one.
    expect(h.logs.join("\n")).not.toContain("could not resolve");
  });

  it("5b. a REFUSED walk hides the pane and RECOVERS once the refusal lifts", async () => {
    seedLedger(h.fs, "/repo");
    // The host refuses the one question the walk asks.
    h.fs.failures.set("/repo/.story", "EACCES");
    await h.start("/repo");
    await h.settle();

    // Hidden, and said so. Pinning a guess here instead would lock the
    // session to a possibly-wrong root for good, because the retry loop below
    // only runs while the Mod is hidden.
    expect(h.render()).not.toContain("Storybloq");
    expect(h.logs.join("\n")).toContain("could not resolve the ledger root");
    expect(h.fs.relativeLedgerCalls()).toEqual([]);

    // The refusal lifts. The retry loop re-walks from the ORIGIN and pins.
    h.fs.failures.delete("/repo/.story");
    await h.fire("turn.complete", {});
    await h.settle();

    expect(h.render()).toContain("T-001");
  });

  it("5c. a reload re-pins, re-arms the purge and can speak again", async () => {
    h.fs.addDir("/repo");
    await h.start("/repo");
    await h.settle();
    expect(h.logs.filter((line) => line.includes("no .story directory here"))).toHaveLength(1);

    // Same session, reload, still no ledger: the said-once flags are per
    // session start, so the diagnostic is not swallowed the second time.
    await h.start("/repo");
    await h.settle();
    expect(h.logs.filter((line) => line.includes("no .story directory here"))).toHaveLength(2);

    // Now a real ledger and a real reload: it pins, and the purge is armed,
    // so a genuine deletion still clears the board.
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    expect(h.render()).toContain("T-001");

    for (const path of [...h.fs.files.keys()]) {
      if (path.startsWith("/repo/.story/tickets/")) h.fs.files.delete(path);
    }
    h.fs.dirs.delete("/repo/.story/tickets");
    await h.fire("turn.complete", {});
    await h.settle();

    expect(h.render()).not.toContain("T-001");
  });

  it("5d. late attachment resolves from the ORIGIN, not the live cwd", async () => {
    h.fs.addDir("/repo");
    await h.start("/repo");
    await h.settle();
    expect(h.render()).not.toContain("Storybloq");

    // `storybloq init` lands in the project. Meanwhile the session has cd-ed
    // somewhere else entirely, and that somewhere has a ledger of its own.
    seedLedger(h.fs, "/repo", "T-001");
    seedLedger(h.fs, "/elsewhere", "T-999");
    h.fs.cwd = "/elsewhere";
    await h.fire("turn.complete", {});
    await h.settle();

    const drawn = h.render();
    expect(drawn).toContain("T-001");
    expect(drawn).not.toContain("T-999");
  });

  it("6. never asks the client for a relative ledger path", async () => {
    seedLedger(h.fs, "/repo");
    h.fs.addDir("/repo/sub");
    await h.start("/repo");
    await h.settle();
    h.fs.cwd = "/repo/sub";
    await h.fire("turn.complete", {});
    await h.settle();

    expect(h.fs.relativeLedgerCalls()).toEqual([]);
  });
});

/**
 * ISS-1251 / ISS-1252, on the same harness. `plugins/storybloq/hooks/
 * sidebar.test.ts` carries the same cases for `claude plugin test`, but that
 * runner opens no pane at all on 2.1.278 (ISS-1253), so the gate is here.
 */
describe("ISS-1251: the person's prompt re-opens a pane parked by a narrow start", () => {
  let h: Harness;
  let opened: unknown[];
  beforeEach(() => {
    h = new Harness();
    opened = [];
    h.$.ui.open = async (pane: unknown) => void opened.push(pane);
  });

  function abovePrompt(columns: number): string {
    const handler = h.handlers.get("ui.render")!;
    const node = handler(h.$, { component: "AbovePrompt", requestId: "above-prompt", viewport: { columns, rows: 30 }, props: { bodyColumns: columns } }, () => null);
    return JSON.stringify(node ?? "");
  }
  async function prompt(): Promise<unknown> {
    const handler = h.handlers.get("prompt.submit")!;
    const e = { text: "hello", turnId: "t1" };
    const passed = await handler(h.$, e, (x: any) => x);
    await Promise.resolve();
    await Promise.resolve();
    return passed === e;
  }

  it("asks once per prompt while the pane is open and undrawn, and passes the prompt on unchanged", async () => {
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    expect(opened).toHaveLength(1);

    // Narrow: the band draws and says the board opens at the prompt.
    expect(abovePrompt(120)).toContain("board opens at your next prompt");

    expect(await prompt()).toBe(true);
    expect(opened).toHaveLength(2);
    expect(opened[1]).toEqual({ id: "storybloq", title: "Storybloq" });

    // The client placed it: one Pane render marks it drawn, then a prompt asks nothing.
    h.render();
    expect(await prompt()).toBe(true);
    expect(opened).toHaveLength(2);

    // Drawn and narrow (the pane keeps its inline seat when the window
    // shrinks): the band still carries the counts, without the hint.
    const under = abovePrompt(120);
    expect(under).toContain("Storybloq:");
    expect(under).not.toContain("board opens at your next prompt");
  });

  it("never re-opens a pane the person closed", async () => {
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    await h.fire("ui.close", { requestId: PANE_ID, origin: "person" });
    expect(await prompt()).toBe(true);
    expect(opened).toHaveLength(1);
    // The band is still the sidebar at this width.
    expect(abovePrompt(120)).toContain("Storybloq:");
  });

  it("asks nothing in a project with no ledger", async () => {
    await h.start("/nowhere");
    await h.settle();
    expect(opened).toHaveLength(0);
    expect(await prompt()).toBe(true);
    expect(opened).toHaveLength(0);
  });
});

describe("ISS-1252: below 60 body columns the pane draws the narrow board", () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });

  function pane(bodyColumns: number): string {
    const handler = h.handlers.get("ui.render")!;
    const node = handler(
      h.$,
      { component: "Pane", requestId: PANE_ID, viewport: { columns: bodyColumns + 4, rows: 20 }, props: { bodyColumns, placement: "inline", scroll: { offset: 0, bodyRows: 20 } } },
      (e: any) => e,
    );
    return JSON.stringify(node);
  }

  it("shows In progress with three cards and a tail, the footer, and nothing of the four columns", async () => {
    seedLedger(h.fs, "/repo");
    for (const id of ["T-003", "T-004", "T-005", "T-006", "T-007"]) {
      h.fs.addFile(`/repo/.story/tickets/${id}.json`, ticket(id, "inprogress"));
    }
    await h.start("/repo");
    await h.settle();
    const drawn = pane(45);
    expect(drawn).toContain('"In progress 6"');
    expect(drawn).toContain('"narrow-card-0"');
    expect(drawn).toContain('"narrow-card-2"');
    expect(drawn).not.toContain('"narrow-card-3"');
    expect(drawn).toContain('"... 3 more"');
    expect(drawn).toContain('"footer"');
    for (const key of ["board-blocked", "board-open", "board-inprogress", "board-done", "header-gap", "issues-gap"]) {
      expect(drawn, key).not.toContain(`"${key}"`);
    }
    expect(drawn).not.toContain("Blocked");
    expect(drawn).not.toContain("Done");
  });

  it("says none when nothing is in progress", async () => {
    seedLedger(h.fs, "/repo");
    h.fs.addFile("/repo/.story/tickets/T-001.json", ticket("T-001", "open"));
    await h.start("/repo");
    await h.settle();
    const drawn = pane(45);
    expect(drawn).toContain('"In progress 0"');
    expect(drawn).toContain('"narrow-none"');
    expect(drawn).not.toContain('"narrow-tail"');
  });

  it("keeps the four-column board from 60 body columns up", async () => {
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    expect(pane(60)).toContain('"board-inprogress"');
    expect(pane(60)).not.toContain('"narrow-heading"');
    expect(pane(59)).toContain('"narrow-heading"');
  });
});
