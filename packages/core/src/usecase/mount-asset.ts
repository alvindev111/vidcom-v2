import {
  ErrorCode,
  type Actor,
  type ContentHash,
  type DomainError,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";

import type { CompositionModel, ProjectRef } from "../domain/models";
import { planSceneInsertion } from "../domain/plan-scene-order";
import { err, ok, type Result } from "../error/result";
import type { MutationOrigin } from "../port/mutation-observer";
import type {
  ClockPort,
  CompositionPort,
  MediaProbePort,
  PendingMountPort,
  WorkspacePort,
} from "../port/ports";
import type {
  CompositeRequest,
  CompositeStep,
  PendingMount,
  PendingToolAudit,
  WriteEnvelope,
} from "../port/types";
import { initialCue, serializeNarrationSidecar } from "./project-writes";

/**
 * Mounts an asset by wrapping it in one scene (Design §5.21, R11).
 *
 * Two things are deliberately not the caller's decision. The duration comes from
 * probing the file at `assetPath` after checking it still hashes to
 * `assetContentHash`, because a number sent by a client can be stale or invented;
 * and the root insertion goes through the same `planSceneInsertion` the timeline
 * uses, so a mounted asset cannot drift from how every other scene is placed.
 */

export type MountAssetInput =
  | {
      projectId: ProjectId;
      operationId?: never;
      assetPath: RelPath;
      assetContentHash: ContentHash;
      atSeconds: number;
      trackIndex: number;
      expectedContentHash: ContentHash | null;
      onOverflow: "shrink" | "extend-root";
    }
  | {
      projectId: ProjectId;
      /** Retry of an upload that never mounted; the record owns the rest. */
      operationId: string;
      assetPath?: never;
      assetContentHash?: never;
      atSeconds?: never;
      trackIndex?: never;
      expectedContentHash: ContentHash | null;
      onOverflow: "shrink" | "extend-root";
    };

export interface MountAssetOutput {
  sceneId: string;
  durationSeconds: number;
  /** Revision the mount is visible at; on a replay it is the recorded one. */
  revision: number;
  /** True when a prior mount of this operation was returned instead of a new one. */
  replayed: boolean;
  envelope: WriteEnvelope | null;
}

export interface MountAssetDependencies {
  workspace: Pick<WorkspacePort, "readProjectRef" | "resolve" | "readHash">;
  composition: Pick<CompositionPort, "parseProject" | "applyOps">;
  probe: Pick<MediaProbePort, "probeMedia">;
  pendingMount: Pick<PendingMountPort, "lookup">;
  authority: {
    mutateSource(request: CompositeRequest, actor: Actor): Promise<Result<WriteEnvelope, DomainError>>;
  };
  clock: ClockPort;
  toolAudit?: PendingToolAudit | null;
}

/** Default length of a still image on the timeline (R11.4). */
export const MOUNTED_IMAGE_DURATION_SECONDS = 4;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "avif", "gif", "svg"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "m4a"]);

function extensionOf(target: string): string {
  const dot = target.lastIndexOf(".");
  return dot < 0 ? "" : target.slice(dot + 1).toLowerCase();
}

function elementFor(target: string): "img" | "audio" | "video" {
  const extension = extensionOf(target);
  if (IMAGE_EXTENSIONS.has(extension)) return "img";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  return "video";
}

function nextSceneId(scenes: readonly { id: string }[]): string {
  const numbers = scenes.flatMap((scene) => {
    const match = /^scene-(\d+)$/.exec(scene.id);
    return match ? [Number(match[1])] : [];
  });
  return `scene-${numbers.length > 0 ? Math.max(...numbers) + 1 : 1}`;
}

/**
 * The wrapper scene document.
 *
 * The asset is referenced from the scene document's directory, never copied, and
 * the element carries `class="clip"` so the runtime treats it as timed content.
 * No in/out point is written: `shrink` shortens the wrapper, which is a timeline
 * decision, and trimming inside the media would be a different edit entirely.
 */
function wrapperSource(input: {
  sceneId: string;
  assetPath: RelPath;
  duration: number;
  width: number;
  height: number;
}): string {
  const element = elementFor(input.assetPath);
  const source = `../${input.assetPath}`;
  const media = element === "img"
    ? `<img class="clip" src="${source}" alt="" data-start="0" data-duration="${input.duration}" />`
    : `<${element} class="clip" src="${source}" data-start="0" data-duration="${input.duration}"`
      + ` preload="auto"${element === "video" ? " muted playsinline" : ""}></${element}>`;
  return `<!doctype html><html><head><meta charset="UTF-8" /></head><body><template>`
    + `<div id="${input.sceneId}" data-composition-id="${input.sceneId}"`
    + ` data-width="${input.width}" data-height="${input.height}"`
    + ` data-start="0" data-duration="${input.duration}">${media}</div>`
    + `</template></body></html>\n`;
}

