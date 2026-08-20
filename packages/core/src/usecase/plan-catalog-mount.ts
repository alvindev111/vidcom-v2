import { type ContentHash, type DomainError, type RelPath } from "@vidcom/contracts";

import { catalogProvenanceAttribute } from "../domain/catalog-install-guard";
import { type VerifiedCatalogItem } from "../domain/catalog";
import { FrameGrid } from "../domain/frame-grid";
import { type CatalogInstallMount } from "../domain/plan-catalog-install";
import type { CompositionModel, CompositionOp, ProjectRef } from "../domain/models";
import { planSceneInsertion } from "../domain/plan-scene-order";
import { err, ok, type Result } from "../error/result";
import { initialCue, serializeNarrationSidecar } from "./project-writes";
import type { CatalogMountDocument } from "./assemble-catalog-install";

/**
 * Plans the authored documents that mount a catalog package (Design §5.17).
 *
 * `new-scene` goes through the same `planSceneInsertion` every other insertion
 * uses, so catalog scenes cannot drift from timeline behaviour, and `into-scene`
 * gets its content from `CompositionPort.applyOps` rather than string surgery.
 * Nothing here commits: the documents are handed to one composite so a mount can
 * never exist without its package files.
 */

export interface CatalogMountCompositionPort {
  applyOps(
    ref: ProjectRef,
    path: RelPath,
    ops: readonly CompositionOp[],
  ): Promise<Result<string, DomainError>>;
}

export interface CatalogMountPlanInput {
  ref: ProjectRef;
  model: CompositionModel;
  item: VerifiedCatalogItem;
  mount: CatalogInstallMount;
  /** Expected hash of the root entry, `null` when it does not exist yet. */
  entryHash: ContentHash | null;
  /** Expected hash of the target scene document for `into-scene`. */
  sceneHash?: ContentHash | null;
  /** Overlay layers already present in the target scene document. */
  sceneOverlays?: number;
  composition: CatalogMountCompositionPort;
  now: () => Date;
}

export type CatalogMountRejection =
  | { code: "mount_not_supported"; kind: VerifiedCatalogItem["kind"] }
  | { code: "scene_not_found"; sceneId: string }
  | { code: "insertion_rejected"; error: DomainError }
  | { code: "composition_rejected"; error: DomainError };

export interface CatalogMountPlan {
  documents: CatalogMountDocument[];
  /** Present only for `new-scene`. */
  sceneId: string | null;
  scenePath: RelPath | null;
  /** Instance element id carrying the provenance attribute. */
  instanceId: string;
  rootDuration: number | null;
}

interface SceneClip {
  id: string;
  src?: string | null;
  start: number;
  duration: number;
  trackIndex: number;
}

function nextSceneId(scenes: readonly SceneClip[]): string {
  const numbers = scenes.flatMap((scene) => {
    const match = /^scene-(\d+)$/.exec(scene.id);
    return match ? [Number(match[1])] : [];
  });
  return `scene-${numbers.length > 0 ? Math.max(...numbers) + 1 : 1}`;
}

function packageLayer(
  instanceId: string,
  item: VerifiedCatalogItem,
  timing: { start: number; duration: number; trackIndex: number },
): string {
  // Provenance is escaped by Core before it reaches this string: the canonical
  // JSON has no `<`, `>` or `&` left, and quotes are entity-escaped.
  return `<div id="${instanceId}" class="catalog-instance comp-layer clip"`
    + ` data-composition-src="${item.entry}"`
    + ` data-start="${timing.start}" data-duration="${timing.duration}"`
    + ` data-track-index="${timing.trackIndex}"`
    + ` data-catalog-provenance="${catalogProvenanceAttribute(item)}"></div>`;
}

