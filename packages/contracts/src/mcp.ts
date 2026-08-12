import { z } from "zod";

import {
  ContentHashSchema,
  DiagnosticSchema,
  IdentifierSchema,
  JobSchema,
  MAX_SOURCE_BYTES,
  PreviewSettingsPatchSchema,
  PreviewSettingsSchema,
  ProjectSummarySchema,
  ProjectRecoveryStatusSchema,
  RelativePathSchema,
  RootTrackSchema,
} from "./dto";
import {
  MAX_TTS_BATCH_CUES,
  MAX_TTS_RATE_PERCENT,
  MIN_TTS_RATE_PERCENT,
  TtsComputeDeviceSchema,
  TtsProviderSchema,
} from "./tts";
import { InstallAgentKitInputSchema, InstallAgentKitOutputSchema } from "./agent-kit";
import {
  ImportBgmInputSchema,
  ImportBgmOutputSchema,
  InstallBgmInputSchema,
  InstallBgmOutputSchema,
  ListBgmBedsInputSchema,
  ListBgmBedsOutputSchema,
  RecordBgmLicenseInputSchema,
  RecordBgmLicenseOutputSchema,
} from "./bgm";
import { NarrationCueInputSchema } from "./delivery-loop-http";
import { ErrorCode } from "./errors";
import { MotionLibraryIdSchema } from "./motion-libraries";

const CanonicalRelativePathSchema = RelativePathSchema.regex(
  /^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*\0)(?!.*\/\/)(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$)).+$/,
  "path must be canonical and project-relative",
);

/** MCP revisions served by VidCom, ordered from newest to oldest. */
export const SUPPORTED_REVISIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

/** Exact protocol revision accepted by a transport or tool invocation. */
export type ProtocolRevision = (typeof SUPPORTED_REVISIONS)[number];

/** MCP wire generation selected by the SDK for one connection or request. */
export type Era = "legacy" | "modern";

/** Authorization and annotation class assigned to a registry tool. */
export type ToolLevel = "read" | "write" | "job" | "destructive";

/** Canonical result envelope shared by every MCP write tool. */
export const WriteEnvelopeSchema = z.strictObject({
  projectRevision: z.number().int().nonnegative(),
  entityRevision: z.number().int().nonnegative().nullable(),
  fileHashes: z.record(CanonicalRelativePathSchema, ContentHashSchema),
  diagnostics: z.array(DiagnosticSchema),
});

/** Compact scene state needed by an agent to plan its next mutation. */
export const SceneContextSchema = z.strictObject({
  id: IdentifierSchema,
  src: RelativePathSchema.nullable(),
  start: z.number().finite(),
  duration: z.number().finite(),
  trackIndex: z.number().int(),
  isTransition: z.boolean(),
  elementCount: z.number().int().nonnegative(),
  fileContentHash: ContentHashSchema.nullable(),
  narrationStale: z.boolean(),
});

const projectIdInput = { projectId: IdentifierSchema } as const;
const grantId = IdentifierSchema.optional();

/** Input for `list_projects`. */
export const LIST_PROJECTS_DEFAULT_LIMIT = 20;
export const LIST_PROJECTS_MAX_LIMIT = 100;
export const ListProjectsInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(LIST_PROJECTS_MAX_LIMIT).default(LIST_PROJECTS_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(255).optional(),
});
/** Output for `list_projects`. */
export const ListProjectsOutputSchema = z.strictObject({
  projects: z.array(z.strictObject({
    projectId: IdentifierSchema,
    slug: IdentifierSchema,
    title: z.string(),
    width: z.number().finite(),
    height: z.number().finite(),
    duration: z.number().finite(),
    projectRevision: z.number().int().nonnegative(),
    recovery: ProjectRecoveryStatusSchema,
  })),
  diagnostics: z.array(DiagnosticSchema),
  nextCursor: z.string().min(1).max(255).nullable(),
});

/** Input for `get_project_context`. */
export const GetProjectContextInputSchema = z.strictObject(projectIdInput);
/** Output for `get_project_context`. */
export const GetProjectContextOutputSchema = z.strictObject({
  project: ProjectSummarySchema,
  scenes: z.array(SceneContextSchema),
  rootTrack: RootTrackSchema.nullable(),
  previewSettings: PreviewSettingsSchema,
  entityRevision: z.number().int().nonnegative(),
  projectRevision: z.number().int().nonnegative(),
  diagnostics: z.array(DiagnosticSchema),
  fileHashes: z.record(z.string(), ContentHashSchema),
  recovery: ProjectRecoveryStatusSchema,
});

