import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  ok,
  representativeSceneTime,
  sampleTimelineThumbnailTimes,
  thumbnailRenderKey,
  ThumbnailService,
  type AbsolutePath,
  type CompositionDependency,
  type CompositionDependencyPort,
  type CompositionModel,
  type CompositionPort,
  type ProjectRef,
  type ResolvedPath,
  type ThumbnailPort,
  type WorkspacePort,
} from "@vidcom/core";

const ref: ProjectRef = {
  id: "project_thumbnails" as ProjectId,
  slug: "thumbnails",
  root: "/workspace/thumbnails" as AbsolutePath,
  entry: "index.html" as RelPath,
};
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}` as ContentHash;

function model(overrides: Partial<CompositionModel> = {}): CompositionModel {
  return {
    project: {
      id: ref.id,
      slug: ref.slug,
      title: "Thumbnails",
      width: 1080,
      height: 1920,
      duration: 2,
      updatedAt: "2026-08-19T00:00:00.000Z",
      sceneCount: 1,
      revision: 0,
    },
    frameRate: 30,
    scenes: [{ id: "scene-a", src: "scenes/a.html", start: 6, duration: 2, trackIndex: 0 }] as never,
    rootTrack: null,
    diagnostics: [],
    sources: [],
    references: [],
    ...overrides,
  };
}

function harness(options: {
  composition?: CompositionModel;
  dependencies?: CompositionDependency[];
  sceneHash?: ContentHash | null;
} = {}) {
  let dependencies = options.dependencies ?? [
    { path: "styles/a.css" as RelPath, state: "present", contentHash: hash("css") },
    { path: "media/missing.png" as RelPath, state: "missing", contentHash: null },
  ];
  let sceneHash = options.sceneHash === undefined ? hash("scene") : options.sceneHash;
  const composition = { parseProject: async () => options.composition ?? model() } as unknown as CompositionPort;
  const dependencyPort: CompositionDependencyPort = {
    async dependenciesOf() { return ok(dependencies); },
  };
  const workspace = {
    async resolve(_ref: ProjectRef, relative: string) {
      return ok(`/workspace/thumbnails/${relative}` as ResolvedPath);
    },
    async readHash() { return sceneHash; },
  } as unknown as WorkspacePort;
  const service = new ThumbnailService({
    workspace,
    composition,
    dependencies: dependencyPort,
    hashContent: hash,
    runtimeDigest: "runtime:abc",
    rendererVersion: "timeline-renderer-v1",
  });
  return {
    service,
    setDependencies(value: CompositionDependency[]) { dependencies = value; },
    setSceneHash(value: ContentHash | null) { sceneHash = value; },
  };
}

describe("timeline thumbnail planning", () => {
  it("fits the server-owned profile and samples scene-local centers on the frame grid", async () => {
    const planned = await harness().service.plan(ref, {
      sceneId: "scene-a",
      atSeconds: sampleTimelineThumbnailTimes(2, 4, 30),
      profile: "timeline-v1",
    });

    expect(planned).toMatchObject({
      ok: true,
      value: {
        profile: {
          width: 90,
          height: 160,
          fps: 30,
          runtimeDigest: "runtime:abc",
          rendererVersion: "timeline-renderer-v1",
        },
        keys: [
          { sceneId: "scene-a", atSeconds: 0.26666666666666666 },
          { sceneId: "scene-a", atSeconds: 0.7666666666666667 },
          { sceneId: "scene-a", atSeconds: 1.2666666666666666 },
          { sceneId: "scene-a", atSeconds: 1.7666666666666666 },
        ],
      },
    });
    if (!planned.ok) return;
    expect(planned.value.keys.every((key) => key.profile === planned.value.profile)).toBe(true);
    expect(planned.value.keys.every((key) => key.fingerprint === planned.value.fingerprint)).toBe(true);
    expect(thumbnailRenderKey(planned.value.keys[0]!, hash)).toMatch(/^[0-9a-f]{64}$/u);
    expect(thumbnailRenderKey(planned.value.keys[0]!, hash))
      .not.toBe(thumbnailRenderKey({ ...planned.value.keys[0]!, atSeconds: 1 }, hash));
  });

  it("rounds and clamps to the final valid frame without adding scene start", () => {
    expect(sampleTimelineThumbnailTimes(0.1, 3, 30)).toEqual([1 / 30, 2 / 30, 2 / 30]);
  });

  it("selects the deterministic 55% representative frame and handles empty or invalid scenes", () => {
    expect(representativeSceneTime(2, 30)).toBe(1.1);
    expect(representativeSceneTime(2, 29.97)).toBe(33 / 29.97);
    expect(representativeSceneTime(0.01, 30)).toBe(0);
    expect(representativeSceneTime(0, 30)).toBe(0);
    expect(() => representativeSceneTime(-1, 30)).toThrow(TypeError);
    expect(() => representativeSceneTime(Number.NaN, 30)).toThrow(TypeError);
    expect(() => representativeSceneTime(2, 0)).toThrow(TypeError);
  });

  it("uses canonical dependency order and changes on dependency, source or profile identity", async () => {
    const a = { path: "a.css" as RelPath, state: "present" as const, contentHash: hash("a") };
    const b = { path: "b.css" as RelPath, state: "present" as const, contentHash: hash("b") };
    const fixture = harness({ dependencies: [b, a] });
    const input = { sceneId: "scene-a", atSeconds: [1], profile: "timeline-v1" as const };
    const first = await fixture.service.plan(ref, input);
    fixture.setDependencies([a, b]);
    const reordered = await fixture.service.plan(ref, input);
    expect(first.ok && reordered.ok && reordered.value.fingerprint).toBe(first.ok ? first.value.fingerprint : "");

    fixture.setDependencies([{ ...a, contentHash: hash("changed") }, b]);
    expect(await fixture.service.isFingerprintCurrent(ref, "scene-a", first.ok ? first.value.fingerprint : hash("x")))
      .toEqual({ ok: true, value: false });
    fixture.setDependencies([a, b]);
    fixture.setSceneHash(hash("changed-scene"));
    expect(await fixture.service.isFingerprintCurrent(ref, "scene-a", first.ok ? first.value.fingerprint : hash("x")))
      .toEqual({ ok: true, value: false });

    const landscape = harness({ composition: model({ project: { ...model().project, width: 1920, height: 1080 } }) });
    const landscapePlan = await landscape.service.plan(ref, input);
    expect(landscapePlan).toMatchObject({ ok: true, value: { profile: { width: 160, height: 90 } } });
    expect(first.ok && landscapePlan.ok && landscapePlan.value.fingerprint)
      .not.toBe(first.ok ? first.value.fingerprint : "");
  });

  it("keeps inline scenes in one source file as distinct thumbnail identities", async () => {
    const inline = harness({
      composition: model({
        project: { ...model().project, sceneCount: 2 },
        scenes: [
          { id: "scene-a", src: null, start: 0, duration: 2, trackIndex: 0 },
          { id: "scene-b", src: null, start: 2, duration: 2, trackIndex: 0 },
        ] as never,
      }),
    });

    const [a, b] = await Promise.all(["scene-a", "scene-b"].map((sceneId) => inline.service.plan(ref, {
      sceneId,
      atSeconds: [1],
      profile: "timeline-v1",
    })));

    expect(a.ok && b.ok && b.value.fingerprint).not.toBe(a.ok ? a.value.fingerprint : "");
    if (!a.ok || !b.ok) return;
    expect(thumbnailRenderKey(a.value.keys[0]!, hash)).not.toBe(thumbnailRenderKey(b.value.keys[0]!, hash));
  });

  it("rejects a client-selected profile and unavailable scene source", async () => {
    await expect(harness().service.plan(ref, { sceneId: "scene-a", atSeconds: [1], profile: "custom" as never }))
      .resolves.toMatchObject({ ok: false, error: { code: ErrorCode.SchemaInvalid, field: "profile" } });
    await expect(harness({ sceneHash: null }).service.plan(ref, {
      sceneId: "scene-a",
      atSeconds: [1],
      profile: "timeline-v1",
    })).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.DependencyGraphUnavailable } });
  });

  it("defines one abortable renderer batch for the prepared keys", async () => {
    const renderer: ThumbnailPort = {
      async renderBatch(_ref, keys, signal) {
        expect(signal.aborted).toBe(false);
        return keys.map((key) => ({ key, result: ok(new Uint8Array([1])) }));
      },
    };
    const planned = await harness().service.plan(ref, { sceneId: "scene-a", atSeconds: [1], profile: "timeline-v1" });
    if (!planned.ok) throw new Error(planned.error.message);

    await expect(renderer.renderBatch(ref, planned.value.keys, new AbortController().signal))
      .resolves.toHaveLength(1);
  });
});
