import { z } from "zod";

import { ErrorCode, WarningCode } from "./errors";
import { HOST_DOMAIN_EVENT_TYPES, PROJECT_DOMAIN_EVENT_TYPES } from "./domain";
import { ColorPaletteIdSchema } from "./color-palettes";

const identifierSchema = z.string().min(1).max(255);
const relativePathSchema = z.string().min(1).max(4096);
const contentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const isoTimestampSchema = z.iso.datetime({ offset: true });
const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** Shared identifier schema for HTTP and MCP contracts. */
export const IdentifierSchema = identifierSchema;
/** Shared project-relative path schema for HTTP and MCP contracts. */
export const RelativePathSchema = relativePathSchema;
/** Shared canonical SHA-256 schema for HTTP and MCP contracts. */
export const ContentHashSchema = contentHashSchema;

/** Project write-gate state shared by HTTP snapshots and MCP project reads. */
export const ProjectRecoveryStatusSchema = z.strictObject({
  writeStatus: z.enum(["ready", "recovery_required"]),
  unresolved: z.array(z.strictObject({
    journalId: z.number().int().positive(),
    status: z.enum(["pending", "orphaned"]),
  })),
});

export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_BGM_BYTES = 20 * 1024 * 1024;

export const DiagnosticSchema = z.strictObject({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string().min(1),
  sceneId: identifierSchema.optional(),
  elementId: identifierSchema.optional(),
  effectId: identifierSchema.optional(),
  file: relativePathSchema.optional(),
  line: z.number().int().positive().optional(),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
  fix: z
    .strictObject({
      kind: z.literal("set-attribute"),
      target: z.string().min(1),
      attribute: z.string().min(1),
      value: z.string(),
    })
    .optional(),
});

