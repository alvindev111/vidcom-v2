import { describe, expect, it } from "vitest";

import { StartRenderInputSchema, type Actor, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  ok,
  ToolAuditService,
  type AbsolutePath,
  type CompositionModel,
  type ProjectRef,
  type MutationRequest,
  type ResolvedPath,
  type ToolAuditEntry,
  type WriteInvocation,
} from "@vidcom/core";
import {
  registerVidcomTools,
  getJobStatusTool,
  saveFileTool,
  startRenderTool,
  startSnapshotTool,
  setSceneTimingTool,
  ToolRegistry,
  type DeliveryLoopToolDependencies,
  type VidcomToolDependencies,
  type JobToolDependencies,
  type WriteToolDependencies,
} from "@vidcom/mcp";

const projectId = "project-tools" as ProjectId;
const ref: ProjectRef = {
  id: projectId,
  slug: "project-tools",
  root: "/workspace/project-tools" as AbsolutePath,
  entry: "index.html" as RelPath,
};
const digest = (digit: string) => `sha256:${digit.repeat(64)}` as ContentHash;
const request = {
  era: "modern" as const,
  protocolVersion: "2025-06-18",
  credentialId: "credential-1",
  requestInput: async (): Promise<never> => { throw new Error("input not expected"); },
};

function audit(records: ToolAuditEntry[], owned: boolean): ToolAuditService {
  return new ToolAuditService(
    { record: async (entry) => { records.push(entry); } },
    { now: () => new Date("2026-08-02T00:00:00.000Z") },
    { warn: () => undefined, error: () => undefined },
    { increment: () => undefined, observeMilliseconds: () => undefined },
    { isJournalOwned: async () => owned },
  );
}

function registry(records: ToolAuditEntry[], owned = false): ToolRegistry {
  let invocation = 0;
  return new ToolRegistry({
    audit: audit(records, owned),
    approvals: { request: async () => "request-1" },
  }, {
    newInvocationId: () => `invocation-${++invocation}`,
    now: () => new Date("2026-08-02T00:00:00.000Z"),
  });
}

