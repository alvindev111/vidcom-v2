import type { z } from "zod";

import {
  ErrorCode,
  GenerateCaptionsInputSchema,
  GenerateCaptionsOutputSchema,
  InstallCatalogItemInputSchema,
  InstallCatalogItemOutputSchema,
  ListCatalogItemsInputSchema,
  ListCatalogItemsOutputSchema,
  MountAssetInputSchema,
  MountAssetOutputSchema,
  DeleteScenesInputSchema,
  DeleteScenesOutputSchema,
  MoveScenesInputSchema,
  MoveScenesOutputSchema,
  ReorderScenesInputSchema,
  ReorderScenesOutputSchema,
  type ContentHash,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import {
  catalogItemDto,
  deleteScenes,
  err,
  executeCatalogInstall,
  generateCaptions,
  moveScenes,
  mountAsset,
  prepareCatalogInstall,
  prepareDeleteScenes,
  readSourceFile,
  reorderScenes,
  type CatalogInstallExecuteDependencies,
  type CatalogListFilter,
  type CatalogListing,
  type GenerateCaptionsDependencies,
  type MountAssetDependencies,
  type ProjectReadDependencies,
  type ProjectWriteDependencies,
  type DeleteScenesDependencies,
} from "@vidcom/core";

import { annotationsForLevel, ToolRegistry } from "./registry";
import { requestDestructiveApproval } from "./destructive-tools";
import type { RegistryApprovalDependencies, ToolDefinition } from "./types";

export type EditingToolDependencies = ProjectWriteDependencies
  & DeleteScenesDependencies
  & GenerateCaptionsDependencies
  & RegistryApprovalDependencies
  & {
    reads: ProjectReadDependencies;
    mount: MountAssetDependencies;
    catalog: { list(filter: CatalogListFilter): Promise<CatalogListing> };
    catalogInstall: CatalogInstallExecuteDependencies;
  };

/** The entry composition as the HTTP surface returns it beside a scene-order write. */
async function entryFile(dependencies: EditingToolDependencies, projectId: ProjectId) {
  return readSourceFile(dependencies.reads, projectId, "index.html" as RelPath);
}

export function reorderScenesTool(
  dependencies: EditingToolDependencies,
): ToolDefinition<z.infer<typeof ReorderScenesInputSchema>, z.infer<typeof ReorderScenesOutputSchema>> {
  return {
    name: "reorder_scenes",
    title: "Reorder one scene",
    level: "write",
    description: [
      "Use when moving one existing scene to a different position, or onto a different track, and letting the timeline close the gap it leaves.",
      "Do not use to change a scene's own start or duration, to move several scenes together, or to delete one.",
      "Preconditions: sceneId, toIndex and expectedContentHash come from read_composition or get_project_context; pass extendRoot only after a root-overflow refusal that says it is allowed.",
      "Side effects: rewrites the entry composition in one revision, shifting the scenes the move displaces and growing the root only when extendRoot was asked for.",
      "Errors/recovery: on write_conflict re-read the entry composition; a duration_overflow names the limit it hit; on recovery_required stop writes and recover; committed_response_error means the mutation committed, so do not retry it.",
    ].join(" "),
    input: ReorderScenesInputSchema,
    output: ReorderScenesOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => {
      const projectId = input.projectId as ProjectId;
      const ordered = await reorderScenes(dependencies, {
        projectId,
        sceneId: input.sceneId,
        toIndex: input.toIndex,
        ...(input.toTrackIndex === undefined ? {} : { toTrackIndex: input.toTrackIndex }),
        ...(input.extendRoot === undefined ? {} : { extendRoot: input.extendRoot }),
        expectedContentHash: input.expectedContentHash as ContentHash,
      }, context.actor, context.writeInvocation);
      if (!ordered.ok) return ordered;
      const file = await entryFile(dependencies, projectId);
      if (!file.ok) return file;
      return {
        ok: true as const,
        value: {
          changed: ordered.value.changed,
          changes: ordered.value.changes,
          file: file.value,
          revision: ordered.value.envelope?.projectRevision ?? ordered.value.project.revision,
          diagnostics: ordered.value.diagnostics,
          changeSeq: ordered.value.envelope?.changeSeq ?? null,
        },
      };
    },
  };
}

export function moveScenesTool(
  dependencies: EditingToolDependencies,
): ToolDefinition<z.infer<typeof MoveScenesInputSchema>, z.infer<typeof MoveScenesOutputSchema>> {
  return {
    name: "move_scenes",
    title: "Move several scenes together",
    level: "write",
    description: [
      "Use when shifting a whole selection of scenes by the same amount of time while keeping the gaps between them.",
      "Do not use to reorder one scene, to change durations, or to move scenes onto another track.",
      "Preconditions: sceneIds must be unique and current, deltaSeconds is the shift in seconds, and expectedContentHash comes from read_composition; pass extendRoot only after a root-overflow refusal that says it is allowed.",
      "Side effects: applies the whole shift in one revision or none of it, so a refused group leaves the timeline untouched.",
      "Errors/recovery: on write_conflict re-read the entry composition; timing_invalid or duration_overflow names what the group would have broken; on recovery_required stop writes and recover; never retry committed_response_error.",
    ].join(" "),
    input: MoveScenesInputSchema,
    output: MoveScenesOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => {
      const projectId = input.projectId as ProjectId;
      const moved = await moveScenes(dependencies, {
        projectId,
        sceneIds: input.sceneIds,
        deltaSeconds: input.deltaSeconds,
        ...(input.extendRoot === undefined ? {} : { extendRoot: input.extendRoot }),
        expectedContentHash: input.expectedContentHash as ContentHash,
      }, context.actor, context.writeInvocation);
      if (!moved.ok) return moved;
      const file = await entryFile(dependencies, projectId);
      if (!file.ok) return file;
      return {
        ok: true as const,
        value: {
          changed: moved.value.changed,
          changes: moved.value.changes,
          file: file.value,
          revision: moved.value.envelope?.projectRevision ?? moved.value.project.revision,
          diagnostics: moved.value.diagnostics,
          changeSeq: moved.value.envelope?.changeSeq ?? null,
        },
      };
    },
  };
}

export function deleteScenesTool(
  dependencies: EditingToolDependencies,
): ToolDefinition<z.infer<typeof DeleteScenesInputSchema>, z.infer<typeof DeleteScenesOutputSchema>> {
  return {
    name: "delete_scenes",
    title: "Delete several scenes",
    level: "destructive",
    description: [
      "Use when permanently removing a whole selection of scenes, their mounts, unique sources and narration, with one verified backup.",
      "Do not use to hide or reorder scenes, to delete a single scene when delete_scene already covers it, or when shared references must remain.",
      "Preconditions: sceneIds and expectedRevision come from current project context; omit grantId to create one approval request for the whole group, then retry once with the issued grantId and the identical selection.",
      "Side effects: after approval, deletes every owned artifact of the selection, updates the root duration, publishes one backup and commits one destructive revision.",
      "Errors/recovery: refresh context after write_conflict; request new approval after approval_invalid or approval_expired; on recovery_required stop and recover; never retry committed_response_error.",
    ].join(" "),
    input: DeleteScenesInputSchema,
    output: DeleteScenesOutputSchema,
    annotations: annotationsForLevel("destructive"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => {
      const projectId = input.projectId as ProjectId;
      if (!input.grantId) {
        const prepared = await prepareDeleteScenes(dependencies, {
          projectId,
          sceneIds: input.sceneIds,
          expectedRevision: input.expectedRevision,
        });
        if (!prepared.ok) return prepared;
        return requestDestructiveApproval(
          dependencies.approvals,
          context,
          prepared.value.binding,
          `Delete ${prepared.value.plan.sceneIds.length} scenes`,
          `delete ${prepared.value.plan.sceneIds.length} scenes`,
          "delete_scenes",
        );
      }
      const deleted = await deleteScenes(dependencies, {
        projectId,
        sceneIds: input.sceneIds,
        expectedRevision: input.expectedRevision,
        grantId: input.grantId,
      }, context.actor, context.writeInvocation);
      if (!deleted.ok) return deleted;
      return {
        ok: true as const,
        value: {
          project: deleted.value.project,
          revision: deleted.value.envelope.projectRevision,
          diagnostics: deleted.value.envelope.diagnostics,
          changeSeq: deleted.value.envelope.changeSeq,
          backupId: deleted.value.backupId,
          deletedFiles: deleted.value.deletedFiles,
          keptFiles: deleted.value.keptFiles,
        },
      };
    },
  };
}



export function listCatalogItemsTool(
  dependencies: EditingToolDependencies,
): ToolDefinition<z.infer<typeof ListCatalogItemsInputSchema>, z.infer<typeof ListCatalogItemsOutputSchema>> {
  return {
    name: "list_catalog_items",
    title: "List catalog items",
    level: "read",
    description: [
      "Use when looking for a template, block or other packaged item to install, optionally filtered by kind, category, tags or a search term.",
      "Do not use to install one, to read project files, or to reach a registry directly.",
      "Preconditions: none; every filter is optional.",
      "Side effects: read-only. The listing says where it came from and whether it is stale, so an offline fallback is visible rather than silent.",
      "Errors/recovery: a stale listing is still usable; install_catalog_item revalidates the exact item before it writes anything.",
    ].join(" "),
    input: ListCatalogItemsInputSchema,
    output: ListCatalogItemsOutputSchema,
    annotations: annotationsForLevel("read"),
    availableInLegacy: true,
    // The catalog is not a project's: a listing is the same everywhere.
    projectIdOf: () => null,
    handler: async (_context, input) => {
      const listing = await dependencies.catalog.list(input);
      return {
        ok: true as const,
        value: {
          items: listing.items.map(catalogItemDto),
          source: listing.source,
          stale: listing.stale,
        },
      };
    },
  };
}

export function generateCaptionsTool(
  dependencies: EditingToolDependencies,
): ToolDefinition<z.infer<typeof GenerateCaptionsInputSchema>, z.infer<typeof GenerateCaptionsOutputSchema>> {
  return {
    name: "generate_captions",
    title: "Generate captions for one scene",
    level: "write",
    description: [
      "Use when turning one scene's narration into on-screen captions timed to the words that were actually spoken.",
      "Do not use to write narration text, to synthesize audio, or on a scene that has no narration.",
      "Preconditions: sceneId and expectedContentHash come from read_composition or get_project_context; the scene's narration must exist, and word timings from the engine give better cues than estimated ones.",
      "Side effects: replaces the scene's whole caption block in one revision, so no cue from a previous run survives.",
      "Errors/recovery: scene_not_found means the id is stale; a scene without narration is refused rather than captioned from nothing; on write_conflict re-read the composition; never retry committed_response_error.",
    ].join(" "),
    input: GenerateCaptionsInputSchema,
    output: GenerateCaptionsOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => {
      const captions = await generateCaptions(dependencies, {
        projectId: input.projectId as ProjectId,
        sceneId: input.sceneId,
        expectedContentHash: input.expectedContentHash as ContentHash,
      }, context.actor, context.writeInvocation);
      if (!captions.ok) return captions;
      return {
        ok: true as const,
        value: {
          cues: captions.value.cues,
          timingSource: captions.value.timingSource,
          revision: captions.value.envelope.projectRevision,
          diagnostics: captions.value.envelope.diagnostics,
          changeSeq: captions.value.envelope.changeSeq,
        },
      };
    },
  };
}

export function installCatalogItemTool(
  dependencies: EditingToolDependencies,
): ToolDefinition<z.infer<typeof InstallCatalogItemInputSchema>, z.infer<typeof InstallCatalogItemOutputSchema>> {
  return {
    name: "install_catalog_item",
    title: "Install a catalog item",
    level: "write",
    description: [
      "Use when installing one packaged catalog item into the project and mounting it as a new scene or inside an existing one.",
      "Do not use to browse the catalog, to install several items at once, or to overwrite an existing copy without saying so.",
      "Preconditions: name, version, mount and expectedRevision come from list_catalog_items and get_project_context; omit grantId to plan and request approval, then retry once with the issued grantId and the identical intent, including existingPolicy.",
      "Side effects: after approval, writes the item's files and mounts it in one revision, and records where the package came from.",
      "Errors/recovery: precondition_required means the package is already installed and needs an explicit existingPolicy — choose one deliberately rather than assuming replace; refresh context after write_conflict; request new approval after approval_invalid or approval_expired; never retry committed_response_error.",
    ].join(" "),
    input: InstallCatalogItemInputSchema,
    output: InstallCatalogItemOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => {
      const { projectId, grantId, ...rest } = input;
      const intent = { projectId: projectId as ProjectId, ...rest } as Parameters<typeof prepareCatalogInstall>[1];
      if (!grantId) {
        const prepared = await prepareCatalogInstall(dependencies.catalogInstall, intent);
        if (!prepared.ok) return prepared;
        if (prepared.value.status !== "ready") {
          // A choice the plan requires stays a choice: turning it into a silent
          // replace is how an installed package disappears under an agent.
          return err({
            code: ErrorCode.PreconditionRequired,
            message: prepared.value.status === "skipped"
              ? "this item is already installed and the intent asked to skip it"
              : "this item is already installed; retry with an explicit existingPolicy",
            field: "existingPolicy",
            details: { status: prepared.value.status },
          });
        }
        return requestDestructiveApproval(
          dependencies.approvals,
          context,
          prepared.value.binding as never,
          `Install ${input.name} ${input.version}`,
          `install ${input.name} ${input.version}`,
          "install_catalog_item",
        );
      }
      const executed = await executeCatalogInstall(
        dependencies.catalogInstall,
        { intent, grantId },
        context.actor,
        context.writeInvocation as never,
      );
      if (!executed.ok) return executed;
      return {
        ok: true as const,
        value: {
          packageStatus: executed.value.packageStatus,
          files: executed.value.files.map((file) => ({ path: file.path, action: file.action })),
          provenance: executed.value.provenance,
          sceneId: executed.value.sceneId,
          revision: executed.value.envelope.projectRevision,
          diagnostics: executed.value.envelope.diagnostics,
          changeSeq: executed.value.envelope.changeSeq,
        },
      };
    },
  };
}

export function mountAssetTool(
  dependencies: EditingToolDependencies,
): ToolDefinition<z.infer<typeof MountAssetInputSchema>, z.infer<typeof MountAssetOutputSchema>> {
  return {
    name: "mount_asset",
    title: "Mount an asset on the timeline",
    level: "write",
    description: [
      "Use when putting a file that is already in the project onto the timeline, wrapped in its own scene, or when finishing an upload that was left unmounted.",
      "Do not use to upload a file, to change an existing clip's timing, or to pass a duration — the daemon measures the file itself.",
      "Preconditions: for an asset in the project pass assetPath, assetContentHash, atSeconds and trackIndex; for a pending upload pass only its operationId, because the placement lives in the server-side record. expectedContentHash comes from read_composition.",
      "Side effects: writes one wrapper scene and its narration sidecar, mounts it in the entry composition, and commits one revision. onOverflow shrink trims the wrapper; extend-root grows the timeline instead.",
      "Errors/recovery: an asset that cannot be inspected is refused and stays in Media; write_conflict means the file changed since its hash was read; not_found on a retry means that operation has expired, so do not start a new one for the same bytes.",
    ].join(" "),
    input: MountAssetInputSchema,
    output: MountAssetOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => {
      const { projectId, ...rest } = input;
      const mounted = await mountAsset(
        dependencies.mount,
        { projectId: projectId as ProjectId, ...rest } as Parameters<typeof mountAsset>[1],
        context.actor,
        context.writeInvocation.origin,
      );
      if (!mounted.ok) return mounted;
      return {
        ok: true as const,
        value: {
          sceneId: mounted.value.sceneId,
          durationSeconds: mounted.value.durationSeconds,
          replayed: mounted.value.replayed,
          revision: mounted.value.revision,
          diagnostics: mounted.value.envelope?.diagnostics ?? [],
          changeSeq: mounted.value.envelope?.changeSeq ?? null,
        },
      };
    },
  };
}

export function registerEditingTools(registry: ToolRegistry, dependencies: EditingToolDependencies): void {
  registry.register(reorderScenesTool(dependencies));
  registry.register(moveScenesTool(dependencies));
  registry.register(deleteScenesTool(dependencies));
  registry.register(listCatalogItemsTool(dependencies));
  registry.register(installCatalogItemTool(dependencies));
  registry.register(generateCaptionsTool(dependencies));
  registry.register(mountAssetTool(dependencies));
}
