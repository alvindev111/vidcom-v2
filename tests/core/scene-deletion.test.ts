import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type RelPath, type SceneDto } from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  deleteScene,
  digestPlan,
  planSceneDeletion,
  prepareSceneDeletion,
  serializePreviewSettings,
  type AbsolutePath,
  type CompositionModel,
  type CompositeRequest,
  type DeletionInputs,
  type DeletionPlan,
  type ProjectRef,
  type ResolvedPath,
} from "@vidcom/core";

const TEST_ORIGIN = { kind: "system", sessionId: null, label: null, historyAction: "ignore", historyOperation: null } as const;
const hash = (digit: string): ContentHash => `sha256:${digit.repeat(64)}` as ContentHash;

function scene(id: string, options: { src?: string | null; start?: number; duration?: number } = {}): SceneDto {
  return {
    id,
    src: (options.src === undefined ? `compositions/${id}.html` : options.src) as RelPath | null,
    sourceFile: (options.src === null ? "index.html" : options.src ?? `compositions/${id}.html`) as RelPath,
    role: "story",
    start: options.start ?? 0,
    duration: options.duration ?? 4,
    trackIndex: 1,
    block: null,
    isTransition: false,
    media: [],
    script: [],
    narration: null,
    elements: [],
    unresolvedEffects: 0,
  };
}

function inputs(scenes: SceneDto[], overrides: Partial<DeletionInputs> = {}): DeletionInputs {
  const sourcePaths = [...new Set(scenes.flatMap((item) => item.src ? [item.src] : []))];
  const model: CompositionModel = {
    project: {
      id: "project_delete",
      slug: "delete",
      title: "Delete",
      width: 1920,
      height: 1080,
      duration: Math.max(0, ...scenes.map((item) => item.start + item.duration)),
      updatedAt: "2026-08-02T00:00:00.000Z",
      sceneCount: scenes.length,
      revision: 1,
    },
    scenes,
    rootTrack: null,
    diagnostics: [],
    sources: [
      { path: "index.html" as RelPath, contentHash: hash("1"), byteSize: 100 },
      ...sourcePaths.map((path, index) => ({ path: path as RelPath, contentHash: hash(String(index + 2)), byteSize: 50 })),
    ],
    references: [],
  };
  return {
    model,
    sceneId: scenes[0]?.id ?? "missing",
    previewSettings: DEFAULT_PREVIEW_SETTINGS,
    previewSettingsRevision: 1,
    previewSettingsHash: hash("9"),
    narration: null,
    ...overrides,
  };
}

describe("planSceneDeletion", () => {
  it("returns scene_not_found without producing a plan", () => {
    expect(planSceneDeletion(inputs([scene("scene-1")], { sceneId: "missing" }))).toMatchObject({
      ok: false,
      error: { code: ErrorCode.SceneNotFound },
    });
  });

  it("deletes an exclusively referenced sub-composition", () => {
    expect(planSceneDeletion(inputs([scene("scene-1"), scene("scene-2", { start: 4 })]))).toMatchObject({
      ok: true,
      value: {
        removeMount: { file: "index.html", hostId: "scene-1" },
        deleteFile: "compositions/scene-1.html",
        keptFileReason: null,
        rootDuration: 8,
        targetHashes: {
          "index.html": hash("1"),
          "compositions/scene-1.html": hash("2"),
        },
      },
    });
  });

  it("keeps a sub-composition referenced by another mount", () => {
    const shared = "compositions/shared.html";
    expect(planSceneDeletion(inputs([
      scene("scene-1", { src: shared }),
      scene("scene-2", { src: shared, start: 4 }),
    ]))).toMatchObject({
      ok: true,
      value: { deleteFile: null, keptFileReason: "shared-src", rootDuration: 8 },
    });
  });

  it("removes an inline host without deleting a source file", () => {
    expect(planSceneDeletion(inputs([
      scene("scene-1", { src: null }),
      scene("scene-2", { start: 4 }),
    ]))).toMatchObject({
      ok: true,
      value: { deleteFile: null, keptFileReason: "inline", rootDuration: 8 },
    });
  });

  it("shrinks root duration to the latest remaining scene end", () => {
    expect(planSceneDeletion(inputs([
      scene("scene-latest", { start: 10, duration: 5 }),
      scene("scene-a", { start: 1, duration: 3 }),
      scene("scene-b", { start: 6, duration: 2 }),
    ]))).toMatchObject({ ok: true, value: { rootDuration: 8 } });
  });

  it("sets last-scene duration to zero and includes narration/settings cleanup", () => {
    const base = inputs([scene("scene-1")]);
    const planned = planSceneDeletion({
      ...base,
      previewSettings: {
        ...base.previewSettings,
        scenes: { "scene-1": { transitionSound: "minimal", revealSound: "ping", hidden: false } },
      },
      narration: {
        jsonPath: "narration/scene-1.json" as RelPath,
        jsonHash: hash("7"),
        wavPath: "narration/scene-1.wav" as RelPath,
        wavHash: hash("8"),
      },
    });
    expect(planned).toMatchObject({
      ok: true,
      value: {
        rootDuration: 0,
        narrationFiles: ["narration/scene-1.json", "narration/scene-1.wav"],
        previewSettingsPatch: { scenesRemove: ["scene-1"] },
        diagnostics: [{ severity: "warning", code: "composition_empty" }],
      },
    });
  });

  it("digests semantically identical plans through canonical JSON", () => {
    const planned = planSceneDeletion(inputs([scene("scene-1")])) as { ok: true; value: DeletionPlan };
    const reordered: DeletionPlan = {
      ...planned.value,
      targetHashes: Object.fromEntries(Object.entries(planned.value.targetHashes).reverse()) as Record<RelPath, ContentHash>,
    };
    const digest = (content: string | Uint8Array) => hash(String(content).length.toString(16).slice(-1));
    expect(digestPlan(planned.value, digest)).toBe(digestPlan(reordered, digest));
  });
});

