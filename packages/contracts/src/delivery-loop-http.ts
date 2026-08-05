import { z } from "zod";

import { ContentHashSchema, IdentifierSchema } from "./dto";
import { InstallAgentKitInputSchema } from "./agent-kit";
import { MotionLibraryIdSchema } from "./motion-libraries";

/** Strict path parameters for project adoption by workspace slug. */
export const ProjectSlugParamsSchema = z.strictObject({ slug: IdentifierSchema });
/** Strict path parameters for scene-scoped delivery-loop operations. */
export const SceneParamsSchema = z.strictObject({ id: IdentifierSchema, sceneId: IdentifierSchema });
/** Strict path parameters for one narration cue. */
export const NarrationCueParamsSchema = SceneParamsSchema.extend({ cueId: IdentifierSchema });
/** Strict path parameters for recovery-entry operations. */
export const RecoveryEntryParamsSchema = z.strictObject({ entryId: IdentifierSchema });

export const ActivateWorkspaceRequestSchema = z.strictObject({ path: z.string().min(1).max(4096) });
export const CreateProjectRequestSchema = z.strictObject({
  name: z.string().min(1).max(255),
  presetId: z.enum(["vertical-shorts", "horizontal-youtube", "custom"]),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  fps: z.number().int().optional(),
});
export const RenameProjectRequestSchema = z.strictObject({ name: z.string().min(1).max(255) });
export const DeleteProjectRequestSchema = z.strictObject({
  confirmed: z.literal(true),
  grantId: IdentifierSchema.optional(),
});
export const EnqueueRenderRequestSchema = z.strictObject({
  bestEffort: z.boolean().optional(),
  renderPresetId: IdentifierSchema.optional(),
  idempotencyKey: z.string().min(1).max(255),
});
export const EnqueueSnapshotRequestSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(255),
});
export const SceneTimingHttpRequestSchema = z.strictObject({
  start: z.number().finite().optional(),
  duration: z.number().finite().optional(),
  trackIndex: z.number().int().optional(),
  ripple: z.boolean(),
  extendRoot: z.boolean().optional(),
  expectedContentHash: ContentHashSchema,
}).refine((value) => value.start !== undefined || value.duration !== undefined || value.trackIndex !== undefined, {
  message: "at least one timing field is required",
});
export const NarrationCueInputSchema = z.strictObject({
  cueId: IdentifierSchema,
  text: z.string(),
  voice: z.string().min(1),
  offsetSeconds: z.number().nonnegative(),
});
export const ReplaceNarrationCuesRequestSchema = z.strictObject({
  cues: z.array(NarrationCueInputSchema),
  expectedContentHash: ContentHashSchema.nullable(),
});
export const PatchNarrationCueRequestSchema = z.strictObject({
  text: z.string().optional(),
  voice: z.string().min(1).optional(),
  offsetSeconds: z.number().nonnegative().optional(),
  expectedContentHash: ContentHashSchema,
}).refine((value) => value.text !== undefined || value.voice !== undefined || value.offsetSeconds !== undefined, {
  message: "at least one cue field is required",
});
/** Body for vendoring one pinned motion library into a project. */
export const InstallMotionLibraryRequestSchema = z.strictObject({
  libraryId: MotionLibraryIdSchema,
});
export const ReplaceRecoveryIdentityRequestSchema = z.strictObject({
  identity: z.record(z.string(), z.unknown()),
  expectedContentHash: ContentHashSchema,
});
export { InstallAgentKitInputSchema };