describe("all registered tool handlers", () => {
  it("runs a guarded case for every registered tool and keeps the case table in sync", async () => {
    const records: ToolAuditEntry[] = [];
    const tools = registry(records);
    const dependencies = {
      workspace: {
        listProjects: async () => [],
        readProjectRef: async () => null,
      },
      composition: {},
      journal: {},
      authority: {},
      clock: { now: () => new Date("2026-08-02T00:00:00.000Z") },
      hashContent: () => digest("f"),
      approvals: { request: async () => "request-1" },
      tts: { listProviders: async () => [] },
      jobs: { enqueue: async () => ({ conflict: "idempotency_key_reused" }), get: async () => null },
      ids: { newId: (prefix: string) => `${prefix}-1` },
      workspaceRoot: "/workspace" as AbsolutePath,
      diagnostics: {
        forProject: async () => ({
          ok: false as const,
          error: { code: "project_not_found", message: "project was not found" },
        }),
      },
      agentKit: {
        apply: async () => ({
          ok: false as const,
          error: { code: "project_not_found", message: "workspace fixture is unavailable" },
        }),
      },
      enqueueRender: async () => ({
        ok: false as const,
        error: { code: "project_not_found", message: "project was not found" },
      }),
      enqueueSnapshot: async () => ({
        ok: false as const,
        error: { code: "project_not_found", message: "project was not found" },
      }),
      mimeFromPath: () => "video/mp4",
      bgmSynth: { render: () => new Uint8Array([82, 73, 70, 70]) },
      bgmLibrary: {
        list: async () => [],
        hasShipped: async () => false,
        readShipped: async () => null,
        shippedLicenses: async () => ({}),
        recordShippedLicense: async () => undefined,
        read: async () => null,
        add: async () => ({
          ok: false as const,
          error: { code: "project_not_found", message: "workspace fixture is unavailable" },
        }),
      },
      lifecycle: {
        create: async () => ({
          ok: false as const,
          error: { code: "project_not_found", message: "workspace fixture is unavailable" },
        }),
        adopt: async () => ({
          ok: false as const,
          error: { code: "project_not_found", message: "workspace fixture is unavailable" },
        }),
        rename: async () => ({
          ok: false as const,
          error: { code: "project_not_found", message: "project was not found" },
        }),
        planRemove: async () => ({
          ok: false as const,
          error: { code: "project_not_found", message: "project was not found" },
        }),
        remove: async () => ({
          ok: false as const,
          error: { code: "project_not_found", message: "project was not found" },
        }),
      },
      // The editing tools take their own capability objects; the guarded harness
      // gives them the same absent project every other tool sees.
      mount: {
        workspace: { readProjectRef: async () => null },
        composition: {},
        probe: {},
        pendingMount: { lookup: async () => ({ state: "never-seen" as const }) },
        authority: {},
        clock: { now: () => new Date(0) },
      },
      catalog: { list: async () => ({ items: [], source: "bundled" as const, stale: false }) },
    } as unknown as VidcomToolDependencies;
    dependencies.reads = dependencies;
    registerVidcomTools(tools, dependencies);

    const cases: Record<string, unknown> = {
      list_projects: {},
      get_project_context: { projectId },
      list_scenes: { projectId },
      read_composition: { projectId, path: "index.html" },
      create_scene: { projectId, title: "Scene", expectedContentHash: digest("1") },
      set_scene_timing: { projectId, sceneId: "scene-1", duration: 4, expectedContentHash: digest("1") },
      set_text: {
        projectId, sceneId: "scene-1", file: "index.html", elementId: "title",
        text: "Hello", expectedContentHash: digest("1"),
      },
      save_file: { projectId, path: "compositions/scene-1.html", content: "<main />", expectedContentHash: digest("1") },
      delete_file: { projectId, path: "compositions/unused.html", expectedContentHash: digest("1") },
      delete_scene: { projectId, sceneId: "scene-1", expectedRevision: 0 },
      reorder_scenes: { projectId, sceneId: "scene-1", toIndex: 0, expectedContentHash: digest("1") },
      move_scenes: { projectId, sceneIds: ["scene-1"], deltaSeconds: 0, expectedContentHash: digest("1") },
      delete_scenes: { projectId, sceneIds: ["scene-1"], expectedRevision: 0 },
      list_catalog_items: {},
      generate_captions: { projectId, sceneId: "scene-1", expectedContentHash: digest("1") },
      mount_asset: {
        projectId, assetPath: "assets/clip.mp4", assetContentHash: digest("1"),
        atSeconds: 0, trackIndex: 0, expectedContentHash: digest("1"), onOverflow: "extend-root",
      },
      list_tts_voices: { projectId },
      start_tts: { projectId, sceneIds: ["scene-1"], providerId: "nobody", voiceId: "nobody" },
      get_job_status: { jobId: "job-1" },
      validate_project: { projectId },
      start_snapshot: { projectId },
      start_render: { projectId, expectedSourceRevision: 0 },
      install_agent_kit: { operation: "install", hosts: ["codex"] },
      install_motion_library: { projectId, libraryId: "gsap" },
      create_project: { name: "Project Tools Two", presetId: "vertical-shorts" },
      adopt_project: { slug: "candidate" },
      rename_project: { projectId, name: "Project Tools Renamed" },
      delete_project: { projectId, confirmed: true },
      list_project_assets: { projectId },
      set_preview_settings: { projectId, patch: { subtitles: { enabled: true } }, expectedRevision: 0 },
      get_narration_cues: { projectId, sceneId: "scene-1" },
      replace_narration_cues: { projectId, sceneId: "scene-1", cues: [], expectedContentHash: null },
      patch_narration_cue: {
        projectId, sceneId: "scene-1", cueId: "scene-1", text: "Hello", expectedContentHash: digest("1"),
      },
      cancel_job: { jobId: "job-1" },
      get_render_output: { jobId: "job-1" },
      list_bgm_beds: {},
      list_color_palettes: { category: "warm" },
      search_bgm: { mood: "calm focused", limit: 4 },
      install_bgm: { projectId, bedId: "ambient", seconds: 10, expectedRevision: 0 },
      import_bgm: {
        projectId,
        path: "preview-assets/bgm/theme.mp3",
        license: { kind: "unknown", holder: null, url: null, note: null },
      },
      record_bgm_license: {
        trackId: "corporate-synth",
        license: { kind: "own-work", holder: null, url: null, note: null },
      },
    };
    expect(Object.keys(cases).sort()).toEqual(tools.list("modern").map((tool) => tool.name));

    for (const [name, input] of Object.entries(cases)) {
      const result = await tools.invoke(name, input, request);
      if (name === "list_projects") {
        expect(result).toEqual({ ok: true, value: { projects: [], diagnostics: [], nextCursor: null } });
      }
      // No provider is registered in this harness, so start_tts rejects on the
      // engine before it ever looks the project up.
      else if (name === "start_tts") {
        expect(result).toMatchObject({ ok: false, error: { code: "tts_provider_unavailable" } });
      }
      // The job-scoped tools are not project-scoped; an absent job is a plain not_found.
      else if (name === "record_bgm_license") {
        expect(result).toMatchObject({ ok: true, value: { trackId: "corporate-synth" } });
      }
      // The catalog is not project-scoped, so an empty listing is the answer.
      else if (name === "list_catalog_items") {
        expect(result).toMatchObject({ ok: true, value: { items: [], source: "bundled", stale: false } });
      }
      else if (name === "list_bgm_beds") {
        expect(result).toMatchObject({ ok: true, value: { library: [] } });
      }
      else if (name === "list_color_palettes") {
        expect(result).toMatchObject({
          ok: true,
          value: {
            defaultPaletteId: "clean-slate",
            palettes: [
              { id: "terracotta", category: "warm" },
              { id: "sand", category: "warm" },
              { id: "rose", category: "warm" },
              { id: "wheat", category: "warm" },
            ],
          },
        });
      }
      else if (name === "search_bgm") {
        expect(result).toMatchObject({
          ok: true,
          value: { tracks: [], providers: [], offlineFallbackAvailable: true },
        });
      }
      else if (name === "get_job_status" || name === "cancel_job" || name === "get_render_output") {
        expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
      }
      else expect(result).toMatchObject({ ok: false, error: { code: "project_not_found" } });
    }
    expect(records).toHaveLength(Object.keys(cases).length);
    expect(new Set(records.map((entry) => entry.tool))).toEqual(new Set(Object.keys(cases)));

    // Every selector install_bgm publishes has to reach the use case. The table
    // above only exercises bedId, and a handler that forwarded two of the three
    // failed schema validation on a valid call — with the schema itself correct,
    // so nothing but this could catch it.
    for (const selector of [
      { bedId: "ambient" },
      { trackId: "lofi-chill" },
      { libraryEntryId: "bgm-1" },
      { providerTrack: { providerId: "openverse", trackId: "remote-1" } },
    ]) {
      expect(await tools.invoke(
        "install_bgm",
        { projectId, ...selector, expectedRevision: 0 },
        request,
      )).toMatchObject({ ok: false, error: { code: "project_not_found" } });
    }
  });
});

