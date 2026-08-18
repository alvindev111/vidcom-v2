import {
  BGM_AUDIO_EXTENSIONS,
  BGM_BED_DEFAULT_VOLUME,
  BGM_BEDS,
  BGM_MAX_BED_SECONDS,
  BGM_MIN_BED_SECONDS,
  ErrorCode,
  findBgmBed,
  findShippedBgmTrack,
  SHIPPED_BGM_TRACKS,
  type BgmLibraryEntry,
  type BgmLicense,
  type BgmProviderTrackRef,
  type ContentHash,
  type DomainError,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";

import { checkPathPurpose, checkPathSyntax } from "../domain/path-policy";
import { err, ok, type Result } from "../error/result";
import { ignoredMutationOriginForActor } from "../port/mutation-observer";
import type {
  BgmLibraryPort,
  BgmProviderPort,
  BgmSynthPort,
  CompositionPort,
  MutationJournalPort,
  WorkspacePort,
} from "../port/ports";
import type { WriteInvocation } from "../port/types";
import type { WriteAuthority } from "../service/write-authority";
import type { Actor } from "@vidcom/contracts";

export interface BgmDependencies {
  workspace: Pick<WorkspacePort, "readProjectRef" | "resolve" | "readBytes" | "readFile">;
  composition: Pick<CompositionPort, "parseProject">;
  journal: Pick<MutationJournalPort, "readEntityState">;
  authority: { uploadBgm?: WriteAuthority["uploadBgm"] };
  bgmSynth: BgmSynthPort;
  bgmLibrary: BgmLibraryPort;
  bgmProviders?: BgmProviderPort;
  hashContent(content: string | Uint8Array): ContentHash;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

/** Everything a caller can choose from: recipes, shipped tracks, and this install's library. */
export async function listBgmSources(dependencies: Pick<BgmDependencies, "bgmLibrary">) {
  // What this install recorded wins over the catalogue's `unknown`: the catalogue
  // states what shipped, the ledger states what somebody actually established.
  const recorded = await dependencies.bgmLibrary.shippedLicenses();
  const tracks = await Promise.all(SHIPPED_BGM_TRACKS.map(async (track) => ({
    id: track.id,
    label: track.label,
    role: track.role,
    selection: track.selection,
    durationSeconds: track.durationSeconds,
    license: recorded[track.id] ?? track.license,
    // Probed, not assumed: a build can ship the catalogue and omit the audio.
    available: await dependencies.bgmLibrary.hasShipped(track.filename),
  })));
  return {
    beds: BGM_BEDS.map(({ id, label, role, selection }) => ({ id, label, role, selection })),
    tracks,
    library: await dependencies.bgmLibrary.list(),
    defaultVolume: BGM_BED_DEFAULT_VOLUME,
  };
}

/** Searches remote catalogues while keeping the offline synth/library fallback explicit. */
export async function searchBgmSources(
  dependencies: Pick<BgmDependencies, "bgmProviders">,
  input: { mood: string; limit: number },
) {
  if (!dependencies.bgmProviders) {
    return { tracks: [], providers: [], offlineFallbackAvailable: true };
  }
  const remote = await dependencies.bgmProviders.search(input);
  return { ...remote, offlineFallbackAvailable: true };
}

/**
 * Reads the project's own length, so a bed can be exactly as long as the video.
 *
 * A bed that stops before the last scene is worse than no bed, and one that runs
 * minutes past the end wastes bytes in every render.
 */
async function projectSeconds(
  dependencies: BgmDependencies,
  projectId: ProjectId,
): Promise<number | null> {
  const ref = await dependencies.workspace.readProjectRef(projectId);
  if (!ref) return null;
  try {
    const model = await dependencies.composition.parseProject(ref);
    const duration = model.project.duration;
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

export interface InstallBgmInput {
  projectId: ProjectId;
  bedId?: string;
  trackId?: string;
  libraryEntryId?: string;
  providerTrack?: BgmProviderTrackRef;
  seconds?: number;
  volume?: number;
  loop?: boolean;
  expectedRevision: number;
}

export interface InstallBgmOutput {
  track: { name: string; path: RelPath; durationSeconds: number; contentHash: ContentHash };
  volume: number;
  loop: boolean;
  revision: number;
  changeSeq: number | null;
}

/**
 * Puts a bed in the project and points preview settings at it, in one mutation.
 *
 * Two sources, one path through: a built-in recipe is rendered here and now at the
 * project's own length, a library entry is copied byte for byte. Either way the
 * bytes land in `preview-assets/bgm/` through the same staged asset + entity
 * mutation the UI's upload uses, so a half-installed bed cannot exist.
 */
export async function installBgm(
  dependencies: BgmDependencies,
  input: InstallBgmInput,
  actor: Actor,
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
): Promise<Result<InstallBgmOutput, DomainError>> {
  const chosen = [input.bedId, input.trackId, input.libraryEntryId, input.providerTrack]
    .filter((value) => value !== undefined);
  if (chosen.length !== 1) {
    return err({
      code: ErrorCode.SchemaInvalid,
      message: "pass exactly one BGM source",
      field: "bedId",
    });
  }
  const ref = await dependencies.workspace.readProjectRef(input.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  if (!dependencies.authority.uploadBgm) {
    return err({ code: ErrorCode.StorageUnavailable, message: "BGM installation is unavailable" });
  }

  let name: string;
  let bytes: Uint8Array;
  let durationSeconds: number;

  if (input.bedId !== undefined) {
    const bed = findBgmBed(input.bedId);
    if (!bed) {
      return err({
        code: ErrorCode.NotFound,
        message: `unknown bed ${input.bedId}; list_bgm_beds has the ids`,
        field: "bedId",
      });
    }
    const requested = input.seconds ?? await projectSeconds(dependencies, input.projectId);
    if (requested === null) {
      return err({
        code: ErrorCode.NoComposition,
        message: "the project has no duration yet, so pass seconds explicitly",
        field: "seconds",
      });
    }
    const seconds = Math.min(BGM_MAX_BED_SECONDS, Math.max(BGM_MIN_BED_SECONDS, requested));
    bytes = dependencies.bgmSynth.render(bed, seconds);
    durationSeconds = seconds;
    name = `${bed.id}.wav`;
  } else if (input.trackId !== undefined) {
    const track = findShippedBgmTrack(input.trackId);
    if (!track) {
      return err({
        code: ErrorCode.NotFound,
        message: `unknown track ${input.trackId}; list_bgm_beds has the ids`,
        field: "trackId",
      });
    }
    const shipped = await dependencies.bgmLibrary.readShipped(track.filename);
    if (!shipped) {
      return err({
        code: ErrorCode.NoFile,
        message: "this build ships the track's catalogue entry but not its audio; list_bgm_beds reports available=false",
        field: "trackId",
      });
    }
    bytes = shipped;
    durationSeconds = track.durationSeconds;
    name = track.filename;
  } else if (input.libraryEntryId !== undefined) {
    const entry = (await dependencies.bgmLibrary.list())
      .find((candidate) => candidate.id === input.libraryEntryId);
    if (!entry) {
      return err({
        code: ErrorCode.NotFound,
        message: "library entry was not found; list_bgm_beds has the current library",
        field: "libraryEntryId",
      });
    }
    const stored = await dependencies.bgmLibrary.read(entry.id);
    if (!stored) {
      return err({
        code: ErrorCode.NoFile,
        message: "the library entry is registered but its file is gone from disk",
        field: "libraryEntryId",
      });
    }
    bytes = stored;
    durationSeconds = entry.durationSeconds;
    name = entry.name.includes(".") ? entry.name : `${entry.name}.wav`;
  } else {
    if (!input.providerTrack || !dependencies.bgmProviders) {
      return err({
        code: ErrorCode.DownloadUnavailable,
        message: "remote BGM providers are unavailable; use list_bgm_beds for an offline fallback",
        field: "providerTrack",
      });
    }
    const downloaded = await dependencies.bgmProviders.download(input.providerTrack);
    if (!downloaded.ok) return downloaded;
    const { track, bytes: remoteBytes } = downloaded.value;
    const cached = await dependencies.bgmLibrary.add({
      name: `${track.title.slice(0, 254 - track.extension.length)}.${track.extension}`,
      extension: track.extension,
      bytes: remoteBytes,
      source: "provider",
      bedId: null,
      license: track.license,
      provenance: {
        providerId: track.providerId,
        trackId: track.trackId,
        sourceUrl: track.sourceUrl,
        attribution: track.attribution,
      },
    });
    if (!cached.ok) return cached;
    bytes = remoteBytes;
    durationSeconds = cached.value.entry.durationSeconds;
    name = `${cached.value.entry.id}.${track.extension}`;
  }

  const volume = input.volume ?? BGM_BED_DEFAULT_VOLUME;
  const loop = input.loop ?? true;
  const written = await dependencies.authority.uploadBgm({
    ref,
    name,
    path: `preview-assets/bgm/${name}` as RelPath,
    bytes,
    expectedRevision: input.expectedRevision,
    volume,
    loop,
  }, actor, invocation);
  if (!written.ok) return written;

  return ok({
    track: {
      name,
      path: `preview-assets/bgm/${name}` as RelPath,
      durationSeconds: Number(durationSeconds.toFixed(3)),
      contentHash: dependencies.hashContent(bytes),
    },
    volume,
    loop,
    revision: written.value.revision,
    changeSeq: written.value.changeSeq ?? null,
  });
}

/**
 * Records what a shipped track is allowed to be used for.
 *
 * Exists because the honest answer at build time was `unknown`: nothing in the
 * audio, the filenames or the commit that added them says. Whoever does know
 * should be able to write it down once, without editing the catalogue and
 * shipping a release.
 */
export async function recordShippedBgmLicense(
  dependencies: Pick<BgmDependencies, "bgmLibrary">,
  input: { trackId: string; license: BgmLicense },
): Promise<Result<{ trackId: string; license: BgmLicense }, DomainError>> {
  const track = findShippedBgmTrack(input.trackId);
  if (!track) {
    return err({
      code: ErrorCode.NotFound,
      message: `unknown track ${input.trackId}; list_bgm_beds has the ids`,
      field: "trackId",
    });
  }
  await dependencies.bgmLibrary.recordShippedLicense(track.id, input.license);
  return ok({ trackId: track.id, license: input.license });
}

export interface ImportBgmInput {
  projectId: ProjectId;
  path: string;
  name?: string;
  license: BgmLicense;
}

/**
 * Takes an audio file that is already in the project into the machine's library.
 *
 * The source is a project-relative path, never an arbitrary one: an agent that
 * could name any file on disk would have a capability nobody granted it, and the
 * project's own assets are the set a caller can legitimately see.
 */
export async function importBgm(
  dependencies: BgmDependencies,
  input: ImportBgmInput,
): Promise<Result<{ entry: BgmLibraryEntry; alreadyPresent: boolean }, DomainError>> {
  const ref = await dependencies.workspace.readProjectRef(input.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  if (checkPathSyntax(input.path) || checkPathPurpose(input.path, "read-asset")) {
    return err({
      code: ErrorCode.AssetNotAllowed,
      message: "the path is not an allowed project asset",
      field: "path",
    });
  }
  const extension = extensionOf(input.path);
  if (!BGM_AUDIO_EXTENSIONS.includes(extension)) {
    return err({
      code: ErrorCode.UnsupportedMedia,
      message: `a BGM track must be one of ${BGM_AUDIO_EXTENSIONS.join(", ")}`,
      field: "path",
    });
  }
  const resolved = await dependencies.workspace.resolve(ref, input.path, "read-asset");
  if (!resolved.ok) return err({ code: ErrorCode.AssetNotAllowed, message: "the path was rejected" });
  const asset = await dependencies.workspace.readBytes(resolved.value);
  if (!asset) return err({ code: ErrorCode.NoFile, message: "the track does not exist in the project", field: "path" });

  return dependencies.bgmLibrary.add({
    name: input.name ?? input.path.slice(input.path.lastIndexOf("/") + 1),
    extension,
    bytes: asset.bytes,
    source: "import",
    bedId: null,
    license: input.license,
  });
}
