import { describe, it, expect, vi } from "vitest";
import { checkCliVersion } from "../../../src/core/health/cli-version.js";
import { ctxFor, stubDeps } from "./stub-deps.js";

const info = (currentVersion: string, latestVersion: string) => ({
  currentVersion,
  latestVersion,
  updateAvailable: currentVersion !== latestVersion,
});

describe("T-502 cli-version check", () => {
  it("advises with the pinned text when the installed version is behind", async () => {
    const deps = stubDeps({ versionCache: { read: () => info("1.14.0", "1.15.0") } });
    const check = await checkCliVersion(ctxFor({ cliVersion: "1.14.0" }), deps);
    expect(check.status).toBe("advise");
    expect(check.message).toBe(
      "storybloq 1.14.0 is installed; 1.15.0 is published. Update with `npm install -g @storybloq/storybloq@latest`, then run `storybloq setup`.",
    );
    expect(check.advice).toBe(check.message);
  });

  it("is ok when the installed version is the newest published one", async () => {
    const deps = stubDeps({ versionCache: { read: () => info("1.14.0", "1.14.0") } });
    const check = await checkCliVersion(ctxFor(), deps);
    expect(check.status).toBe("ok");
    expect(check.message).toBe("storybloq 1.14.0 is installed, which is the newest published version.");
  });

  it("is ok and says so in detail when the installed version is ahead of the registry", async () => {
    const deps = stubDeps({ versionCache: { read: () => info("1.15.0", "1.14.0") } });
    const check = await checkCliVersion(ctxFor({ cliVersion: "1.15.0" }), deps);
    expect(check.status).toBe("ok");
    expect(check.detail.note).toBe("the installed version is ahead of the registry");
  });

  // Mutant (a): dropping the cache read makes this refetch.
  it("never calls refresh when the cache is fresh", async () => {
    const refresh = vi.fn(async () => info("1.14.0", "1.14.0"));
    const deps = stubDeps({ versionCache: { read: () => info("1.14.0", "1.14.0"), refresh } });
    await checkCliVersion(ctxFor(), deps);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("calls refresh exactly once when the cache is stale", async () => {
    const refresh = vi.fn(async () => info("1.14.0", "1.15.0"));
    const deps = stubDeps({ versionCache: { read: () => null, refresh } });
    const check = await checkCliVersion(ctxFor(), deps);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]![0]).toMatchObject({ currentVersion: "1.14.0", force: false });
    expect(check.status).toBe("advise");
  });

  // Mutant (b): mapping a null fetch to "current" reddens this.
  it("skips with reason offline when the registry cannot be reached", async () => {
    const deps = stubDeps({ versionCache: { read: () => null, refresh: async () => null } });
    const check = await checkCliVersion(ctxFor(), deps);
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe("offline");
    expect(check.message).toContain("could not reach the npm registry");
  });

  it("skips when update checks are disabled by NO_UPDATE_NOTIFIER or CI", async () => {
    for (const env of [{ NO_UPDATE_NOTIFIER: "1" }, { CI: "true" }]) {
      const refresh = vi.fn(async () => info("1.14.0", "1.15.0"));
      const check = await checkCliVersion(ctxFor(), stubDeps({ env, versionCache: { refresh } }));
      expect(check.status).toBe("skip");
      expect(check.detail.reason).toBe("update checks disabled");
      expect(refresh).not.toHaveBeenCalled();
    }
  });

  it("empty-string env values do not count as disabled", async () => {
    const deps = stubDeps({
      env: { CI: "", NO_UPDATE_NOTIFIER: "" },
      versionCache: { read: () => info("1.14.0", "1.14.0") },
    });
    expect((await checkCliVersion(ctxFor(), deps)).status).toBe("ok");
  });

  it("refresh: true forces the fetch even when the cache is fresh", async () => {
    const read = vi.fn(() => info("1.14.0", "1.14.0"));
    const refresh = vi.fn(async () => info("1.14.0", "1.15.0"));
    const check = await checkCliVersion(ctxFor(), stubDeps({ versionCache: { read, refresh } }), { refresh: true });
    expect(read).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]![0]).toMatchObject({ force: true });
    expect(check.status).toBe("advise");
  });

  it("skips a dev build and a prerelease running version", async () => {
    for (const version of ["0.0.0-dev", "1.15.0-rc.1", ""]) {
      const check = await checkCliVersion(ctxFor({ cliVersion: version }), stubDeps());
      expect(check.status).toBe("skip");
      expect(check.detail.reason).toBe("non-release build");
    }
  });

  it("clamps the fetch timeout to the remaining budget and skips when it is gone", async () => {
    const refresh = vi.fn(async () => info("1.14.0", "1.14.0"));
    const deps = stubDeps({ now: () => 1_000, versionCache: { read: () => null, refresh } });
    await checkCliVersion(ctxFor({ deadline: 1_300 }), deps);
    expect(refresh.mock.calls[0]![0]!.timeoutMs).toBe(300);

    const refresh2 = vi.fn(async () => info("1.14.0", "1.14.0"));
    const check = await checkCliVersion(
      ctxFor({ deadline: 1_000 }),
      stubDeps({ now: () => 1_000, versionCache: { read: () => null, refresh: refresh2 } }),
    );
    expect(refresh2).not.toHaveBeenCalled();
    expect(check.detail.reason).toBe("time budget exhausted");
  });

  it("caps the fetch timeout at 2000 ms when plenty of budget remains", async () => {
    const refresh = vi.fn(async () => info("1.14.0", "1.14.0"));
    await checkCliVersion(
      ctxFor({ deadline: 90_000 }),
      stubDeps({ now: () => 1_000, versionCache: { read: () => null, refresh } }),
    );
    expect(refresh.mock.calls[0]![0]!.timeoutMs).toBe(2000);
  });
});