function writeDependencies(
  captured: Array<{ tool: string; invocation: WriteInvocation }>,
  /** Lets a test stand in for write authority's proven no-op path. */
  onMutate?: (invocation: WriteInvocation) => void,
): WriteToolDependencies {
  const model: CompositionModel = {
    project: {
      id: projectId,
      slug: "project-tools",
      title: "Project tools",
      width: 1920,
      height: 1080,
      duration: 8,
      updatedAt: "2026-08-02T00:00:00.000Z",
      sceneCount: 1,
      revision: 0,
    },
    scenes: [{
      id: "scene-1",
      src: null,
      start: 0,
      duration: 4,
      trackIndex: 1,
      block: null,
      isTransition: false,
      media: [],
      script: [],
      narration: null,
      elements: [],
      unresolvedEffects: 0,
    }],
    rootTrack: null,
    diagnostics: [],
    sources: [{ path: "index.html" as RelPath, contentHash: digest("1"), byteSize: 16 }],
    references: [],
  };
  const mutate = async (mutation: MutationRequest, _actor: Actor, invocation?: WriteInvocation) => {
    captured.push({
      tool: mutation.kind === "file" && mutation.path === "index.html" ? "set_scene_timing" : "save_file",
      invocation: invocation!,
    });
    if (invocation) onMutate?.(invocation);
    return ok({
      revision: captured.length,
      contentHash: digest(String(captured.length + 1)),
      diagnostics: [],
    });
  };
  return {
    workspace: {
      readProjectRef: async () => ref,
      resolve: async (_ref: ProjectRef, path: RelPath) => ok(path as unknown as ResolvedPath),
      readFile: async () => ({ content: "<main>before</main>", contentHash: digest("1") }),
    },
    composition: {
      parseProject: async () => model,
      applyOps: async () => ok("<main>after</main>"),
    },
    journal: {} as WriteToolDependencies["journal"],
    authority: {
      mutate,
      mutateSource: mutate,
    },
    clock: { now: () => new Date("2026-08-02T00:00:00.000Z") },
  } as unknown as WriteToolDependencies;
}