describe("prepareSceneDeletion", () => {
  it("collects settings/narration hashes and builds an exact approval binding", async () => {
    const fixture = inputs([scene("scene-1"), scene("scene-2", { start: 4 })]);
    const previewSettings = {
      ...DEFAULT_PREVIEW_SETTINGS,
      scenes: { "scene-1": { transitionSound: "minimal" as const, revealSound: "ping" as const, hidden: false } },
    };
    const ref: ProjectRef = {
      id: fixture.model.project.id as never,
      slug: "delete",
      root: "/workspace/delete" as AbsolutePath,
      entry: "index.html" as RelPath,
    };
    const prepared = await prepareSceneDeletion({
      workspace: {
        async readProjectRef() { return ref; },
        async resolve(_ref, relative) { return { ok: true as const, value: relative as ResolvedPath }; },
        async readFile(target) {
          return target === "preview-settings.json"
            ? { content: serializePreviewSettings(previewSettings), contentHash: hash("9") }
            : null;
        },
        async readHash(target) {
          if (target === "narration/scene-1.json") return hash("7");
          if (target === "narration/scene-1.wav") return hash("8");
          return null;
        },
      },
      composition: { async parseProject() { return fixture.model; } },
      journal: {
        async latestRevision() { return 12; },
        async readEntityState() {
          return { revision: 3, contentHash: hash("9"), backingPath: "preview-settings.json" as RelPath };
        },
      },
      hashContent(content) {
        const length = typeof content === "string" ? content.length : content.byteLength;
        return hash((length % 16).toString(16));
      },
    }, { projectId: ref.id, sceneId: "scene-1", expectedRevision: 12 });

    expect(prepared).toMatchObject({
      ok: true,
      value: {
        plan: {
          narrationFiles: ["narration/scene-1.json", "narration/scene-1.wav"],
          previewSettingsPatch: { scenesRemove: ["scene-1"] },
          targetHashes: {
            "index.html": hash("1"),
            "compositions/scene-1.html": hash("2"),
            "preview-settings.json": hash("9"),
            "narration/scene-1.json": hash("7"),
            "narration/scene-1.wav": hash("8"),
          },
        },
        binding: {
          tool: "delete_scene",
          projectId: ref.id,
          target: "scene-1",
          expectedRevision: 12,
        },
      },
    });
    if (!prepared.ok) throw new Error("plan failed");
    expect(prepared.value.binding.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects a stale project revision before returning a grant binding", async () => {
    const fixture = inputs([scene("scene-1")]);
    const prepared = await prepareSceneDeletion({
      workspace: {
        async readProjectRef() {
          return { id: "project_delete", slug: "delete", root: "/workspace/delete" as AbsolutePath, entry: "index.html" as RelPath } as ProjectRef;
        },
        async resolve() { throw new Error("must not resolve settings after revision conflict"); },
        async readFile() { return null; },
        async readHash() { return null; },
      },
      composition: { async parseProject() { return fixture.model; } },
      journal: {
        async latestRevision() { return 13; },
        async readEntityState() { return null; },
      },
      hashContent: () => hash("a"),
    }, { projectId: "project_delete" as never, sceneId: "scene-1", expectedRevision: 12 });
    expect(prepared).toMatchObject({ ok: false, error: { code: ErrorCode.WriteConflict } });
  });
});

describe("deleteScene", () => {
  it("executes mount/source/narration/settings cleanup in one backed-up grant-bound composite", async () => {
    const fixture = inputs([scene("scene-1")]);
    const previewSettings = {
      ...DEFAULT_PREVIEW_SETTINGS,
      scenes: { "scene-1": { transitionSound: "minimal" as const, revealSound: "ping" as const, hidden: false } },
    };
    const ref: ProjectRef = {
      id: "project_delete" as never,
      slug: "delete",
      root: "/workspace/delete" as AbsolutePath,
      entry: "index.html" as RelPath,
    };
    const requests: CompositeRequest[] = [];
    const operations: unknown[] = [];
    const result = await deleteScene({
      clock: { now: () => new Date("2026-08-02T00:00:00.000Z") },
      workspace: {
        async readProjectRef() { return ref; },
        async resolve(_ref, relative) { return { ok: true as const, value: relative as ResolvedPath }; },
        async readFile(target) {
          return target === "preview-settings.json"
            ? { content: serializePreviewSettings(previewSettings), contentHash: hash("9") }
            : null;
        },
        async readHash(target) {
          if (target === "narration/scene-1.json") return hash("7");
          if (target === "narration/scene-1.wav") return hash("8");
          return null;
        },
      },
      composition: {
        async parseProject() { return fixture.model; },
        async applyOps(_ref, _file, ops) { operations.push(...ops); return { ok: true as const, value: "entry updated" }; },
      },
      journal: {
        async latestRevision() { return 12; },
        async readEntityState() {
          return { revision: 3, contentHash: hash("9"), backingPath: "preview-settings.json" as RelPath };
        },
      },
      hashContent: () => hash("a"),
      authority: {
        async mutateSource(request) {
          requests.push(request);
          return {
            ok: true as const,
            value: {
              projectRevision: 13,
              entityRevision: 4,
              fileHashes: { "index.html": hash("b"), "preview-settings.json": hash("c") },
              diagnostics: request.diagnostics ?? [],
              changeSeq: 13,
              backupId: "backup_scene_1",
            },
          };
        },
      },
    }, {
      projectId: ref.id,
      sceneId: "scene-1",
      expectedRevision: 12,
      grantId: "grant_scene_1",
    }, "agent", { origin: TEST_ORIGIN, toolAudit: null });

    expect(result).toMatchObject({
      ok: true,
      value: {
        project: { duration: 0, sceneCount: 0, revision: 13 },
        envelope: { projectRevision: 13, diagnostics: [{ code: "composition_empty" }] },
        deletedFile: "compositions/scene-1.html",
        backupId: "backup_scene_1",
      },
    });
    expect(operations).toEqual([
      { kind: "removeElement", target: "scene-1" },
      { kind: "setTiming", target: "@root", value: { duration: 0 } },
    ]);
    expect(requests).toMatchObject([{
      backup: true,
      grant: { id: "grant_scene_1", binding: { tool: "delete_scene", expectedRevision: 12 } },
      diagnostics: [{ code: "composition_empty" }],
      steps: [
        { kind: "write", path: "index.html", expectedContentHash: hash("1") },
        { kind: "delete", path: "compositions/scene-1.html", expectedContentHash: hash("2") },
        { kind: "delete", path: "narration/scene-1.json", expectedContentHash: hash("7") },
        { kind: "delete", path: "narration/scene-1.wav", expectedContentHash: hash("8") },
        { kind: "entity", entity: "preview-settings", expectedRevision: 3, undoable: true },
      ],
    }]);
  });
});
