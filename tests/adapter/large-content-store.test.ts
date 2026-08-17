import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  type AbsolutePath,
  type MutationReceipt,
  type MutationReceiptStep,
  type StagedFileSource,
  type UndoContentRef,
} from "@vidcom/core";
import { LargePreviousContentStore } from "@vidcom/adapter";

let root: string;

const hash = (digit: string) => `sha256:${digit.repeat(64)}` as ContentHash;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-undo-content-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("mutation receipt contract", () => {
  it("keeps all five receipt step branches distinct", () => {
    const inline: UndoContentRef = {
      kind: "inline",
      bytes: new Uint8Array([1]),
      encoding: "binary",
      contentHash: hash("1"),
    };
    const steps: MutationReceiptStep[] = [
      {
        kind: "file",
        undoable: true,
        path: "index.html" as RelPath,
        beforeContent: inline,
        afterContent: null,
        fromHash: hash("1"),
        toHash: null,
      },
      {
        kind: "file",
        undoable: false,
        path: "assets/video.mp4" as RelPath,
        fromHash: null,
        toHash: hash("2"),
        omittedReason: "not-undoable",
      },
      {
        kind: "directory",
        undoable: true,
        op: "mkdir",
        path: "compositions/catalog" as RelPath,
        existedBefore: false,
      },
      {
        kind: "pending-mount",
        undoable: true,
        operationId: "01K00000000000000000000000",
        before: { state: "uploaded_unmounted", lastFailure: null },
        after: { state: "mounted", sceneId: "scene-1", revision: 2 },
      },
      {
        kind: "entity",
        undoable: false,
        entity: "preview-settings",
        backingPath: "preview-settings.json" as RelPath,
        beforeState: null,
        afterState: DEFAULT_PREVIEW_SETTINGS,
        fromRevision: 0,
        toRevision: 1,
        fromHash: null,
        toHash: hash("3"),
      },
    ];
    const receipt: MutationReceipt = {
      id: "journal:1",
      projectId: "project-1" as ProjectId,
      origin: {
        kind: "ui",
        sessionId: "session-1",
        label: "Edit project",
        historyAction: "record",
        historyOperation: null,
      },
      steps,
      paths: ["index.html" as RelPath],
      readGuards: [{ path: "assets/logo.png" as RelPath, state: { kind: "file", contentHash: hash("4") } }],
      projectRevision: 1,
      at: "2026-08-17T00:00:00.000Z",
      undoable: false,
    };

    expect(receipt.steps.map(({ kind }) => kind)).toEqual([
      "file",
      "file",
      "directory",
      "pending-mount",
      "entity",
    ]);
  });
});

describe("LargePreviousContentStore undo leases", () => {
  it("retains inline bytes without exposing the caller buffer", async () => {
    const store = new LargePreviousContentStore(root);
    const bytes = new Uint8Array([1, 2, 3]);

    const retained = await store.retainBytes(bytes, "binary", "inline");
    bytes[0] = 9;

    expect(retained).toMatchObject({ kind: "inline", encoding: "binary" });
    expect(await store.resolve(retained)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("streams a staged file into an object and holds it through live lease cleanup", async () => {
    const store = new LargePreviousContentStore(root);
    const sourcePath = path.join(root, "source.bin") as AbsolutePath;
    const bytes = new Uint8Array(2 * 1024 * 1024).fill(7);
    await writeFile(sourcePath, bytes);
    const contentHash = await store.put(bytes);
    const source: StagedFileSource = { sourcePath, contentHash };

    const first = await store.retainFile(source, "binary");
    const second = await store.retainFile(source, "binary");
    expect(first).toEqual(second);
    const resolved = await store.resolve(first);
    expect(resolved).toMatchObject({ contentHash });
    expect(await readFile((resolved as StagedFileSource).sourcePath)).toEqual(Buffer.from(bytes));

    expect(await store.cleanupUnreferenced(new Set(), new Date("2100-01-01"))).toBe(0);
    store.release([first]);
    expect(await store.cleanupUnreferenced(new Set(), new Date("2100-01-01"))).toBe(0);
    store.release([second]);
    expect(await store.cleanupUnreferenced(new Set(), new Date("2100-01-01"))).toBe(1);
  });

  it("rejects symlink staged sources instead of following them", async () => {
    const store = new LargePreviousContentStore(root);
    const target = path.join(root, "target.bin");
    const sourcePath = path.join(root, "source-link.bin") as AbsolutePath;
    const bytes = new Uint8Array([4, 5, 6]);
    await writeFile(target, bytes);
    await symlink(target, sourcePath);
    const source: StagedFileSource = { sourcePath, contentHash: await store.put(bytes) };

    await expect(store.retainFile(source, "binary")).rejects.toBeDefined();
  });

  it("rejects a staged file whose bytes do not match its declared hash", async () => {
    const store = new LargePreviousContentStore(root);
    const sourcePath = path.join(root, "mismatch.bin") as AbsolutePath;
    await writeFile(sourcePath, new Uint8Array([7, 8, 9]));

    await expect(store.retainFile({ sourcePath, contentHash: hash("f") }, "binary"))
      .rejects.toThrow("did not match its declared hash");
  });

  it("streams 250 MiB and releases 50 shared object leases without heap-sized retention", async () => {
    const store = new LargePreviousContentStore(root);
    const sourcePath = path.join(root, "large-source.bin") as AbsolutePath;
    const chunk = Buffer.alloc(1024 * 1024, 0x2a);
    const digest = createHash("sha256");
    const sourceHandle = await open(sourcePath, "wx", 0o600);
    try {
      for (let index = 0; index < 250; index += 1) {
        await sourceHandle.write(chunk);
        digest.update(chunk);
      }
      await sourceHandle.sync();
    } finally {
      await sourceHandle.close();
    }
    const largeHash = `sha256:${digest.digest("hex")}` as ContentHash;
    const baselineHeap = process.memoryUsage().heapUsed;
    const large = await store.retainFile({ sourcePath, contentHash: largeHash }, "binary");
    expect(await store.resolve(large)).toMatchObject({ contentHash: largeHash });

    const sharedBytes = new Uint8Array(65 * 1024).fill(7);
    const shared = await Promise.all(Array.from({ length: 50 }, () =>
      store.retainBytes(sharedBytes, "binary", "object")));
    expect(new Set(shared.map(({ contentHash }) => contentHash)).size).toBe(1);
    expect(process.memoryUsage().heapUsed - baselineHeap).toBeLessThan(32 * 1024 * 1024);

    store.release(shared.slice(0, 25));
    expect(await store.cleanupUnreferenced(new Set(), new Date("2100-01-01"))).toBe(0);
    store.release(shared.slice(25));
    store.release([large]);
    expect(await store.cleanupUnreferenced(new Set(), new Date("2100-01-01"))).toBe(2);
  }, 30_000);

  it("does not over-release a duplicate object lease", async () => {
    const store = new LargePreviousContentStore(root);
    const bytes = new Uint8Array(65 * 1024).fill(9);
    const original = await store.retainBytes(bytes, "binary", "object");
    const duplicate = await store.retainBytes(bytes, "binary", "object");
    expect(duplicate).toEqual(original);

    store.release([duplicate]);
    expect(await store.cleanupUnreferenced(new Set(), new Date("2100-01-01"))).toBe(0);
    store.release([original]);
    expect(await store.cleanupUnreferenced(new Set(), new Date("2100-01-01"))).toBe(1);
  });
});
