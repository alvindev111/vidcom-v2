import type { z } from "zod";

import {
  ListProjectAssetsInputSchema,
  ListProjectAssetsOutputSchema,
  SetPreviewSettingsInputSchema,
  SetPreviewSettingsOutputSchema,
  type PreviewSettingsPatchDto,
  type ProjectId,
} from "@vidcom/contracts";
import {
  assertBgmTrackReadable,
  listProjectAssets,
  ok,
  patchPreviewSettings,
  type ProjectReadDependencies,
  type ProjectWriteDependencies,
} from "@vidcom/core";

import { annotationsForLevel, ToolRegistry } from "./registry";
import type { ToolDefinition } from "./types";

export type AssetToolDependencies = ProjectWriteDependencies & { reads: ProjectReadDependencies };

/**
 * Reports the media that is already in the project directory.
 *
 * A person who drops a track into `preview-assets/bgm/` performs no upload and
 * fires no event an MCP client can hear, so a headless agent has no other way to
 * find out the file arrived.
 */
export function listProjectAssetsTool(
  dependencies: AssetToolDependencies,
): ToolDefinition<z.infer<typeof ListProjectAssetsInputSchema>, z.infer<typeof ListProjectAssetsOutputSchema>> {
  return {
    name: "list_project_assets",
    title: "List project media assets",
    level: "read",
    description: [
      "Use when you need to discover the audio, image, video and font files that exist in the project, including one a person just copied into it by hand.",
      "Do not use to read composition source, to list scenes, or to browse anything outside this project.",
      "Preconditions: projectId comes from list_projects; pass directory to narrow to one project-relative folder such as preview-assets/bgm or assets.",
      "Side effects: read-only; nothing is written and no revision is created.",
      "Errors/recovery: path_invalid means the directory is not project-relative; truncated=true means only the first page is listed, so narrow with directory; referencedByPreviewSettings=true marks the track preview settings already point at.",
    ].join(" "),
    input: ListProjectAssetsInputSchema,
    output: ListProjectAssetsOutputSchema,
    annotations: annotationsForLevel("read"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (_context, input) => listProjectAssets(dependencies.reads, {
      projectId: input.projectId as ProjectId,
      ...(input.directory === undefined ? {} : { directory: input.directory }),
    }),
  };
}

/**
 * Patches tone, theme, subtitles, per-scene flags and background music.
 *
 * A BGM track is verified against the project directory first: preview settings
 * accept any relative path, and a track that is not there fails silently at
 * playback instead of at the call that set it.
 */
export function setPreviewSettingsTool(
  dependencies: AssetToolDependencies,
): ToolDefinition<z.infer<typeof SetPreviewSettingsInputSchema>, z.infer<typeof SetPreviewSettingsOutputSchema>> {
  return {
    name: "set_preview_settings",
    title: "Patch preview settings",
    level: "write",
    description: [
      "Use when changing tone, theme variables, subtitle styling, per-scene transition or reveal sounds, or attaching background music from a file already in the project.",
      "Do not use to edit composition source, to upload bytes, or to change scene timing.",
      "Preconditions: projectId and expectedRevision come from get_project_context; a bgm.track path must name an existing mp3, wav, ogg or m4a asset listed by list_project_assets, and setting bgm.track to null detaches the music.",
      "Side effects: merges the patch into preview-settings.json as one journaled entity mutation, returning the complete settings and their new revision.",
      "Errors/recovery: no_file or unsupported_media means the track is missing or not audio, so run list_project_assets; write_conflict means expectedRevision is stale, so re-read get_project_context; never retry a committed_response_error mutation.",
    ].join(" "),
    input: SetPreviewSettingsInputSchema,
    output: SetPreviewSettingsOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => {
      const projectId = input.projectId as ProjectId;
      const track = input.patch.bgm?.track;
      if (track) {
        const readable = await assertBgmTrackReadable(dependencies.reads, { projectId, path: track.path });
        if (!readable.ok) return readable;
      }
      const patched = await patchPreviewSettings(dependencies, {
        projectId,
        patch: input.patch as PreviewSettingsPatchDto,
        expectedRevision: input.expectedRevision,
      }, context.actor, context.writeInvocation);
      return patched.ok ? ok(SetPreviewSettingsOutputSchema.parse(patched.value)) : patched;
    },
  };
}

export function registerAssetTools(registry: ToolRegistry, dependencies: AssetToolDependencies): void {
  registry.register(listProjectAssetsTool(dependencies));
  registry.register(setPreviewSettingsTool(dependencies));
}
