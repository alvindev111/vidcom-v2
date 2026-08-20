import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  compactTrack,
  deleteScenes,
  moveScenes,
  prepareDeleteScenes,
  reorderScenes,
  serializePreviewSettings,
  type AbsolutePath,
  type CompositionModel,
  type CompositeRequest,
  type ProjectRef,
  type ResolvedPath,
} from "@vidcom/core";

const projectId = "project_order" as ProjectId;
const ref: ProjectRef = {
  id: projectId,
  slug: "order",
  root: "/workspace/order" as AbsolutePath,
  entry: "index.html" as RelPath,
};
const origin = {
  kind: "system",
  sessionId: null,
  label: null,
  historyAction: "record",
  historyOperation: null,
} as const;
const hash = (digit: string): ContentHash => `sha256:${digit.repeat(64)}` as ContentHash;

function model(): CompositionModel {
  return {
    frameRate: 30,
    project: {
      id: projectId,
      slug: "order",
      title: "Order",
      width: 1920,
      height: 1080,
      duration: 20,
      updatedAt: "2026-08-18T00:00:00.000Z",
      sceneCount: 3,
      revision: 7,
    },
    scenes: [
      { id: "a", src: "compositions/shared.html" as RelPath, start: 2, duration: 3, trackIndex: 1, block: null, isTransition: false, media: [], script: [], narration: null, elements: [], unresolvedEffects: 0 },
      { id: "b", src: "compositions/shared.html" as RelPath, start: 7, duration: 2, trackIndex: 1, block: null, isTransition: false, media: [], script: [], narration: null, elements: [], unresolvedEffects: 0 },
      { id: "c", src: "compositions/c.html" as RelPath, start: 12, duration: 4, trackIndex: 2, block: null, isTransition: false, media: [], script: [], narration: null, elements: [], unresolvedEffects: 0 },
    ],
    rootTrack: null,
    diagnostics: [],
    sources: [
      { path: "index.html" as RelPath, contentHash: hash("1"), byteSize: 10 },
      { path: "compositions/shared.html" as RelPath, contentHash: hash("2"), byteSize: 10 },
      { path: "compositions/c.html" as RelPath, contentHash: hash("3"), byteSize: 10 },
    ],
    references: [],
  };
}

function timingHarness(compositionModel = model()) {
  const requests: CompositeRequest[] = [];
  const operations: unknown[][] = [];
  const deps = {
    workspace: {
      async readProjectRef() { return ref; },
      async resolve(_ref: ProjectRef, path: RelPath) { return { ok: true as const, value: path as unknown as ResolvedPath }; },
      async readFile(path: ResolvedPath) { return path === "index.html" ? { content: "entry", contentHash: hash("1") } : null; },
    },
    composition: {
      async parseProject() { return compositionModel; },
      async applyOps(_ref: ProjectRef, _path: RelPath, ops: unknown[]) {
        operations.push(ops);
        return { ok: true as const, value: "updated entry" };
      },
    },
    authority: {
      async mutateSource(request: CompositeRequest) {
        requests.push(request);
        return {
          ok: true as const,
          value: {
            projectRevision: 8,
            entityRevision: null,
            fileHashes: { "index.html": hash("8") },
            diagnostics: request.diagnostics ?? [],
            changeSeq: 8,
          },
        };
      },
    },
    journal: {},
    clock: { now: () => new Date("2026-08-18T00:00:00.000Z") },
  };
  return { deps: deps as never, requests, operations };
}