export const ErrorDetailSchema = z.strictObject({
  code: z.enum(ErrorCode),
  message: z.string().min(1),
  field: z.string().min(1).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const ErrorResponseSchema = z.strictObject({
  error: ErrorDetailSchema,
});

export const ProjectSummarySchema = z.strictObject({
  id: identifierSchema,
  slug: identifierSchema,
  title: z.string(),
  description: z.string().optional(),
  width: z.number().finite(),
  height: z.number().finite(),
  duration: z.number().finite(),
  updatedAt: isoTimestampSchema,
  sceneCount: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});

export interface FileNodeDto {
  path: string;
  name: string;
  kind: "file" | "folder";
  children?: FileNodeDto[];
}

export const FileNodeSchema: z.ZodType<FileNodeDto> = z.lazy(() =>
  z.strictObject({
    path: relativePathSchema,
    name: z.string().min(1),
    kind: z.enum(["file", "folder"]),
    children: z.array(FileNodeSchema).optional(),
  }),
);

export const SceneEffectSchema = z.strictObject({
  id: identifierSchema,
  method: z.string().min(1),
  start: z.number().finite(),
  duration: z.number().finite(),
  ease: z.string().nullable(),
  propertyGroup: z.string().nullable(),
});

export const SceneElementSchema = z.strictObject({
  id: identifierSchema,
  label: z.string(),
  kind: z.enum(["image", "video", "audio", "element"]),
  start: z.number().finite().nullable(),
  duration: z.number().finite().nullable(),
  src: z.string().nullable(),
  effects: z.array(SceneEffectSchema),
});

export const RootTrackSchema = z.strictObject({
  id: identifierSchema,
  duration: z.number().finite(),
  elements: z.array(SceneElementSchema),
  unresolvedEffects: z.number().int().nonnegative(),
});

export const SceneSchema = z.strictObject({
  id: identifierSchema,
  src: relativePathSchema.nullable(),
  start: z.number().finite(),
  duration: z.number().finite(),
  trackIndex: z.number().int(),
  block: z
    .strictObject({
      name: z.string().min(1),
      title: z.string().nullable(),
      description: z.string().nullable(),
      category: z.string().nullable(),
      tags: z.array(z.string()),
    })
    .nullable(),
  isTransition: z.boolean(),
  media: z.array(
    z.strictObject({
      kind: z.enum(["image", "video", "audio"]),
      url: z.string(),
      src: z.string(),
      start: z.number().finite().nullable(),
      duration: z.number().finite().nullable(),
    }),
  ),
  script: z.array(
    z.strictObject({
      id: identifierSchema,
      text: z.string(),
      file: relativePathSchema,
    }),
  ),
  narration: z
    .strictObject({
      sceneId: identifierSchema,
      text: z.string(),
      voice: z.string(),
      status: z.enum(["mock", "generated"]),
      audioPath: relativePathSchema,
      command: z.string(),
      revision: z.number().int().nonnegative(),
      updatedAt: isoTimestampSchema,
      staleSince: isoTimestampSchema.nullable(),
      /** Absent on sidecars written before real TTS existed, and on mock records. */
      provider: identifierSchema.optional(),
      durationSeconds: z.number().positive().optional(),
      /** Word boundaries against the published audio, for word-level transcript highlighting. */
      words: z.array(z.strictObject({
        text: z.string().min(1),
        startSeconds: z.number().nonnegative(),
        endSeconds: z.number().nonnegative(),
      })).optional(),
      /**
       * `engine` = measured against the audio, safe for per-word highlighting.
       * `estimated` = apportioned from the text by word length, so it drifts within
       * a sentence — good enough for a moving highlight, not an alignment.
       */
      wordTimingSource: z.enum(["engine", "estimated"]).optional(),
      /** Engine provenance: model, revision, device, effective rate. */
      engine: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    })
    .nullable(),
  elements: z.array(SceneElementSchema),
  unresolvedEffects: z.number().int().nonnegative(),
});

const lightPositionSchema = z.enum([
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
]);
const lightIntensitySchema = z.enum(["low", "medium", "high", "max"]);
const transitionSoundSchema = z.enum([
  "gong",
  "rise",
  "bass",
  "chime",
  "sweep",
  "boom",
  "alarm",
  "chord",
  "ascending",
  "retro",
  "minimal",
  "dramatic",
]);
const revealSoundSchema = z.enum([
  "ping",
  "pop",
  "chime",
  "click",
  "bubble",
  "woosh",
  "sparkle",
  "drop",
  "tick",
  "bell",
  "blip",
  "snap",
]);
const themeVariablesSchema = z.strictObject({
  "--primary": z.string(),
  "--primary-light": z.string(),
  "--accent": z.string(),
  "--accent-light": z.string(),
  "--background": z.string(),
  "--surface": z.string(),
  "--text": z.string(),
  "--text-muted": z.string(),
  "--success": z.string(),
  "--info": z.string(),
});

export const ToneSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  colorMode: z.enum(["dark", "cream"]),
  backgroundColor: hexColorSchema,
  backgroundFx: z.enum(["none", "scan", "particles", "rings", "lorenz"]),
  mainLight: hexColorSchema,
  mainLightPosition: lightPositionSchema,
  mainLightIntensity: lightIntensitySchema,
  softLight: hexColorSchema,
  softLightPosition: lightPositionSchema,
  softLightIntensity: lightIntensitySchema,
});

export const BgmSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  volume: z.number().min(0).max(1),
  loop: z.boolean(),
  track: z
    .strictObject({ name: z.string().min(1), path: relativePathSchema })
    .nullable(),
});

export const SubtitleSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  override: z.boolean(),
  color: hexColorSchema,
  activeColor: hexColorSchema,
  fontSize: z.number().finite(),
  bottom: z.number().finite(),
});

export const SceneSettingsSchema = z.strictObject({
  transitionSound: transitionSoundSchema,
  revealSound: revealSoundSchema,
  hidden: z.boolean(),
});

