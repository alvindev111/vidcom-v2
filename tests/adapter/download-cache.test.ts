import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DownloadCacheCoordinator, RuntimeAssetError } from "@vidcom/adapter";
import { ErrorCode } from "@vidcom/contracts";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function coordinator() {
  const cacheRoot = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-download-")));
  roots.push(cacheRoot);
  return { cacheRoot, cache: new DownloadCacheCoordinator({ cacheRoot, lockTimeoutMs: 30_000 }) };
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
  });

  it("survives a restart: an interrupted download still reads partial", async () => {
    const { cacheRoot, cache } = await coordinator();
    await cache.markPartial("chromium");

    // A brand new coordinator, as a later boot would build.
    const reopened = new DownloadCacheCoordinator({ cacheRoot });
    expect((await reopened.status("chromium")).state).toBe("partial");
  });

  it("times out with a coded failure instead of hanging", async () => {
    const { cache } = await coordinator();
    const failure = await cache.download("chromium", () => new Promise<never>(() => {}), 120)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeAssetError);
    expect((failure as RuntimeAssetError).code).toBe(ErrorCode.DownloadUnavailable);
    // Still partial: a timeout is not a completed download.
    expect((await cache.status("chromium")).state).toBe("partial");
  });

  it("serializes two fetches of one component", async () => {
    const { cache } = await coordinator();
    let active = 0;
    let overlapped = false;
    const fetch = () => cache.download("chromium", async () => {
      active += 1;
      if (active > 1) overlapped = true;
      await new Promise((resolve) => { setTimeout(resolve, 40); });
      active -= 1;
    }, 10_000);

    await Promise.all([fetch(), fetch()]);
    expect(overlapped).toBe(false);
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
    await writeFile(path.join(cache.componentRoot("chromium"), ".downloading.json"), "{not json", "utf8");
    // Conservative on purpose: a marker that exists means a download started.
    expect((await cache.status("chromium")).state).toBe("partial");
  });

  it("rejects a component name that is not a portable directory", async () => {
    const { cache } = await coordinator();
    expect(() => cache.componentRoot("../escape")).toThrow(RuntimeAssetError);
  });

  it("refuses a download without a timeout", async () => {
    const { cache } = await coordinator();
    await expect(cache.download("chromium", () => Promise.resolve("x"), 0)).rejects.toThrow(TypeError);
  });
});