describe("write tool invocation forwarding", () => {
  it("passes Registry-created pending audits unchanged through save_file and set_scene_timing", async () => {
    const captured: Array<{ tool: string; invocation: WriteInvocation }> = [];
    const dependencies = writeDependencies(captured);
    const tools = registry([], true);
    tools.register(saveFileTool(dependencies));
    tools.register(setSceneTimingTool(dependencies));

    await expect(tools.invoke("save_file", {
      projectId,
      path: "compositions/scene-1.html",
      content: "<main>after</main>",
      expectedContentHash: digest("1"),
    }, request)).resolves.toMatchObject({ ok: true, value: { envelope: { projectRevision: 1 } } });
    const timingResult = await tools.invoke("set_scene_timing", {
      projectId,
      sceneId: "scene-1",
      duration: 5,
      expectedContentHash: digest("1"),
    }, request);
    expect(timingResult).toMatchObject({ ok: true, value: { envelope: { projectRevision: 2 } } });

    expect(captured.map((item) => item.tool)).toEqual(["save_file", "set_scene_timing"]);
    expect(captured[0]!.invocation.toolAudit).toMatchObject({
      tool: "save_file", invocationId: "invocation-1", projectId, credentialId: "credential-1",
    });
    expect(captured[1]!.invocation.toolAudit).toMatchObject({
      tool: "set_scene_timing", invocationId: "invocation-2", projectId, credentialId: "credential-1",
    });
  });

  it("accepts a write whose request was already satisfied and audits it like a read", async () => {
    // Re-sending content the project already holds opens no journal, so the
    // invocation cannot be journal-owned. It is still a successful write, and it
    // has to leave an audit row rather than an `internal` error.
    const records: ToolAuditEntry[] = [];
    const captured: Array<{ tool: string; invocation: WriteInvocation }> = [];
    const dependencies = writeDependencies(captured, (invocation) => invocation.noteUnchanged?.());
    const tools = registry(records, false);
    tools.register(saveFileTool(dependencies));

    await expect(tools.invoke("save_file", {
      projectId,
      path: "compositions/scene-1.html",
      content: "<main>before</main>",
      expectedContentHash: digest("1"),
    }, request)).resolves.toMatchObject({ ok: true });
    expect(records).toMatchObject([{ tool: "save_file", level: "write", outcome: "ok" }]);
  });

  it("still rejects a write that commits without journal ownership and does not claim it was unchanged", async () => {
    const records: ToolAuditEntry[] = [];
    const tools = registry(records, false);
    tools.register(saveFileTool(writeDependencies([])));

    await expect(tools.invoke("save_file", {
      projectId,
      path: "compositions/scene-1.html",
      content: "<main>after</main>",
      expectedContentHash: digest("1"),
    }, request)).resolves.toMatchObject({
      ok: false,
      error: { code: "internal", message: "write tool completed without durable journal audit ownership" },
    });
  });
});