/** Input for `list_scenes`. */
export const ListScenesInputSchema = z.strictObject(projectIdInput);
/** Output for `list_scenes`. */
export const ListScenesOutputSchema = z.strictObject({
  scenes: z.array(SceneContextSchema),
  projectRevision: z.number().int().nonnegative(),
  recovery: ProjectRecoveryStatusSchema,
  diagnostics: z.array(DiagnosticSchema),
});

/** Input for `read_composition`. */
export const ReadCompositionInputSchema = z.strictObject({
  ...projectIdInput,
  path: RelativePathSchema,
});
/** Output for `read_composition`. */
export const ReadCompositionOutputSchema = z.strictObject({
  path: RelativePathSchema,
  content: z.string().max(MAX_SOURCE_BYTES),
  contentHash: ContentHashSchema,
  recovery: ProjectRecoveryStatusSchema,
});

/** Input for `create_scene`. */
export const CreateSceneInputSchema = z.strictObject({
  ...projectIdInput,
  title: z.string().min(1).max(255),
  duration: z.number().finite().optional(),
  index: z.number().int().nonnegative().optional(),
  trackIndex: z.number().int().nonnegative().optional(),
  expectedContentHash: ContentHashSchema.nullable(),
});
const SceneRippleMoveSchema = z.strictObject({
  sceneId: IdentifierSchema,
  fromStart: z.number().nonnegative(),
  toStart: z.number().nonnegative(),
});
/** Output for `create_scene`. */
export const CreateSceneOutputSchema = z.strictObject({
  scene: SceneContextSchema,
  project: ProjectSummarySchema,
  envelope: WriteEnvelopeSchema,
  affectedTrackIndex: z.number().int().nonnegative(),
  moved: z.array(SceneRippleMoveSchema),
});

/** Input for `set_scene_timing`. */
export const SetSceneTimingInputSchema = z.strictObject({
  ...projectIdInput,
  sceneId: IdentifierSchema,
  start: z.number().finite().optional(),
  duration: z.number().finite().optional(),
  trackIndex: z.number().int().optional(),
  ripple: z.boolean().optional(),
  extendRoot: z.boolean().optional(),
  expectedContentHash: ContentHashSchema,
}).refine(
  (input) => input.start !== undefined || input.duration !== undefined || input.trackIndex !== undefined,
  { message: "at least one timing field is required", path: ["start"] },
);
/** Output for `set_scene_timing`. */
export const SetSceneTimingOutputSchema = z.strictObject({
  scene: SceneContextSchema,
  project: ProjectSummarySchema,
  envelope: WriteEnvelopeSchema,
  affectedTrackIndex: z.number().int().nonnegative(),
  moved: z.array(SceneRippleMoveSchema),
});

/** Input for `set_text`. */
export const SetTextInputSchema = z.strictObject({
  ...projectIdInput,
  sceneId: IdentifierSchema,
  file: RelativePathSchema,
  elementId: IdentifierSchema,
  text: z.string(),
  expectedContentHash: ContentHashSchema,
});
/** Output for `set_text`. */
export const SetTextOutputSchema = z.strictObject({
  scene: SceneContextSchema,
  project: ProjectSummarySchema,
  envelope: WriteEnvelopeSchema,
  narrationStale: z.boolean(),
});

/** Input for `save_file`. */
export const SaveFileInputSchema = z.strictObject({
  ...projectIdInput,
  path: RelativePathSchema,
  content: z.string().max(MAX_SOURCE_BYTES),
  expectedContentHash: ContentHashSchema,
});
/** Output for `save_file`. */
export const SaveFileOutputSchema = z.strictObject({
  file: z.strictObject({ path: RelativePathSchema, contentHash: ContentHashSchema }),
  envelope: WriteEnvelopeSchema,
});

/** Input for `install_motion_library`. */
export const InstallMotionLibraryInputSchema = z.strictObject({
  ...projectIdInput,
  libraryId: MotionLibraryIdSchema,
});
/** Output for `install_motion_library`. */
export const InstallMotionLibraryOutputSchema = z.strictObject({
  status: z.enum(["installed", "already_installed"]),
  library: z.strictObject({
    id: MotionLibraryIdSchema,
    version: z.string(),
    loader: z.enum(["global", "module"]),
    globalName: z.string().nullable(),
    entry: RelativePathSchema,
    scriptTag: z.string(),
    importSpecifier: z.string().nullable(),
  }),
  files: z.array(z.strictObject({
    path: RelativePathSchema,
    contentHash: ContentHashSchema.nullable(),
  })),
  revision: z.number().int().nullable(),
});