export const PreviewSettingsSchema = z.strictObject({
  tone: ToneSettingsSchema,
  theme: z.strictObject({
    paletteId: ColorPaletteIdSchema.nullable(),
    variables: themeVariablesSchema,
  }),
  bgm: BgmSettingsSchema,
  subtitles: SubtitleSettingsSchema,
  scenes: z.record(z.string(), SceneSettingsSchema),
});

export const PreviewSettingsPatchSchema = z
  .strictObject({
    tone: ToneSettingsSchema.partial().optional(),
    theme: z
      .strictObject({
        paletteId: ColorPaletteIdSchema.nullable().optional(),
        variables: themeVariablesSchema.partial().optional(),
      })
      .optional(),
    bgm: BgmSettingsSchema.partial().optional(),
    subtitles: SubtitleSettingsSchema.partial().optional(),
    scenes: z.record(z.string(), SceneSettingsSchema).optional(),
    scenesRemove: z.array(identifierSchema).max(1_000).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, "patch must not be empty");

export const AuthExchangeRequestSchema = z.strictObject({
  nonce: z.string().min(1).max(512),
});
export const NoContentResponseSchema = z.undefined();

const browseTokenSchema = z.string().min(1).max(4_096);
const displayPathSchema = z.string().min(1).max(4_096);

/** One safe starting point exposed by the authenticated filesystem browser. */
export const BrowseRootSchema = z.strictObject({
  name: z.string().min(1).max(255),
  displayPath: displayPathSchema,
  token: browseTokenSchema,
  canWrite: z.boolean(),
});

/** Metadata-only directory entry; file contents and sizes are intentionally absent. */
export const BrowseEntrySchema = z.strictObject({
  name: z.string().min(1).max(255),
  displayPath: displayPathSchema,
  token: browseTokenSchema,
  isDir: z.boolean(),
  canWrite: z.boolean(),
});

/** Bounded page returned while navigating one tokenized directory. */
export const BrowsePageSchema = z.strictObject({
  directory: BrowseRootSchema,
  parentToken: browseTokenSchema.nullable(),
  entries: z.array(BrowseEntrySchema).max(500),
  nextCursor: z.string().min(1).max(1_024).nullable(),
  truncated: z.boolean(),
});

/** Response from `GET /api/v1/system/filesystem/roots`. */
export const FilesystemRootsResponseSchema = z.strictObject({
  roots: z.array(BrowseRootSchema),
});

/** Body for the bounded filesystem entries query. */
export const FilesystemEntriesRequestSchema = z.strictObject({
  token: browseTokenSchema,
  cursor: z.string().min(1).max(1_024).optional(),
});

/** Response from the bounded filesystem entries query. */
export const FilesystemEntriesResponseSchema = BrowsePageSchema;

/** Body for creating exactly one child directory under a tokenized parent. */
export const CreateSystemDirectoryRequestSchema = z.strictObject({
  parentToken: browseTokenSchema,
  name: z.string().min(1).max(255).regex(/^(?!\.{1,2}$)[^/\\\0]+$/),
});

/** Created directory metadata, including the token used to select or enter it. */
export const CreateSystemDirectoryResponseSchema = z.strictObject({
  entry: BrowseEntrySchema,
});

/** Six observable lifecycle states of the mutable workspace foundation. */
export const SystemWorkspaceStateSchema = z.enum([
  "none",
  "starting",
  "active",
  "switching",
  "reacquiring",
  "failed",
]);

/** Browser-visible active workspace identity. */
export const SystemWorkspaceInfoSchema = z.strictObject({
  root: displayPathSchema,
  name: z.string().min(1).max(255),
});

/** Current host workspace state, including a retained lease-loss explanation. */
export const SystemWorkspaceSchema = z.strictObject({
  state: SystemWorkspaceStateSchema,
  workspace: SystemWorkspaceInfoSchema.optional(),
  error: ErrorDetailSchema.optional(),
});

/** Runtime archive state visible to a newly connected browser session. */
export const SystemRuntimeArchiveSchema = z.strictObject({
  key: z.string().min(1).max(255),
  status: z.enum(["ready", "preparing", "broken"]),
  version: z.string().min(1).max(255),
});

/** Current embedded-runtime preparation state. */
export const SystemRuntimeSchema = z.strictObject({
  state: z.enum(["ready", "preparing", "broken"]),
  archives: z.array(SystemRuntimeArchiveSchema),
  startedAt: isoTimestampSchema.optional(),
});

const bridgeWorkspaceRootSchema = z.string().min(1).max(4_096);
const bridgeProtocolVersionSchema = z.string().min(1).max(64);

/** Client classes that may hold a short-lived daemon attachment. */
export const BridgeClientKindSchema = z.enum(["bridge", "ui", "render"]);

/** Identity proof requested before a bridge may invoke its first tool. */
export const BridgeHandshakeRequestSchema = z.strictObject({
  workspaceRoot: bridgeWorkspaceRootSchema,
  expectedInstanceId: identifierSchema,
  clientKind: BridgeClientKindSchema,
  clientVersion: z.string().min(1).max(255),
});

/** Canonical daemon identity and supported protocol revisions. */
export const BridgeHandshakeResponseSchema = z.strictObject({
  workspaceRoot: bridgeWorkspaceRootSchema,
  instanceId: identifierSchema,
  protocolVersions: z.array(bridgeProtocolVersionSchema).min(1),
  daemonVersion: z.string().min(1).max(255),
});

/** Body that creates one daemon-owned attachment lease. */
export const BridgeAttachmentCreateRequestSchema = z.strictObject({
  kind: BridgeClientKindSchema,
});

/** Lease identity and cadence returned to an attached client. */
export const BridgeAttachmentCreateResponseSchema = z.strictObject({
  attachmentId: z.string().regex(/^[0-9a-f]{64}$/),
  heartbeatEveryMs: z.number().int().positive(),
  expiresAt: isoTimestampSchema,
});

/** Path parameters shared by attachment renew and detach endpoints. */
export const BridgeAttachmentParamsSchema = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Renew has no mutable client-controlled fields; identity comes from the path. */
export const BridgeAttachmentRenewRequestSchema = z.strictObject({});

/** New expiry returned after a successful attachment heartbeat. */
export const BridgeAttachmentRenewResponseSchema = z.strictObject({
  expiresAt: isoTimestampSchema,
});

/** Protocol-neutral tool input carried from the MCP bridge to its daemon. */
export const BridgeToolInvokeRequestSchema = z.strictObject({
  // A no-input tool is sent without this property because JSON.stringify drops
  // `undefined`; the daemon route deliberately accepts that shape.
  input: z.unknown().optional(),
  protocolVersion: bridgeProtocolVersionSchema,
  era: z.enum(["legacy", "modern"]),
  requestState: z.unknown().optional(),
});

/**
 * Raw successful tool payload returned by the daemon.
 *
 * Its concrete schema belongs to the named tool in `TOOL_SCHEMA_CATALOGUE`;
 * wrapping it in `{ ok, value }` here would describe a wire envelope that the
 * bridge never sends.
 */
export const BridgeToolInvokeResponseSchema = z.unknown();

/** Standard HTTP error envelope used when a bridge tool invocation fails. */
export const BridgeToolInvokeErrorResponseSchema = ErrorResponseSchema.extend({
  // Write conflicts also expose the authoritative state at the HTTP boundary.
  current: z.unknown().optional(),
});

export const ListProjectsResponseSchema = z.strictObject({
  projects: z.array(ProjectSummarySchema),
});

export const ProjectParamsSchema = z.strictObject({ id: identifierSchema });
export const JobParamsSchema = z.strictObject({ jobId: identifierSchema });
export const AssetParamsSchema = z.strictObject({
  id: identifierSchema,
  path: relativePathSchema,
});

export const ProjectFileSchema = z.strictObject({
  path: relativePathSchema,
  content: z.string(),
  contentHash: contentHashSchema,
});

export const StudioSnapshotResponseSchema = z.strictObject({
  project: ProjectSummarySchema,
  entryFile: ProjectFileSchema,
  tree: z.array(FileNodeSchema),
  scenes: z.array(SceneSchema),
  rootTrack: RootTrackSchema.nullable(),
  previewSettings: PreviewSettingsSchema,
  previewSettingsRevision: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  projectRevision: z.number().int().nonnegative(),
  entityRevision: z.number().int().nonnegative(),
  fileHashes: z.record(z.string(), contentHashSchema),
  recovery: ProjectRecoveryStatusSchema,
  diagnostics: z.array(DiagnosticSchema),
});

export const ReadProjectFileQuerySchema = z.strictObject({ path: relativePathSchema });
export const ReadProjectFileResponseSchema = z.strictObject({ file: ProjectFileSchema });

export const PutProjectFileRequestSchema = z.strictObject({
  path: relativePathSchema,
  content: z.string().max(MAX_SOURCE_BYTES),
  expectedContentHash: z.string().max(255).nullable(),
});
export const PutProjectFileResponseSchema = z.strictObject({
  file: ProjectFileSchema,
  revision: z.number().int().nonnegative(),
  diagnostics: z.array(DiagnosticSchema),
  changeSeq: z.number().int().nonnegative().nullable(),
});

export const WriteConflictResponseSchema = ErrorResponseSchema.extend({
  current: z.strictObject({
    content: z.string(),
    contentHash: contentHashSchema,
    revision: z.number().int().nonnegative(),
  }),
});

export const PatchPreviewSettingsRequestSchema = z.strictObject({
  patch: PreviewSettingsPatchSchema,
  expectedRevision: z.number().int().nonnegative(),
});
export const PatchPreviewSettingsResponseSchema = z.strictObject({
  previewSettings: PreviewSettingsSchema,
  revision: z.number().int().nonnegative(),
  diagnostics: z.array(DiagnosticSchema),
  changeSeq: z.number().int().nonnegative().nullable(),
});

/** Job states after which no further handler execution may settle the job. */
export const TERMINAL_JOB_STATUSES = ["succeeded", "partial", "failed", "cancelled"] as const;

export const JobWarningSchema = z.strictObject({
  code: z.enum(WarningCode),
  message: z.string().min(1),
});

export const JobSchema = z.strictObject({
  id: identifierSchema,
  type: z.string().min(1),
  status: z.enum(["queued", "running", ...TERMINAL_JOB_STATUSES]),
  progress: z.number().min(0).max(1),
  stage: z.string().nullable(),
  result: z.unknown().nullable(),
  error: ErrorDetailSchema.nullable(),
  warnings: z.array(JobWarningSchema).nullable(),
  cleanupPending: z.boolean(),
  attempt: z.number().int().nonnegative(),
  createdAt: isoTimestampSchema,
  startedAt: isoTimestampSchema.nullable(),
  finishedAt: isoTimestampSchema.nullable(),
});
export const GetJobResponseSchema = JobSchema;
export const CancelJobResponseSchema = NoContentResponseSchema;

export const EventsHeadersSchema = z.strictObject({
  lastEventId: z.coerce.number().int().nonnegative().optional(),
});
export const DomainEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    id: z.number().int().positive(),
    type: z.enum(PROJECT_DOMAIN_EVENT_TYPES),
    projectId: identifierSchema,
    payload: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    id: z.number().int().positive(),
    type: z.enum(HOST_DOMAIN_EVENT_TYPES),
    projectId: z.null(),
    payload: z.record(z.string(), z.unknown()),
  }),
]);

