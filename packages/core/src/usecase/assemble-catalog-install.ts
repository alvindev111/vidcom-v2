import { type ContentHash, type RelPath } from "@vidcom/contracts";

import { err, ok, type Result } from "../error/result";
import { type CatalogMaterializedFile, type VerifiedCatalogItem } from "../domain/catalog";
import { type CatalogProvenance } from "../domain/catalog-install-guard";
import { type CatalogInstallPlan } from "../domain/plan-catalog-install";
import type { ProjectRef } from "../domain/models";
import type { MutationOrigin, MutationReadGuard } from "../port/mutation-observer";
import type {
  CompositeRequest,
  CompositeStep,
  GrantBinding,
  PendingToolAudit,
} from "../port/types";

/**
 * Assembles the single composite that installs a catalog package (Design §5.17).
 *
 * One mutation carries the package files, the mount and the provenance, because
 * splitting them would let a project exist with mounted markup pointing at files
 * that were never written, or with orphaned files nothing references. The mount
 * documents arrive already serialized — the composition adapter owns markup — so
 * this stays pure and node-testable.
 */

export interface CatalogMountDocument {
  path: RelPath;
  content: string;
  expectedContentHash: ContentHash | null;
}

export type CatalogCompositeRejection =
  | { code: "staged_set_mismatch"; missing: RelPath[]; unexpected: RelPath[] }
  | { code: "staged_digest_mismatch"; path: RelPath }
  | { code: "mount_document_missing" }
  | { code: "document_duplicate"; path: RelPath }
  | { code: "document_collides_with_package"; path: RelPath };

export interface CatalogCompositeInput {
  ref: ProjectRef;
  item: VerifiedCatalogItem;
  plan: CatalogInstallPlan;
  files: readonly CatalogMaterializedFile[];
  /** Serialized authored documents that carry the mount and its provenance. */
  documents: readonly CatalogMountDocument[];
  provenance: CatalogProvenance;
  origin: MutationOrigin;
  toolAudit: PendingToolAudit | null;
  grant?: { id: string; binding: GrantBinding };
  noteUnchanged?: () => void;
}

function sorted(values: Iterable<RelPath>): RelPath[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function assembleCatalogInstallComposite(
  input: CatalogCompositeInput,
): Result<CompositeRequest, CatalogCompositeRejection> {
  const { plan, files, documents } = input;
  const written = plan.files.filter((file) => file.action !== "reuse");
  const staged = new Map(files.map((file) => [file.path, file]));

  const expected = new Set(written.map((file) => file.path));
  const supplied = new Set(files.map((file) => file.path));
  const missing = sorted([...expected].filter((path) => !supplied.has(path)));
  const unexpected = sorted([...supplied].filter((path) => !plan.files.some((file) => file.path === path)));
  if (missing.length > 0 || unexpected.length > 0) {
    return err({ code: "staged_set_mismatch", missing, unexpected });
  }
  for (const file of written) {
    const source = staged.get(file.path)!;
    if (source.contentHash !== `sha256:${file.toDigest}`) {
      return err({ code: "staged_digest_mismatch", path: file.path });
    }
  }

  if (documents.length === 0) return err({ code: "mount_document_missing" });
  const seen = new Set<RelPath>();
  const packagePaths = new Set(plan.files.map((file) => file.path));
  for (const document of documents) {
    if (seen.has(document.path)) return err({ code: "document_duplicate", path: document.path });
    seen.add(document.path);
    // An authored document may never be a package target: the package write and
    // the mount write would then race for the same path inside one composite.
    if (packagePaths.has(document.path)) {
      return err({ code: "document_collides_with_package", path: document.path });
    }
  }

  const steps: CompositeStep[] = [
    // Shallow-first, so every parent is journaled before its child is published.
    ...plan.directories.map((path): CompositeStep => ({
      kind: "mkdir",
      path: path as RelPath,
      expectExisting: "either",
    })),
    ...written.map((file): CompositeStep => ({
      kind: "write-staged",
      path: file.path,
      source: staged.get(file.path)!.source,
      expectedContentHash: file.fromHash,
      undoable: true,
    })),
    ...documents.map((document): CompositeStep => ({
      kind: "write",
      path: document.path,
      content: document.content,
      expectedContentHash: document.expectedContentHash,
    })),
  ];

  // Reused files are not written, so they enter history as dependencies: another
  // session cannot undo the install that created them while this mount uses them.
  const historyReadGuards: MutationReadGuard[] = Object.entries(plan.readGuards)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, contentHash]) => ({
      path: path as RelPath,
      state: { kind: "file" as const, contentHash },
    }));

  return ok({
    ref: input.ref,
    steps,
    origin: input.origin,
    historyReadGuards,
    toolAudit: input.toolAudit,
    // Nothing is deleted, so no verified backup is required; a replaced file is
    // captured as its own pre-image by the authority.
    backup: false,
    ...(input.grant ? { grant: input.grant } : {}),
    ...(input.noteUnchanged ? { noteUnchanged: input.noteUnchanged } : {}),
  });
}
