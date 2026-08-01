import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type DomainError, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  err,
  getPreviewSettings,
  getStudioSnapshot,
  listProjects,
  mergePreviewSettings,
  ok,
  patchPreviewSettings,
  readAsset,
  readSourceFile,
  regenerateNarration,
  saveSourceFile,
  setSceneScript,
  setSceneTiming,
  uploadBgm,
  createScene,
  type AbsolutePath,
  type CompositionModel,
  type EntityState,
  type JournalId,
  type MutationRequest,
  type WriteResult,
  type Result,
  type ProjectReadDependencies,
  type ProjectWriteDependencies,
  type CompositionOp,
  type ProjectRef,
  type ResolvedPath,
} from "@vidcom/core";

const projectId = "project-usecase" as ProjectId;
const ref: ProjectRef = {
  id: projectId,
  slug: "project",
  root: "/workspace/project" as AbsolutePath,
  entry: "index.html" as RelPath,
};
const hash = (value: string | Uint8Array): ContentHash => {
  const text = typeof value === "string" ? value : [...value].join("-");
  return `sha256:${text.length.toString(16).padStart(64, "0")}` as ContentHash;
};

function setup(options: { missing?: boolean; failWrite?: boolean; failParse?: boolean } = {}) {
  const files = new Map<string, string>([
    ["index.html", "<main>old</main>"],
    ["preview-settings.json", `${JSON.stringify(DEFAULT_PREVIEW_SETTINGS)}\n`],
  ]);
  const binaries = new Map<string, Uint8Array>([["assets/poster.png", new Uint8Array([1, 2, 3])]]);
  let revision = 2;
  let entityState: EntityState = {
    revision: 1,
    contentHash: hash(files.get("preview-settings.json")!),
    backingPath: "preview-settings.json" as RelPath,
  };
  const model: CompositionModel = {
    project: {
      id: projectId,
      slug: "project",
      title: "Project",
      width: 1920,
      height: 1080,
      duration: 8,
      updatedAt: "2026-08-01T00:00:00.000Z",
      sceneCount: 1,
      revision: 0,
    },
    scenes: [{
      id: "scene-1", start: 0, duration: 4, trackIndex: 1,
      script: [{ id: "hf-title", file: "index.html" }],
    }],
    rootTrack: null,
    diagnostics: [],
  };
  const workspace = {
    async resolve(_ref: ProjectRef, path: string) { return ok(path as ResolvedPath); },
    async listProjects() { return options.missing ? [] : [ref]; },
    async readProjectRef() { return options.missing ? null : ref; },
    async readFile(path: ResolvedPath) {
      const content = files.get(path);
      return content === undefined ? null : { content, contentHash: hash(content) };
    },
    async readBytes(path: ResolvedPath) {
      const bytes = binaries.get(path);
      return bytes ? { bytes, contentHash: hash(bytes) } : null;
    },
    async readHash(path: ResolvedPath) {
      const content = files.get(path);
      const bytes = binaries.get(path);
      return content === undefined ? (bytes ? hash(bytes) : null) : hash(content);
    },
    async writeAtomic() {},
    async readTree() { return [{ path: "index.html" as RelPath, name: "index.html", kind: "file" as const }]; },
    async stat() { return null; },
  };
  const composition = {
    async parseProject() {
      if (options.failParse) throw new Error("parse failed");
      return model;
    },
    async buildDocument() { return "document"; },
    async applyOps(_ref: ProjectRef, _file: RelPath, operations: CompositionOp[]) {
      return options.failParse
        ? err({ code: ErrorCode.SdkRejected, message: "rejected" } as DomainError)
        : ok(`serialized:${operations[0]?.kind}`);
    },
  };
  const journal = {
    async begin() { return 1 as JournalId; },
    async commit() { return ++revision; },
    async abort() {}, async recover() { return ++revision; }, async orphan() {}, async listPending() { return []; },
    async latestRevision() { return revision; },
    async readEntityState() { return entityState; },
    async findProjectRegistration() { return null; }, async registerProject() {},
    async beginBootstrap() { return 1 as JournalId; },
  };
  const mutations: unknown[] = [];
  const authority = {
    async mutate(request: MutationRequest): Promise<Result<WriteResult, DomainError>> {
      mutations.push(request);
      if (options.failWrite) return err({ code: ErrorCode.WorkspaceLeaseLost, message: "lost" });
      revision += 1;
      if (request.kind === "entity") {
        const settings = mergePreviewSettings(DEFAULT_PREVIEW_SETTINGS, request.patch);
        const content = `${JSON.stringify(settings, null, 2)}\n`;
        files.set("preview-settings.json", content);
        entityState = { ...entityState, revision: entityState.revision + 1, contentHash: hash(content) };
        return ok({ path: null, contentHash: hash(content), revision: entityState.revision, diagnostics: [], previewSettings: settings });
      }
      const content = request.content;
      if (typeof content === "string") files.set(request.path, content);
      else binaries.set(request.path, content);
      return ok({ path: request.path, contentHash: hash(content), revision, diagnostics: [] });
    },
    async uploadBgm(request: { name: string; path: RelPath; bytes: Uint8Array }): Promise<Result<WriteResult, DomainError>> {
      mutations.push({ kind: "composite", ...request });
      const settings = mergePreviewSettings(DEFAULT_PREVIEW_SETTINGS, {
        bgm: { enabled: true, track: { name: request.name, path: request.path } },
      });
      return ok({ path: null, contentHash: hash(JSON.stringify(settings)), revision: 2, diagnostics: [], previewSettings: settings });
    },
  };
  const deps: ProjectReadDependencies & ProjectWriteDependencies = {
    workspace,
    composition,
    journal,
    authority,
    clock: { now: () => new Date("2026-08-01T00:00:00.000Z") },
  };
  return { deps, files, binaries, mutations };
}