/** Input for `delete_file`. */
export const DeleteFileInputSchema = z.strictObject({
  ...projectIdInput,
  path: RelativePathSchema,
  expectedContentHash: ContentHashSchema,
  grantId,
});
/** Output for `delete_file`. */
export const DeleteFileOutputSchema = z.strictObject({
  deleted: RelativePathSchema,
  envelope: WriteEnvelopeSchema,
  backupId: IdentifierSchema,
});

/** Input for `delete_scene`. */
export const DeleteSceneInputSchema = z.strictObject({
  ...projectIdInput,
  sceneId: IdentifierSchema,
  expectedRevision: z.number().int().nonnegative(),
  grantId,
});
/** Output for `delete_scene`. */
export const DeleteSceneOutputSchema = z.strictObject({
  project: ProjectSummarySchema,
  envelope: WriteEnvelopeSchema,
  deletedFile: RelativePathSchema.nullable(),
  keptFileReason: z.string().nullable(),
  backupId: IdentifierSchema,
});

/** Input for `list_tts_voices`. */
export const ListTtsVoicesInputSchema = z.strictObject({ ...projectIdInput });
/** Output for `list_tts_voices`. */
export const ListTtsVoicesOutputSchema = z.strictObject({
  providers: z.array(TtsProviderSchema),
});

/** Input for `start_tts`. */
export const StartTtsInputSchema = z.strictObject({
  ...projectIdInput,
  sceneIds: z.array(IdentifierSchema).min(1).max(MAX_TTS_BATCH_CUES),
  providerId: IdentifierSchema,
  voiceId: IdentifierSchema,
  modelId: IdentifierSchema.nullish(),
  ratePercent: z.number().int().min(MIN_TTS_RATE_PERCENT).max(MAX_TTS_RATE_PERCENT).nullish(),
  computeDevice: TtsComputeDeviceSchema.nullish(),
});
/** Output for `start_tts`; the audio itself arrives through the job. */
export const StartTtsOutputSchema = z.strictObject({
  jobId: IdentifierSchema,
  status: z.literal("queued"),
  pollWith: z.literal("get_job_status"),
});

/** Input for `get_job_status`. */
export const GetJobStatusInputSchema = z.strictObject({ jobId: IdentifierSchema });
/**
 * Error codes already published by the MCP job contract before packaging support.
 *
 * Packaging-only failures remain available to HTTP, bridge, and internal callers,
 * but adding them here would be a breaking `tools/list` schema change.
 */
export const MCP_PUBLIC_ERROR_CODES = [
  ErrorCode.SchemaInvalid,
  ErrorCode.PathRequired,
  ErrorCode.PathInvalid,
  ErrorCode.VersionFormatLegacy,
  ErrorCode.PreconditionRequired,
  ErrorCode.AuthRequired,
  ErrorCode.AuthNonceInvalid,
  ErrorCode.HostNotAllowed,
  ErrorCode.OriginNotAllowed,
  ErrorCode.AssetNotAllowed,
  ErrorCode.PathOutsideProject,
  ErrorCode.ProjectNotFound,
  ErrorCode.ProjectInvalid,
  ErrorCode.IdentityParseError,
  ErrorCode.CompositionParseError,
  ErrorCode.NoComposition,
  ErrorCode.NoScenes,
  ErrorCode.NotFound,
  ErrorCode.WriteConflict,
  ErrorCode.IdempotencyKeyReused,
  ErrorCode.WorkspaceLeaseLost,
  ErrorCode.TimingInvalid,
  ErrorCode.DurationOverflow,
  ErrorCode.SceneNotFound,
  ErrorCode.SdkRejected,
  ErrorCode.NoFile,
  ErrorCode.TooLarge,
  ErrorCode.UnsupportedMedia,
  ErrorCode.Internal,
  ErrorCode.StorageUnavailable,
  ErrorCode.WorkspaceLeaseDenied,
  ErrorCode.ApprovalRequired,
  ErrorCode.ApprovalExpired,
  ErrorCode.ApprovalInvalid,
  ErrorCode.CredentialInvalid,
  ErrorCode.ToolNotAvailableInEra,
  ErrorCode.ReferencedByComposition,
  ErrorCode.BackupFailed,
  ErrorCode.BackupExpired,
  ErrorCode.DuplicateMutationTarget,
  ErrorCode.RecoveryRequired,
  ErrorCode.RemoteAssetNotLocal,
  ErrorCode.RenderBinaryMissing,
  ErrorCode.SubTimelineReadinessTimeout,
  ErrorCode.ProcessTerminationUnverified,
  ErrorCode.ConfirmationRequired,
  ErrorCode.RollbackPayloadPruned,
  ErrorCode.CommittedResponseError,
  ErrorCode.TtsProviderUnavailable,
  ErrorCode.TtsCredentialMissing,
  ErrorCode.TtsVoiceNotSupported,
  ErrorCode.TtsQuotaExceeded,
  ErrorCode.TtsSynthesisFailed,
] as const;

