import { type ContentHash, type RelPath } from "@vidcom/contracts";

import { err, ok, type Result } from "../error/result";
import { classifyCatalogVersion, type CatalogItemKind, type VerifiedCatalogItem } from "./catalog";
import { type CatalogProvenance } from "./catalog-install-guard";

/**
 * Install/mount policy for a catalog package (Design §5.17).
 *
 * Pure on purpose: the questions this answers — may this kind mount here, is
 * this a reinstall, may the author reuse or replace, which files change and what
 * exactly does the grant bind — are product decisions, so they live in Core and
 * are decided once for the route, the UI and the mutation.
 */

export type CatalogInstallMount =
  | {
    kind: "new-scene";
    /** Global storyboard slot; Core maps it to a slot inside the selected track. */
    toIndex: number;
    trackIndex?: number;
  }
  | { kind: "into-scene"; sceneId: string };

export type CatalogFileAction = "create" | "replace" | "reuse";
export type CatalogExistingPolicy = "reuse" | "replace" | "skip";

export interface CatalogPlannedFile {
  path: RelPath;
  action: CatalogFileAction;
  /** Exact pre-image for a replace, `null` when the target must be absent. */
  fromHash: ContentHash | null;
  toDigest: string;
}

export interface CatalogInstallPlan {
  files: CatalogPlannedFile[];
  /** `mkdir either` parents, shallow-first, so no publish mkdirs outside the journal. */
  directories: string[];
  mountTarget: RelPath;
  mount: CatalogInstallMount;
  existingPolicy: CatalogExistingPolicy | null;
  expectedRevision: number;
  /** Reused files enter history read guards rather than the write set. */
  readGuards: Record<RelPath, ContentHash>;
  /** Only targets that currently exist; absence is locked by the digest instead. */
  targetHashes: Record<RelPath, ContentHash>;
  /** Canonicalized by the caller into `GrantBinding.planDigest`. */
  digestInput: Record<string, unknown>;
}

export type CatalogInstallDecision =
  | {
      status: "choice_required";
      comparison: "identical" | "newer" | "older" | "different" | "unmanaged";
      choices: CatalogExistingPolicy[];
      existing: {
        version: string | null;
        integrity: string | null;
        targetHashes: Record<RelPath, ContentHash>;
      };
      candidate: { version: string; integrity: string };
    }
  | { status: "skipped" }
  | { status: "ready"; plan: CatalogInstallPlan };

export type CatalogInstallRejection =
  | { code: "kind_not_installable"; kind: CatalogItemKind }
  | { code: "mount_not_supported"; kind: CatalogItemKind }
  | { code: "integrity_mismatch"; version: string }
  | { code: "policy_not_allowed"; policy: CatalogExistingPolicy };

export interface CatalogInstallPlanInput {
  item: VerifiedCatalogItem;
  /** Current hash of every package target, `null` when absent. */
  targets: Record<RelPath, ContentHash | null>;
  /** Provenance already mounted for this package, when it is managed. */
  installed: CatalogProvenance | null;
  mount: CatalogInstallMount;
  expectedRevision: number;
  existingPolicy?: CatalogExistingPolicy;
}

function parentDirectories(paths: readonly RelPath[]): string[] {
  const seen = new Set<string>();
  for (const target of paths) {
    const segments = target.split("/");
    segments.pop();
    for (let index = 1; index <= segments.length; index += 1) {
      seen.add(segments.slice(0, index).join("/"));
    }
  }
  return [...seen].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth !== 0 ? depth : left.localeCompare(right);
  });
}

export function planCatalogInstall(
  input: CatalogInstallPlanInput,
): Result<CatalogInstallDecision, CatalogInstallRejection> {
  const { item, targets, installed, mount } = input;
  if (item.kind !== "template" && item.kind !== "block") {
    return err({ code: "kind_not_installable", kind: item.kind });
  }
  // A template is a whole scene; nesting it inside another scene is a
  // composition shape R7 does not describe, so it is refused rather than guessed.
  if (item.kind === "template" && mount.kind === "into-scene") {
    return err({ code: "mount_not_supported", kind: item.kind });
  }

  const declared = Object.keys(item.integrity.files) as RelPath[];
  const existingTargets: Record<RelPath, ContentHash> = {};
  for (const target of declared) {
    const current = targets[target] ?? null;
    if (current !== null) existingTargets[target] = current;
  }
  const anyPresent = Object.keys(existingTargets).length > 0;
  const candidate = { version: item.version, integrity: item.integrity.manifest };

  if (!anyPresent) {
    return ok({
      status: "ready",
      plan: buildPlan(input, declared, existingTargets, "create-only"),
    });
  }

  const comparison = installed === null
    ? "unmanaged" as const
    : installed.version === item.version
      ? installed.integrity === item.integrity.manifest ? "identical" as const : "conflict" as const
      : classifyCatalogVersion(
        { version: installed.version, committedAt: null },
        { version: item.version, committedAt: item.source.committedAt },
      );

  // Same version, different bytes is never a choice: one of the two is not what
  // it claims to be, so nothing is offered and nothing is written (R9.5d).
  if (comparison === "conflict") return err({ code: "integrity_mismatch", version: item.version });

  const choices: CatalogExistingPolicy[] = comparison === "identical"
    ? ["reuse", "skip"]
    : ["replace", "skip"];
  const policy = input.existingPolicy;
  if (policy === undefined) {
    return ok({
      status: "choice_required",
      comparison,
      choices,
      existing: {
        version: installed?.version ?? null,
        integrity: installed?.integrity ?? null,
        targetHashes: existingTargets,
      },
      candidate,
    });
  }
  if (!choices.includes(policy)) return err({ code: "policy_not_allowed", policy });
  if (policy === "skip") return ok({ status: "skipped" });
  return ok({
    status: "ready",
    plan: buildPlan(input, declared, existingTargets, policy === "reuse" ? "reuse" : "replace"),
  });
}

function buildPlan(
  input: CatalogInstallPlanInput,
  declared: readonly RelPath[],
  existingTargets: Record<RelPath, ContentHash>,
  mode: "create-only" | "reuse" | "replace",
): CatalogInstallPlan {
  const { item, mount, expectedRevision } = input;
  const files: CatalogPlannedFile[] = [];
  const readGuards: Record<RelPath, ContentHash> = {};
  for (const path of [...declared].sort((left, right) => left.localeCompare(right))) {
    const digest = item.integrity.files[path]!;
    const current = existingTargets[path] ?? null;
    if (mode === "reuse" && current !== null) {
      files.push({ path, action: "reuse", fromHash: current, toDigest: digest });
      readGuards[path] = current;
      continue;
    }
    files.push(current === null
      ? { path, action: "create", fromHash: null, toDigest: digest }
      : { path, action: "replace", fromHash: current, toDigest: digest });
  }
  const written = files.filter((file) => file.action !== "reuse").map((file) => file.path);
  const targetHashes: Record<RelPath, ContentHash> = { ...readGuards };
  for (const file of files) {
    if (file.action === "replace" && file.fromHash !== null) targetHashes[file.path] = file.fromHash;
  }
  const digestInput = {
    name: item.name,
    version: item.version,
    integrity: item.integrity.manifest,
    mount,
    mountTarget: item.entry,
    existingPolicy: input.existingPolicy ?? null,
    expectedRevision,
    files,
    readGuards,
  };
  return {
    files,
    directories: parentDirectories(written),
    mountTarget: item.entry,
    mount,
    existingPolicy: input.existingPolicy ?? null,
    expectedRevision,
    readGuards,
    targetHashes,
    digestInput,
  };
}
