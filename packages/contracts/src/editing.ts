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

const queryInteger = z.preprocess(
  (value) => typeof value === "string" && value.trim() !== "" ? Number(value) : value,
  z.number().int().nonnegative(),
);
const queryNumber = z.preprocess(
  (value) => typeof value === "string" && value.trim() !== "" ? Number(value) : value,
  z.number().finite().nonnegative(),
);

export const UploadAssetQuerySchema = z.strictObject({
  kind: z.enum(["image", "video", "audio", "font"]),
  filename: z.string().min(1).max(255),
  expectedRevision: queryInteger,
  operationId: PendingMountOperationIdSchema.optional(),
  atSeconds: queryNumber.optional(),
  trackIndex: queryInteger.optional(),
}).superRefine((value, context) => {
  const pending = [value.operationId, value.atSeconds, value.trackIndex];
  if (pending.some((item) => item !== undefined) && pending.some((item) => item === undefined)) {
    context.addIssue({ code: "custom", message: "pending mount metadata must be supplied together" });
  }
});

export const CreateEntryRequestSchema = z.strictObject({
  path: RelativePathSchema,
  kind: z.enum(["file", "folder"]),
  expectedRevision: z.number().int().nonnegative(),
});

const renameEntryBase = {
  from: RelativePathSchema,
  to: RelativePathSchema,
  expectedRevision: z.number().int().nonnegative(),
} as const;

export const RenameEntryRequestSchema = z.union([
  z.strictObject({ ...renameEntryBase, expectedContentHash: ContentHashSchema }),
  z.strictObject({ ...renameEntryBase, expectedTreeDigest: ContentHashSchema }),
]);

export const DeleteEntryRequestSchema = z.strictObject({
  path: RelativePathSchema,
  recursive: z.boolean(),
  expectedRevision: z.number().int().nonnegative(),
});

export const ApplyFontRequestSchema = z.strictObject({
  fontPath: RelativePathSchema,
  fontContentHash: ContentHashSchema,
  scope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("project") }),
    z.strictObject({ kind: z.literal("scene"), sceneId: IdentifierSchema }),
  ]),
  expectedContentHash: ContentHashSchema,
});

export const AssetMetadataSchema = z.union([
  z.strictObject({ status: z.literal("unknown"), byteSize: z.number().int().nonnegative().nullable(), reason: z.string() }),
  z.strictObject({
    status: z.literal("ok"), kind: z.literal("media"), byteSize: z.number().int().nonnegative(),
    durationSeconds: z.number().finite().nonnegative().nullable(), width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(), codec: z.string().nullable(),
  }),
  z.strictObject({
    status: z.literal("ok"), kind: z.literal("font"), byteSize: z.number().int().nonnegative(),
    family: z.string(), style: z.string(),
  }),
]);

const mutationEnvelope = {
  revision: z.number().int().nonnegative(),
  diagnostics: z.array(DiagnosticSchema),
  changeSeq: z.number().int().nonnegative().nullable(),
} as const;

export const UploadAssetResponseSchema = z.strictObject({
  path: RelativePathSchema, renamedFrom: z.string().nullable(), assetContentHash: ContentHashSchema,
  metadata: AssetMetadataSchema, replayed: z.boolean(), revision: z.number().int().nonnegative(),
  changeSeq: z.number().int().nonnegative().nullable(),
});

export const CreateEntryResponseSchema = z.strictObject({
  path: RelativePathSchema, kind: z.enum(["file", "folder"]), ...mutationEnvelope,
});

export const RenameEntryResponseSchema = z.strictObject({
  from: RelativePathSchema, to: RelativePathSchema, backupId: IdentifierSchema, ...mutationEnvelope,
});

export const DeleteEntryPlanSchema = z.strictObject({
  path: RelativePathSchema, recursive: z.boolean(), expectedRevision: z.number().int().nonnegative(),
  rootKind: z.enum(["file", "folder"]),
  entries: z.array(z.strictObject({
    path: RelativePathSchema, kind: z.enum(["file", "folder"]), contentHash: ContentHashSchema.nullable(),
  })),
  targetHashes: z.record(z.string(), ContentHashSchema), planDigest: ContentHashSchema,
});

export const PrepareDeleteEntryResponseSchema = z.strictObject({ plan: DeleteEntryPlanSchema, grantId: IdentifierSchema });
export const DeleteEntryResponseSchema = z.strictObject({
  deleted: RelativePathSchema, backupId: IdentifierSchema, ...mutationEnvelope,
});
export const ApplyFontResponseSchema = z.strictObject({
  path: RelativePathSchema, family: z.string(), style: z.string(), ...mutationEnvelope,
});

/** §7.14 precondition and overflow policy, identical on both arms of the mount union. */
const mountPolicy = {
  ...expectedSource,
  onOverflow: z.enum(["shrink", "extend-root"]),
} as const;

/**
 * §7.14. A retry carries its operation id and nothing else: placement lives in the
 * server-side record, so a payload that also sends a path or a time is rejected
 * rather than silently redirecting the mount.
 */
export const MountAssetRequestSchema = z.union([
  z.strictObject({
    assetPath: RelativePathSchema,
    assetContentHash: ContentHashSchema,
    atSeconds: z.number().finite().nonnegative(),
    trackIndex: z.number().int().nonnegative(),
    ...mountPolicy,
  }),
  z.strictObject({ operationId: PendingMountOperationIdSchema, ...mountPolicy }),
]);

export const MountAssetResponseSchema = z.strictObject({
  sceneId: IdentifierSchema,
  durationSeconds: z.number().finite().positive(),
  /** True when a retry was answered from the recorded mount instead of a new one. */
  replayed: z.boolean(),
  ...mutationEnvelope,
});

/** §7.14b path parameters; every branch requires the operation to be in this project. */
export const PendingMountParamsSchema = z.strictObject({
  id: IdentifierSchema,
  operationId: PendingMountOperationIdSchema,
});

export const PendingMountListResponseSchema = z.strictObject({
  items: z.array(PendingMountSchema),
});