export async function planCatalogMountDocuments(
  input: CatalogMountPlanInput,
): Promise<Result<CatalogMountPlan, CatalogMountRejection>> {
  const { item, model, mount, ref } = input;
  if (item.kind === "template" && mount.kind === "into-scene") {
    return err({ code: "mount_not_supported", kind: item.kind });
  }
  const scenes = (model.scenes ?? []) as unknown as SceneClip[];
  const project = model.project as unknown as { width: number; height: number; duration: number };
  const frameGrid = FrameGrid.fromFps(model.frameRate ?? 30);

  if (mount.kind === "into-scene") {
    const scene = scenes.find((candidate) => candidate.id === mount.sceneId);
    if (!scene) return err({ code: "scene_not_found", sceneId: mount.sceneId });
    const target = (scene.src ?? ref.entry) as RelPath;
    // Scene-local zero, clamped to the host scene, on the next overlay track.
    const duration = Math.min(item.durationSeconds ?? scene.duration, scene.duration);
    const alignment = frameGrid.validate(duration, "duration");
    if (alignment) return err({ code: "insertion_rejected", error: alignment });
    const trackIndex = (input.sceneOverlays ?? 0) + 1;
    const instanceId = `${item.name}-${scene.id}-${trackIndex}`;
    const applied = await input.composition.applyOps(ref, target, [{
      kind: "addElement",
      target: `@${scene.id}`,
      value: { index: -1, html: packageLayer(instanceId, item, { start: 0, duration, trackIndex }) },
    } as CompositionOp]);
    if (!applied.ok) return err({ code: "composition_rejected", error: applied.error });
    return ok({
      documents: [{
        path: target,
        content: applied.value,
        expectedContentHash: input.sceneHash ?? null,
      }],
      sceneId: null,
      scenePath: null,
      instanceId,
      rootDuration: null,
    });
  }

  const sceneId = nextSceneId(scenes);
  const scenePath = `compositions/${sceneId}.html` as RelPath;
  const duration = item.durationSeconds ?? 4;
  const reference = scenes[mount.toIndex] ?? scenes[scenes.length - 1] ?? null;
  const trackIndex = mount.trackIndex ?? reference?.trackIndex ?? 0;
  const insertion = planSceneInsertion(
    scenes.map((scene) => ({
      sceneId: scene.id,
      start: scene.start,
      duration: scene.duration,
      trackIndex: scene.trackIndex,
    })),
    {
      sceneId,
      scenePath,
      duration,
      toIndex: mount.toIndex,
      trackIndex,
      rootDuration: project.duration,
    },
    frameGrid,
  );
  if (!insertion.ok) return err({ code: "insertion_rejected", error: insertion.error });

  const instanceId = `${item.name}-${sceneId}`;
  const wrapper = `<!doctype html><html><head><meta charset="UTF-8" /></head><body><template>`
    + `<div id="${sceneId}" data-composition-id="${sceneId}"`
    + ` data-width="${project.width}" data-height="${project.height}"`
    + ` data-start="0" data-duration="${duration}">`
    + packageLayer(instanceId, item, { start: 0, duration, trackIndex: 0 })
    + `</div></template></body></html>\n`;

  const documentIndex = insertion.value.beforeSceneId
    ? scenes.findIndex((scene) => scene.id === insertion.value.beforeSceneId)
    : -1;
  const applied = await input.composition.applyOps(ref, ref.entry, [
    {
      kind: "addElement",
      target: "@root",
      value: {
        index: documentIndex,
        html: `<div id="${sceneId}-layer" class="comp-layer clip" data-composition-id="${sceneId}"`
          + ` data-composition-src="${scenePath}" data-start="${insertion.value.scene.start}"`
          + ` data-duration="${duration}" data-track-index="${trackIndex}"`
          + ` data-width="${project.width}" data-height="${project.height}"></div>`,
      },
    },
    ...insertion.value.changes.map((change) => ({
      kind: "setTiming" as const,
      target: change.sceneId,
      value: { start: change.start },
    })),
    ...insertion.value.rootDuration !== project.duration
      ? [{ kind: "setTiming" as const, target: "@root", value: { duration: insertion.value.rootDuration } }]
      : [],
  ] as readonly CompositionOp[]);
  if (!applied.ok) return err({ code: "composition_rejected", error: applied.error });

  return ok({
    documents: [
      { path: scenePath, content: wrapper, expectedContentHash: null },
      {
        path: `narration/${sceneId}.json` as RelPath,
        content: serializeNarrationSidecar(
          sceneId,
          [initialCue(sceneId, item.title)],
          1,
          input.now().toISOString(),
        ),
        expectedContentHash: null,
      },
      { path: ref.entry, content: applied.value, expectedContentHash: input.entryHash },
    ],
    sceneId,
    scenePath,
    instanceId,
    rootDuration: insertion.value.rootDuration,
  });
}
