import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync, symlinkSync, lstatSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeScript } from "./health/subprocess-probe.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  shouldEmitUpdateBanner,
  refreshUpdateCacheInBackground,
  checkForUpdate,
  refreshUpdateCache,
} from "../../src/core/update-check.js";

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

// ISS-777: the update check previously fetched the npm registry
// UNCONDITIONALLY on every refreshUpdateCacheInBackground call (no cache-TTL
// gate, no env opt-out), so every Claude hook / CLI dispatch / MCP status
// phoned home. The once-per-day cache and the NO_UPDATE_NOTIFIER/CI opt-outs
// must gate the FETCH itself; the opt-outs are enforced at the single fetch
// site so EVERY caller (refreshUpdateCacheInBackground, checkForUpdate, and
// any future one) inherits them.
describe("npm-registry fetch gating (ISS-777)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let tempHome: string;
  let originalHome: string | undefined;
  let originalCI: string | undefined;
  let originalNoNotifier: string | undefined;
  let originalFetch: typeof globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  function writeCacheFile(fetchedAt: number, latestVersion = "1.0.0"): void {
    const dir = join(tempHome, ".claude", "storybloq");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "update-check.json"), JSON.stringify({ latestVersion, fetchedAt }), "utf-8");
  }

  beforeEach(() => {
    tempHome = join(tmpdir(), `storybloq-uc-${randomUUID()}`);
    mkdirSync(tempHome, { recursive: true });
    originalHome = process.env.HOME;
    originalCI = process.env.CI;
    originalNoNotifier = process.env.NO_UPDATE_NOTIFIER;
    process.env.HOME = tempHome;
    delete process.env.CI;
    delete process.env.NO_UPDATE_NOTIFIER;
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ version: "9.9.9" }) }) as unknown as Response);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalCI === undefined) delete process.env.CI;
    else process.env.CI = originalCI;
    if (originalNoNotifier === undefined) delete process.env.NO_UPDATE_NOTIFIER;
    else process.env.NO_UPDATE_NOTIFIER = originalNoNotifier;
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("does NOT fetch when the cache is fresh (within 24h)", async () => {
    writeCacheFile(Date.now());
    refreshUpdateCacheInBackground();
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches when the cache is stale (older than 24h)", async () => {
    writeCacheFile(Date.now() - DAY_MS - 60_000);
    refreshUpdateCacheInBackground();
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("fetches when no cache exists", async () => {
    refreshUpdateCacheInBackground();
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT fetch when NO_UPDATE_NOTIFIER is set", async () => {
    process.env.NO_UPDATE_NOTIFIER = "1";
    refreshUpdateCacheInBackground();
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT fetch when CI is set", async () => {
    process.env.CI = "1";
    refreshUpdateCacheInBackground();
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Fix round: the opt-out must live at the fetch site, not only in
  // refreshUpdateCacheInBackground, or checkForUpdate on a cold/stale cache
  // bypasses the privacy opt-out.
  it("checkForUpdate does NOT fetch on a cold cache when NO_UPDATE_NOTIFIER is set", async () => {
    process.env.NO_UPDATE_NOTIFIER = "1";
    const info = await checkForUpdate("1.0.0");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(info).toBeNull();
  });

  it("checkForUpdate does NOT fetch on a cold cache when CI is set", async () => {
    process.env.CI = "1";
    const info = await checkForUpdate("1.0.0");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(info).toBeNull();
  });

  it("checkForUpdate still fetches on a cold cache with a clean env", async () => {
    const info = await checkForUpdate("1.0.0");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(info).toEqual({ currentVersion: "1.0.0", latestVersion: "9.9.9", updateAvailable: true });
  });
});

// T-502: the health check needs an AWAITED refresh with a caller-supplied cap,
// and the fetch's abort timer must stay armed through the body read. Before
// this, the timer was cleared as soon as the response headers arrived, so a
// server that answered with headers and then stalled the body had no cap at
// all -- on a synchronous command path that is a wedge, not a skip.
describe("refreshUpdateCache + the armed-through-body fetch cap (T-502)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const cacheFile = (home: string) => join(home, ".claude", "storybloq", "update-check.json");
  let tempHome: string;
  let originalHome: string | undefined;
  let originalCI: string | undefined;
  let originalNoNotifier: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  function writeCacheFile(fetchedAt: number, latestVersion = "1.0.0"): void {
    mkdirSync(join(tempHome, ".claude", "storybloq"), { recursive: true });
    writeFileSync(cacheFile(tempHome), JSON.stringify({ latestVersion, fetchedAt }), "utf-8");
  }

  beforeEach(() => {
    tempHome = join(tmpdir(), `storybloq-uc-t502-${randomUUID()}`);
    mkdirSync(tempHome, { recursive: true });
    originalHome = process.env.HOME;
    originalCI = process.env.CI;
    originalNoNotifier = process.env.NO_UPDATE_NOTIFIER;
    process.env.HOME = tempHome;
    delete process.env.CI;
    delete process.env.NO_UPDATE_NOTIFIER;
    originalFetch = globalThis.fetch;
  });

  // Every environment variable this block touches is restored, including
  // whether it was absent: a leaked NO_UPDATE_NOTIFIER would silently disable
  // network suppression checks in later tests sharing the worker.
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of [["HOME", originalHome], ["CI", originalCI], ["NO_UPDATE_NOTIFIER", originalNoNotifier]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempHome, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A response that answers with headers and then never delivers a body. */
  function stallingBodyFetch(): ReturnType<typeof vi.fn> {
    return vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => ({
      ok: true,
      json: () =>
        new Promise((_resolve, reject) => {
          // Exactly what a real fetch body does when the signal fires.
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    }) as unknown as Response);
  }

  it("returns the fresh cache without fetching", async () => {
    writeCacheFile(Date.now(), "2.0.0");
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const info = await refreshUpdateCache({ currentVersion: "1.0.0" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(info).toEqual({ currentVersion: "1.0.0", latestVersion: "2.0.0", updateAvailable: true });
  });

  it("force fetches even when the cache is fresh, and writes the answer", async () => {
    writeCacheFile(Date.now(), "2.0.0");
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: "3.0.0" }) }) as unknown as Response) as typeof globalThis.fetch;
    const info = await refreshUpdateCache({ currentVersion: "1.0.0", force: true });
    expect(info?.latestVersion).toBe("3.0.0");
    expect(JSON.parse(readFileSync(cacheFile(tempHome), "utf-8")).latestVersion).toBe("3.0.0");
  });

  it("fetches when the cache is stale", async () => {
    writeCacheFile(Date.now() - DAY_MS - 1, "2.0.0");
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ version: "4.0.0" }) }) as unknown as Response);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    expect((await refreshUpdateCache({ currentVersion: "1.0.0" }))?.latestVersion).toBe("4.0.0");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null and leaves the cache file byte-identical when the fetch fails", async () => {
    writeCacheFile(Date.now() - DAY_MS - 1, "2.0.0");
    const before = readFileSync(cacheFile(tempHome), "utf-8");
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;
    expect(await refreshUpdateCache({ currentVersion: "1.0.0" })).toBeNull();
    expect(readFileSync(cacheFile(tempHome), "utf-8")).toBe(before);
  });

  it("treats a corrupt cache as absent and rewrites it on the next success", async () => {
    mkdirSync(join(tempHome, ".claude", "storybloq"), { recursive: true });
    writeFileSync(cacheFile(tempHome), "{ not json", "utf-8");
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: "5.0.0" }) }) as unknown as Response) as typeof globalThis.fetch;
    expect((await refreshUpdateCache({ currentVersion: "1.0.0" }))?.latestVersion).toBe("5.0.0");
    expect(JSON.parse(readFileSync(cacheFile(tempHome), "utf-8")).latestVersion).toBe("5.0.0");
  });

  it("refuses a non-positive timeout and a dev version without fetching", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    expect(await refreshUpdateCache({ currentVersion: "1.0.0", timeoutMs: 0 })).toBeNull();
    expect(await refreshUpdateCache({ currentVersion: "0.0.0-dev" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("honours NO_UPDATE_NOTIFIER at the single fetch site", async () => {
    process.env.NO_UPDATE_NOTIFIER = "1";
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    expect(await refreshUpdateCache({ currentVersion: "1.0.0" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // The regression this fix exists for: without the armed-through-body timer
  // this call never settles at all. Fake timers pin the deadline to the
  // REQUESTED cap, so an implementation that ignored timeoutMs and always used
  // the 2000 ms default would fail here rather than passing on a loose bound.
  it("gives up at exactly the requested cap when the server stalls the body", async () => {
    vi.useFakeTimers();
    globalThis.fetch = stallingBodyFetch() as unknown as typeof globalThis.fetch;
    let settled = false;
    const pending = refreshUpdateCache({ currentVersion: "1.0.0", timeoutMs: 200 }).then((v) => {
      settled = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(199);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await pending).toBeNull();
    expect(existsSync(cacheFile(tempHome))).toBe(false);
  });

  it("gives up in real time too, not only under fake timers", { timeout: 4000 }, async () => {
    globalThis.fetch = stallingBodyFetch() as unknown as typeof globalThis.fetch;
    const started = Date.now();
    expect(await refreshUpdateCache({ currentVersion: "1.0.0", timeoutMs: 200 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("clears the abort timer on the success path too", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: "6.0.0" }) }) as unknown as Response) as typeof globalThis.fetch;
    await refreshUpdateCache({ currentVersion: "1.0.0" });
    expect(clearSpy).toHaveBeenCalled();
  });

  it("treats an oversized cache file as absent", async () => {
    mkdirSync(join(tempHome, ".claude", "storybloq"), { recursive: true });
    writeFileSync(cacheFile(tempHome), `{"latestVersion":"2.0.0","fetchedAt":${Date.now()},"pad":"${"x".repeat(70_000)}"}`, "utf-8");
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: "7.0.0" }) }) as unknown as Response) as typeof globalThis.fetch;
    expect((await refreshUpdateCache({ currentVersion: "1.0.0" }))?.latestVersion).toBe("7.0.0");
  });

  // The cache read happens synchronously BEFORE the first await, so a
  // blocking-read regression would freeze this worker's event loop and its own
  // test timeout could never fire. Run it in a child under a SIGKILL deadline.
  it("does not block on a FIFO at the cache path", { timeout: 40_000 }, () => {
    mkdirSync(join(tempHome, ".claude", "storybloq"), { recursive: true });
    if (spawnSync("mkfifo", [cacheFile(tempHome)], { stdio: "ignore" }).status !== 0) return;
    const moduleFile = fileURLToPath(new URL("../../src/core/update-check.ts", import.meta.url));
    const probe = probeScript({
      timeoutMs: 20_000,
      env: { HOME: tempHome, CI: undefined, NO_UPDATE_NOTIFIER: undefined },
      source: `globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: "7.0.0" }) });
const m = await import(${JSON.stringify(moduleFile)});
const info = await m.refreshUpdateCache({ currentVersion: "1.0.0" });
console.log(JSON.stringify(info));
`,
    });
    expect(probe.timedOut).toBe(false);
    expect(probe.status).toBe(0);
    expect(probe.value).toMatchObject({ latestVersion: "7.0.0" });
    // The FIFO was replaced by a real cache file, not written through.
    expect(lstatSync(cacheFile(tempHome)).isFIFO()).toBe(false);
    expect(JSON.parse(readFileSync(cacheFile(tempHome), "utf-8")).latestVersion).toBe("7.0.0");
  });

  // The write is the command's ONLY permitted write, so it must land on the
  // cache path itself and nowhere else.
  it("replaces a symlink at the cache path instead of writing through it", async () => {
    const dir = join(tempHome, ".claude", "storybloq");
    mkdirSync(dir, { recursive: true });
    const victim = join(tempHome, "victim.json");
    writeFileSync(victim, "do not touch", "utf-8");
    symlinkSync(victim, cacheFile(tempHome));
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: "8.0.0" }) }) as unknown as Response) as typeof globalThis.fetch;
    expect((await refreshUpdateCache({ currentVersion: "1.0.0" }))?.latestVersion).toBe("8.0.0");
    expect(readFileSync(victim, "utf-8")).toBe("do not touch");
    expect(lstatSync(cacheFile(tempHome)).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(cacheFile(tempHome), "utf-8")).latestVersion).toBe("8.0.0");
  });

  // `owned` is assigned only AFTER the exclusive open returns, so an EEXIST
  // can never reach the unlink. This pins the observable consequence: another
  // writer's in-flight temp file survives both a successful and a failed write.
  it("never removes a temp file it did not create", async () => {
    const dir = join(tempHome, ".claude", "storybloq");
    mkdirSync(dir, { recursive: true });
    const foreign = join(dir, "update-check.json.tmp.99999.1.dead");
    writeFileSync(foreign, "someone else's", "utf-8");
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: "10.0.0" }) }) as unknown as Response) as typeof globalThis.fetch;
    expect((await refreshUpdateCache({ currentVersion: "1.0.0" }))?.latestVersion).toBe("10.0.0");
    expect(readFileSync(foreign, "utf-8")).toBe("someone else's");
  });

  it("preserves the previous cache bytes when the write itself fails", async () => {
    if (process.getuid?.() === 0) return; // root can write anywhere
    const dir = join(tempHome, ".claude", "storybloq");
    writeCacheFile(Date.now() - DAY_MS - 1, "2.0.0");
    const before = readFileSync(cacheFile(tempHome), "utf-8");
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: "9.0.0" }) }) as unknown as Response) as typeof globalThis.fetch;
    chmodSync(dir, 0o500);
    try {
      // The fetch succeeded, so a verdict is still returned; the cache write
      // is best-effort and must leave the old file exactly as it was.
      expect((await refreshUpdateCache({ currentVersion: "1.0.0" }))?.latestVersion).toBe("9.0.0");
      expect(readFileSync(cacheFile(tempHome), "utf-8")).toBe(before);
      expect(readdirSync(dir).filter((f) => f.includes(".tmp."))).toEqual([]);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
