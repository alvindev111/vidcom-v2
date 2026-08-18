import {
  ErrorCode,
  PendingMountOperationIdSchema,
  type Actor,
  type ContentHash,
  type DomainError,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";

import { resolveCollision, sanitizeFilename } from "../domain/asset-names";
import { ASSET_POLICIES, isSvgContent, matchesDeclaredKind, type AssetKind } from "../domain/magic-bytes";
import type { ProjectRef } from "../domain/models";
import { err, ok, type Result } from "../error/result";
import type { MutationOrigin } from "../port/mutation-observer";
import type {
  AssetProbeMetadata,
  AssetStagingPort,
  MediaProbePort,
  MutationJournalPort,
  PendingMountPort,
  StagedWriter,
  SvgSanitizerPort,
  WorkspacePort,
} from "../port/ports";
import type {
  CompositeRequest,
  StagedFileSource,
  WriteEnvelope,
} from "../port/types";
import { canonicalizeJson } from "../service/canonical-json";

const MAGIC_HEAD_BYTES = 4 * 1024;

export interface IngestAssetInput {
  projectId: ProjectId;
  kind: AssetKind;
  filename: string;
  stream: AsyncIterable<Uint8Array>;
  expectedRevision: number;
  signal?: AbortSignal;
  pendingMount?: { operationId: string; atSeconds: number; trackIndex: number };
}

export interface IngestAssetOutput {
  path: RelPath;
  renamedFrom: string | null;
  assetContentHash: ContentHash;
  metadata: AssetProbeMetadata;
  replayed: boolean;
  revision: number;
  envelope: WriteEnvelope | null;
}

export interface IngestAssetDependencies {
  workspace: Pick<WorkspacePort, "readProjectRef" | "readTree">;
  journal: Pick<MutationJournalPort, "latestRevision">;
  staging: AssetStagingPort;
  sanitizer: SvgSanitizerPort;
  pendingMount: Pick<PendingMountPort, "lookup">;
  authority: {
    mutateSource(request: CompositeRequest, actor: Actor): Promise<Result<WriteEnvelope, DomainError>>;
  };
  probe: MediaProbePort;
  hashContent(content: string | Uint8Array): ContentHash;
}

function extension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

function directAssetNames(nodes: Awaited<ReturnType<WorkspacePort["readTree"]>>): { names: string[]; exists: boolean } {
  const root = nodes.find((node) => node.kind === "folder" && node.path === "assets");
  return {
    exists: root !== undefined,
    names: root?.children?.map((node) => node.name) ?? [],
  };
}

function pendingInputError(input: IngestAssetInput): DomainError | null {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    return { code: ErrorCode.SchemaInvalid, message: "expectedRevision must be a non-negative integer", field: "expectedRevision" };
  }
  if (!input.pendingMount) return null;
  if (!PendingMountOperationIdSchema.safeParse(input.pendingMount.operationId).success) {
    return { code: ErrorCode.SchemaInvalid, message: "pending mount operationId must be a ULID", field: "operationId" };
  }
  if (!Number.isFinite(input.pendingMount.atSeconds) || input.pendingMount.atSeconds < 0) {
    return { code: ErrorCode.SchemaInvalid, message: "atSeconds must be finite and non-negative", field: "atSeconds" };
  }
  if (!Number.isSafeInteger(input.pendingMount.trackIndex) || input.pendingMount.trackIndex < 0) {
    return { code: ErrorCode.SchemaInvalid, message: "trackIndex must be a non-negative integer", field: "trackIndex" };
  }
  return null;
}

async function probeAsset(
  probe: MediaProbePort,
  ref: ProjectRef,
  path: RelPath,
  kind: AssetKind,
): Promise<AssetProbeMetadata> {
  try {
    const result = kind === "font" ? await probe.probeFont(ref, path) : await probe.probeMedia(ref, path);
    return result.ok ? result.value : { status: "unknown", byteSize: null, reason: result.error.message };
  } catch {
    return { status: "unknown", byteSize: null, reason: "asset metadata could not be read" };
  }
}

