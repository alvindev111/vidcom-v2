import { z } from "zod";

import {
  ContentHashSchema,
  DiagnosticSchema,
  IdentifierSchema,
  MAX_SOURCE_BYTES,
  PreviewSettingsSchema,
  ProjectSummarySchema,
  ProjectRecoveryStatusSchema,
  RelativePathSchema,
  RootTrackSchema,
} from "./dto";

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
  expectedContentHash: ContentHashSchema,
});
/** Output for `create_scene`. */
export const CreateSceneOutputSchema = z.strictObject({
  scene: SceneContextSchema,
  project: ProjectSummarySchema,
  envelope: WriteEnvelopeSchema,
});

/** Input for `set_scene_timing`. */
export const SetSceneTimingInputSchema = z.strictObject({
  ...projectIdInput,
  sceneId: IdentifierSchema,
  start: z.number().finite().optional(),
  duration: z.number().finite().optional(),
  trackIndex: z.number().int().optional(),
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

export type SceneContext = z.infer<typeof SceneContextSchema>;