async function hashOf(
  dependencies: MountAssetDependencies,
  ref: ProjectRef,
  path: RelPath,
): Promise<ContentHash | null> {
  const resolved = await dependencies.workspace.resolve(ref, path, "read-asset");
  if (!resolved.ok) return null;
  return await dependencies.workspace.readHash(resolved.value);
}

/**
 * Answers a retry of an operation that already mounted, without writing anything.
 *
 * The duration is read back from the scene the record points at rather than
 * re-probed: the timeline may legitimately have shortened the wrapper since, and
 * the reply must describe what is on the timeline now. A record pointing at a
 * scene that no longer exists is a conflict — the mount happened and was undone
 * or deleted, and replaying cannot bring it back.
 */
async function replayMount(
  dependencies: MountAssetDependencies,
  ref: ProjectRef,
  record: PendingMount,
): Promise<Result<MountAssetOutput, DomainError>> {
  const sceneId = record.mountedSceneId;
  if (sceneId === null || record.mountedRevision === null) {
    return err({ code: ErrorCode.InvariantViolated, message: "the mounted operation has no recorded result" });
  }
  let model: CompositionModel;
  try { model = await dependencies.composition.parseProject(ref); }
  catch { return err({ code: ErrorCode.StorageUnavailable, message: "composition could not be read" }); }
  const scene = ((model.scenes ?? []) as unknown as Array<{ id: string; duration: number }>)
    .find((candidate) => candidate.id === sceneId);
  if (!scene) {
    return err({
      code: ErrorCode.WriteConflict,
      message: "the scene this upload was mounted into no longer exists",
      field: "operationId",
    });
  }
  return ok({
    sceneId,
    durationSeconds: scene.duration,
    revision: record.mountedRevision,
    replayed: true,
    envelope: null,
  });
}

