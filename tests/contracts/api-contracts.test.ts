import { describe, expect, it } from "vitest";

import {
  AssetParamsSchema,
  AssetResponseSchema,
  AuthExchangeRequestSchema,
  CancelJobResponseSchema,
  DomainEventSchema,
  ErrorCode,
  ErrorResponseSchema,
  EventsHeadersSchema,
  GetJobResponseSchema,
  JobParamsSchema,
  LegacyGenerateResponseSchema,
  LegacySceneMutationRequestSchema,
  LegacyTtsResponseSchema,
  ListProjectsResponseSchema,
  NoContentResponseSchema,
  PatchPreviewSettingsRequestSchema,
  PatchPreviewSettingsResponseSchema,
  PatchSceneScriptRequestSchema,
  PatchSceneScriptResponseSchema,
  PatchSceneTimingRequestSchema,
  PatchSceneTimingResponseSchema,
  ProjectParamsSchema,
  PutProjectFileRequestSchema,
  PutProjectFileResponseSchema,
  ReadProjectFileQuerySchema,
  ReadProjectFileResponseSchema,
  StudioSnapshotResponseSchema,
  UploadBgmRequestSchema,
  UploadBgmResponseSchema,
  WriteConflictResponseSchema,
} from "@vidcom/contracts";

const hash = `sha256:${"a".repeat(64)}`;
const now = "2026-08-01T00:00:00.000Z";
const diagnostics: never[] = [];
const project = {
  id: "project_0001",
  slug: "warm-grain",
  title: "Warm Grain",
  width: 1920,
  height: 1080,
  duration: 12,
  updatedAt: now,
  sceneCount: 1,
  revision: 3,
};
const file = { path: "index.html", content: "<!doctype html>", contentHash: hash };
const previewSettings = {
  tone: {
    enabled: false,
    colorMode: "dark" as const,
    backgroundColor: "#000000",
    backgroundFx: "none" as const,
    mainLight: "#ffffff",
    mainLightPosition: "top-left" as const,
    mainLightIntensity: "low" as const,
    softLight: "#ffffff",
    softLightPosition: "bottom-right" as const,
    softLightIntensity: "medium" as const,
  },
  theme: {
    variables: {
      "--primary": "#ff0000",
      "--primary-light": "#ffaaaa",
      "--accent": "#00ff00",
      "--accent-light": "#aaffaa",
      "--success": "#008800",
      "--info": "#0000ff",
    },
  },
  bgm: { enabled: false, volume: 0.5, loop: true, track: null },
  subtitles: {
    enabled: true,
    override: false,
    color: "#ffffff",
    activeColor: "#ffff00",
    fontSize: 48,
    bottom: 80,
  },
  scenes: {},
};

describe("API request contracts", () => {
  it("accepts one representative request for every §7 input shape", () => {
    const upload = new File([new Uint8Array([0x49, 0x44, 0x33])], "music.mp3", {
      type: "audio/mpeg",
    });

    expect(AuthExchangeRequestSchema.parse({ nonce: "nonce" })).toEqual({ nonce: "nonce" });
    expect(ProjectParamsSchema.parse({ id: project.id })).toEqual({ id: project.id });
    expect(JobParamsSchema.parse({ jobId: "job_0001" })).toEqual({ jobId: "job_0001" });
    expect(AssetParamsSchema.parse({ id: project.id, path: "assets/poster.png" })).toEqual({
      id: project.id,
      path: "assets/poster.png",
    });
    expect(ReadProjectFileQuerySchema.parse({ path: "index.html" })).toEqual({ path: "index.html" });
    expect(
      PutProjectFileRequestSchema.parse({
        path: "index.html",
        content: "<!doctype html>",
        expectedContentHash: hash,
      }),
    ).toMatchObject({ expectedContentHash: hash });
    expect(
      PatchPreviewSettingsRequestSchema.parse({
        patch: { bgm: { volume: 0.4 } },
        expectedRevision: 3,
      }),
    ).toMatchObject({ expectedRevision: 3 });
    expect(EventsHeadersSchema.parse({ lastEventId: "7" })).toEqual({ lastEventId: 7 });
    expect(UploadBgmRequestSchema.parse({ file: upload, expectedRevision: "3" })).toMatchObject({
      file: upload,
      expectedRevision: 3,
    });
    for (const expectedRevision of [null, "", "   ", undefined]) {
      expect(UploadBgmRequestSchema.safeParse({ file: upload, expectedRevision }).success).toBe(false);
    }
    expect(PatchSceneTimingRequestSchema.parse({
      timing: { start: 1, duration: 2, trackIndex: 3 }, expectedContentHash: hash,
    })).toMatchObject({ expectedContentHash: hash });
    expect(PatchSceneScriptRequestSchema.parse({
      file: "index.html", elementId: "title", text: "Hello", expectedContentHash: hash,
    })).toMatchObject({ file: "index.html", expectedContentHash: hash });
    expect(
      LegacySceneMutationRequestSchema.parse({ action: "tts", sceneId: "scene-1", text: "Hello" }),
    ).toMatchObject({ action: "tts" });
    expect(
      LegacySceneMutationRequestSchema.parse({ action: "generate", prompt: "Add a title" }),
    ).toMatchObject({ action: "generate" });
  });

  it("rejects unknown fields at the boundary", () => {
    expect(() => AuthExchangeRequestSchema.parse({ nonce: "nonce", admin: true })).toThrow();
  });
});