describe("project read use cases without HTTP", () => {
  it("lists projects and overlays persisted revision", async () => {
    expect(await listProjects(setup().deps)).toMatchObject({ ok: true, value: [{ revision: 2 }] });
  });
  it("returns list failure without throwing", async () => {
    expect(await listProjects(setup({ failParse: true }).deps)).toMatchObject({
      ok: false, error: { code: ErrorCode.StorageUnavailable },
    });
  });
  it("builds one complete studio snapshot", async () => {
    expect(await getStudioSnapshot(setup().deps, projectId)).toMatchObject({
      ok: true,
      value: { project: { revision: 2 }, entryFile: { path: "index.html" }, revision: 2 },
    });
  });
  it("reads source content and hash", async () => {
    expect(await readSourceFile(setup().deps, projectId, "index.html" as RelPath)).toMatchObject({
      ok: true, value: { content: "<main>old</main>" },
    });
  });
  it("reads asset bytes without UTF-8 coercion", async () => {
    expect(await readAsset(setup().deps, projectId, "assets/poster.png" as RelPath)).toMatchObject({
      ok: true, value: { bytes: new Uint8Array([1, 2, 3]) },
    });
  });
  it("normalizes preview settings with entity revision", async () => {
    expect(await getPreviewSettings(setup().deps, projectId)).toMatchObject({
      ok: true, value: { revision: 1, previewSettings: DEFAULT_PREVIEW_SETTINGS },
    });
  });
  const missingReads: Array<[string, (deps: ProjectReadDependencies) => Promise<unknown>]> = [
    ["snapshot", (deps) => getStudioSnapshot(deps, projectId)],
    ["source", (deps) => readSourceFile(deps, projectId, "index.html" as RelPath)],
    ["asset", (deps) => readAsset(deps, projectId, "assets/poster.png" as RelPath)],
    ["settings", (deps) => getPreviewSettings(deps, projectId)],
  ];
  it.each(missingReads)("returns project_not_found for %s", async (_name, invoke) => {
    expect(await invoke(setup({ missing: true }).deps)).toMatchObject({
      ok: false, error: { code: ErrorCode.ProjectNotFound },
    });
  });
});