describe("delivery-loop MCP schemas", () => {
  it("requires a source revision for start_render", () => {
    expect(StartRenderInputSchema.safeParse({ projectId }).success).toBe(false);
    expect(StartRenderInputSchema.safeParse({ projectId, expectedSourceRevision: 0 }).success).toBe(true);
  });

  it("forwards idempotency only when the caller explicitly supplies it", async () => {
    const renderInputs: unknown[] = [];
    const snapshotInputs: unknown[] = [];
    const dependencies = {
      enqueueRender: async (input: unknown) => {
        renderInputs.push(input);
        return ok({ id: "job-render" });
      },
      enqueueSnapshot: async (input: unknown) => {
        snapshotInputs.push(input);
        return ok({ id: "job-snapshot" });
      },
    } as unknown as DeliveryLoopToolDependencies;
    await startRenderTool(dependencies).handler({} as never, { projectId, expectedSourceRevision: 2 });
    await startRenderTool(dependencies).handler({} as never, {
      projectId,
      expectedSourceRevision: 2,
      idempotencyKey: "render-request-2",
    });
    await startSnapshotTool(dependencies).handler({} as never, { projectId });
    await startSnapshotTool(dependencies).handler({} as never, { projectId, idempotencyKey: "snapshot-request-2" });
    expect(renderInputs).toEqual([
      { projectId, expectedSourceRevision: 2 },
      { projectId, expectedSourceRevision: 2, idempotencyKey: "render-request-2" },
    ]);
    expect(snapshotInputs).toEqual([
      { projectId },
      { projectId, idempotencyKey: "snapshot-request-2" },
    ]);
  });

  it("exposes stable backoff hints and an explicit partial terminal outcome", async () => {
    const tools = registry([]);
    let status: "queued" | "running" | "partial" = "queued";
    const jobs = {
      get: async () => ({
        id: "job-delivery",
        type: "snapshot",
        status,
        progress: status === "queued" ? 0 : status === "running" ? 0.5 : 1,
        stage: status === "running" ? "capture" : null,
        result: status === "partial" ? { missingSceneIds: ["scene-2"] } : null,
        error: null,
        warnings: status === "partial" ? [{
          code: "sub_timeline_readiness_timeout",
          message: "scene-2 failed",
        }] : null,
        cleanupPending: status === "partial",
        attempt: status === "queued" ? 0 : 1,
        createdAt: "2026-08-02T00:00:00.000Z",
        startedAt: status === "queued" ? null : "2026-08-02T00:00:01.000Z",
        finishedAt: status === "partial" ? "2026-08-02T00:00:02.000Z" : null,
      }),
    } as unknown as JobToolDependencies["jobs"];
    tools.register(getJobStatusTool({ jobs } as unknown as JobToolDependencies));

    await expect(tools.invoke("get_job_status", { jobId: "job-delivery" }, request))
      .resolves.toMatchObject({ ok: true, value: { outcome: null, pollAfterMs: 250 } });
    status = "running";
    await expect(tools.invoke("get_job_status", { jobId: "job-delivery" }, request))
      .resolves.toMatchObject({ ok: true, value: { outcome: null, pollAfterMs: 1000 } });
    status = "partial";
    await expect(tools.invoke("get_job_status", { jobId: "job-delivery" }, request))
      .resolves.toMatchObject({
        ok: true,
        value: {
          outcome: "partial",
          pollAfterMs: null,
          warnings: [{ code: "sub_timeline_readiness_timeout", message: "scene-2 failed" }],
          cleanupPending: true,
        },
      });
  });

  it("rejects cross-branch install_agent_kit fields before the handler", async () => {
    const tools = registry([]);
    const dependencies = {
      workspaceRoot: "/workspace" as AbsolutePath,
      agentKit: { apply: async () => { throw new Error("handler must not run"); } },
    } as unknown as VidcomToolDependencies;
    registerVidcomTools(tools, dependencies);

    for (const input of [
      { operation: "install", hosts: ["codex"], host: "codex" },
      { operation: "link", host: "claude-code", expectedContentHash: digest("1"), hosts: ["codex"] },
      {
        operation: "replace",
        host: "codex",
        relativePath: ".agents/skills/vidcom/SKILL.md",
        expectedContentHash: digest("1"),
        hosts: ["codex"],
      },
    ]) {
      await expect(tools.invoke("install_agent_kit", input, request)).resolves.toMatchObject({
        ok: false,
        error: { code: "schema_invalid", field: "input" },
      });
    }
  });
});