async function discard(writer: StagedWriter | null): Promise<void> {
  if (writer) await Promise.allSettled([writer.discard()]);
}

/** Streams one asset through Core gates and publishes it only through WriteAuthority. */
export async function ingestAsset(
  dependencies: IngestAssetDependencies,
  input: IngestAssetInput,
  actor: Actor,
  origin: MutationOrigin,
): Promise<Result<IngestAssetOutput, DomainError>> {
  const invalid = pendingInputError(input);
  if (invalid) return err(invalid);
  const policy = ASSET_POLICIES[input.kind];
  const filenameNfc = input.filename.normalize("NFC");
  const filename = sanitizeFilename(filenameNfc);
  const suffix = extension(filename);
  if (!policy.extensions.includes(suffix)) {
    return err({ code: ErrorCode.AssetNotAllowed, message: `${input.kind} extension is not allowed`, field: "filename" });
  }

  let ref: ProjectRef;
  let currentRevision: number;
  try {
    const found = await dependencies.workspace.readProjectRef(input.projectId);
    if (!found) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
    ref = found;
    currentRevision = (await dependencies.journal.latestRevision(input.projectId)) ?? 0;
    if (!input.pendingMount && currentRevision !== input.expectedRevision) {
      return err({
        code: ErrorCode.WriteConflict,
        message: "project revision changed before asset upload",
        details: { currentRevision },
      });
    }
  } catch {
    return err({ code: ErrorCode.StorageUnavailable, message: "asset upload preconditions could not be read" });
  }

  let rawWriter: StagedWriter | null = null;
  let cleanWriter: StagedWriter | null = null;
  try {
    rawWriter = await dependencies.staging.open(ref, { filename, maxBytes: policy.maxBytes });
    const head = new Uint8Array(MAGIC_HEAD_BYTES);
    let headBytes = 0;
    let totalBytes = 0;
    for await (const chunk of input.stream) {
      if (input.signal?.aborted) {
        return err({ code: ErrorCode.StorageUnavailable, message: "asset upload was cancelled" });
      }
      totalBytes += chunk.byteLength;
      if (totalBytes > policy.maxBytes) {
        return err({
          code: ErrorCode.TooLarge,
          message: `${input.kind} assets are limited to ${policy.maxBytes} bytes`,
          details: { limit: policy.maxBytes, actual: totalBytes },
        });
      }
      const copied = Math.min(chunk.byteLength, MAGIC_HEAD_BYTES - headBytes);
      if (copied > 0) {
        head.set(chunk.subarray(0, copied), headBytes);
        headBytes += copied;
      }
      await rawWriter.write(chunk);
    }
    if (input.signal?.aborted) return err({ code: ErrorCode.StorageUnavailable, message: "asset upload was cancelled" });
    const rawSource = await rawWriter.finalize();
    const magic = head.subarray(0, headBytes);
    if (!matchesDeclaredKind(magic, input.kind)) {
      return err({ code: ErrorCode.UnsupportedMedia, message: "asset signature does not match its declared kind" });
    }
    const svg = isSvgContent(magic);
    if (input.kind === "image" && (suffix === "svg") !== svg) {
      return err({ code: ErrorCode.UnsupportedMedia, message: "image signature does not match its filename extension" });
    }

    const pending = input.pendingMount;
    const uploadFingerprint = dependencies.hashContent(canonicalizeJson({
      kind: input.kind,
      filenameNfc,
      atSeconds: pending?.atSeconds ?? null,
      trackIndex: pending?.trackIndex ?? null,
      requestContentHash: rawSource.contentHash,
    }));
    if (pending) {
      let prior: Awaited<ReturnType<PendingMountPort["lookup"]>>;
      try { prior = await dependencies.pendingMount.lookup(input.projectId, pending.operationId); }
      catch { return err({ code: ErrorCode.StorageUnavailable, message: "pending mount state could not be read" }); }
      if (prior.state === "expired") {
        return err({ code: ErrorCode.NotFound, message: "pending mount operation has expired" });
      }
      if (prior.state === "active") {
        if (prior.record.operationId !== pending.operationId
          || prior.record.projectId !== input.projectId
          || prior.record.uploadFingerprint !== uploadFingerprint
          || prior.record.atSeconds !== pending.atSeconds
          || prior.record.trackIndex !== pending.trackIndex) {
          return err({ code: ErrorCode.WriteConflict, message: "pending mount operation was already used with different input" });
        }
        return ok({
          path: prior.record.assetPath,
          renamedFrom: prior.record.assetPath.slice("assets/".length) === filename ? null : filename,
          assetContentHash: prior.record.assetContentHash,
          metadata: await probeAsset(dependencies.probe, ref, prior.record.assetPath, input.kind),
          replayed: true,
          revision: currentRevision,
          envelope: null,
        });
      }
    }

    let publishSource: StagedFileSource = rawSource;
    if (svg) {
      const sanitized = await dependencies.sanitizer.sanitize(rawSource);
      if (!sanitized.ok) return sanitized;
      cleanWriter = await dependencies.staging.open(ref, { filename, maxBytes: policy.maxBytes });
      await cleanWriter.write(new TextEncoder().encode(sanitized.value));
      publishSource = await cleanWriter.finalize();
    }

    try { currentRevision = (await dependencies.journal.latestRevision(input.projectId)) ?? 0; }
    catch { return err({ code: ErrorCode.StorageUnavailable, message: "project revision could not be read" }); }
    if (currentRevision !== input.expectedRevision) {
      return err({
        code: ErrorCode.WriteConflict,
        message: "project revision changed before asset upload",
        details: { currentRevision },
      });
    }

    let tree: Awaited<ReturnType<WorkspacePort["readTree"]>>;
    try { tree = await dependencies.workspace.readTree(ref); }
    catch { return err({ code: ErrorCode.StorageUnavailable, message: "project assets could not be listed" }); }
    const assets = directAssetNames(tree);
    const finalName = resolveCollision(filename, new Set(assets.names));
    const path = `assets/${finalName}` as RelPath;
    const steps: CompositeRequest["steps"] = [];
    if (!assets.exists) steps.push({ kind: "mkdir", path: "assets" as RelPath, expectExisting: "either" });
    steps.push({
      kind: "write-staged",
      path,
      source: publishSource,
      expectedContentHash: null,
      undoable: false,
    });
    const written = await dependencies.authority.mutateSource({
      ref,
      steps,
      origin,
      toolAudit: null,
      pendingMountTransition: pending ? {
        kind: "open",
        operationId: pending.operationId,
        record: {
          operationId: pending.operationId,
          projectId: input.projectId,
          assetPath: path,
          assetContentHash: publishSource.contentHash,
          uploadFingerprint,
          atSeconds: pending.atSeconds,
          trackIndex: pending.trackIndex,
        },
      } : undefined,
      backup: false,
    }, actor);
    if (!written.ok) return written;
    return ok({
      path,
      renamedFrom: finalName === filename ? null : filename,
      assetContentHash: publishSource.contentHash,
      metadata: await probeAsset(dependencies.probe, ref, path, input.kind),
      replayed: false,
      revision: written.value.projectRevision,
      envelope: written.value,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AssetStagingLimitError") {
      const detail = error as Error & { limit?: number; actual?: number };
      return err({
        code: ErrorCode.TooLarge,
        message: `${input.kind} assets are limited to ${policy.maxBytes} bytes`,
        details: { limit: detail.limit ?? policy.maxBytes, actual: detail.actual },
      });
    }
    return err({ code: ErrorCode.StorageUnavailable, message: "asset upload could not be staged" });
  } finally {
    await discard(cleanWriter);
    await discard(rawWriter);
  }
}