describe("scene order use cases", () => {
  it("performs no composition apply or source write for an unchanged reorder", async () => {
    const runtime = timingHarness();
    const result = await reorderScenes(runtime.deps, {
      projectId,
      sceneId: "a",
      toIndex: 0,
      expectedContentHash: hash("1"),
    }, "user", { origin, toolAudit: null });

    expect(result).toMatchObject({ ok: true, value: { changed: false, envelope: null } });
    expect(runtime.operations).toHaveLength(0);
    expect(runtime.requests).toHaveLength(0);
  });

  it("writes reorder, compact and group shift through one composite each", async () => {
    const reorder = timingHarness();
    expect(await reorderScenes(reorder.deps, {
      projectId, sceneId: "b", toIndex: 0, expectedContentHash: hash("1"),
    }, "user", { origin, toolAudit: null })).toMatchObject({ ok: true, value: { changed: true } });
    expect(reorder.requests).toHaveLength(1);
    expect(reorder.requests[0]).toMatchObject({ backup: false, steps: [{ kind: "write", path: "index.html" }] });

    const compact = timingHarness();
    expect(await compactTrack(compact.deps, {
      projectId, trackIndex: 1, expectedContentHash: hash("1"),
    }, "user", { origin, toolAudit: null })).toMatchObject({ ok: true, value: { changed: true } });
    expect(compact.requests).toHaveLength(1);

    const move = timingHarness();
    expect(await moveScenes(move.deps, {
      projectId, sceneIds: ["a", "c"], deltaSeconds: 1, expectedContentHash: hash("1"),
    }, "user", { origin, toolAudit: null })).toMatchObject({ ok: true, value: { changed: true } });
    expect(move.requests).toHaveLength(1);
    expect(move.operations[0]).toEqual(expect.arrayContaining([
      { kind: "setTiming", target: "a", value: { start: 3 } },
      { kind: "setTiming", target: "c", value: { start: 13 } },
    ]));
  });

  it("rejects an invalid group shift atomically", async () => {
    const runtime = timingHarness();
    await expect(moveScenes(runtime.deps, {
      projectId, sceneIds: ["a", "a"], deltaSeconds: 1, expectedContentHash: hash("1"),
    }, "user")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.DuplicateMutationTarget } });
    expect(runtime.operations).toHaveLength(0);
    expect(runtime.requests).toHaveLength(0);
  });

  it("rejects sub-frame group and reorder-derived writes before apply or authority", async () => {
    const shifted = timingHarness();
    await expect(moveScenes(shifted.deps, {
      projectId, sceneIds: ["a", "c"], deltaSeconds: 0.05, expectedContentHash: hash("1"),
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: {
        code: ErrorCode.TimingNotFrameAligned,
        field: "deltaSeconds",
        details: { value: 0.05, fps: 30 },
      },
    });
    expect(shifted.operations).toHaveLength(0);
    expect(shifted.requests).toHaveLength(0);

    const legacy = model();
    legacy.scenes[1] = { ...legacy.scenes[1]!, duration: 2.55 };
    const reordered = timingHarness(legacy);
    await expect(reorderScenes(reordered.deps, {
      projectId, sceneId: "b", toIndex: 0, expectedContentHash: hash("1"),
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.TimingNotFrameAligned, field: "start", details: { fps: 30 } },
    });
    expect(reordered.operations).toHaveLength(0);
    expect(reordered.requests).toHaveLength(0);
  });

  it("returns overlap diagnostics without blocking the composite", async () => {
    const overlapping = model();
    overlapping.scenes[0] = { ...overlapping.scenes[0]!, start: 3, duration: 5 };
    const runtime = timingHarness(overlapping);
    const result = await moveScenes(runtime.deps, {
      projectId, sceneIds: ["a"], deltaSeconds: 1, expectedContentHash: hash("1"),
    }, "user");

    expect(result).toMatchObject({
      ok: true,
      value: { envelope: { diagnostics: [{ code: "track-overlap" }] } },
    });
    expect(runtime.requests).toHaveLength(1);
  });

  it("classifies root and runtime overflow before apply or write", async () => {
    const rootRuntime = model();
    rootRuntime.scenes[2] = { ...rootRuntime.scenes[2]!, start: 19, duration: 1 };
    const root = timingHarness(rootRuntime);
    await expect(moveScenes(root.deps, {
      projectId, sceneIds: ["c"], deltaSeconds: 1, expectedContentHash: hash("1"),
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.DurationOverflow, details: { limitKind: "root", extendRootAllowed: true } },
    });
    expect(root.operations).toHaveLength(0);
    expect(root.requests).toHaveLength(0);

    rootRuntime.scenes[2] = { ...rootRuntime.scenes[2]!, start: 3_599, duration: 1 };
    const runtime = timingHarness(rootRuntime);
    await expect(moveScenes(runtime.deps, {
      projectId, sceneIds: ["c"], deltaSeconds: 1, extendRoot: true, expectedContentHash: hash("1"),
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.DurationOverflow, details: { limitKind: "runtime", extendRootAllowed: false } },
    });
    expect(runtime.operations).toHaveLength(0);
    expect(runtime.requests).toHaveLength(0);
  });
});

