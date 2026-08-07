import { z } from "zod";

import {
  ContentHashSchema,
  DiagnosticSchema,
  IdentifierSchema,
  JobSchema,
  MAX_SOURCE_BYTES,
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

/** Runtime-resolvable contract for one public MCP tool. */
export interface ToolSchemaEntry {
  input: z.ZodType;
  output: z.ZodType;
  level: ToolLevel;
}

/** Canonical schema and authorization-level catalogue for every public MCP tool. */
export const TOOL_SCHEMA_CATALOGUE = {
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
  get_project_context: {
    input: GetProjectContextInputSchema,
    output: GetProjectContextOutputSchema,
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
  read_composition: {
    input: ReadCompositionInputSchema,
    output: ReadCompositionOutputSchema,
    level: "read",
  },
  save_file: {
    input: SaveFileInputSchema,
    output: SaveFileOutputSchema,
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
