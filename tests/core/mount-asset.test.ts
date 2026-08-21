import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  mountAsset,
  type AbsolutePath,
  type CompositeRequest,
  type MountAssetDependencies,
  type PendingMount,
  type ProjectRef,
} from "@vidcom/core";

const projectId = "project_mount" as ProjectId;
const ASSET = "assets/clip.mp4" as RelPath;
const ASSET_HASH = `sha256:${"a".repeat(64)}` as ContentHash;
const ENTRY_HASH = `sha256:${"b".repeat(64)}` as ContentHash;

const ref = {
  id: projectId,
  slug: "mount",
  root: "/w/mount" as AbsolutePath,
  entry: "index.html" as RelPath,
} as ProjectRef;

const model = {
  project: { id: projectId, width: 1920, height: 1080, duration: 4, sceneCount: 1 },
  scenes: [{ id: "scene-1", src: "compositions/scene-1.html", start: 0, duration: 4, trackIndex: 0 }],
  frameRate: 30,
} as never;

const origin = {
  kind: "ui" as const,
  sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  label: "Mount asset",
  historyAction: "record" as const,
  historyOperation: null,
};

interface Harness {
  dependencies: MountAssetDependencies;
  state: {
    requests: CompositeRequest[];
    probed: RelPath[];
    hashes: Map<RelPath, ContentHash | null>;
  };
}

function harness(options: {
  duration?: number | null;
  probeKind?: "media" | "unknown";
  hash?: ContentHash | null;
  pending?: PendingMount | null;
  pendingState?: "active" | "expired" | "never-seen";
} = {}): Harness {
  const state = {
    requests: [] as CompositeRequest[],
    probed: [] as RelPath[],
    hashes: new Map<RelPath, ContentHash | null>([
      [ASSET, options.hash === undefined ? ASSET_HASH : options.hash],
      [ref.entry, ENTRY_HASH],
    ]),
  };
  const dependencies = {
    workspace: {
      readProjectRef: async () => ref,
      resolve: async (_ref: ProjectRef, path: RelPath) => ({ ok: true as const, value: path as never }),
      readHash: async (resolved: never) => state.hashes.get(resolved as unknown as RelPath) ?? null,
    },
    composition: {
      parseProject: async () => model,
      applyOps: async () => ({ ok: true as const, value: "<main/>" }),
    },
    probe: {
      probeMedia: async (_ref: ProjectRef, path: RelPath) => {
        state.probed.push(path);
        return options.probeKind === "unknown"
          ? { ok: true as const, value: { status: "unknown" as const, byteSize: 10, reason: "ffprobe failed" } }
          : {
              ok: true as const,
              value: {
                status: "ok" as const,
                kind: "media" as const,
                byteSize: 10,
                durationSeconds: options.duration === undefined ? 7.5 : options.duration,
                width: 1920,
                height: 1080,
                codec: "h264",
              },
            };
      },
    },
    pendingMount: {
      lookup: async () => (options.pendingState === "expired"
        ? { state: "expired" as const }
        : options.pendingState === "never-seen" || !options.pending
          ? { state: "never-seen" as const }
          : { state: "active" as const, record: options.pending }),
      listPending: async () => [],
      markFailed: async () => {},
      abandon: async () => {},
    },
    authority: {
      mutateSource: async (request: CompositeRequest) => {
        state.requests.push(request);
        return {
          ok: true as const,
          value: {
            projectRevision: 2,
            entityRevision: null,
            fileHashes: {},
            diagnostics: [],
            changeSeq: 9,
          } as never,
        };
      },
    },
    clock: { now: () => new Date("2026-08-19T00:00:00.000Z") },
  } as unknown as MountAssetDependencies;
  return { dependencies, state };
}

const existingAssetInput = {
  projectId,
  assetPath: ASSET,
  assetContentHash: ASSET_HASH,
  atSeconds: 4,
  trackIndex: 0,
  expectedContentHash: ENTRY_HASH,
  onOverflow: "extend-root" as const,
};

const pendingRecord = (overrides: Partial<PendingMount> = {}): PendingMount => ({
  operationId: "01BX5ZZKBKACTAV9WEVGEMMVRZ",
  projectId,
  assetPath: ASSET,
  assetContentHash: ASSET_HASH,
  uploadFingerprint: `sha256:${"c".repeat(64)}` as ContentHash,
  atSeconds: 4,
  trackIndex: 0,
  state: "uploaded_unmounted",
  lastFailure: null,
  mountedSceneId: null,
  mountedRevision: null,
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
  ...overrides,
});

