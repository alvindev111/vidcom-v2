import {
  ErrorCode,
  type Actor,
  type ContentHash,
  type DomainError,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";

import { type CatalogMaterializedFile, type VerifiedCatalogItem } from "../domain/catalog";
import {
  catalogProvenanceOf,
  verifyCatalogPackage,
  type CatalogProvenance,
} from "../domain/catalog-install-guard";
import type { CompositionModel, ProjectRef } from "../domain/models";
import {
  planCatalogInstall,
  type CatalogExistingPolicy,
  type CatalogInstallDecision,
  type CatalogInstallMount,
  type CatalogInstallPlan,
} from "../domain/plan-catalog-install";
import { err, ok, type Result } from "../error/result";
import type { MutationOrigin } from "../port/mutation-observer";
import type { CompositionPort, MutationJournalPort, WorkspacePort } from "../port/ports";
import type {
  CompositeRequest,
  GrantBinding,
  WriteEnvelope,
  WriteInvocation,
} from "../port/types";
import { canonicalizeJson } from "../service/canonical-json";
import { assembleCatalogInstallComposite } from "./assemble-catalog-install";
import { planCatalogMountDocuments } from "./plan-catalog-mount";

/**
 * Exact-intent install: `prepare → grant → execute` (Design §5.17).
 *
 * Both phases run the identical planner. `prepare` materializes, verifies,
 * computes the binding and then releases its cache pin, so nothing survives in
 * memory while the author looks at a dialog; `execute` receives the same intent,
 * materializes again, rebuilds the binding, reserves the grant and only then
 * mutates, holding the pin until the mutation settles. Any drift in intent,
 * digest, hash or revision therefore fails before a single byte is written.
 */

export const CATALOG_INSTALL_TOOL = "install_catalog_item";

export interface CatalogInstallIntent {
  projectId: ProjectId;
  name: string;
  version: string;
  mount: CatalogInstallMount;
  existingPolicy?: CatalogExistingPolicy;
  expectedRevision: number;
}

export interface CatalogInstallDependencies {
  workspace: Pick<WorkspacePort, "readProjectRef" | "resolve" | "readHash">;
  composition: Pick<CompositionPort, "parseProject" | "applyOps">;
  journal: Pick<MutationJournalPort, "latestRevision">;
  catalog: {
    materialize(name: string, version: string, signal: AbortSignal): Promise<Result<{
      item: VerifiedCatalogItem;
      files: readonly CatalogMaterializedFile[];
      release(): Promise<void>;
    }, DomainError>>;
  };
  /** Provenance already mounted for this package, parsed from the composition. */
  installedProvenance(ref: ProjectRef, name: string): Promise<CatalogProvenance | null>;
  hashContent(content: string | Uint8Array): ContentHash;
  /** Digest of the current item, recomputed by the hashing adapter. */
  manifestDigest(item: VerifiedCatalogItem): string;
  clock: { now(): Date };
}

export interface CatalogInstallExecuteDependencies extends CatalogInstallDependencies {
  approval: {
    planReserve(grantId: string, binding: GrantBinding): Promise<Result<unknown, DomainError>>;
  };
  authority: {
    mutateSource(request: CompositeRequest, actor: Actor): Promise<Result<WriteEnvelope, DomainError>>;
  };
}

export type CatalogInstallPreparation =
  | { status: "choice_required"; decision: Extract<CatalogInstallDecision, { status: "choice_required" }> }
  | { status: "skipped" }
  | { status: "ready"; plan: CatalogInstallPlan; binding: GrantBinding };

interface PlannedInstall {
  ref: ProjectRef;
  model: CompositionModel;
  item: VerifiedCatalogItem;
  files: readonly CatalogMaterializedFile[];
  preparation: CatalogInstallPreparation;
  documentHashes: Record<RelPath, ContentHash>;
  release(): Promise<void>;
}

async function readHashOf(
  dependencies: CatalogInstallDependencies,
  ref: ProjectRef,
  path: RelPath,
  purpose: "read-source" | "read-package-target",
): Promise<Result<ContentHash | null, DomainError>> {
  const resolved = await dependencies.workspace.resolve(ref, path, purpose);
  if (!resolved.ok) {
    return err({
      code: resolved.error.reason === "invalid_syntax"
        ? ErrorCode.PathInvalid
        : resolved.error.reason === "not_allowed_for_purpose"
          ? ErrorCode.AssetNotAllowed
          : ErrorCode.PathOutsideProject,
      message: "catalog target path could not be read",
      field: "path",
      details: { path, reason: resolved.error.reason },
    });
  }
  return ok(await dependencies.workspace.readHash(resolved.value));
}

/** Shared planner; the caller decides when to release the returned pin. */
async function planInstall(
  dependencies: CatalogInstallDependencies,
  intent: CatalogInstallIntent,
  signal: AbortSignal,
): Promise<Result<PlannedInstall, DomainError>> {
  const ref = await dependencies.workspace.readProjectRef(intent.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  const latestRevision = await dependencies.journal.latestRevision(intent.projectId) ?? 0;
  if (latestRevision !== intent.expectedRevision) {
    return err({
      code: ErrorCode.WriteConflict,
      message: "project revision changed before catalog install planning",
      details: { currentRevision: latestRevision },
    });
  }
  const materialized = await dependencies.catalog.materialize(intent.name, intent.version, signal);
  if (!materialized.ok) return materialized;
  const { item, files, release } = materialized.value;
  let transferred = false;
  try {
    signal.throwIfAborted();
    const verified = verifyCatalogPackage({
      item,
      files: files.map((file) => ({ path: file.path, contentHash: file.contentHash })),
      manifestDigest: dependencies.manifestDigest(item),
    });
    if (!verified.ok) {
      return err({
        code: ErrorCode.IntegrityMismatch,
        message: "the catalog package failed verification",
        details: { rejection: verified.error },
      });
    }
    let model: CompositionModel;
    try { model = await dependencies.composition.parseProject(ref); }
    catch { return err({ code: ErrorCode.StorageUnavailable, message: "composition could not be read" }); }
    signal.throwIfAborted();

    const targets: Record<RelPath, ContentHash | null> = {};
    for (const path of Object.keys(item.integrity.files) as RelPath[]) {
      signal.throwIfAborted();
      const target = await readHashOf(dependencies, ref, path, "read-package-target");
      if (!target.ok) return target;
      targets[path] = target.value;
    }
    const installed = await dependencies.installedProvenance(ref, item.name);
    const planned = planCatalogInstall({
      item,
      targets,
      installed,
      mount: intent.mount,
      expectedRevision: intent.expectedRevision,
      ...(intent.existingPolicy ? { existingPolicy: intent.existingPolicy } : {}),
    });
    if (!planned.ok) return err(mapPlanRejection(planned.error));

    // Authored documents this mutation will rewrite are existing targets too, so
    // their real hashes belong in the binding beside the package targets.
    const documentHashes: Record<RelPath, ContentHash> = {};
    const entryHash = await readHashOf(dependencies, ref, ref.entry, "read-source");
    if (!entryHash.ok) return entryHash;
    if (entryHash.value) documentHashes[ref.entry] = entryHash.value;
    if (intent.mount.kind === "into-scene") {
      const sceneId = intent.mount.sceneId;
      const scene = (model.scenes as unknown as { id: string; src?: string | null }[])
        .find((candidate) => candidate.id === sceneId);
      const scenePath = (scene?.src ?? null) as RelPath | null;
      if (scenePath) {
        const sceneHash = await readHashOf(dependencies, ref, scenePath, "read-source");
        if (!sceneHash.ok) return sceneHash;
        if (sceneHash.value) documentHashes[scenePath] = sceneHash.value;
      }
    }

    if (planned.value.status !== "ready") {
      const value: PlannedInstall = {
        ref,
        model,
        item,
        files,
        preparation: planned.value.status === "skipped"
          ? { status: "skipped" }
          : { status: "choice_required", decision: planned.value },
        documentHashes,
        release,
      };
      transferred = true;
      return ok(value);
    }

    const plan = planned.value.plan;
    const binding: GrantBinding = {
      tool: CATALOG_INSTALL_TOOL,
      projectId: intent.projectId,
      target: canonicalizeJson({ name: intent.name, version: intent.version, mount: intent.mount }),
      expectedRevision: intent.expectedRevision,
      planDigest: dependencies.hashContent(canonicalizeJson({
        ...plan.digestInput,
        documentHashes,
      })),
      targetHashes: { ...plan.targetHashes, ...documentHashes },
    };
    const value: PlannedInstall = {
      ref,
      model,
      item,
      files,
      preparation: { status: "ready", plan, binding },
      documentHashes,
      release,
    };
    transferred = true;
    return ok(value);
  } finally {
    if (!transferred) await release();
  }
}

function mapPlanRejection(rejection: { code: string }): DomainError {
  if (rejection.code === "integrity_mismatch") {
    return { code: ErrorCode.IntegrityMismatch, message: "the installed package has the same version with different bytes" };
  }
  if (rejection.code === "policy_not_allowed") {
    return { code: ErrorCode.SchemaInvalid, message: "that choice is not available for this package", field: "existingPolicy" };
  }
  return { code: ErrorCode.InvariantViolated, message: "this catalog item cannot be mounted that way" };
}

export async function prepareCatalogInstall(
  dependencies: CatalogInstallDependencies,
  intent: CatalogInstallIntent,
  signal: AbortSignal = AbortSignal.timeout(60_000),
): Promise<Result<CatalogInstallPreparation, DomainError>> {
  const planned = await planInstall(dependencies, intent, signal);
  if (!planned.ok) return planned;
  try {
    return ok(planned.value.preparation);
  } finally {
    // Nothing is held while the author decides: no pin, no staged source, no plan.
    await planned.value.release();
  }
}

export async function executeCatalogInstall(
  dependencies: CatalogInstallExecuteDependencies,
  input: { intent: CatalogInstallIntent; grantId: string },
  actor: Actor,
  invocation: WriteInvocation & { origin: MutationOrigin },
  signal: AbortSignal = AbortSignal.timeout(120_000),
): Promise<Result<{
  packageStatus: "installed" | "reused" | "replaced";
  files: CatalogInstallPlan["files"];
  provenance: CatalogProvenance;
  sceneId: string | null;
  envelope: WriteEnvelope;
}, DomainError>> {
  const planned = await planInstall(dependencies, input.intent, signal);
  if (!planned.ok) return planned;
  const { ref, model, item, files, preparation, documentHashes, release } = planned.value;
  try {
    if (preparation.status === "skipped") {
      return err({ code: ErrorCode.SchemaInvalid, message: "this install was skipped", field: "existingPolicy" });
    }
    if (preparation.status !== "ready") {
      return err({
        code: ErrorCode.PreconditionRequired,
        message: "this package needs an explicit choice before it can be installed",
        field: "existingPolicy",
      });
    }
    const reserved = await dependencies.approval.planReserve(input.grantId, preparation.binding);
    if (!reserved.ok) return reserved;

    const documents = await planCatalogMountDocuments({
      ref,
      model,
      item,
      mount: input.intent.mount,
      entryHash: documentHashes[ref.entry] ?? null,
      sceneHash: input.intent.mount.kind === "into-scene"
        ? Object.entries(documentHashes)
          .filter(([path]) => path !== ref.entry)
          .map(([, hash]) => hash)[0] ?? null
        : null,
      composition: dependencies.composition,
      now: () => dependencies.clock.now(),
    });
    if (!documents.ok) {
      return err({ code: ErrorCode.InvariantViolated, message: "the catalog mount could not be planned" });
    }

    const provenance = catalogProvenanceOf(item);
    const composite = assembleCatalogInstallComposite({
      ref,
      item,
      plan: preparation.plan,
      files,
      documents: documents.value.documents,
      provenance,
      origin: invocation.origin,
      toolAudit: invocation.toolAudit,
      grant: { id: input.grantId, binding: preparation.binding },
    });
    if (!composite.ok) {
      return err({ code: ErrorCode.InvariantViolated, message: "the catalog composite could not be assembled" });
    }
    const written = await dependencies.authority.mutateSource(composite.value, actor);
    if (!written.ok) return written;
    const actions = new Set(preparation.plan.files.map((file) => file.action));
    return ok({
      packageStatus: actions.has("replace") ? "replaced" : actions.has("create") ? "installed" : "reused",
      files: preparation.plan.files,
      provenance,
      sceneId: documents.value.sceneId,
      envelope: written.value,
    });
  } finally {
    // The pin outlives only the mutation, and it is released even when the grant,
    // the mount planning or the authority rejects.
    await release();
  }
}
