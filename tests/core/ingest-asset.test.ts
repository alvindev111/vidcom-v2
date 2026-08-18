import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  canonicalizeJson,
  err,
  ingestAsset,
  ok,
  type AbsolutePath,
  type CompositeRequest,
  type PendingMount,
  type ProjectRef,
  type StagedFileSource,
  type StagedWriter,
  type WriteEnvelope,
} from "@vidcom/core";

const projectId = "project-assets" as ProjectId;
const ref: ProjectRef = {
  id: projectId,
  slug: "project-assets",
  root: "/workspace/project-assets" as AbsolutePath,
  entry: "index.html" as RelPath,
};
const operationId = "01K1ABCDEFGHJKMNPQRSTVWXYZ";
const actor = "user" as const;
const origin = { kind: "ui", sessionId: "session", label: "Upload asset", historyAction: "record", historyOperation: null } as const;

function digest(value: string | Uint8Array): ContentHash {
  return `sha256:${createHash("sha256").update(value).digest("hex")}` as ContentHash;
}

function png(extra = ""): Uint8Array {
  return new Uint8Array([...Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...Buffer.from(extra)]);
}

function stream(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

class MemoryWriter implements StagedWriter {
  readonly chunks: Uint8Array[] = [];
  discarded = false;

  constructor(private readonly id: number, private readonly limit: number) {}

  async write(chunk: Uint8Array): Promise<void> {
    const size = this.chunks.reduce((total, item) => total + item.byteLength, 0) + chunk.byteLength;
    if (size > this.limit) {
      const error = new Error("limit") as Error & { name: string; limit: number; actual: number };
      error.name = "AssetStagingLimitError";
      error.limit = this.limit;
      error.actual = size;
      throw error;
    }
    this.chunks.push(chunk.slice());
  }

  bytes(): Uint8Array {
    return new Uint8Array(Buffer.concat(this.chunks.map((chunk) => Buffer.from(chunk))));
  }

  async finalize(): Promise<StagedFileSource> {
    const bytes = this.bytes();
    return { sourcePath: `/tmp/asset-${this.id}` as AbsolutePath, contentHash: digest(bytes) };
  }

  async discard(): Promise<void> { this.discarded = true; }
}

function envelope(revision = 4): WriteEnvelope {
  return { projectRevision: revision, entityRevision: null, fileHashes: {}, diagnostics: [], changeSeq: revision };
}

function setup(options: {
  revision?: number;
  assets?: string[];
  pending?: { state: "active"; record: PendingMount } | { state: "expired" } | { state: "never-seen" };
  cleanSvg?: string;
  probeFails?: boolean;
} = {}) {
  const writers: MemoryWriter[] = [];
  const mutations: CompositeRequest[] = [];
  const events: string[] = [];
  const dependencies = {
    workspace: {
      async readProjectRef(id: ProjectId) { return id === projectId ? ref : null; },
      async readTree() {
        const names = options.assets ?? [];
        return names.length === 0 ? [] : [{
          path: "assets" as RelPath,
          name: "assets",
          kind: "folder" as const,
          children: names.map((name) => ({ path: `assets/${name}` as RelPath, name, kind: "file" as const })),
        }];
      },
    },
    journal: { async latestRevision() { return options.revision ?? 3; } },
    staging: {
      async open(_ref: ProjectRef, hint: { maxBytes: number }) {
        const writer = new MemoryWriter(writers.length, hint.maxBytes);
        writers.push(writer);
        return writer;
      },
    },
    sanitizer: {
      async sanitize() { return ok(options.cleanSvg ?? "<svg><path/></svg>"); },
    },
    pendingMount: {
      async lookup() { return options.pending ?? { state: "never-seen" as const }; },
    },
    authority: {
      async mutateSource(request: CompositeRequest) {
        events.push("mutate");
        mutations.push(request);
        return ok(envelope());
      },
    },
    probe: {
      async probeMedia() {
        events.push("probe");
        expect(mutations).toHaveLength(1);
        if (options.probeFails) throw new Error("ffprobe unavailable");
        return ok({ status: "ok" as const, kind: "media" as const, byteSize: 12, durationSeconds: null, width: 1, height: 1, codec: "png" });
      },
      async probeFont() { return err({ code: ErrorCode.UnsupportedMedia, message: "not a font" }); },
    },
    hashContent: digest,
  };
  return { dependencies, writers, mutations, events };
}

function activePending(uploadFingerprint: ContentHash, assetContentHash = digest(png("old"))): PendingMount {
  return {
    operationId,
    projectId,
    assetPath: "assets/photo.png" as RelPath,
    assetContentHash,
    uploadFingerprint,
    atSeconds: 2.5,
    trackIndex: 1,
    state: "uploaded_unmounted",
    lastFailure: null,
    mountedSceneId: null,
    mountedRevision: null,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
}

describe("ingestAsset", () => {
  it("streams, resolves a visible collision, opens pending mount in the same non-undoable mutation, then probes", async () => {
    const raw = png("body");
    const setupResult = setup({ assets: ["Photo.png"] });

    const result = await ingestAsset(setupResult.dependencies, {
      projectId,
      kind: "image",
      filename: "folder/photo.png",
      stream: stream(raw.subarray(0, 5), raw.subarray(5)),
      expectedRevision: 3,
      pendingMount: { operationId, atSeconds: 2.5, trackIndex: 1 },
    }, actor, origin);

    expect(result).toMatchObject({ ok: true, value: { path: "assets/photo (2).png", renamedFrom: "photo.png", replayed: false } });
    expect(setupResult.events).toEqual(["mutate", "probe"]);
    expect(setupResult.mutations).toHaveLength(1);
    const request = setupResult.mutations[0]!;
    expect(request.steps).toMatchObject([
      { kind: "write-staged", path: "assets/photo (2).png", expectedContentHash: null, undoable: false },
    ]);
    expect(request.backup).toBe(false);
    expect(request.pendingMountTransition).toMatchObject({
      kind: "open",
      operationId,
      record: { assetPath: "assets/photo (2).png", atSeconds: 2.5, trackIndex: 1 },
    });
    expect(request.pendingMountTransition).toMatchObject({ record: {
      assetContentHash: digest(raw),
      uploadFingerprint: digest(canonicalizeJson({
        kind: "image",
        filenameNfc: "folder/photo.png",
        atSeconds: 2.5,
        trackIndex: 1,
        requestContentHash: digest(raw),
      })),
    } });
    expect(setupResult.writers[0]?.discarded).toBe(true);
  });

  it("creates a missing assets directory in the same composite", async () => {
    const setupResult = setup();
    const result = await ingestAsset(setupResult.dependencies, {
      projectId, kind: "image", filename: "photo.png", stream: stream(png()), expectedRevision: 3,
    }, actor, origin);

    expect(result.ok).toBe(true);
    expect(setupResult.mutations[0]?.steps).toMatchObject([
      { kind: "mkdir", path: "assets", expectExisting: "either" },
      { kind: "write-staged", path: "assets/photo.png", undoable: false },
    ]);
  });

  it("keeps the committed file and reports unknown metadata when probing fails", async () => {
    const setupResult = setup({ probeFails: true });
    const result = await ingestAsset(setupResult.dependencies, {
      projectId, kind: "image", filename: "photo.png", stream: stream(png()), expectedRevision: 3,
    }, actor, origin);

    expect(result).toMatchObject({ ok: true, value: {
      replayed: false,
      metadata: { status: "unknown", reason: "asset metadata could not be read" },
    } });
    expect(setupResult.events).toEqual(["mutate", "probe"]);
  });

  it("discards staged bytes when the upload signal is cancelled", async () => {
    const controller = new AbortController();
    const body = {
      async *[Symbol.asyncIterator]() {
        yield png();
        controller.abort();
        yield new Uint8Array([1]);
      },
    };
    const setupResult = setup();
    const result = await ingestAsset(setupResult.dependencies, {
      projectId,
      kind: "image",
      filename: "photo.png",
      stream: body,
      expectedRevision: 3,
      signal: controller.signal,
    }, actor, origin);

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ message: "asset upload was cancelled" }) });
    expect(setupResult.mutations).toHaveLength(0);
    expect(setupResult.writers[0]?.discarded).toBe(true);
  });

  it("discards an exact replay and returns the durable asset without a second mutation", async () => {
    const raw = png("old");
    const fingerprint = digest(canonicalizeJson({
      kind: "image", filenameNfc: "photo.png", atSeconds: 2.5, trackIndex: 1, requestContentHash: digest(raw),
    }));
    const setupResult = setup({ pending: { state: "active", record: activePending(fingerprint) } });

    const result = await ingestAsset(setupResult.dependencies, {
      projectId, kind: "image", filename: "photo.png", stream: stream(raw), expectedRevision: 0,
      pendingMount: { operationId, atSeconds: 2.5, trackIndex: 1 },
    }, actor, origin);

    expect(result).toMatchObject({ ok: true, value: {
      path: "assets/photo.png", assetContentHash: digest(raw), replayed: true,
    } });
    expect(setupResult.mutations).toHaveLength(0);
    expect(setupResult.writers[0]?.discarded).toBe(true);
  });

  it("rejects changed or retention-expired operations before mutation", async () => {
    const raw = png("new");
    const changed = setup({ pending: { state: "active", record: activePending(digest("other")) } });
    const conflict = await ingestAsset(changed.dependencies, {
      projectId, kind: "image", filename: "photo.png", stream: stream(raw), expectedRevision: 3,
      pendingMount: { operationId, atSeconds: 2.5, trackIndex: 1 },
    }, actor, origin);
    expect(conflict).toEqual({ ok: false, error: expect.objectContaining({ code: ErrorCode.WriteConflict }) });
    expect(changed.mutations).toHaveLength(0);

    const expired = setup({ pending: { state: "expired" } });
    const gone = await ingestAsset(expired.dependencies, {
      projectId, kind: "image", filename: "photo.png", stream: stream(raw), expectedRevision: 3,
      pendingMount: { operationId, atSeconds: 2.5, trackIndex: 1 },
    }, actor, origin);
    expect(gone).toEqual({ ok: false, error: expect.objectContaining({ code: ErrorCode.NotFound }) });
    expect(expired.mutations).toHaveLength(0);
  });

  it("fingerprints raw SVG bytes even when sanitization produces identical published bytes", async () => {
    const firstRaw = new TextEncoder().encode("<svg><script>one()</script><path/></svg>");
    const secondRaw = new TextEncoder().encode("<svg><script>two()</script><path/></svg>");
    const firstFingerprint = digest(canonicalizeJson({
      kind: "image", filenameNfc: "art.svg", atSeconds: 2.5, trackIndex: 1,
      requestContentHash: digest(firstRaw),
    }));
    const clean = "<svg><path /></svg>";
    const setupResult = setup({
      cleanSvg: clean,
      pending: { state: "active", record: activePending(firstFingerprint, digest(clean)) },
    });

    const result = await ingestAsset(setupResult.dependencies, {
      projectId, kind: "image", filename: "art.svg", stream: stream(secondRaw), expectedRevision: 3,
      pendingMount: { operationId, atSeconds: 2.5, trackIndex: 1 },
    }, actor, origin);

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: ErrorCode.WriteConflict }) });
    expect(setupResult.writers).toHaveLength(1);
    expect(setupResult.writers.every((writer) => writer.discarded)).toBe(true);
    expect(setupResult.mutations).toHaveLength(0);
  });

  it("publishes only the second staged source containing sanitized SVG bytes", async () => {
    const raw = new TextEncoder().encode("<svg><script>bad()</script><path/></svg>");
    const clean = "<svg><path /></svg>";
    const setupResult = setup({ cleanSvg: clean });

    const result = await ingestAsset(setupResult.dependencies, {
      projectId, kind: "image", filename: "art.svg", stream: stream(raw), expectedRevision: 3,
    }, actor, origin);

    expect(result).toMatchObject({ ok: true, value: { assetContentHash: digest(clean) } });
    expect(setupResult.writers).toHaveLength(2);
    expect(setupResult.writers[0]?.discarded).toBe(true);
    expect(setupResult.writers[1]?.discarded).toBe(true);
    expect(setupResult.mutations[0]?.steps.at(-1)).toMatchObject({
      kind: "write-staged",
      source: { sourcePath: "/tmp/asset-1", contentHash: digest(clean) },
    });
  });

  it("rejects revision, extension, magic and size failures without publishing", async () => {
    const stale = setup({ revision: 4 });
    await expect(ingestAsset(stale.dependencies, {
      projectId, kind: "image", filename: "photo.png", stream: stream(png()), expectedRevision: 3,
    }, actor, origin)).resolves.toEqual({ ok: false, error: expect.objectContaining({ code: ErrorCode.WriteConflict }) });
    expect(stale.writers).toHaveLength(0);

    for (const input of [
      { kind: "image" as const, filename: "photo.exe", body: png(), code: ErrorCode.AssetNotAllowed },
      { kind: "image" as const, filename: "photo.png", body: new TextEncoder().encode("not an image"), code: ErrorCode.UnsupportedMedia },
    ]) {
      const current = setup();
      const result = await ingestAsset(current.dependencies, {
        projectId, kind: input.kind, filename: input.filename, stream: stream(input.body), expectedRevision: 3,
      }, actor, origin);
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: input.code }) });
      expect(current.mutations).toHaveLength(0);
      expect(current.writers.every((writer) => writer.discarded)).toBe(true);
    }

    const oversized = setup();
    const huge = new Uint8Array(25 * 1024 * 1024);
    huge.set(png());
    const tooLarge = await ingestAsset(oversized.dependencies, {
      projectId,
      kind: "image",
      filename: "photo.png",
      stream: stream(huge, new Uint8Array([1])),
      expectedRevision: 3,
    }, actor, origin);
    expect(tooLarge).toEqual({ ok: false, error: expect.objectContaining({
      code: ErrorCode.TooLarge,
      details: { limit: 25 * 1024 * 1024, actual: 25 * 1024 * 1024 + 1 },
    }) });
    expect(oversized.mutations).toHaveLength(0);
    expect(oversized.writers[0]?.discarded).toBe(true);
  });
});
