import { z } from "zod";

import { ContentHashSchema, IdentifierSchema, RelativePathSchema } from "./dto";

/** Browser-generated operation identity shared by upload, mount, HTTP and MCP retry contracts. */
export const PendingMountOperationIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);

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
