import { describe, expect, it } from "vitest";

import { ErrorCode, MAX_SOURCE_BYTES, type ContentHash, type DomainError, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  err,
  getPreviewSettings,
  getProjectContext,
  getStudioSnapshot,
  listProjectContexts,
  listSceneContexts,
  listProjects,
  mergePreviewSettings,
  ok,
  patchPreviewSettings,
  readAsset,
  readComposition,
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
  type CompositeRequest,
  type ProjectRef,
  type PendingToolAudit,
  ProjectCache,
  type ResolvedPath,
  type WriteEnvelope,
  type WriteInvocation,
} from "@vidcom/core";

const TEST_ORIGIN = { kind: "system", sessionId: null, label: null, historyAction: "ignore", historyOperation: null } as const;
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

function setup(options: {
  missing?: boolean;
  failWrite?: boolean;
  failParse?: boolean;
  tooLarge?: boolean;
  recoveryRequired?: boolean;
  withNarration?: boolean;
  sceneTiming?: { start: number; duration: number; trackIndex: number };
} = {}) {
  const files = new Map<string, string>([
    ["index.html", "<main>old</main>"],
    ["preview-settings.json", `${JSON.stringify(DEFAULT_PREVIEW_SETTINGS)}\n`],
  ]);
  const binaries = new Map<string, Uint8Array>([["assets/poster.png", new Uint8Array([1, 2, 3])]]);
  const narration = {
    sceneId: "scene-1",
    text: "Title",
    voice: "af_heart",
    status: "generated" as const,
    audioPath: "narration/scene-1.wav",
    command: "hyperframes tts",
    revision: 1,
    updatedAt: "2026-07-31T00:00:00.000Z",
    staleSince: null,
    words: [{ text: "Title", startSeconds: 0, endSeconds: 0.6 }],
    wordTimingSource: "engine" as const,
  };
  if (options.withNarration) files.set("narration/scene-1.json", `${JSON.stringify(narration, null, 2)}\n`);
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
      id: "scene-1",
      start: options.sceneTiming?.start ?? 0,
      duration: options.sceneTiming?.duration ?? 4,
      trackIndex: options.sceneTiming?.trackIndex ?? 1,
      src: null, block: null, isTransition: false, media: [],
      script: [{ id: "hf-title", text: "Title", file: "index.html" }],
      narration: options.withNarration ? narration : null, elements: [], unresolvedEffects: 0,
    }],
    rootTrack: null,
    diagnostics: [],
    sources: [{ path: "index.html" as RelPath, contentHash: hash("entry"), byteSize: 5 }],
    references: [],
  };
  const reads: string[] = [];
  const workspace = {
    async resolve(_ref: ProjectRef, path: string, purpose: string) {
      if (path === "../secret.html") return err({ reason: "outside_project" as const });
      if (path === "assets/poster.png" && purpose === "read-source") {
        return err({ reason: "not_allowed_for_purpose" as const });
      }
      return ok(path as ResolvedPath);
    },
    async resolveWorkspace() { throw new Error("unused"); },
    async listProjects() { return options.missing ? [] : [ref]; },
    async readProjectRef() { return options.missing ? null : ref; },
    async readFile(path: ResolvedPath) {
      reads.push(path);
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
    async exists(path: ResolvedPath) { return files.has(path) || binaries.has(path); },
    async deleteAtomic(path: ResolvedPath) { files.delete(path); binaries.delete(path); },
    async captureForMutation() { throw new Error("unused"); },
    async publishCaptured() { throw new Error("unused"); },
    async restoreCaptured() { throw new Error("unused"); },
    async discardCapture() {},
    async readTree() { return [{ path: "index.html" as RelPath, name: "index.html", kind: "file" as const }]; },
    async stat() {
      return options.tooLarge
        ? { size: 2 * 1024 * 1024 + 1, modifiedAt: new Date(0), kind: "file" as const }
        : null;
    },
    async readDirectory() { return []; },
  };
  const appliedOps: CompositionOp[][] = [];
  const composition = {
    async parseProject() {
      if (options.failParse) throw new Error("parse failed");
      return model;
    },
    async buildDocument() { return "document"; },
    async applyOps(_ref: ProjectRef, _file: RelPath, operations: CompositionOp[]) {
      appliedOps.push(operations);
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
    async latestSourceRevision() { return revision; },
    async readRevisionRollbackPayload() {
      return err({ code: ErrorCode.NotFound, message: "unused" });
    },
    async readEntityState() { return entityState; },
    async findProjectRegistration() { return null; }, async registerProject() {},
    async beginBootstrap() { return 1 as JournalId; },
    async readProjectRecoveryStatus() {
      return options.recoveryRequired
        ? { writeStatus: "recovery_required" as const, unresolved: [{ journalId: 9 as JournalId, status: "orphaned" as const }] }
        : { writeStatus: "ready" as const, unresolved: [] };
    },
  };
  const mutations: unknown[] = [];
  const invocations: WriteInvocation[] = [];
  async function mutateSource(
    request: MutationRequest,
    _actor?: string,
    invocation?: WriteInvocation,
  ): Promise<Result<WriteResult, DomainError>>;
  async function mutateSource(
    request: CompositeRequest,
    _actor?: string,
  ): Promise<Result<WriteEnvelope, DomainError>>;
  async function mutateSource(
    request: MutationRequest | CompositeRequest,
    _actor?: string,
    invocation: WriteInvocation = { origin: TEST_ORIGIN, toolAudit: null },
  ): Promise<Result<WriteResult | WriteEnvelope, DomainError>> {
      if ("steps" in request) {
        mutations.push(request);
        if (options.failWrite) return err({ code: ErrorCode.WorkspaceLeaseLost, message: "lost" });
        const fileHashes: Record<RelPath, ContentHash> = {};
        for (const step of request.steps) {
          if (step.kind !== "write") continue;
          if (typeof step.content === "string") files.set(step.path, step.content);
          else if (step.content instanceof Uint8Array) binaries.set(step.path, step.content);
          fileHashes[step.path] = typeof step.content === "object" && !(step.content instanceof Uint8Array)
            ? step.content.contentHash
            : hash(step.content);
        }
        revision += 1;
        return ok({ projectRevision: revision, entityRevision: null, fileHashes, diagnostics: [], changeSeq: revision });
      }
      mutations.push(request);
      invocations.push(invocation);
      if (options.failWrite) return err({ code: ErrorCode.WorkspaceLeaseLost, message: "lost" });
      revision += 1;
      if (request.kind === "entity") {
        const settings = mergePreviewSettings(DEFAULT_PREVIEW_SETTINGS, request.patch);
        const content = `${JSON.stringify(settings, null, 2)}\n`;
        files.set("preview-settings.json", content);
        entityState = { ...entityState, revision: entityState.revision + 1, contentHash: hash(content) };
        return ok({
          path: null,
          contentHash: hash(content),
          revision: entityState.revision,
          diagnostics: [],
          changeSeq: revision,
          previewSettings: settings,
        });
      }
      const content = request.content;
      if (typeof content === "string") files.set(request.path, content);
      else binaries.set(request.path, content);
      return ok({ path: request.path, contentHash: hash(content), revision, diagnostics: [], changeSeq: revision });
  }
  const authority = {
    mutateSource,
    async uploadBgm(request: { name: string; path: RelPath; bytes: Uint8Array }): Promise<Result<WriteResult, DomainError>> {
      mutations.push({ kind: "composite", ...request });
      const settings = mergePreviewSettings(DEFAULT_PREVIEW_SETTINGS, {
        bgm: { enabled: true, track: { name: request.name, path: request.path } },
      });
      return ok({
        path: null,
        contentHash: hash(JSON.stringify(settings)),
        revision: 2,
        diagnostics: [],
        changeSeq: 2,
        previewSettings: settings,
      });
    },
  };
  const deps: ProjectReadDependencies & ProjectWriteDependencies = {
    workspace,
    composition,
    journal,
    authority,
    clock: { now: () => new Date("2026-08-01T00:00:00.000Z") },
  };
  return { deps, files, binaries, mutations, invocations, reads, appliedOps };
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
      value: {
        project: { revision: 2 },
        entryFile: { path: "index.html" },
        revision: 2,
        projectRevision: 2,
        entityRevision: 1,
        fileHashes: { "index.html": hash("entry") },
        recovery: { writeStatus: "ready", unresolved: [] },
      },
    });
  });
  it("builds bounded project and scene contexts without absolute paths", async () => {
    const { deps } = setup();
    const projects = await listProjectContexts(deps, { limit: 20 });
    expect(projects).toMatchObject({
      ok: true,
      value: {
        projects: [{ projectId, projectRevision: 2, recovery: { writeStatus: "ready" } }],
        diagnostics: [],
        nextCursor: null,
      },
    });
    expect(JSON.stringify(projects)).not.toContain("/workspace/project");
    await expect(getProjectContext(deps, projectId)).resolves.toMatchObject({
      ok: true,
      value: {
        scenes: [{ id: "scene-1", elementCount: 0, fileContentHash: hash("entry"), narrationStale: false }],
        projectRevision: 2,
        entityRevision: 1,
      },
    });
    await expect(listSceneContexts(deps, projectId)).resolves.toMatchObject({
      ok: true,
      value: { scenes: [{ id: "scene-1" }], projectRevision: 2 },
    });
  });

  it("paginates deterministically, caps parse concurrency at four, and isolates one malformed project", async () => {
    const { deps } = setup();
    const refs = Array.from({ length: 7 }, (_, index): ProjectRef => ({
      id: `project-${index + 1}` as ProjectId,
      slug: `project-${index + 1}`,
      root: `/workspace/project-${index + 1}` as AbsolutePath,
      entry: "index.html" as RelPath,
    })).reverse();
    deps.workspace.listProjects = async () => refs;
    const parse = deps.composition.parseProject.bind(deps.composition);
    let active = 0;
    let maxActive = 0;
    deps.composition.parseProject = async (projectRef) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      try {
        if (projectRef.id === "project-3") throw new Error("malformed project");
        return await parse(projectRef);
      } finally {
        active -= 1;
      }
    };

    await expect(listProjectContexts(deps, { limit: 6 })).resolves.toMatchObject({
      ok: true,
      value: {
        projects: [
          { projectId: "project-1" },
          { projectId: "project-2" },
          { projectId: "project-4" },
          { projectId: "project-5" },
          { projectId: "project-6" },
        ],
        diagnostics: [{
          severity: "warning",
          code: "project_context_unavailable",
          message: "Project project-3 could not be read.",
        }],
        nextCursor: "project-6",
      },
    });
    expect(maxActive).toBe(4);
    await expect(listProjectContexts(deps, { limit: 6, cursor: "project-6" })).resolves.toMatchObject({
      ok: true,
      value: { projects: [{ projectId: "project-7" }], diagnostics: [], nextCursor: null },
    });
  });

  it("returns missing referenced scene sources as nullable state with one bounded diagnostic per path", async () => {
    const { deps } = setup();
    const parse = deps.composition.parseProject.bind(deps.composition);
    deps.composition.parseProject = async (projectRef) => {
      const model = await parse(projectRef);
      const missing = "compositions/missing.html" as RelPath;
      return {
        ...model,
        scenes: [
          { ...model.scenes[0]!, id: "scene-1", src: missing },
          { ...model.scenes[0]!, id: "scene-2", src: missing },
        ],
      };
    };

    const expected = {
      scenes: [
        { id: "scene-1", src: "compositions/missing.html", fileContentHash: null },
        { id: "scene-2", src: "compositions/missing.html", fileContentHash: null },
      ],
      diagnostics: [{
        severity: "warning",
        code: "referenced_source_missing",
        file: "compositions/missing.html",
        message: "Referenced scene source compositions/missing.html is missing.",
      }],
    };
    await expect(getProjectContext(deps, projectId)).resolves.toMatchObject({ ok: true, value: expected });
    await expect(listSceneContexts(deps, projectId)).resolves.toMatchObject({ ok: true, value: expected });
  });
  it("reads an allowlisted composition with recovery status", async () => {
    await expect(readComposition(setup({ recoveryRequired: true }).deps, projectId, "index.html" as RelPath))
      .resolves.toMatchObject({
        ok: true,
        value: { path: "index.html", recovery: { writeStatus: "recovery_required" } },
      });
  });
  it("never caches a healthy recovery status while composition parsing is cached", async () => {
    const { deps } = setup();
    deps.cache = new ProjectCache();
    let blocked = false;
    deps.journal.readProjectRecoveryStatus = async () => blocked
      ? { writeStatus: "recovery_required", unresolved: [{ journalId: 7 as JournalId, status: "pending" }] }
      : { writeStatus: "ready", unresolved: [] };
    await expect(getProjectContext(deps, projectId)).resolves.toMatchObject({
      ok: true,
      value: { recovery: { writeStatus: "ready" } },
    });
    blocked = true;
    await expect(getProjectContext(deps, projectId)).resolves.toMatchObject({
      ok: true,
      value: { recovery: { writeStatus: "recovery_required", unresolved: [{ journalId: 7 }] } },
    });
  });
  it("rejects outside, forbidden and oversized composition reads before content", async () => {
    await expect(readComposition(setup().deps, projectId, "../secret.html" as RelPath))
      .resolves.toMatchObject({ ok: false, error: { code: ErrorCode.PathOutsideProject } });
    await expect(readComposition(setup().deps, projectId, "assets/poster.png" as RelPath))
      .resolves.toMatchObject({ ok: false, error: { code: ErrorCode.AssetNotAllowed } });
    const oversized = setup({ tooLarge: true });
    await expect(readComposition(oversized.deps, projectId, "index.html" as RelPath))
      .resolves.toMatchObject({ ok: false, error: { code: ErrorCode.TooLarge } });
    expect(oversized.reads).toEqual([]);
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
  it("removes requested scene settings after applying the additive patch", () => {
    const current = mergePreviewSettings(DEFAULT_PREVIEW_SETTINGS, {
      scenes: {
        "scene-1": { transitionSound: "gong", revealSound: "ping", hidden: false },
        "scene-2": { transitionSound: "minimal", revealSound: "pop", hidden: true },
      },
    });
    expect(mergePreviewSettings(current, { scenesRemove: ["scene-1"] }).scenes).toEqual({
      "scene-2": current.scenes["scene-2"],
    });
  });

  it("saves source through the authority", async () => {
    const runtime = setup();
    expect(await saveSourceFile(runtime.deps, {
      projectId, path: "index.html" as RelPath, content: "new", expectedContentHash: hash("<main>old</main>"),
    }, "user")).toMatchObject({
      ok: true,
      value: { file: { path: "index.html", contentHash: hash("new") }, envelope: { projectRevision: 3 } },
    });
    expect(runtime.mutations).toHaveLength(1);
  });
  it("rejects oversized and protected source writes before authority", async () => {
    const runtime = setup();
    await expect(saveSourceFile(runtime.deps, {
      projectId,
      path: "index.html" as RelPath,
      content: "x".repeat(MAX_SOURCE_BYTES + 1),
      expectedContentHash: hash("<main>old</main>"),
    }, "user")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.TooLarge } });
    await expect(saveSourceFile(runtime.deps, {
      projectId,
      path: "hyperframes.json" as RelPath,
      content: "{}",
      expectedContentHash: hash("x"),
    }, "user")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.AssetNotAllowed } });
    expect(runtime.mutations).toHaveLength(0);
  });
  it("patches preview settings through the authority", async () => {
    expect(await patchPreviewSettings(setup().deps, {
      projectId, patch: { bgm: { volume: 0.7 } }, expectedRevision: 1,
    }, "user")).toMatchObject({
      ok: true,
      value: { previewSettings: { bgm: { volume: 0.7 } }, changeSeq: 3 },
    });
  });
  it("uploads BGM before pointing settings at it", async () => {
    const runtime = setup();
    expect(await uploadBgm(runtime.deps, {
      projectId, name: "track one.mp3", bytes: new Uint8Array([9]), expectedRevision: 1,
    }, "user")).toMatchObject({ ok: true, value: { changeSeq: 2 } });
    expect(runtime.mutations).toMatchObject([
      { kind: "composite", path: "preview-assets/bgm/track-one.mp3" },
    ]);
  });
  it("sets scene timing by serializing then writing through authority", async () => {
    const runtime = setup();
    const toolAudit: PendingToolAudit = {
      schemaVersion: 1, invocationId: "invocation-timing", tool: "set_scene_timing", level: "write",
      projectId, era: "modern", protocolVersion: "2026-07-28", detail: {}, credentialId: null,
      invokedAt: "2026-08-01T00:00:00.000Z",
      revisionBefore: 0,
    };
    expect(await setSceneTiming(runtime.deps, {
      projectId, sceneId: "scene-1", timing: { duration: 6 }, expectedContentHash: hash("<main>old</main>"),
    }, "user", { origin: TEST_ORIGIN, toolAudit })).toMatchObject({
      ok: true,
      value: {
        scene: { id: "scene-1", duration: 6 },
        project: { revision: 3 },
        envelope: { projectRevision: 3, fileHashes: { "index.html": hash("serialized:setTiming") } },
      },
    });
    expect(runtime.invocations).toEqual([{ origin: TEST_ORIGIN, toolAudit }]);
  });
  it.each([
    [{ duration: 0 }, ErrorCode.TimingInvalid],
    [{ duration: 9 }, ErrorCode.DurationOverflow],
  ] as const)("rejects invalid scene timing %o before authority", async (timing, code) => {
    const runtime = setup();
    await expect(setSceneTiming(runtime.deps, {
      projectId,
      sceneId: "scene-1",
      timing,
      expectedContentHash: hash("<main>old</main>"),
    }, "user")).resolves.toMatchObject({ ok: false, error: { code } });
    expect(runtime.mutations).toHaveLength(0);
  });
  it("sets scene script by serializing then writing through authority", async () => {
    const runtime = setup({ withNarration: true });
    const toolAudit: PendingToolAudit = {
      schemaVersion: 1, invocationId: "invocation-text", tool: "set_text", level: "write",
      projectId, era: "modern", protocolVersion: "2026-07-28", detail: {}, credentialId: null,
      invokedAt: "2026-08-01T00:00:00.000Z",
      revisionBefore: 0,
    };
    expect(await setSceneScript(runtime.deps, {
      projectId, sceneId: "scene-1", file: "index.html" as RelPath, elementId: "hf-title", text: "new", expectedContentHash: hash("<main>old</main>"),
    }, "user", { origin: TEST_ORIGIN, toolAudit })).toMatchObject({
      ok: true,
      value: {
        scene: { id: "scene-1", narrationStale: true },
        project: { revision: 3 },
        envelope: { projectRevision: 3 },
        narrationStale: true,
      },
    });
    expect(runtime.mutations).toMatchObject([{
      toolAudit,
      steps: [
        { kind: "write", path: "index.html", expectedContentHash: hash("<main>old</main>") },
        { kind: "write", path: "narration/scene-1.json" },
      ],
    }]);
    expect(JSON.parse(runtime.files.get("narration/scene-1.json") ?? "null"))
      .toMatchObject({
        staleSince: "2026-08-01T00:00:00.000Z",
        status: "generated",
        wordTimingSource: "engine",
        words: [{ text: "Title", startSeconds: 0, endSeconds: 0.6 }],
      });
  });
  it("returns narrationStale false and writes no sidecar when narration is absent", async () => {
    const runtime = setup();
    await expect(setSceneScript(runtime.deps, {
      projectId,
      sceneId: "scene-1",
      file: "index.html" as RelPath,
      elementId: "hf-title",
      text: "new",
      expectedContentHash: hash("<main>old</main>"),
    }, "user")).resolves.toMatchObject({
      ok: true,
      value: {
        scene: { narrationStale: false },
        narrationStale: false,
      },
    });
    expect(runtime.mutations).toMatchObject([{
      steps: [{ kind: "write", path: "index.html" }],
    }]);
    expect((runtime.mutations[0] as CompositeRequest).steps).toHaveLength(1);
    expect(runtime.files.has("narration/scene-1.json")).toBe(false);
  });
  it("regenerates the legacy mock narration through authority", async () => {
    expect(await regenerateNarration(setup().deps, { projectId, sceneId: "scene-1", text: "Hello" }, "user")).toMatchObject({
      ok: true,
      value: {
        status: "mock",
        revision: 1,
        updatedAt: "2026-08-01T00:00:00.000Z",
        staleSince: null,
        changeSeq: 3,
      },
    });
  });
  it("creates a scene, entry mount and narration sidecar in one composite", async () => {
    const runtime = setup();
    const toolAudit: PendingToolAudit = {
      schemaVersion: 1,
      invocationId: "invocation-create",
      tool: "create_scene",
      level: "write",
      projectId,
      era: "modern",
      protocolVersion: "2026-07-28",
      detail: {},
      credentialId: null,
      invokedAt: "2026-08-01T00:00:00.000Z",
      revisionBefore: 0,
    };
    expect(await createScene(runtime.deps, {
      projectId,
      title: "Next",
      expectedContentHash: hash("<main>old</main>"),
    }, "user", { origin: TEST_ORIGIN, toolAudit })).toMatchObject({
      ok: true,
      value: {
        scene: { id: "scene-2", start: 4, duration: 4, narrationStale: false },
        project: { sceneCount: 2, revision: 3 },
        envelope: { projectRevision: 3 },
      },
    });
    expect(runtime.mutations).toHaveLength(1);
    expect(runtime.mutations[0]).toMatchObject({
      toolAudit,
      steps: [
        { kind: "write", path: "compositions/scene-2.html", expectedContentHash: null },
        { kind: "write", path: "index.html", expectedContentHash: hash("<main>old</main>") },
        { kind: "write", path: "narration/scene-2.json", expectedContentHash: null },
      ],
    });
    const scene = (runtime.mutations[0] as CompositeRequest).steps[0];
    if (scene?.kind !== "write" || typeof scene.content !== "string") throw new Error("scene write was not captured");
    expect(scene.content).toContain("<template><style>");
    expect(scene.content).toContain("width:1920px;height:1080px");
    expect(scene.content).toContain('data-width="1920" data-height="1080"');
    expect(scene.content).toContain("<h2>Next</h2>");
    expect(runtime.appliedOps[0]).toMatchObject([{
      kind: "addElement",
      value: { html: expect.stringContaining('data-width="1920" data-height="1080"') },
    }]);
  });
  it("rejects an empty scene timing patch before source read, SDK ops or mutation", async () => {
    const runtime = setup();
    await expect(setSceneTiming(runtime.deps, {
      projectId,
      sceneId: "scene-1",
      timing: {},
      expectedContentHash: hash("<main>old</main>"),
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.SchemaInvalid, field: "timing" },
    });
    expect(runtime.reads).toHaveLength(0);
    expect(runtime.appliedOps).toHaveLength(0);
    expect(runtime.mutations).toHaveLength(0);
  });
  it.each([
    ["zero duration", 0, undefined],
    ["negative duration", -1, undefined],
    ["overflowing end", Number.MAX_VALUE, {
      start: Number.MAX_VALUE / 2,
      duration: Number.MAX_VALUE / 2,
      trackIndex: 1,
    }],
  ] as const)("rejects create_scene with %s before SDK ops or T1", async (_case, duration, sceneTiming) => {
    const runtime = setup({ ...(sceneTiming ? { sceneTiming } : {}) });
    await expect(createScene(runtime.deps, {
      projectId,
      title: "Invalid",
      duration,
      expectedContentHash: hash("<main>old</main>"),
    }, "user")).resolves.toMatchObject({ ok: false, error: { code: expect.stringMatching(/timing_invalid|duration_overflow/) } });
    expect(runtime.appliedOps).toHaveLength(0);
    expect(runtime.mutations).toHaveLength(0);
    expect(runtime.files.has("compositions/scene-2.html")).toBe(false);
    expect(runtime.files.has("narration/scene-2.json")).toBe(false);
  });
  const missingWrites: Array<[string, (deps: ProjectWriteDependencies) => Promise<unknown>]> = [
    ["save", (deps) => saveSourceFile(deps, { projectId, path: "index.html" as RelPath, content: "x", expectedContentHash: null }, "user")],
    ["patch", (deps) => patchPreviewSettings(deps, { projectId, patch: { bgm: { volume: 0.5 } }, expectedRevision: 1 }, "user")],
    ["upload", (deps) => uploadBgm(deps, { projectId, name: "x.mp3", bytes: new Uint8Array(), expectedRevision: 1 }, "user")],
    ["timing", (deps) => setSceneTiming(deps, { projectId, sceneId: "s", timing: {}, expectedContentHash: hash("x") }, "user")],
    ["script", (deps) => setSceneScript(deps, { projectId, sceneId: "s", file: "index.html" as RelPath, elementId: "x", text: "x", expectedContentHash: hash("x") }, "user")],
    ["tts", (deps) => regenerateNarration(deps, { projectId, sceneId: "s", text: "x" }, "user")],
    ["generate", (deps) => createScene(deps, { projectId, title: "x", expectedContentHash: hash("x") }, "user")],
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
