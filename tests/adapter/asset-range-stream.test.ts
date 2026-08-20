import { mkdtemp, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceFs } from "@vidcom/adapter";
import type { AbsolutePath, ResolvedPath } from "@vidcom/core";

const roots: string[] = [];
const SPARSE_SIZE = 500 * 1024 * 1024;

interface AssetIdentity {
  device: string;
  inode: string;
  size: number;
  modifiedAtNs: string;
  changedAtNs: string;
}

interface AssetMetadata {
  size: number;
  etag: string;
  identity: AssetIdentity;
}

interface AssetWorkspace {
  statAsset(pathname: ResolvedPath): Promise<AssetMetadata | null>;
  openAssetRange(pathname: ResolvedPath, options: {
    start: number;
    end: number;
    identity: AssetIdentity;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array> | null>;
}

interface StreamObservation {
  opened: number;
  closed: number;
  active: number;
  maximumActive: number;
  bytesRead: number;
  largestRead: number;
}

async function sparseFixture(concurrency = 4) {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-asset-range-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const projectRoot = path.join(workspaceRoot, "project");
  const asset = path.join(projectRoot, "assets", "sparse.bin") as ResolvedPath;
  await mkdir(path.dirname(asset), { recursive: true });
  await writeFile(path.join(projectRoot, "vidcom.json"), '{"id":"asset_range"}\n');
  await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
  await writeFile(path.join(projectRoot, "index.html"), "entry");
  const handle = await open(asset, "w+");
  try {
    await handle.truncate(SPARSE_SIZE);
    for (const [position, byte] of [[0, 0x11], [SPARSE_SIZE / 2, 0x22], [SPARSE_SIZE - 1, 0x33]] as const) {
      await handle.write(Uint8Array.of(byte), 0, 1, position);
    }
  } finally {
    await handle.close();
  }
  const observation: StreamObservation = {
    opened: 0, closed: 0, active: 0, maximumActive: 0, bytesRead: 0, largestRead: 0,
  };
  const Constructor = WorkspaceFs as unknown as new (
    root: AbsolutePath,
    options: {
      assetStreamConcurrency: number;
      assetStreamObserver: {
        open(): void;
        read(bytes: number): void;
        close(): void;
      };
    },
  ) => AssetWorkspace;
  const workspace = new Constructor(workspaceRoot as AbsolutePath, {
    assetStreamConcurrency: concurrency,
    assetStreamObserver: {
      open() {
        observation.opened += 1;
        observation.active += 1;
        observation.maximumActive = Math.max(observation.maximumActive, observation.active);
      },
      read(bytes) {
        observation.bytesRead += bytes;
        observation.largestRead = Math.max(observation.largestRead, bytes);
      },
      close() {
        observation.closed += 1;
        observation.active -= 1;
      },
    },
  });
  return { asset, workspace, observation };
}

async function bytes(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!stream) throw new Error("asset stream was not opened");
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded asset range streaming", () => {
  it("reads one byte from a sparse 500 MB asset without hashing or buffering the file", async () => {
    const value = await sparseFixture();
    const metadata = await value.workspace.statAsset(value.asset);
    expect(metadata).toMatchObject({ size: SPARSE_SIZE });
    expect(metadata?.etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/u);
    if (!metadata) throw new Error("sparse fixture metadata is missing");
    const rssBefore = process.memoryUsage.rss();

    const body = await bytes(await value.workspace.openAssetRange(value.asset, {
      start: SPARSE_SIZE - 1,
      end: SPARSE_SIZE - 1,
      identity: metadata.identity,
    }));

    const rssDelta = process.memoryUsage.rss() - rssBefore;
    process.stdout.write(`P14_ASSET_RANGE_SAMPLE ${JSON.stringify({
      case: "sparse-one-byte",
      fileBytes: SPARSE_SIZE,
      rssDelta,
      bytesRead: value.observation.bytesRead,
      largestRead: value.observation.largestRead,
    })}\n`);
    expect([...body]).toEqual([0x33]);
    expect(value.observation).toMatchObject({ opened: 1, closed: 1, bytesRead: 1, largestRead: 1 });
    expect(rssDelta).toBeLessThan(64 * 1024 * 1024);
  });

  it("closes the file handle and releases capacity when a consumer cancels", async () => {
    const value = await sparseFixture(1);
    const metadata = await value.workspace.statAsset(value.asset);
    if (!metadata) throw new Error("sparse fixture metadata is missing");
    const stream = await value.workspace.openAssetRange(value.asset, {
      start: 0,
      end: SPARSE_SIZE - 1,
      identity: metadata.identity,
    });
    if (!stream) throw new Error("asset stream was not opened");
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value?.byteLength).toBeGreaterThan(0);

    await reader.cancel("test cancellation");

    expect(value.observation.opened).toBe(1);
    expect(value.observation.closed).toBe(1);
    expect(value.observation.active).toBe(0);
    expect(value.observation.bytesRead).toBeLessThan(SPARSE_SIZE);
    expect(value.observation.largestRead).toBeLessThanOrEqual(64 * 1024);
  });

