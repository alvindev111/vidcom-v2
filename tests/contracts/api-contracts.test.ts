import { describe, expect, it } from "vitest";

import {
  AssetParamsSchema,
  AssetResponseSchema,
  AuthExchangeRequestSchema,
  CancelJobResponseSchema,
  CompactTrackRequestSchema,
  DeleteScenesRequestSchema,
  DomainEventSchema,
  ErrorCode,
  ErrorResponseSchema,
  EventsHeadersSchema,
  GetJobResponseSchema,
  JobParamsSchema,
  JobSchema,
  LegacyGenerateResponseSchema,
  LegacySceneMutationRequestSchema,
  LegacyTtsResponseSchema,
  PendingMountSchema,
  PendingMountOperationIdSchema,
  ListProjectsResponseSchema,
  NoContentResponseSchema,
  PatchPreviewSettingsRequestSchema,
  PatchPreviewSettingsResponseSchema,
  PatchSceneScriptRequestSchema,
  PatchSceneScriptResponseSchema,
  PatchSceneTimingRequestSchema,
  PatchSceneTimingResponseSchema,
  PrepareDeleteScenesRequestSchema,
  ProjectParamsSchema,
  PutProjectFileRequestSchema,
  PutProjectFileResponseSchema,
  ReorderScenesRequestSchema,
  ReadProjectFileQuerySchema,
  ReadProjectFileResponseSchema,
  StudioSnapshotResponseSchema,
  MoveScenesRequestSchema,
  TERMINAL_JOB_STATUSES,
  TimelineThumbnailRequestSchema,
  ThumbnailImageParamsSchema,
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
    paletteId: null,
    variables: {
      "--primary": "#ff0000",
      "--primary-light": "#ffaaaa",
      "--accent": "#00ff00",
      "--accent-light": "#aaffaa",
      "--background": "#000000",
      "--surface": "#111111",
      "--text": "#ffffff",
      "--text-muted": "#aaaaaa",
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
  it("keeps timeline thumbnail requests single-scene, bounded and strict", () => {
    expect(TimelineThumbnailRequestSchema.parse({
      sceneId: "scene-1", atSeconds: [0, 1.5], profile: "timeline-v1",
    })).toEqual({ sceneId: "scene-1", atSeconds: [0, 1.5], profile: "timeline-v1" });
    expect(TimelineThumbnailRequestSchema.safeParse({
      sceneId: "scene-1", atSeconds: [0, 0], profile: "timeline-v1",
    }).success).toBe(false);
    expect(TimelineThumbnailRequestSchema.safeParse({
      sceneId: "scene-1", atSeconds: Array.from({ length: 257 }, (_, index) => index), profile: "timeline-v1",
    }).success).toBe(false);
    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(TimelineThumbnailRequestSchema.safeParse({
        sceneId: "scene-1", atSeconds: [invalid], profile: "timeline-v1",
      }).success).toBe(false);
    }
    expect(TimelineThumbnailRequestSchema.safeParse({
      sceneId: "scene-1", atSeconds: [0], profile: { name: "timeline-v1" },
    }).success).toBe(false);
    expect(TimelineThumbnailRequestSchema.safeParse({
      sceneId: "scene-1", atSeconds: [0], profile: "timeline-v1", width: 160,
    }).success).toBe(false);
    expect(ThumbnailImageParamsSchema.safeParse({ id: project.id, key: "A".repeat(64) }).success).toBe(false);
    expect(ThumbnailImageParamsSchema.parse({ id: project.id, key: "a".repeat(64) }))
      .toEqual({ id: project.id, key: "a".repeat(64) });
  });

  it("shares strict pending-mount primitives across editing boundaries", () => {
    const operationId = "01K1ABCDEFGHJKMNPQRSTVWXYZ";
    expect(PendingMountOperationIdSchema.parse(operationId)).toBe(operationId);
    expect(PendingMountSchema.parse({
      operationId,
      projectId: project.id,
      assetPath: "assets/video/upload.mp4",
      assetContentHash: hash,
      uploadFingerprint: hash,
      atSeconds: 1.25,
      trackIndex: 2,
      state: "uploaded_unmounted",
      lastFailure: { code: "interrupted", message: "Mount interrupted" },
      mountedSceneId: null,
      mountedRevision: null,
      createdAt: now,
      updatedAt: now,
    })).toMatchObject({ operationId, state: "uploaded_unmounted" });
    expect(PendingMountOperationIdSchema.safeParse("not-a-ulid").success).toBe(false);
  });

  it("shares strict scene order and bulk deletion request contracts", () => {
    expect(ReorderScenesRequestSchema.parse({
      sceneId: "scene-1", toIndex: 1, toTrackIndex: 2, extendRoot: true, expectedContentHash: hash,
    })).toMatchObject({ sceneId: "scene-1", toIndex: 1, toTrackIndex: 2 });
    expect(CompactTrackRequestSchema.parse({ expectedContentHash: hash })).toEqual({ expectedContentHash: hash });
    expect(MoveScenesRequestSchema.parse({
      sceneIds: ["scene-1", "scene-2"], deltaSeconds: -1.5, expectedContentHash: hash,
    })).toMatchObject({ sceneIds: ["scene-1", "scene-2"], deltaSeconds: -1.5 });
    expect(PrepareDeleteScenesRequestSchema.parse({ sceneIds: ["scene-1"], expectedRevision: 3 }))
      .toEqual({ sceneIds: ["scene-1"], expectedRevision: 3 });
    expect(DeleteScenesRequestSchema.parse({ sceneIds: ["scene-1"], expectedRevision: 3 }))
      .toEqual({ sceneIds: ["scene-1"], expectedRevision: 3 });
    expect(ReorderScenesRequestSchema.safeParse({
      sceneId: "scene-1", toIndex: 1, expectedContentHash: hash, compact: true,
    }).success).toBe(false);
    expect(MoveScenesRequestSchema.safeParse({
      sceneIds: [], deltaSeconds: 1, expectedContentHash: hash,
    }).success).toBe(false);
    expect(DeleteScenesRequestSchema.safeParse({
      sceneIds: ["scene-1", "scene-1"], expectedRevision: 3,
    }).success).toBe(false);
  });

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
      "agent_session_limit",
      "agent_unavailable",
      "approval_expired",
      "approval_invalid",
      "approval_required",
      "asset_not_allowed",
      "auth_nonce_invalid",
      "auth_required",
      "backup_expired",
      "backup_failed",
      "bootstrap_lock_timeout",
      "bridge_credential_invalid",
      "bridge_credential_unavailable",
      "bridge_rotation_in_progress",
      "browse_token_invalid",
      "committed_response_error",
      "compiler_unavailable",
      "composition_parse_error",
      "confirmation_required",
      "credential_invalid",
      "daemon_identity_mismatch",
      "daemon_unavailable",
      "dependency_graph_unavailable",
      "download_tls_untrusted",
      "download_unavailable",
      "duplicate_mutation_target",
      "duration_overflow",
      "host_not_allowed",
      "idempotency_key_reused",
      "identity_parse_error",
      "integrity_mismatch",
      "internal",
      "invariant_violated",
      "no_composition",
      "no_file",
      "no_scenes",
      "not_found",
      "origin_not_allowed",
      "path_invalid",
      "path_outside_project",
      "path_permission_denied",
      "path_required",
      "path_timeout",
      "payload_too_large",
      "precondition_required",
      "process_termination_unverified",
      "project_import_conflict",
      "project_invalid",
      "project_not_found",
      "recovery_required",
      "referenced_by_composition",
      "remote_asset_not_local",
      "render_binary_missing",
      "resource_limit_exceeded",
      "rollback_payload_pruned",
      "runtime_extraction_incomplete",
      "runtime_manifest_invalid",
      "scene_not_found",
      "schema_invalid",
      "sdk_rejected",
      "source_changing",
      "storage_unavailable",
      "sub_timeline_readiness_timeout",
      "thumbnail_capacity",
      "timing_invalid",
      "timing_not_frame_aligned",
      "too_large",
      "tool_not_available_in_era",
      "tts_credential_missing",
      "tts_provider_unavailable",
      "tts_quota_exceeded",
      "tts_synthesis_failed",
      "tts_voice_not_supported",
      "unsupported_media",
      "version_format_legacy",
      "workspace_busy",
      "workspace_lease_denied",
      "workspace_lease_lost",
      "workspace_switching",
      "workspace_unavailable",
      "write_conflict",
    ]);
  });

  it("locks every JSON success response shape", () => {
    const mutation = { previewSettings, revision: 4, diagnostics, changeSeq: 9 };
    const narration = {
      sceneId: "scene-1",
      text: "Hello",
      voice: "af_heart",
      status: "mock" as const,
      audioPath: "narration/scene-1.wav",
      command: "kokoro narration/scene-1.wav",
      revision: 1,
      updatedAt: now,
      staleSince: null,
    };

    expect(ListProjectsResponseSchema.parse({ projects: [project] })).toEqual({ projects: [project] });
    expect(
      StudioSnapshotResponseSchema.parse({
        project,
        entryFile: file,
        tree: [{ path: "index.html", name: "index.html", kind: "file" }],
        scenes: [],
        rootTrack: null,
        frameRate: 30,
        previewSettings,
        previewSettingsRevision: 2,
        revision: 3,
        projectRevision: 3,
        entityRevision: 2,
        fileHashes: { "index.html": file.contentHash },
        recovery: { writeStatus: "ready", unresolved: [] },
        diagnostics,
      }),
    ).toMatchObject({ project, revision: 3, diagnostics });
    expect(ReadProjectFileResponseSchema.parse({ file })).toEqual({ file });
    expect(PutProjectFileResponseSchema.parse({ file, revision: 4, diagnostics, changeSeq: 9 })).toEqual({
      file,
      revision: 4,
      diagnostics,
      changeSeq: 9,
    });
    expect(PatchSceneTimingResponseSchema.parse({ file, revision: 4, diagnostics, changeSeq: 9 })).toMatchObject({ file });
    expect(PatchSceneScriptResponseSchema.parse({ file, revision: 4, diagnostics, changeSeq: 9 })).toMatchObject({ file });
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
        warnings: null,
        cleanupPending: false,
        attempt: 1,
        createdAt: now,
        startedAt: now,
        finishedAt: now,
      }),
    ).toMatchObject({ id: "job_0001", status: "succeeded" });

    const warnings = [
      { code: "engine_version_drift", message: "runtime version differs" },
      { code: "external_dependency_unpinned", message: "remote font observed" },
    ];
    expect(JobSchema.parse({
      id: "job_partial",
      type: "snapshot",
      status: "partial",
      progress: 1,
      stage: null,
      result: { missingSceneIds: ["scene-2"] },
      error: null,
      warnings,
      cleanupPending: true,
      attempt: 1,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
    }).warnings).toEqual(warnings);
    expect(TERMINAL_JOB_STATUSES).toEqual(["succeeded", "partial", "failed", "cancelled"]);
    expect(LegacyTtsResponseSchema.parse({ ok: true, narration, changeSeq: 9 }))
      .toEqual({ ok: true, narration, changeSeq: 9 });
    expect(
      LegacyGenerateResponseSchema.parse({
        ok: true,
        sceneId: "scene-2",
        changeSeq: 10,
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