export const AssetResponseSchema = z.instanceof(Uint8Array);

export const UploadBgmRequestSchema = z.strictObject({
  file: z.file().max(MAX_BGM_BYTES),
  expectedRevision: z.preprocess(
    (value) => typeof value === "string" && value.trim() !== "" ? Number(value) : value,
    z.number().int().nonnegative(),
  ),
});
export const UploadBgmResponseSchema = PatchPreviewSettingsResponseSchema;

export const PatchSceneTimingRequestSchema = z.strictObject({
  timing: z.strictObject({
    start: z.number().nonnegative().optional(),
    duration: z.number().positive().optional(),
    trackIndex: z.number().int().nonnegative().optional(),
  }),
  expectedContentHash: contentHashSchema,
});
export const PatchSceneTimingResponseSchema = PutProjectFileResponseSchema;
export const PatchSceneScriptRequestSchema = z.strictObject({
  file: relativePathSchema,
  elementId: identifierSchema,
  text: z.string(),
  expectedContentHash: contentHashSchema,
});
export const PatchSceneScriptResponseSchema = PutProjectFileResponseSchema;

export const LegacySceneMutationRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("tts"),
    sceneId: identifierSchema,
    text: z.string().min(1),
  }),
  z.strictObject({ action: z.literal("generate"), prompt: z.string().min(1) }),
]);
export const LegacyTtsResponseSchema = z.strictObject({
  ok: z.literal(true),
  narration: SceneSchema.shape.narration.unwrap(),
  changeSeq: z.number().int().nonnegative().nullable(),
});
export const LegacyGenerateResponseSchema = z.strictObject({
  ok: z.literal(true),
  sceneId: identifierSchema,
  changeSeq: z.number().int().nonnegative().nullable(),
  transcript: z.array(
    z.strictObject({
      kind: z.enum(["command", "output", "muted", "accent"]),
      text: z.string(),
    }),
  ),
});

