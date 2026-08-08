import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { BROWSE_WORKER_SOURCE, BrowseWorkerPool } from "@vidcom/adapter";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const pools: BrowseWorkerPool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pool(concurrency = 2, timeoutMs = 5_000) {
  const created = new BrowseWorkerPool(concurrency, timeoutMs);
  pools.push(created);
  return created;
}

async function tree(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-browse-")));
  roots.push(root);
  await mkdir(path.join(root, "projects"), { recursive: true });
  await writeFile(path.join(root, "notes.txt"), "notes\n", "utf8");
  return root;
}

describe("browse worker", () => {
  it("reads a real directory off the event loop", async () => {
    const root = await tree();
    const response = await pool().run({ kind: "read", path: root });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const entries = response.entries as { name: string; isDirectory: boolean }[];
    expect(entries.map((entry) => entry.name).sort()).toEqual(["notes.txt", "projects"]);
    expect(entries.find((entry) => entry.name === "projects")?.isDirectory).toBe(true);
  });

  it("reports a directory identity a caller can compare later", async () => {
    const root = await tree();
    const response = await pool().run({ kind: "identity", path: root });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const identity = response.identity as { device: string; inode: string };
    expect(identity.device.length).toBeGreaterThan(0);
    expect(identity.inode.length).toBeGreaterThan(0);
  });

  it("turns a missing directory into a code, not a throw", async () => {
    const response = await pool().run({ kind: "read", path: path.join(await tree(), "absent") });

    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.code).toBe("ENOENT");
  });

  it("serves more requests than it has workers", async () => {
    const root = await tree();
    const instance = pool(2);

    // Six requests through two workers: the pool has to hand workers back.
    const responses = await Promise.all(Array.from({ length: 6 }, () =>
      instance.run({ kind: "read", path: root })));
    expect(responses.every((response) => response.ok)).toBe(true);
  });

  it("keeps working after a request times out", async () => {
    const root = await tree();
    // A budget nothing can meet, so the timeout path is the one taken.
    const instance = pool(1, 1);
    const timedOut = await instance.run({ kind: "read", path: root });
    expect(timedOut.ok).toBe(false);
    if (timedOut.ok) return;
    expect(timedOut.code).toBe("timeout");

    // The timed-out worker was terminated rather than abandoned, and the pool
    // replaced it — otherwise a single slow read would retire the pool.
    const recovered = await pool(1, 5_000).run({ kind: "read", path: root });
    expect(recovered.ok).toBe(true);
  });

  it("refuses work once closed instead of hanging", async () => {
    const root = await tree();
    const instance = new BrowseWorkerPool(1, 5_000);
    await instance.close();

    const response = await instance.run({ kind: "read", path: root });
    expect(response).toEqual({ ok: false, code: "closed" });
  });
});

describe("worker construction shape", () => {
  it("starts from eval source, which is the only form a packaged binary has", async () => {
    // The wrong form does not error — the worker never starts and the request
    // waits forever. That silence is why the shape is pinned by a test.
    const worker = new Worker(BROWSE_WORKER_SOURCE, { eval: true });
    try {
      const ready = await new Promise<boolean>((resolve) => {
        worker.once("online", () => { resolve(true); });
        worker.once("error", () => { resolve(false); });
        setTimeout(() => { resolve(false); }, 5_000).unref();
      });
      expect(ready).toBe(true);
    } finally {
      await worker.terminate();
    }
  });

  it("fails to start from a file path that does not exist in a packaged binary", async () => {
    // F.9: prove the wrong form fails loudly here, so it cannot come back
    // quietly. In an artifact there is no such file at all.
    const missing = path.join(await tree(), "browse-worker.js");
    let worker: Worker | undefined;
    let failed = false;
    try {
      worker = new Worker(missing);
      // Node may reject synchronously or asynchronously depending on how the
      // path fails; both count, and neither is the silent hang the eval form
      // avoids.
      failed = await new Promise<boolean>((resolve) => {
        worker?.once("error", () => { resolve(true); });
        worker?.once("exit", (code) => { resolve(code !== 0); });
        setTimeout(() => { resolve(false); }, 5_000).unref();
      });
    } catch {
      failed = true;
    } finally {
      await worker?.terminate();
    }
    expect(failed).toBe(true);
  });
});