describe("project write and legacy use cases without HTTP", () => {
  it("saves source through the authority", async () => {
    const runtime = setup();
    expect(await saveSourceFile(runtime.deps, {
      projectId, path: "index.html" as RelPath, content: "new", expectedContentHash: hash("<main>old</main>"),
    }, "user")).toMatchObject({ ok: true, value: { file: { content: "new" }, diagnostics: [] } });
    expect(runtime.mutations).toHaveLength(1);
  });
  it("patches preview settings through the authority", async () => {
    expect(await patchPreviewSettings(setup().deps, {
      projectId, patch: { bgm: { volume: 0.7 } }, expectedRevision: 1,
    }, "user")).toMatchObject({ ok: true, value: { previewSettings: { bgm: { volume: 0.7 } } } });
  });
  it("uploads BGM before pointing settings at it", async () => {
    const runtime = setup();
    expect(await uploadBgm(runtime.deps, {
      projectId, name: "track one.mp3", bytes: new Uint8Array([9]), expectedRevision: 1,
    }, "user")).toMatchObject({ ok: true });
    expect(runtime.mutations).toMatchObject([
      { kind: "composite", path: "preview-assets/bgm/track-one.mp3" },
    ]);
  });
  it("sets scene timing by serializing then writing through authority", async () => {
    expect(await setSceneTiming(setup().deps, {
      projectId, sceneId: "scene-1", timing: { duration: 6 }, expectedContentHash: hash("<main>old</main>"),
    }, "user")).toMatchObject({ ok: true, value: { file: { content: "serialized:setTiming" } } });
  });
  it("sets scene script by serializing then writing through authority", async () => {
    expect(await setSceneScript(setup().deps, {
      projectId, sceneId: "scene-1", file: "index.html" as RelPath, elementId: "hf-title", text: "new", expectedContentHash: hash("<main>old</main>"),
    }, "user")).toMatchObject({ ok: true, value: { file: { content: "serialized:setText" } } });
  });
  it("regenerates the legacy mock narration through authority", async () => {
    expect(await regenerateNarration(setup().deps, { projectId, sceneId: "scene-1", text: "Hello" }, "user")).toMatchObject({
      ok: true, value: { status: "mock", revision: 1, updatedAt: "2026-08-01T00:00:00.000Z" },
    });
  });
  it("creates the legacy scene with both files written through authority", async () => {
    const runtime = setup();
    expect(await createScene(runtime.deps, { projectId, title: "Next" }, "user")).toMatchObject({
      ok: true, value: { sceneId: "scene-2", start: 4, duration: 4 },
    });
    expect(runtime.mutations).toHaveLength(3);
  });
  const missingWrites: Array<[string, (deps: ProjectWriteDependencies) => Promise<unknown>]> = [
    ["save", (deps) => saveSourceFile(deps, { projectId, path: "index.html" as RelPath, content: "x", expectedContentHash: null }, "user")],
    ["patch", (deps) => patchPreviewSettings(deps, { projectId, patch: { bgm: { volume: 0.5 } }, expectedRevision: 1 }, "user")],
    ["upload", (deps) => uploadBgm(deps, { projectId, name: "x.mp3", bytes: new Uint8Array(), expectedRevision: 1 }, "user")],
    ["timing", (deps) => setSceneTiming(deps, { projectId, sceneId: "s", timing: {}, expectedContentHash: hash("x") }, "user")],
    ["script", (deps) => setSceneScript(deps, { projectId, sceneId: "s", file: "index.html" as RelPath, elementId: "x", text: "x", expectedContentHash: hash("x") }, "user")],
    ["tts", (deps) => regenerateNarration(deps, { projectId, sceneId: "s", text: "x" }, "user")],
    ["generate", (deps) => createScene(deps, { projectId, title: "x" }, "user")],
  ];
  it.each(missingWrites)("returns project_not_found for %s failure", async (_name, invoke) => {
    expect(await invoke(setup({ missing: true }).deps)).toMatchObject({
      ok: false, error: { code: ErrorCode.ProjectNotFound },
    });
  });
  it("propagates write authority failure without touching transport concerns", async () => {
    expect(await saveSourceFile(setup({ failWrite: true }).deps, {
      projectId, path: "index.html" as RelPath, content: "x", expectedContentHash: hash("<main>old</main>"),
    }, "user")).toMatchObject({ ok: false, error: { code: ErrorCode.WorkspaceLeaseLost } });
  });
});