describe("mountAsset", () => {
  it("wraps an existing asset in one scene through one composite", async () => {
    const harnessed = harness();
    const mounted = await mountAsset(harnessed.dependencies, existingAssetInput, "user", origin);
    expect(mounted.ok).toBe(true);
    if (!mounted.ok) return;
    expect(mounted.value.durationSeconds).toBe(7.5);
    expect(mounted.value.sceneId).toBe("scene-2");

    // Exactly one mutation: the wrapper, its sidecar and the root entry.
    expect(harnessed.state.requests).toHaveLength(1);
    const request = harnessed.state.requests[0]!;
    expect(request.steps.map((step) => [step.kind, "path" in step ? step.path : null])).toEqual([
      ["write", "compositions/scene-2.html"],
      ["write", "narration/scene-2.json"],
      ["write", "index.html"],
    ]);
    const wrapper = request.steps[0]!;
    if (wrapper.kind !== "write" || typeof wrapper.content !== "string") throw new Error("expected a wrapper");
    // The asset is referenced, never copied, and the element is a clip.
    expect(wrapper.content).toContain(`src="../${ASSET}"`);
    expect(wrapper.content).toContain("<video");
    expect(wrapper.content).toContain("class=\"clip\"");
    // The asset itself is a typed dependency of this mutation, not a write.
    expect(request.historyReadGuards).toEqual([
      { path: ASSET, state: { kind: "file", contentHash: ASSET_HASH } },
    ]);
    expect(request.backup).toBe(false);
    // No pending row is opened or closed for an asset already in the project.
    expect(request.pendingMountTransition).toBeUndefined();
  });

  it("probes the file itself and refuses to take a duration from the caller", async () => {
    const harnessed = harness();
    await mountAsset(harnessed.dependencies, existingAssetInput, "user", origin);
    expect(harnessed.state.probed).toEqual([ASSET]);

    // A client-supplied duration is not part of the contract at all.
    const rejected = await mountAsset(
      harnessed.dependencies,
      { ...existingAssetInput, durationSeconds: 99 } as never,
      "user",
      origin,
    );
    expect(rejected.ok).toBe(true);
    if (rejected.ok) expect(rejected.value.durationSeconds).toBe(7.5);
  });

  it("rejects a probed sub-frame duration before composing or writing", async () => {
    const harnessed = harness({ duration: 7.55 });
    const mounted = await mountAsset(harnessed.dependencies, existingAssetInput, "user", origin);
    expect(mounted).toMatchObject({
      ok: false,
      error: {
        code: ErrorCode.TimingNotFrameAligned,
        field: "duration",
        details: { value: 7.55, fps: 30 },
      },
    });
    expect(harnessed.state.requests).toHaveLength(0);
  });

  it("defaults an image to four seconds and keeps a video's probed duration", async () => {
    const image = harness({ duration: null });
    // The image is a different file, so it needs its own hash on disk.
    image.state.hashes.set("assets/still.png" as RelPath, ASSET_HASH);
    const mountedImage = await mountAsset(
      image.dependencies,
      { ...existingAssetInput, assetPath: "assets/still.png" as RelPath },
      "user",
      origin,
    );
    expect(mountedImage.ok).toBe(true);
    if (mountedImage.ok) expect(mountedImage.value.durationSeconds).toBe(4);
    const wrapper = image.state.requests[0]!.steps[0]!;
    if (wrapper.kind !== "write" || typeof wrapper.content !== "string") throw new Error("expected a wrapper");
    expect(wrapper.content).toContain("<img");
  });

  it("refuses with 422 semantics when the file cannot be probed, leaving it in Media", async () => {
    const harnessed = harness({ probeKind: "unknown" });
    const mounted = await mountAsset(harnessed.dependencies, existingAssetInput, "user", origin);
    expect(mounted.ok).toBe(false);
    if (!mounted.ok) expect(mounted.error.code).toBe(ErrorCode.InvariantViolated);
    // Nothing was written, so the uploaded file simply stays where it is.
    expect(harnessed.state.requests).toEqual([]);
  });

  it("refuses when the asset on disk no longer matches the hash it was mounted for", async () => {
    const harnessed = harness({ hash: `sha256:${"9".repeat(64)}` as ContentHash });
    const mounted = await mountAsset(harnessed.dependencies, existingAssetInput, "user", origin);
    expect(mounted.ok).toBe(false);
    if (!mounted.ok) expect(mounted.error.code).toBe(ErrorCode.WriteConflict);
    expect(harnessed.state.requests).toEqual([]);

    const missing = harness({ hash: null });
    const gone = await mountAsset(missing.dependencies, existingAssetInput, "user", origin);
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.error.code).toBe(ErrorCode.NotFound);
    expect(missing.state.requests).toEqual([]);
  });

  it("takes path, hash, time and track from the record when retrying a pending mount", async () => {
    const record = pendingRecord({ atSeconds: 4, trackIndex: 1 });
    const harnessed = harness({ pending: record });
    const mounted = await mountAsset(harnessed.dependencies, {
      projectId,
      operationId: record.operationId,
      expectedContentHash: ENTRY_HASH,
      onOverflow: "extend-root",
    }, "user", origin);
    expect(mounted.ok).toBe(true);
    if (!mounted.ok) return;
    const request = harnessed.state.requests[0]!;
    // The retry closes the same pending operation inside the same composite.
    expect(request.pendingMountTransition).toMatchObject({
      kind: "close",
      operationId: record.operationId,
    });
    expect(request.historyReadGuards).toEqual([
      { path: ASSET, state: { kind: "file", contentHash: ASSET_HASH } },
    ]);
    const wrapper = request.steps[0]!;
    if (wrapper.kind !== "write" || typeof wrapper.content !== "string") throw new Error("expected a wrapper");
    expect(wrapper.content).toContain(`src="../${ASSET}"`);
  });

  it("refuses an expired or never-seen operation before any mutation", async () => {
    for (const pendingState of ["expired", "never-seen"] as const) {
      const harnessed = harness({ pendingState });
      const mounted = await mountAsset(harnessed.dependencies, {
        projectId,
        operationId: "01BX5ZZKBKACTAV9WEVGEMMVRZ",
        expectedContentHash: ENTRY_HASH,
        onOverflow: "extend-root",
      }, "user", origin);
      expect(mounted.ok, pendingState).toBe(false);
      if (!mounted.ok) expect(mounted.error.code).toBe(ErrorCode.NotFound);
      expect(harnessed.state.requests, pendingState).toEqual([]);
    }

    // An abandoned row is terminal: the file stays in Media, but this operation
    // is over and cannot be resumed.
    const gone = harness({
      pending: pendingRecord({ state: "abandoned", lastFailure: { code: "abandoned", message: "cancelled" } }),
    });
    const abandoned = await mountAsset(gone.dependencies, {
      projectId,
      operationId: "01BX5ZZKBKACTAV9WEVGEMMVRZ",
      expectedContentHash: ENTRY_HASH,
      onOverflow: "extend-root",
    }, "user", origin);
    expect(abandoned.ok).toBe(false);
    if (!abandoned.ok) expect(abandoned.error.code).toBe(ErrorCode.NotFound);
    expect(gone.state.requests).toEqual([]);
  });

  it("replays a mounted operation with its old result instead of mounting twice", async () => {
    const done = harness({
      pending: pendingRecord({ state: "mounted", mountedSceneId: "scene-1", mountedRevision: 5 }),
    });
    const replayed = await mountAsset(done.dependencies, {
      projectId,
      operationId: "01BX5ZZKBKACTAV9WEVGEMMVRZ",
      expectedContentHash: ENTRY_HASH,
      onOverflow: "extend-root",
    }, "user", origin);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value).toMatchObject({
      sceneId: "scene-1",
      durationSeconds: 4,
      revision: 5,
      replayed: true,
      envelope: null,
    });
    // A retry after a lost response must not mint a second scene or a second write.
    expect(done.state.requests).toEqual([]);
    expect(done.state.probed).toEqual([]);

    // If the scene the record points at is gone, replay cannot resurrect it.
    const orphaned = harness({
      pending: pendingRecord({ state: "mounted", mountedSceneId: "scene-9", mountedRevision: 5 }),
    });
    const missing = await mountAsset(orphaned.dependencies, {
      projectId,
      operationId: "01BX5ZZKBKACTAV9WEVGEMMVRZ",
      expectedContentHash: ENTRY_HASH,
      onOverflow: "extend-root",
    }, "user", origin);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe(ErrorCode.WriteConflict);
    expect(orphaned.state.requests).toEqual([]);
  });

  it("shrinks only the wrapper scene, and extends the root when asked", async () => {
    // The asset is longer than the space left before the root duration ends.
    const shrink = harness({ duration: 30 });
    const shrunk = await mountAsset(
      shrink.dependencies,
      { ...existingAssetInput, atSeconds: 2, onOverflow: "shrink" },
      "user",
      origin,
    );
    expect(shrunk.ok).toBe(true);
    if (!shrunk.ok) return;
    // Only the wrapper duration is reduced; no in/out point is invented.
    expect(shrunk.value.durationSeconds).toBeLessThan(30);
    const wrapper = shrink.state.requests[0]!.steps[0]!;
    if (wrapper.kind !== "write" || typeof wrapper.content !== "string") throw new Error("expected a wrapper");
    expect(wrapper.content).not.toContain("data-in");
    expect(wrapper.content).not.toContain("#t=");

    const extend = harness({ duration: 30 });
    const extended = await mountAsset(
      extend.dependencies,
      { ...existingAssetInput, atSeconds: 2, onOverflow: "extend-root" },
      "user",
      origin,
    );
    expect(extended.ok).toBe(true);
    if (extended.ok) expect(extended.value.durationSeconds).toBe(30);
  });
});