const McpPublicErrorDetailSchema = z.strictObject({
  code: z.enum(MCP_PUBLIC_ERROR_CODES),
  message: z.string().min(1),
  field: z.string().min(1).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** Output for `get_job_status`. */
export const GetJobStatusOutputSchema = JobSchema.extend({
  error: McpPublicErrorDetailSchema.nullable(),
  outcome: z.enum(["succeeded", "partial", "failed", "cancelled"]).nullable(),
  pollAfterMs: z.union([z.literal(250), z.literal(1000)]).nullable(),
});

export const ValidateProjectInputSchema = z.strictObject({ ...projectIdInput });
export const ValidateProjectOutputSchema = z.strictObject({
  diagnostics: z.array(DiagnosticSchema),
  computedAtSourceRevision: z.number().int().nonnegative().nullable(),
  lintSourceAvailable: z.boolean(),
});
export const StartRenderInputSchema = z.strictObject({
  ...projectIdInput,
  bestEffort: z.boolean().optional(),
  renderPresetId: IdentifierSchema.optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
});
export const StartSnapshotInputSchema = z.strictObject({
  ...projectIdInput,
  idempotencyKey: z.string().min(1).max(255).optional(),
});
export const StartDeliveryJobOutputSchema = z.strictObject({ jobId: IdentifierSchema });
export { InstallAgentKitInputSchema, InstallAgentKitOutputSchema };

/** Input for `create_project`; custom presets carry their own dimensions. */
export const CreateProjectInputSchema = z.strictObject({
  name: z.string().min(1).max(255),
  presetId: z.enum(["vertical-shorts", "horizontal-youtube", "custom"]),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  fps: z.number().int().optional(),
});
/** Output for `create_project`. */
export const CreateProjectOutputSchema = z.strictObject({
  projectId: IdentifierSchema,
  slug: IdentifierSchema,
});

/** Input for `adopt_project`; the slug is a workspace folder, never a path. */
export const AdoptProjectInputSchema = z.strictObject({ slug: IdentifierSchema });
/** Output for `adopt_project`. */
export const AdoptProjectOutputSchema = z.strictObject({ projectId: IdentifierSchema });

/** Input for `rename_project`. */
export const RenameProjectInputSchema = z.strictObject({
  ...projectIdInput,
  name: z.string().min(1).max(255),
});
/** Output for `rename_project`. */
export const RenameProjectOutputSchema = z.strictObject({ slug: IdentifierSchema });

/** Input for `delete_project`; confirmation and an approval grant are both required. */
export const DeleteProjectInputSchema = z.strictObject({
  ...projectIdInput,
  confirmed: z.literal(true),
  grantId,
});
/** Output for `delete_project`. */
export const DeleteProjectOutputSchema = z.strictObject({ backupId: IdentifierSchema });

/** Largest asset page one `list_project_assets` call returns. */
export const MAX_LISTED_PROJECT_ASSETS = 500;
/** Asset classes an agent can act on without opening the bytes. */
export const ProjectAssetKindSchema = z.enum(["audio", "image", "video", "font", "other"]);
/** Input for `list_project_assets`. */
export const ListProjectAssetsInputSchema = z.strictObject({
  ...projectIdInput,
  directory: RelativePathSchema.optional(),
});
/** Output for `list_project_assets`. */
export const ListProjectAssetsOutputSchema = z.strictObject({
  assets: z.array(z.strictObject({
    path: CanonicalRelativePathSchema,
    kind: ProjectAssetKindSchema,
    byteSize: z.number().int().nonnegative(),
    modifiedAt: z.string().min(1),
    referencedByPreviewSettings: z.boolean(),
  })).max(MAX_LISTED_PROJECT_ASSETS),
  truncated: z.boolean(),
});

/** Input for `set_preview_settings`. */
export const SetPreviewSettingsInputSchema = z.strictObject({
  ...projectIdInput,
  patch: PreviewSettingsPatchSchema,
  expectedRevision: z.number().int().nonnegative(),
});
/** Output for `set_preview_settings`. */
export const SetPreviewSettingsOutputSchema = z.strictObject({
  previewSettings: PreviewSettingsSchema,
  revision: z.number().int().nonnegative(),
  diagnostics: z.array(DiagnosticSchema),
});

/** Authored and synthesis state of one narration cue, without engine word timings. */
export const NarrationCueStateSchema = z.strictObject({
  cueId: IdentifierSchema,
  text: z.string(),
  voice: z.string(),
  offsetSeconds: z.number().nonnegative(),
  durationSeconds: z.number().nonnegative().nullable(),
  staleSince: z.string().nullable(),
  status: z.enum(["mock", "generated"]).nullable(),
  audioPath: RelativePathSchema.nullable(),
});

/** Input for `get_narration_cues`. */
export const GetNarrationCuesInputSchema = z.strictObject({
  ...projectIdInput,
  sceneId: IdentifierSchema,
});
/** Output for `get_narration_cues`; a scene with no sidecar returns an empty list. */
export const GetNarrationCuesOutputSchema = z.strictObject({
  cues: z.array(NarrationCueStateSchema),
  contentHash: ContentHashSchema.nullable(),
});

/** Input for `replace_narration_cues`. */
export const ReplaceNarrationCuesInputSchema = z.strictObject({
  ...projectIdInput,
  sceneId: IdentifierSchema,
  cues: z.array(NarrationCueInputSchema).max(MAX_TTS_BATCH_CUES),
  expectedContentHash: ContentHashSchema.nullable(),
});
/** Input for `patch_narration_cue`. */
export const PatchNarrationCueInputSchema = z.strictObject({
  ...projectIdInput,
  sceneId: IdentifierSchema,
  cueId: IdentifierSchema,
  text: z.string().optional(),
  voice: z.string().min(1).optional(),
  offsetSeconds: z.number().nonnegative().optional(),
  expectedContentHash: ContentHashSchema,
}).refine(
  (input) => input.text !== undefined || input.voice !== undefined || input.offsetSeconds !== undefined,
  { message: "at least one cue field is required", path: ["text"] },
);
/** Output shared by both narration cue writes. */
export const NarrationCuesWriteOutputSchema = z.strictObject({
  cues: z.array(NarrationCueStateSchema),
  contentHash: ContentHashSchema,
  revision: z.number().int().nonnegative(),
});

/** Input for `cancel_job`. */
export const CancelJobInputSchema = z.strictObject({ jobId: IdentifierSchema });
/** Output for `cancel_job`; a terminal job reports requested=false without changing. */
export const CancelJobOutputSchema = z.strictObject({
  jobId: IdentifierSchema,
  status: JobSchema.shape.status,
  requested: z.boolean(),
});

/** Input for `get_render_output`. */
export const GetRenderOutputInputSchema = z.strictObject({ jobId: IdentifierSchema });
/** Output for `get_render_output`; the artifact stays on disk instead of crossing the wire. */
export const GetRenderOutputOutputSchema = z.strictObject({
  jobId: IdentifierSchema,
  projectId: IdentifierSchema,
  path: CanonicalRelativePathSchema,
  absolutePath: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  contentHash: ContentHashSchema,
  mediaType: z.string().min(1),
  outcome: z.enum(["succeeded", "partial"]),
});

/** Runtime-resolvable contract for one public MCP tool. */
export interface ToolSchemaEntry {
  input: z.ZodType;
  output: z.ZodType;
  level: ToolLevel;
}

/** Canonical schema and authorization-level catalogue for every public MCP tool. */
export const TOOL_SCHEMA_CATALOGUE = {
  adopt_project: {
    input: AdoptProjectInputSchema,
    output: AdoptProjectOutputSchema,
    level: "write",
  },
  cancel_job: {
    input: CancelJobInputSchema,
    output: CancelJobOutputSchema,
    level: "job",
  },
  import_bgm: {
    input: ImportBgmInputSchema,
    output: ImportBgmOutputSchema,
    level: "write",
  },
  install_bgm: {
    input: InstallBgmInputSchema,
    output: InstallBgmOutputSchema,
    level: "write",
  },
  list_bgm_beds: {
    input: ListBgmBedsInputSchema,
    output: ListBgmBedsOutputSchema,
    level: "read",
  },
  create_project: {
    input: CreateProjectInputSchema,
    output: CreateProjectOutputSchema,
    level: "write",
  },
  create_scene: {
    input: CreateSceneInputSchema,
    output: CreateSceneOutputSchema,
    level: "write",
  },
  delete_file: {
    input: DeleteFileInputSchema,
    output: DeleteFileOutputSchema,
    level: "destructive",
  },
  delete_project: {
    input: DeleteProjectInputSchema,
    output: DeleteProjectOutputSchema,
    level: "destructive",
  },
  delete_scene: {
    input: DeleteSceneInputSchema,
    output: DeleteSceneOutputSchema,
    level: "destructive",
  },
  get_job_status: {
    input: GetJobStatusInputSchema,
    output: GetJobStatusOutputSchema,
    level: "read",
  },
  get_narration_cues: {
    input: GetNarrationCuesInputSchema,
    output: GetNarrationCuesOutputSchema,
    level: "read",
  },
  get_project_context: {
    input: GetProjectContextInputSchema,
    output: GetProjectContextOutputSchema,
    level: "read",
  },
  get_render_output: {
    input: GetRenderOutputInputSchema,
    output: GetRenderOutputOutputSchema,
    level: "read",
  },
  install_agent_kit: {
    input: InstallAgentKitInputSchema,
    output: InstallAgentKitOutputSchema,
    level: "write",
  },
  install_motion_library: {
    input: InstallMotionLibraryInputSchema,
    output: InstallMotionLibraryOutputSchema,
    level: "write",
  },
  list_project_assets: {
    input: ListProjectAssetsInputSchema,
    output: ListProjectAssetsOutputSchema,
    level: "read",
  },
  list_projects: {
    input: ListProjectsInputSchema,
    output: ListProjectsOutputSchema,
    level: "read",
  },
  list_scenes: {
    input: ListScenesInputSchema,
    output: ListScenesOutputSchema,
    level: "read",
  },
  list_tts_voices: {
    input: ListTtsVoicesInputSchema,
    output: ListTtsVoicesOutputSchema,
    level: "read",
  },
  patch_narration_cue: {
    input: PatchNarrationCueInputSchema,
    output: NarrationCuesWriteOutputSchema,
    level: "write",
  },
  record_bgm_license: {
    input: RecordBgmLicenseInputSchema,
    output: RecordBgmLicenseOutputSchema,
    level: "write",
  },
  read_composition: {
    input: ReadCompositionInputSchema,
    output: ReadCompositionOutputSchema,
    level: "read",
  },
  rename_project: {
    input: RenameProjectInputSchema,
    output: RenameProjectOutputSchema,
    level: "write",
  },
  replace_narration_cues: {
    input: ReplaceNarrationCuesInputSchema,
    output: NarrationCuesWriteOutputSchema,
    level: "write",
  },
  save_file: {
    input: SaveFileInputSchema,
    output: SaveFileOutputSchema,
    level: "write",
  },
  set_preview_settings: {
    input: SetPreviewSettingsInputSchema,
    output: SetPreviewSettingsOutputSchema,
    level: "write",
  },
  set_scene_timing: {
    input: SetSceneTimingInputSchema,
    output: SetSceneTimingOutputSchema,
    level: "write",
  },
  set_text: {
    input: SetTextInputSchema,
    output: SetTextOutputSchema,
    level: "write",
  },
  start_render: {
    input: StartRenderInputSchema,
    output: StartDeliveryJobOutputSchema,
    level: "job",
  },
  start_snapshot: {
    input: StartSnapshotInputSchema,
    output: StartDeliveryJobOutputSchema,
    level: "job",
  },
  start_tts: {
    input: StartTtsInputSchema,
    output: StartTtsOutputSchema,
    level: "job",
  },
  validate_project: {
    input: ValidateProjectInputSchema,
    output: ValidateProjectOutputSchema,
    level: "read",
  },
} as const satisfies Record<string, ToolSchemaEntry>;

export type SceneContext = z.infer<typeof SceneContextSchema>;