export type ProjectSummaryDto = z.infer<typeof ProjectSummarySchema>;
export type SceneDto = z.infer<typeof SceneSchema>;
export type StudioSnapshotResponse = z.infer<typeof StudioSnapshotResponseSchema>;
export type PreviewSettingsDto = z.infer<typeof PreviewSettingsSchema>;
export type PreviewSettingsPatchDto = z.infer<typeof PreviewSettingsPatchSchema>;
export type JobDto = z.infer<typeof JobSchema>;
export type JobStatus = JobDto["status"];
export type JobWarningDto = z.infer<typeof JobWarningSchema>;
export type DomainEventDto = z.infer<typeof DomainEventSchema>;
export type BrowseRootDto = z.infer<typeof BrowseRootSchema>;
export type BrowseEntryDto = z.infer<typeof BrowseEntrySchema>;
export type BrowsePage = z.infer<typeof BrowsePageSchema>;
export type SystemWorkspaceDto = z.infer<typeof SystemWorkspaceSchema>;
export type SystemRuntimeDto = z.infer<typeof SystemRuntimeSchema>;
export type BridgeClientKind = z.infer<typeof BridgeClientKindSchema>;
export type BridgeHandshakeRequest = z.infer<typeof BridgeHandshakeRequestSchema>;
export type BridgeHandshakeResponse = z.infer<typeof BridgeHandshakeResponseSchema>;
export type BridgeToolInvokeRequest = z.infer<typeof BridgeToolInvokeRequestSchema>;
export type BridgeToolInvokeResponse = z.infer<typeof BridgeToolInvokeResponseSchema>;
export type BridgeToolInvokeErrorResponse = z.infer<typeof BridgeToolInvokeErrorResponseSchema>;

/**
 * Entry listing is a POST, not a GET.
 *
 * The body carries a browse token rather than a path, but the response names
 * real directories, and a GET puts its input in the request line — where access
 * logs, proxies and browser history all keep it.
 */
export const BrowseEntriesRequestSchema = z.strictObject({
  token: z.string().min(1).max(256),
  cursor: z.string().max(64).optional(),
});

export const CreateDirectoryRequestSchema = z.strictObject({
  parentToken: z.string().min(1).max(256),
  name: z.string().min(1).max(255),
});