  it("aborts a queued consumer without consuming capacity", async () => {
    const value = await sparseFixture(1);
    const metadata = await value.workspace.statAsset(value.asset);
    if (!metadata) throw new Error("sparse fixture metadata is missing");
    const first = await value.workspace.openAssetRange(value.asset, {
      start: 0,
      end: SPARSE_SIZE - 1,
      identity: metadata.identity,
    });
    if (!first) throw new Error("first asset stream was not opened");
    const controller = new AbortController();
    const waiting = value.workspace.openAssetRange(value.asset, {
      start: 0,
      end: 0,
      identity: metadata.identity,
      signal: controller.signal,
    });
    const aborted = expect(waiting).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    await aborted;
    await first.cancel("release first stream");

    expect(value.observation).toMatchObject({ opened: 1, closed: 1, active: 0 });
  });

  it("invalidates the weak ETag and rejects a stale identity after external replacement", async () => {
    const value = await sparseFixture();
    const before = await value.workspace.statAsset(value.asset);
    if (!before) throw new Error("sparse fixture metadata is missing");
    const replacement = path.join(path.dirname(value.asset), "replacement.bin");
    const handle = await open(replacement, "w+");
    try {
      await handle.truncate(SPARSE_SIZE);
      await handle.write(Uint8Array.of(0x44), 0, 1, SPARSE_SIZE - 1);
    } finally {
      await handle.close();
    }
    await rename(replacement, value.asset);

    const after = await value.workspace.statAsset(value.asset);
    expect(after?.etag).not.toBe(before.etag);
    expect(await value.workspace.openAssetRange(value.asset, {
      start: 0,
      end: 0,
      identity: before.identity,
    })).toBeNull();
    expect(value.observation).toMatchObject({ opened: 0, closed: 0, active: 0 });
  });

  it("bounds twenty concurrent consumers and returns only their requested ranges", async () => {
    const value = await sparseFixture(4);
    const metadata = await value.workspace.statAsset(value.asset);
    if (!metadata) throw new Error("sparse fixture metadata is missing");

    const responses = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const position = index % 2 === 0 ? 0 : SPARSE_SIZE - 1;
      return bytes(await value.workspace.openAssetRange(value.asset, {
        start: position,
        end: position,
        identity: metadata.identity,
      }));
    }));

    expect(responses.map((body) => body[0])).toEqual(Array.from(
      { length: 20 }, (_, index) => index % 2 === 0 ? 0x11 : 0x33,
    ));
    expect(value.observation.opened).toBe(20);
    expect(value.observation.closed).toBe(20);
    expect(value.observation.maximumActive).toBeLessThanOrEqual(4);
    expect(value.observation.active).toBe(0);
    expect(value.observation.bytesRead).toBe(20);
    process.stdout.write(`P14_ASSET_RANGE_SAMPLE ${JSON.stringify({
      case: "twenty-consumers",
      consumers: responses.length,
      maximumActive: value.observation.maximumActive,
      bytesRead: value.observation.bytesRead,
    })}\n`);
  });
});