export async function mountAsset(
  dependencies: MountAssetDependencies,
  input: MountAssetInput,
  actor: Actor,
  origin: MutationOrigin,
): Promise<Result<MountAssetOutput, DomainError>> {
  const ref = await dependencies.workspace.readProjectRef(input.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });

  // A pending retry carries only its operation id: path, hash, time and track all
  // come from the server-side record, so a client cannot redirect the mount.
  let placement: { assetPath: RelPath; assetContentHash: ContentHash; atSeconds: number; trackIndex: number };
  let closing: string | null = null;
  if (input.operationId !== undefined) {
    const found = await dependencies.pendingMount.lookup(input.projectId, input.operationId);
    // A mount whose response was lost is replayed from the record, never mounted a
    // second time: the operation already produced a scene, and a second one would
    // be a duplicate the user never asked for (Design §5.21).
    if (found.state === "active"
      && found.record.state === "mounted"
      && found.record.projectId === input.projectId) {
      return replayMount(dependencies, ref, found.record);
    }
    if (found.state !== "active" || found.record.state !== "uploaded_unmounted") {
      return err({
        code: ErrorCode.NotFound,
        message: found.state === "expired"
          ? "this upload can no longer be mounted"
          : "there is no pending upload for that operation",
        field: "operationId",
      });
    }
    const record = found.record;
    if (record.projectId !== input.projectId) {
      return err({ code: ErrorCode.NotFound, message: "that operation belongs to another project" });
    }
    placement = {
      assetPath: record.assetPath,
      assetContentHash: record.assetContentHash,
      atSeconds: record.atSeconds,
      trackIndex: record.trackIndex,
    };
    closing = record.operationId;
  } else {
    placement = {
      assetPath: input.assetPath,
      assetContentHash: input.assetContentHash,
      atSeconds: input.atSeconds,
      trackIndex: input.trackIndex,
    };
  }

  // Measure the file that is actually there, and only if it is still the file the
  // mount was requested for.
  const current = await hashOf(dependencies, ref, placement.assetPath);
  if (current === null) {
    return err({ code: ErrorCode.NotFound, message: "the asset is no longer in the project", field: "assetPath" });
  }
  if (current !== placement.assetContentHash) {
    return err({
      code: ErrorCode.WriteConflict,
      message: "the asset changed before it could be mounted",
      field: "assetContentHash",
    });
  }
  const probed = await dependencies.probe.probeMedia(ref, placement.assetPath);
  if (!probed.ok) return probed;
  const metadata = probed.value;
  const isImage = elementFor(placement.assetPath) === "img";
  if (metadata.status !== "ok") {
    // Unknown metadata is a refusal, not a guess: the file stays in Media and the
    // UI says it could not be mounted (R11.4b).
    return err({
      code: ErrorCode.InvariantViolated,
      message: "the asset could not be inspected, so it was not mounted",
      field: "assetPath",
      details: { reason: metadata.reason },
    });
  }
  const probedDuration = metadata.kind === "media" ? metadata.durationSeconds : null;
  const naturalDuration = probedDuration ?? (isImage ? MOUNTED_IMAGE_DURATION_SECONDS : null);
  if (naturalDuration === null || !Number.isFinite(naturalDuration) || naturalDuration <= 0) {
    return err({
      code: ErrorCode.InvariantViolated,
      message: "the asset has no usable duration, so it was not mounted",
      field: "assetPath",
    });
  }

  let model: CompositionModel;
  try { model = await dependencies.composition.parseProject(ref); }
  catch { return err({ code: ErrorCode.StorageUnavailable, message: "composition could not be read" }); }
  const scenes = (model.scenes ?? []) as unknown as Array<{
    id: string;
    start: number;
    duration: number;
    trackIndex: number;
  }>;
  const project = model.project as unknown as { width: number; height: number; duration: number };

  // `shrink` trims the wrapper so it ends with the root; `extend-root` keeps the
  // asset whole and lets the insertion planner grow the root instead.
  const available = Math.max(0, project.duration - placement.atSeconds);
  const duration = input.onOverflow === "shrink" && available > 0 && naturalDuration > available
    ? available
    : naturalDuration;

  const sceneId = nextSceneId(scenes);
  const scenePath = `compositions/${sceneId}.html` as RelPath;
  const onTrack = scenes.filter((scene) => scene.trackIndex === placement.trackIndex);
  const toIndex = onTrack.filter((scene) => scene.start < placement.atSeconds).length;
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
      toIndex,
      trackIndex: placement.trackIndex,
      rootDuration: project.duration,
    },
  );
  if (!insertion.ok) return insertion;

  const documentIndex = insertion.value.beforeSceneId
    ? scenes.findIndex((scene) => scene.id === insertion.value.beforeSceneId)
    : -1;
  const applied = await dependencies.composition.applyOps(ref, ref.entry, [
    {
      kind: "addElement",
      target: "@root",
      value: {
        index: documentIndex,
        html: `<div id="${sceneId}-layer" class="comp-layer clip" data-composition-id="${sceneId}"`
          + ` data-composition-src="${scenePath}" data-start="${insertion.value.scene.start}"`
          + ` data-duration="${duration}" data-track-index="${placement.trackIndex}"`
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
  ] as never);
  if (!applied.ok) return applied;

  const steps: CompositeStep[] = [
    {
      kind: "write",
      path: scenePath,
      content: wrapperSource({
        sceneId,
        assetPath: placement.assetPath,
        duration,
        width: project.width,
        height: project.height,
      }),
      expectedContentHash: null,
    },
    {
      kind: "write",
      path: `narration/${sceneId}.json` as RelPath,
      content: serializeNarrationSidecar(
        sceneId,
        [initialCue(sceneId, sceneId)],
        1,
        dependencies.clock.now().toISOString(),
      ),
      expectedContentHash: null,
    },
    {
      kind: "write",
      path: ref.entry,
      content: applied.value,
      expectedContentHash: input.expectedContentHash,
    },
  ];

  const written = await dependencies.authority.mutateSource({
    ref,
    steps,
    origin,
    // The asset is a dependency, not a write: undo can remove the reference, and
    // redo is blocked if the asset changed or was deleted meanwhile.
    historyReadGuards: [
      { path: placement.assetPath, state: { kind: "file", contentHash: placement.assetContentHash } },
    ],
    toolAudit: dependencies.toolAudit ?? null,
    backup: false,
    ...(closing
      ? {
          pendingMountTransition: {
            kind: "close" as const,
            operationId: closing,
            sceneId,
          },
        }
      : {}),
  } as CompositeRequest, actor);
  if (!written.ok) return written;
  return ok({
    sceneId,
    durationSeconds: duration,
    revision: written.value.projectRevision,
    replayed: false,
    envelope: written.value,
  });
}