describe("API response contracts", () => {
  it("locks the shared ErrorCode vocabulary", () => {
    expect(Object.values(ErrorCode).sort()).toEqual([
      "asset_not_allowed",
      "auth_nonce_invalid",
      "auth_required",
      "duration_overflow",
      "host_not_allowed",
      "idempotency_key_reused",
      "internal",
      "no_file",
      "not_found",
      "origin_not_allowed",
      "path_invalid",
      "path_outside_project",
      "path_required",
      "precondition_required",
      "project_not_found",
      "scene_not_found",
      "schema_invalid",
      "sdk_rejected",
      "storage_unavailable",
      "timing_invalid",
      "too_large",
      "unsupported_media",
      "version_format_legacy",
      "workspace_lease_denied",
      "workspace_lease_lost",
      "write_conflict",
    ]);
  });

  it("locks every JSON success response shape", () => {
    const mutation = { previewSettings, revision: 4, diagnostics };
    const narration = {
      sceneId: "scene-1",
      text: "Hello",
      voice: "af_heart",
      status: "mock" as const,
      audioPath: "narration/scene-1.wav",
      command: "kokoro narration/scene-1.wav",
      revision: 1,
      updatedAt: now,
    };

    expect(ListProjectsResponseSchema.parse({ projects: [project] })).toEqual({ projects: [project] });
    expect(
      StudioSnapshotResponseSchema.parse({
        project,
        entryFile: file,
        tree: [{ path: "index.html", name: "index.html", kind: "file" }],
        scenes: [],
        rootTrack: null,
        previewSettings,
        previewSettingsRevision: 2,
        revision: 3,
        diagnostics,
      }),
    ).toMatchObject({ project, revision: 3, diagnostics });
    expect(ReadProjectFileResponseSchema.parse({ file })).toEqual({ file });
    expect(PutProjectFileResponseSchema.parse({ file, revision: 4, diagnostics })).toEqual({
      file,
      revision: 4,
      diagnostics,
    });
    expect(PatchSceneTimingResponseSchema.parse({ file, revision: 4, diagnostics })).toMatchObject({ file });
    expect(PatchSceneScriptResponseSchema.parse({ file, revision: 4, diagnostics })).toMatchObject({ file });
    expect(PatchPreviewSettingsResponseSchema.parse(mutation)).toEqual(mutation);
    expect(UploadBgmResponseSchema.parse(mutation)).toEqual(mutation);
    expect(
      GetJobResponseSchema.parse({
        id: "job_0001",
        type: "noop-probe",
        status: "succeeded",
        progress: 1,
        stage: null,
        result: { completedSteps: 2 },
        error: null,
        attempt: 1,
        createdAt: now,
        startedAt: now,
        finishedAt: now,
      }),
    ).toMatchObject({ id: "job_0001", status: "succeeded" });
    expect(LegacyTtsResponseSchema.parse({ ok: true, narration })).toEqual({ ok: true, narration });
    expect(
      LegacyGenerateResponseSchema.parse({
        ok: true,
        sceneId: "scene-2",
        transcript: [{ kind: "command", text: "generate" }],
      }),
    ).toMatchObject({ ok: true, sceneId: "scene-2" });
  });

  it("locks stream, binary, empty and structured error responses", () => {
    expect(
      DomainEventSchema.parse({
        id: 1,
        type: "file.changed",
        projectId: project.id,
        payload: { source: "external" },
      }),
    ).toMatchObject({ id: 1, type: "file.changed" });
    expect(AssetResponseSchema.parse(new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
    expect(NoContentResponseSchema.parse(undefined)).toBeUndefined();
    expect(CancelJobResponseSchema.parse(undefined)).toBeUndefined();
    expect(
      ErrorResponseSchema.parse({
        error: { code: ErrorCode.ProjectNotFound, message: "project not found" },
      }),
    ).toMatchObject({ error: { code: "project_not_found" } });
    expect(
      WriteConflictResponseSchema.parse({
        error: {
          code: ErrorCode.WriteConflict,
          message: "content changed",
          field: "expectedContentHash",
        },
        current: { content: "new", contentHash: hash, revision: 4 },
      }),
    ).toMatchObject({ current: { revision: 4 } });
  });

  it("fails when a required response field is absent or a removed field returns", () => {
    expect(() => PutProjectFileResponseSchema.parse({ file, revision: 4 })).toThrow();
    expect(() => ListProjectsResponseSchema.parse({ projects: [], cursor: null })).toThrow();
  });
});
