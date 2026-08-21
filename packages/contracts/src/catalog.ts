import { z } from "zod";

import { ContentHashSchema, DiagnosticSchema, IdentifierSchema, RelativePathSchema } from "./dto";

/**
 * Shared catalog contracts (Design §5.16, §7.12, §7.13a/b).
 *
 * Two rules shape these schemas. The client never sends anything the server must
 * trust — no digest, no file list, no plan — because every one of those is
 * recomputed before a write. And the server never sends anything local: no cache
 * path, no staged source, no registry URL, so a listing cannot be turned into a
 * fetch target or a filesystem hint.
 */

const CATALOG_ITEM_KINDS = ["template", "block", "motion-graphic", "start-end", "video"] as const;
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/u);

export const CatalogItemKindSchema = z.enum(CATALOG_ITEM_KINDS);

export const CatalogCompatibilityWarningSchema = z.union([
  z.strictObject({ status: z.literal("compatible") }),
  z.strictObject({ status: z.literal("incompatible"), required: z.string().max(64), runtime: z.string().max(64) }),
  z.strictObject({ status: z.literal("unknown"), required: z.string().max(64) }),
]);

export const CatalogItemDtoSchema = z.strictObject({
  name: z.string().min(1).max(128),
  kind: CatalogItemKindSchema,
  title: z.string().max(256),
  description: z.string().max(2_048).nullable(),
  tags: z.array(z.string().max(64)).max(32),
  category: z.string().min(1).max(64),
  version: z.string().min(1).max(128),
  /** Present only once the package is verified; digests only, never bytes. */
  integrity: z.strictObject({
    manifest: DIGEST,
    files: z.record(z.string(), DIGEST),
  }).nullable(),
  materialization: z.enum(["metadata", "verified"]),
  source: z.strictObject({
    registry: z.enum(["bundled", "hyperframes"]),
    revision: z.string().regex(/^[0-9a-f]{40}$/u).nullable(),
    committedAt: z.string().max(64).nullable(),
  }),
  dependencies: z.array(z.string().max(128)).max(256),
  compatibility: z.strictObject({
    aspectRatios: z.array(z.string().max(16)).nullable(),
    minWidth: z.number().int().positive().nullable(),
    fps: z.array(z.number().finite().positive()).nullable(),
    minHyperframesVersion: z.string().max(64).nullable(),
  }),
  durationSeconds: z.number().finite().positive().nullable(),
  entry: RelativePathSchema,
  /** Project-relative preview inside the package; bundled items ship one. */
  previewPath: RelativePathSchema.nullable(),
  compatibilityWarning: CatalogCompatibilityWarningSchema.nullable(),
});

export const CatalogListResponseSchema = z.strictObject({
  items: z.array(CatalogItemDtoSchema),
  source: z.enum(["bundled", "cache", "network"]),
  stale: z.boolean(),
});

export const CatalogListQuerySchema = z.strictObject({
  kind: CatalogItemKindSchema.optional(),
  category: z.string().min(1).max(64).optional(),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  query: z.string().max(128).optional(),
});

export const CatalogMountSchema = z.union([
  z.strictObject({
    kind: z.literal("new-scene"),
    toIndex: z.number().int().nonnegative(),
    trackIndex: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({ kind: z.literal("into-scene"), sceneId: IdentifierSchema }),
]);

export const CatalogExistingPolicySchema = z.enum(["reuse", "replace", "skip"]);

export const CatalogInstallPrepareRequestSchema = z.strictObject({
  name: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  mount: CatalogMountSchema,
  existingPolicy: CatalogExistingPolicySchema.optional(),
  expectedRevision: z.number().int().nonnegative(),
});

export const CatalogInstallExecuteRequestSchema = CatalogInstallPrepareRequestSchema.extend({
  grantId: IdentifierSchema,
});

export const CatalogInstallPlanDtoSchema = z.strictObject({
  files: z.array(z.strictObject({
    path: RelativePathSchema,
    action: z.enum(["create", "replace", "reuse"]),
    fromHash: ContentHashSchema.nullable(),
    toDigest: DIGEST,
  })),
  directories: z.array(z.string().min(1)),
  mountTarget: RelativePathSchema,
  expectedRevision: z.number().int().nonnegative(),
  targetHashes: z.record(z.string(), ContentHashSchema),
  planDigest: ContentHashSchema,
});

export const CatalogInstallPrepareResponseSchema = z.union([
  z.strictObject({
    status: z.literal("choice_required"),
    comparison: z.enum(["identical", "newer", "older", "different", "unmanaged"]),
    choices: z.array(CatalogExistingPolicySchema).min(1).max(2),
    existing: z.strictObject({
      /** Null for an unmanaged file: the app must not invent a version. */
      version: z.string().max(128).nullable(),
      integrity: DIGEST.nullable(),
      targetHashes: z.record(z.string(), ContentHashSchema),
    }),
    candidate: z.strictObject({ version: z.string().min(1).max(128), integrity: DIGEST }),
  }),
  z.strictObject({ status: z.literal("skipped") }),
  z.strictObject({
    status: z.literal("ready"),
    grantId: IdentifierSchema,
    plan: CatalogInstallPlanDtoSchema,
  }),
]);

export const CatalogInstallResponseSchema = z.strictObject({
  packageStatus: z.enum(["installed", "reused", "replaced"]),
  files: z.array(z.strictObject({
    path: RelativePathSchema,
    action: z.enum(["create", "replace", "reuse"]),
  })),
  provenance: z.strictObject({
    name: z.string().min(1).max(128),
    title: z.string().max(256),
    description: z.string().max(2_048).nullable(),
    category: z.string().min(1).max(64),
    tags: z.array(z.string().max(64)).max(32),
    registry: z.enum(["bundled", "hyperframes"]),
    version: z.string().min(1).max(128),
    integrity: DIGEST,
  }),
  sceneId: IdentifierSchema.nullable(),
  revision: z.number().int().nonnegative(),
  diagnostics: z.array(DiagnosticSchema),
  changeSeq: z.number().int().nonnegative().nullable(),
});

export type CatalogItemDto = z.infer<typeof CatalogItemDtoSchema>;
export type CatalogListResponse = z.infer<typeof CatalogListResponseSchema>;
export type CatalogListQuery = z.infer<typeof CatalogListQuerySchema>;
export type CatalogInstallPrepareRequest = z.infer<typeof CatalogInstallPrepareRequestSchema>;
export type CatalogInstallExecuteRequest = z.infer<typeof CatalogInstallExecuteRequestSchema>;
export type CatalogInstallPrepareResponse = z.infer<typeof CatalogInstallPrepareResponseSchema>;
export type CatalogInstallResponse = z.infer<typeof CatalogInstallResponseSchema>;
export type CatalogCompatibilityWarning = z.infer<typeof CatalogCompatibilityWarningSchema>;