function deletionHarness() {
  const requests: CompositeRequest[] = [];
  const operations: unknown[][] = [];
  let projectReads = 0;
  const settings = {
    ...DEFAULT_PREVIEW_SETTINGS,
    scenes: {
      a: { transitionSound: "minimal" as const, revealSound: "ping" as const, hidden: false },
      c: { transitionSound: "gong" as const, revealSound: "pop" as const, hidden: false },
    },
  };
  const deps = {
    clock: { now: () => new Date("2026-08-18T00:00:00.000Z") },
    workspace: {
      async readProjectRef() { projectReads += 1; return ref; },
      async resolve(_ref: ProjectRef, path: RelPath) { return { ok: true as const, value: path as unknown as ResolvedPath }; },
      async readFile(path: ResolvedPath) {
        return path === "preview-settings.json"
          ? { content: serializePreviewSettings(settings), contentHash: hash("9") }
          : null;
      },
      async readHash(path: ResolvedPath) {
        const hashes: Record<string, ContentHash> = {
          "narration/a.json": hash("4"),
          "narration/a.wav": hash("5"),
          "narration/c.json": hash("6"),
          "narration/c.wav": hash("7"),
        };
        return hashes[path] ?? null;
      },
    },
    composition: {
      async parseProject() { return model(); },
      async applyOps(_ref: ProjectRef, _path: RelPath, ops: unknown[]) {
        operations.push(ops);
        return { ok: true as const, value: "entry after group delete" };
      },
    },
    journal: {
      async latestRevision() { return 7; },
      async readEntityState() {
        return { revision: 2, contentHash: hash("9"), backingPath: "preview-settings.json" as RelPath };
      },
    },
    hashContent() { return hash("a"); },
    authority: {
      async mutateSource(request: CompositeRequest) {
        requests.push(request);
        return {
          ok: true as const,
          value: {
            projectRevision: 8,
            entityRevision: 3,
            fileHashes: { "index.html": hash("8") },
            diagnostics: request.diagnostics ?? [],
            changeSeq: 8,
            backupId: "backup_group",
          },
        };
      },
    },
  };
  return { deps: deps as never, requests, operations, projectReads: () => projectReads };
}

describe("bulk scene deletion", () => {
  it.each([
    [[], ErrorCode.SchemaInvalid],
    [["a", "a"], ErrorCode.DuplicateMutationTarget],
  ] as const)("rejects invalid targets %o before planning or writing", async (sceneIds, code) => {
    const runtime = deletionHarness();
    await expect(prepareDeleteScenes(runtime.deps, {
      projectId, sceneIds: [...sceneIds], expectedRevision: 7,
    })).resolves.toMatchObject({ ok: false, error: { code } });
    expect(runtime.projectReads()).toBe(0);
    expect(runtime.operations).toHaveLength(0);
    expect(runtime.requests).toHaveLength(0);
  });

  it("replans and deletes a group in one exact-intent backed-up composite", async () => {
    const runtime = deletionHarness();
    const result = await deleteScenes(runtime.deps, {
      projectId, sceneIds: ["c", "a"], expectedRevision: 7, grantId: "grant_group",
    }, "agent", { origin, toolAudit: null });

    expect(result).toMatchObject({
      ok: true,
      value: { project: { sceneCount: 1, duration: 9 }, backupId: "backup_group" },
    });
    expect(runtime.operations).toEqual([[
      { kind: "removeElement", target: "a" },
      { kind: "removeElement", target: "c" },
      { kind: "setTiming", target: "@root", value: { duration: 9 } },
    ]]);
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]).toMatchObject({
      backup: true,
      grant: {
        id: "grant_group",
        binding: { tool: "delete_scenes", target: '["a","c"]', expectedRevision: 7 },
      },
      steps: [
        { kind: "write", path: "index.html", expectedContentHash: hash("1") },
        { kind: "delete", path: "compositions/c.html", expectedContentHash: hash("3") },
        { kind: "delete", path: "narration/a.json", expectedContentHash: hash("4") },
        { kind: "delete", path: "narration/a.wav", expectedContentHash: hash("5") },
        { kind: "delete", path: "narration/c.json", expectedContentHash: hash("6") },
        { kind: "delete", path: "narration/c.wav", expectedContentHash: hash("7") },
        { kind: "entity", entity: "preview-settings", expectedRevision: 2, undoable: true },
      ],
    });
  });
});
