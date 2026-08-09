import { realpathSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DownloadCacheCoordinator, RuntimeAssetError } from "@vidcom/adapter";
import { ErrorCode } from "@vidcom/contracts";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function coordinator(lockTimeoutMs = 30_000) {
  const cacheRoot = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-download-")));
  roots.push(cacheRoot);
  return { cacheRoot, cache: new DownloadCacheCoordinator({ cacheRoot, lockTimeoutMs }) };
}

describe("download cache coordinator", () => {
  it("reports a component nobody has fetched as missing", async () => {
    const { cache } = await coordinator();
    expect((await cache.status("chromium")).state).toBe("missing");
  });

  it("clears the marker only when the download reports success", async () => {
    const { cache } = await coordinator();
    const seen: string[] = [];

    await cache.download("chromium", async (root) => {
      // Mid-download the component must already read as partial: this is the
      // window a crash lands in.
      seen.push((await cache.status("chromium")).state);
      await writeFile(path.join(root, "chrome"), "binary", "utf8");
    }, 5_000);

    expect(seen).toEqual(["partial"]);
    expect((await cache.status("chromium")).state).toBe("ready");
  });

  it("leaves a failed download visibly partial rather than looking complete", async () => {
    const { cache } = await coordinator();

    await expect(cache.download("chromium", async (root) => {
      // A truncated download: bytes on disk, no success. Asking the tool would
      // say fine — `hyperframes browser path` exits 0 for a 1 MB Chromium.
      await writeFile(path.join(root, "chrome"), "truncated", "utf8");
      throw new Error("connection reset");
    }, 5_000)).rejects.toThrow("connection reset");

    const status = await cache.status("chromium");
    expect(status.state).toBe("partial");
    expect(status.startedAt).toBeDefined();
    expect(status.failureCode).toBeUndefined();
  });

  it("survives a restart: an interrupted download still reads partial", async () => {
    const { cacheRoot, cache } = await coordinator();
    await cache.markPartial("chromium");

    // A brand new coordinator, as a later boot would build.
    const reopened = new DownloadCacheCoordinator({ cacheRoot });
    expect((await reopened.status("chromium")).state).toBe("partial");
  });

  it("aborts a timed-out operation and persists its coded failure across restart", async () => {
    const { cacheRoot, cache } = await coordinator();
    let abortReason: unknown;
    const failure = await cache.download("chromium", (_root, signal) => new Promise<never>(
      (_resolve, reject) => {
        signal.addEventListener("abort", () => {
          abortReason = signal.reason;
          reject(signal.reason);
        }, { once: true });
      },
    ), 120)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeAssetError);
    expect((failure as RuntimeAssetError).code).toBe(ErrorCode.DownloadUnavailable);
    expect(abortReason).toBe(failure);
    // Still partial: a timeout is not a completed download.
    expect(await cache.status("chromium")).toMatchObject({
      state: "partial",
      failureCode: ErrorCode.DownloadUnavailable,
    });
    expect(await new DownloadCacheCoordinator({ cacheRoot }).status("chromium")).toMatchObject({
      state: "partial",
      failureCode: ErrorCode.DownloadUnavailable,
    });
    // `discardPartial` uses the same lease, so this also waits for the
    // abort-cooperative operation's background release before temp cleanup.
    await cache.discardPartial("chromium");
  });

  it("returns a prompt timeout but keeps the lock until a non-cooperative operation settles", async () => {
    const { cache } = await coordinator();
    let releaseCleanup = () => {};
    const cleanupHeld = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let reportAbort = () => {};
    const aborted = new Promise<void>((resolve) => { reportAbort = resolve; });
    const firstFailure = cache.download("chromium", async (_root, signal) => {
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          reportAbort();
          resolve();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      await cleanupHeld;
      throw signal.reason;
    }, 120).then(
      () => undefined,
      (error: unknown) => error,
    );

    await aborted;
    let promptTimer: ReturnType<typeof setTimeout> | undefined;
    const failure = await Promise.race([
      firstFailure,
      new Promise<"hung">((resolve) => {
        promptTimer = setTimeout(() => { resolve("hung"); }, 1_000);
      }),
    ]);
    if (promptTimer !== undefined) clearTimeout(promptTimer);
    expect(failure).not.toBe("hung");
    expect(failure).toBeInstanceOf(RuntimeAssetError);
    expect((failure as RuntimeAssetError).code).toBe(ErrorCode.DownloadUnavailable);
    expect(await cache.status("chromium")).toMatchObject({
      state: "partial",
      failureCode: ErrorCode.DownloadUnavailable,
    });
    expect((await lstat(`${cache.componentRoot("chromium")}.lock`)).isDirectory()).toBe(true);

    let secondStarted = false;
    const second = cache.download("chromium", async () => {
      secondStarted = true;
    }, 5_000);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(secondStarted).toBe(false);

    releaseCleanup();
    await second;
    expect(secondStarted).toBe(true);
  });

  it("does not discard a partial component while its timed-out writer is still running", async () => {
    const { cache } = await coordinator();
    let releaseWriter = () => {};
    const writerHeld = new Promise<void>((resolve) => { releaseWriter = resolve; });
    let reportAbort = () => {};
    const aborted = new Promise<void>((resolve) => { reportAbort = resolve; });

    const failure = cache.download("models", async (_root, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          reportAbort();
          resolve();
        }, { once: true });
      });
      await writerHeld;
      throw signal.reason;
    }, 120).catch((error: unknown) => error);
    await aborted;
    expect(await failure).toBeInstanceOf(RuntimeAssetError);

    let discarded = false;
    const discard = cache.discardPartial("models").then(() => { discarded = true; });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(discarded).toBe(false);
    expect((await lstat(cache.componentRoot("models"))).isDirectory()).toBe(true);

    releaseWriter();
    await discard;
    expect((await cache.status("models")).state).toBe("missing");
  });

  it("persists a mapped TLS failure without storing the error message", async () => {
    const { cacheRoot, cache } = await coordinator();
    await expect(cache.download("models", async () => {
      throw new RuntimeAssetError(
        ErrorCode.DownloadTlsUntrusted,
        "private certificate path must not be persisted",
      );
    }, 5_000)).rejects.toMatchObject({ code: ErrorCode.DownloadTlsUntrusted });

    const reopened = new DownloadCacheCoordinator({ cacheRoot });
    expect(await reopened.status("models")).toMatchObject({
      state: "partial",
      failureCode: ErrorCode.DownloadTlsUntrusted,
    });
    const marker = await readFile(
      path.join(cache.componentRoot("models"), ".downloading.json"),
      "utf8",
    );
    expect(marker).not.toContain("private certificate path");
  });

  it("serializes two fetches of one component", async () => {
    const { cache } = await coordinator();
    let releaseFirst = () => {};
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let reportFirstStarted = () => {};
    const firstStarted = new Promise<void>((resolve) => { reportFirstStarted = resolve; });
    const first = cache.download("chromium", async () => {
      reportFirstStarted();
      await firstHeld;
    }, 10_000);
    await firstStarted;

    let secondStarted = false;
    const second = cache.download("chromium", async () => {
      secondStarted = true;
    }, 10_000);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(secondStarted).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
  });

  it("keeps separate components independent", async () => {
    const { cache } = await coordinator();
    let releaseModel = () => {};
    const modelHeld = new Promise<void>((resolve) => { releaseModel = resolve; });
    let modelStarted = () => {};
    const modelRunning = new Promise<void>((resolve) => { modelStarted = resolve; });

    // A slow model download holds its own lock. Synchronised explicitly rather
    // than by sleeping: on a loaded runner a sleep proves nothing about order.
    const model = cache.download("models", async () => {
      modelStarted();
      await modelHeld;
      return "model";
    }, 10_000);
    await modelRunning;

    // This completes while the model is provably still in flight, which is the
    // property being tested: separate components do not block each other.
    expect(await cache.download("chromium", () => Promise.resolve("browser"), 10_000))
      .toBe("browser");

    releaseModel();
    expect(await model).toBe("model");
  });

  it("discards a partial component so the next attempt starts clean", async () => {
    const { cache } = await coordinator();
    await cache.markPartial("chromium");
    await cache.discardPartial("chromium");
    expect((await cache.status("chromium")).state).toBe("missing");
  });

  it("does not discard a component that finished", async () => {
    const { cache } = await coordinator();
    await cache.markReady("chromium");
    await cache.discardPartial("chromium");
    expect((await cache.status("chromium")).state).toBe("ready");
  });

  it("treats an unreadable marker as partial rather than complete", async () => {
    const { cache } = await coordinator();
    await cache.markReady("chromium");
    const marker = path.join(cache.componentRoot("chromium"), ".downloading.json");
    await writeFile(marker, "{not json", "utf8");
    // Conservative on purpose: a marker that exists means a download started.
    expect((await cache.status("chromium")).state).toBe("partial");
    await writeFile(marker, "{}", "utf8");
    expect((await cache.status("chromium")).state).toBe("partial");
  });

  it("does not follow a marker symlink outside the cache", async () => {
    const { cache } = await coordinator();
    const outsideRoot = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-outside-")));
    roots.push(outsideRoot);
    await writeFile(path.join(outsideRoot, "outside-marker.json"), JSON.stringify({
      component: "chromium",
      startedAt: "outside-secret",
      pid: process.pid,
      failureCode: ErrorCode.DownloadTlsUntrusted,
    }), "utf8");
    await cache.markReady("chromium");
    await symlink(
      outsideRoot,
      path.join(cache.componentRoot("chromium"), ".downloading.json"),
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(await cache.status("chromium")).toMatchObject({
      state: "partial",
      startedAt: "unknown",
    });
    expect((await cache.status("chromium")).failureCode).toBeUndefined();
  });

  it("rejects a component symlink without writing outside the cache", async () => {
    const { cacheRoot, cache } = await coordinator();
    const outsideRoot = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-outside-")));
    roots.push(outsideRoot);
    await symlink(
      outsideRoot,
      path.join(cacheRoot, "chromium"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const statusFailure = await cache.status("chromium").catch((error: unknown) => error);
    expect(statusFailure).toBeInstanceOf(RuntimeAssetError);
    expect((statusFailure as RuntimeAssetError).code).toBe(ErrorCode.RuntimeManifestInvalid);
    const downloadFailure = await cache.download(
      "chromium",
      () => Promise.resolve(),
      5_000,
    ).catch((error: unknown) => error);
    expect(downloadFailure).toBeInstanceOf(RuntimeAssetError);
    expect((downloadFailure as RuntimeAssetError).code).toBe(ErrorCode.RuntimeManifestInvalid);
    await expect(lstat(path.join(outsideRoot, ".downloading.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a special component entry", async () => {
    const { cacheRoot, cache } = await coordinator();
    await writeFile(path.join(cacheRoot, "models"), "not a directory", "utf8");

    const failure = await cache.markPartial("models").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeAssetError);
    expect((failure as RuntimeAssetError).code).toBe(ErrorCode.RuntimeManifestInvalid);
  });

  it("rejects a component name that is not a portable directory", async () => {
    const { cache } = await coordinator();
    expect(() => cache.componentRoot("../escape")).toThrow(RuntimeAssetError);
  });

  it("requires a normalized absolute non-root cache authority", async () => {
    const { cacheRoot } = await coordinator();
    expect(() => new DownloadCacheCoordinator({
      cacheRoot: `${cacheRoot}${path.sep}child${path.sep}..`,
    })).toThrow(TypeError);
    expect(() => new DownloadCacheCoordinator({
      cacheRoot: path.parse(cacheRoot).root,
    })).toThrow(TypeError);
  });

  it("refuses a download without a timeout", async () => {
    const { cache } = await coordinator();
    await expect(cache.download("chromium", () => Promise.resolve("x"), 0)).rejects.toThrow(TypeError);
  });
});
