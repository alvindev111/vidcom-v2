import { ErrorCode, type ContentHash, type DomainError, type RelPath } from "@vidcom/contracts";

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
  source: string,
  timing: { start: number; duration: number; trackIndex: number },
): string {
  // Provenance is escaped by Core before it reaches this string: the canonical
  // JSON has no `<`, `>` or `&` left, and quotes are entity-escaped.
  return `<div id="${instanceId}" class="catalog-instance comp-layer clip"`
    + ` data-composition-id="${instanceId}"`
    + ` data-composition-src="${source}"`
    + ` data-start="${timing.start}" data-duration="${timing.duration}"`
    + ` data-track-index="${timing.trackIndex}"`
    + ` data-catalog-provenance="${catalogProvenanceAttribute(item)}"></div>`;
}

function relativeCatalogReference(owner: RelPath, target: RelPath): string {
  const ownerSegments = owner.split("/").slice(0, -1);
  const targetSegments = target.split("/");
  let shared = 0;
  while (shared < ownerSegments.length && ownerSegments[shared] === targetSegments[shared]) shared += 1;
  const up = ownerSegments.slice(shared).map(() => "..");
  return [...up, ...targetSegments.slice(shared)].join("/") || ".";
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
      value: {
        index: -1,
        html: packageLayer(
          instanceId,
          item,
          relativeCatalogReference(target, item.entry),
          { start: 0, duration, trackIndex },
        ),
      },
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
  // Mount the package entry directly from the root. HyperFrames resolves one
  // external composition level; wrapping the package in another external scene
  // produces a valid-looking install whose frame is blank at runtime.
  const scenePath = item.entry;
  const duration = item.durationSeconds ?? 4;
  const storyboard = [...scenes]
    .sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
  if (!Number.isInteger(mount.toIndex) || mount.toIndex < 0 || mount.toIndex > storyboard.length) {
    return err({
      code: "insertion_rejected",
      error: {
        code: ErrorCode.SchemaInvalid,
        message: "toIndex is outside the storyboard",
        field: "toIndex",
      },
    });
  }
  const reference = storyboard[mount.toIndex] ?? storyboard[storyboard.length - 1] ?? null;
  const trackIndex = mount.trackIndex ?? reference?.trackIndex ?? 0;
  // The catalog intent addresses the storyboard, while the shared insertion
  // planner addresses one target track. Convert the global storyboard slot to
  // that track's local slot so a composition with one scene per lane can still
  // append a catalog scene after the final card.
  const trackToIndex = storyboard
    .slice(0, mount.toIndex)
    .filter((scene) => scene.trackIndex === trackIndex)
    .length;
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
      toIndex: trackToIndex,
      trackIndex,
      rootDuration: project.duration,
    },
    frameGrid,
  );
  if (!insertion.ok) return err({ code: "insertion_rejected", error: insertion.error });

  const instanceId = `${item.name}-${sceneId}`;
  const documentIndex = insertion.value.beforeSceneId
    ? scenes.findIndex((scene) => scene.id === insertion.value.beforeSceneId)
    : -1;
  const applied = await input.composition.applyOps(ref, ref.entry, [
    {
      kind: "addElement",
      target: "@root",
      value: {
        index: documentIndex,
        html: `<div id="${instanceId}" class="catalog-instance comp-layer clip" data-composition-id="${sceneId}"`
          + ` data-composition-src="${relativeCatalogReference(ref.entry, item.entry)}"`
          + ` data-start="${insertion.value.scene.start}"`
          + ` data-duration="${duration}" data-track-index="${trackIndex}"`
          + ` data-width="${project.width}" data-height="${project.height}"`
          + ` data-catalog-provenance="${catalogProvenanceAttribute(item)}"></div>`,
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
