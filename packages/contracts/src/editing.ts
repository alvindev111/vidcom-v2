import { z } from "zod";

import {
  ContentHashSchema,
  DiagnosticSchema,
  IdentifierSchema,
  PreviewSettingsPatchSchema,
  ProjectFileSchema,
  ProjectSummarySchema,
  RelativePathSchema,
} from "./dto";

/** One canonical ULID contract for browser-owned ephemeral identities. */
export const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);

/** Browser-generated operation identity shared by upload, mount, HTTP and MCP retry contracts. */
export const PendingMountOperationIdSchema = UlidSchema;

/** Browser-generated identity for one mounted editor history stack. */
export const StudioSessionIdSchema = UlidSchema;

const expectedSource = { expectedContentHash: ContentHashSchema } as const;
const sceneIds = z.array(IdentifierSchema).min(1).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "sceneIds must be unique" });
  }
});

/** Shared HTTP/MCP payload for §7.2 scene ordering. */
export const ReorderScenesRequestSchema = z.strictObject({
  sceneId: IdentifierSchema,
  toIndex: z.number().int().nonnegative(),
  toTrackIndex: z.number().int().nonnegative().optional(),
  extendRoot: z.boolean().optional(),
  ...expectedSource,
});

/** §7.2b is intentionally separate from reorder; no scene or compact flag is accepted. */
export const CompactTrackRequestSchema = z.strictObject({
  extendRoot: z.boolean().optional(),
  ...expectedSource,
});

export const TrackIndexParamsSchema = z.strictObject({
  id: IdentifierSchema,
  trackIndex: z.preprocess(
    (value) => typeof value === "string" && value.trim() !== "" ? Number(value) : value,
    z.number().int().nonnegative(),
  ),
});

/** Shared HTTP/MCP payload for one all-or-nothing group shift. */
export const MoveScenesRequestSchema = z.strictObject({
  sceneIds,
  deltaSeconds: z.number().finite(),
  extendRoot: z.boolean().optional(),
  ...expectedSource,
});

export const PrepareDeleteScenesRequestSchema = z.strictObject({
  sceneIds,
  expectedRevision: z.number().int().nonnegative(),
});

/** Exact intent repeated at destructive execute; grantId remains in the HTTP path/MCP envelope. */
export const DeleteScenesRequestSchema = PrepareDeleteScenesRequestSchema;

export const SceneOrderChangeSchema = z.strictObject({
  sceneId: IdentifierSchema,
  start: z.number().finite().nonnegative().optional(),
  trackIndex: z.number().int().nonnegative().optional(),
});

export const SceneOrderMutationResponseSchema = z.strictObject({
  changed: z.boolean(),
  changes: z.array(SceneOrderChangeSchema),
  file: ProjectFileSchema,
  revision: z.number().int().nonnegative(),
  diagnostics: z.array(DiagnosticSchema),
  changeSeq: z.number().int().nonnegative().nullable(),
});

export const DeleteScenesPlanSchema = z.strictObject({
  sceneIds,
  entry: RelativePathSchema,
  deleteFiles: z.array(RelativePathSchema),
  keptFiles: z.array(RelativePathSchema),
  narrationFiles: z.array(RelativePathSchema),
  rootDuration: z.number().finite().nonnegative(),
  previewSettingsPatch: PreviewSettingsPatchSchema.nullable(),
  targetHashes: z.record(z.string(), ContentHashSchema),
  diagnostics: z.array(DiagnosticSchema),
});

export const PrepareDeleteScenesResponseSchema = z.strictObject({
  plan: DeleteScenesPlanSchema,
  grantId: IdentifierSchema,
});

export const DeleteScenesResponseSchema = z.strictObject({
  project: ProjectSummarySchema,
  revision: z.number().int().nonnegative(),
  diagnostics: z.array(DiagnosticSchema),
  changeSeq: z.number().int().nonnegative().nullable(),
  backupId: IdentifierSchema,
  deletedFiles: z.array(RelativePathSchema),
  keptFiles: z.array(RelativePathSchema),
});

export const PendingMountFailureSchema = z.strictObject({
  code: z.string().min(1).max(255),
  message: z.string().min(1).max(2_048),
});

export const PendingMountSchema = z.strictObject({
  operationId: PendingMountOperationIdSchema,
  projectId: IdentifierSchema,
  assetPath: RelativePathSchema,
  assetContentHash: ContentHashSchema,
  uploadFingerprint: ContentHashSchema,
  atSeconds: z.number().finite().nonnegative(),
  trackIndex: z.number().int().nonnegative(),
  state: z.enum(["uploaded_unmounted", "mounted", "abandoned"]),
  lastFailure: PendingMountFailureSchema.nullable(),
  mountedSceneId: IdentifierSchema.nullable(),
  mountedRevision: z.number().int().positive().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
}).superRefine((record, context) => {
  const hasResult = record.mountedSceneId !== null && record.mountedRevision !== null;
  const lacksResult = record.mountedSceneId === null && record.mountedRevision === null;
  const valid = record.state === "mounted"
    ? hasResult && record.lastFailure === null
    : record.state === "abandoned"
      ? lacksResult && record.lastFailure !== null
      : lacksResult;
  if (!valid) {
    context.addIssue({
      code: "custom",
      message: "pending mount state, failure and mounted result are inconsistent",
    });
  }
});

export type PendingMountDto = z.infer<typeof PendingMountSchema>;
