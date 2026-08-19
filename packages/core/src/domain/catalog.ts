import { compareVersions, validate as isSemver } from "compare-versions";

import { type ContentHash, type RelPath } from "@vidcom/contracts";

import { err, ok, type Result } from "../error/result";
import { HYPERFRAMES_EXPECTED_VERSION, type StagedFileSource } from "../port/types";

/**
 * Normalized VidCom catalog contract (Design §5.16).
 *
 * This is deliberately *not* the upstream HyperFrames schema: 0.7.86 publishes
 * `hyperframes:example | hyperframes:block | hyperframes:component`, has no
 * version, no digest and no category. The Adapter validates that boundary and
 * normalizes into these types, so nothing downstream has to know two shapes.
 */
export type CatalogItemKind = "template" | "block" | "motion-graphic" | "start-end" | "video";

/** Digest set for a package whose bytes are present and hashed. */
export interface CatalogIntegrity {
  algo: "sha256";
  /** Digest per package-relative file target; the exact expected file set. */
  files: Record<RelPath, string>;
  /** Digest of the canonicalized manifest, so displayed metadata is covered too. */
  manifest: string;
}

export interface CatalogItem {
  name: string;
  /** Required, never inferred from a tag. */
  kind: CatalogItemKind;
  title: string;
  description: string | null;
  /** Canonical: NFC, de-duplicated, sorted by code point. */
  tags: string[];
  /** R9.1 "group" and R9.5 "category" are this one normalized field. */
  category: string;
  /** Bundled items use semver; HyperFrames snapshots use `git:<40 lowercase hex>`. */
  version: string;
  /** Bundled/materialized packages carry digests; network listings stay null. */
  integrity: CatalogIntegrity | null;
  materialization: "metadata" | "verified";
  source: {
    registry: "bundled" | "hyperframes";
    url: string | null;
    /** 40-hex commit when the registry is HyperFrames. */
    revision: string | null;
    /** RFC 3339; only used to classify a different commit as newer/older. */
    committedAt: string | null;
  };
  /** Topo-sorted closure, excluding the item itself. */
  dependencies: string[];
  compatibility: {
    aspectRatios: string[] | null;
    minWidth: number | null;
    fps: number[] | null;
    minHyperframesVersion: string | null;
  };
  durationSeconds: number | null;
  /** Entry composition of the top-level item, never taken from a dependency. */
  entry: RelPath;
  preview: { kind: "image"; path: RelPath } | null;
}

/** A catalog item whose bytes are present, hashed and safe to install from. */
export type VerifiedCatalogItem = CatalogItem & {
  integrity: CatalogIntegrity;
  materialization: "verified";
};

/** One materialized package file, exposed as a capability instead of bytes. */
export interface CatalogMaterializedFile {
  path: RelPath;
  contentHash: ContentHash;
  source: StagedFileSource;
  encoding: "utf8" | "binary";
}

/** Filter applied to a catalog listing; `kind` is matched before text. */
export interface CatalogListFilter {
  kind?: CatalogItemKind;
  category?: string;
  tags?: readonly string[];
  query?: string;
}

export interface CatalogListing {
  items: CatalogItem[];
  source: "bundled" | "cache" | "network";
  stale: boolean;
}

/** Kebab slug policy shared by item names and dependency names. */
export const CATALOG_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Post-NFC code-point bounds for normalized metadata (Design §5.16). */
export const CATALOG_METADATA_LIMITS = Object.freeze({
  name: 128,
  title: 256,
  category: 64,
  tag: 64,
  description: 2_048,
  tags: 32,
});

const GIT_VERSION_PATTERN = /^git:([0-9a-f]{40})$/;
/**
 * Canonical semver shape (semver.org), used for our own version fields.
 *
 * `compare-versions` deliberately accepts loose input such as `v1.2.0` or `0.8`;
 * a normalized catalog version may not, because the version string feeds the
 * manifest digest and the install grant binding, and two spellings of one
 * version would produce two digests for the same package. Ordering still comes
 * from `compare-versions` — this only constrains the shape.
 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Version identity of a catalog item: a bundled semver or a pinned commit. */
export type CatalogVersion =
  | { kind: "semver"; value: string }
  | { kind: "git"; commit: string };

/** Parses a normalized version string; anything else is a rejected item. */
export function parseCatalogVersion(version: string): CatalogVersion | null {
  const git = GIT_VERSION_PATTERN.exec(version);
  if (git) return { kind: "git", commit: git[1]! };
  return SEMVER_PATTERN.test(version) ? { kind: "semver", value: version } : null;
}

/** Code-point length after NFC, so a decomposed string cannot dodge a bound. */
function codePoints(value: string): number {
  return [...value.normalize("NFC")].length;
}

function isCanonicalTagList(tags: readonly string[]): boolean {
  const canonical = tags.map((tag) => tag.normalize("NFC"));
  if (canonical.some((tag, index) => tag !== tags[index])) return false;
  const unique = [...new Set(canonical)];
  if (unique.length !== canonical.length) return false;
  const sorted = [...unique].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return sorted.every((tag, index) => tag === canonical[index]);
}

/** Whether a catalog item may be installed: bytes present and hashed. */
export function isVerifiedCatalogItem(item: CatalogItem): item is VerifiedCatalogItem {
  return item.materialization === "verified" && item.integrity !== null;
}

/** Stable diagnostic codes; a rejected item is dropped with one of these. */
export type CatalogItemDefect =
  | "name_invalid"
  | "name_too_long"
  | "title_too_long"
  | "category_invalid"
  | "category_too_long"
  | "description_too_long"
  | "tag_too_long"
  | "too_many_tags"
  | "tags_not_canonical"
  | "version_invalid"
  | "version_registry_mismatch"
  | "version_revision_mismatch"
  | "revision_required"
  | "revision_forbidden"
  | "integrity_required"
  | "integrity_forbidden"
  | "entry_not_relative"
  | "entry_not_in_package"
  | "dependency_name_invalid"
  | "dependency_self_reference"
  | "dependency_duplicate";

function isRelativeInsidePackage(target: string): boolean {
  if (target.length === 0 || target.startsWith("/") || target.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(target)) return false;
  return !target.split(/[/\\]/).some((segment) => segment === "" || segment === "." || segment === "..");
}

/**
 * Validates one normalized item against the contract invariants.
 *
 * Returns every defect rather than the first, so an adapter can log one stable
 * diagnostic set per dropped item instead of re-running the check.
 */
export function validateCatalogItem(item: CatalogItem): CatalogItemDefect[] {
  const defects: CatalogItemDefect[] = [];

  if (!CATALOG_NAME_PATTERN.test(item.name)) defects.push("name_invalid");
  if (codePoints(item.name) > CATALOG_METADATA_LIMITS.name) defects.push("name_too_long");
  if (codePoints(item.title) > CATALOG_METADATA_LIMITS.title) defects.push("title_too_long");
  if (item.category.length === 0 || item.category !== item.category.normalize("NFC")) {
    defects.push("category_invalid");
  }
  if (codePoints(item.category) > CATALOG_METADATA_LIMITS.category) defects.push("category_too_long");
  if (item.description !== null
    && codePoints(item.description) > CATALOG_METADATA_LIMITS.description) {
    defects.push("description_too_long");
  }
  if (item.tags.some((tag) => codePoints(tag) > CATALOG_METADATA_LIMITS.tag)) {
    defects.push("tag_too_long");
  }
  if (item.tags.length > CATALOG_METADATA_LIMITS.tags) defects.push("too_many_tags");
  if (!isCanonicalTagList(item.tags)) defects.push("tags_not_canonical");

  const version = parseCatalogVersion(item.version);
  if (version === null) defects.push("version_invalid");
  else if (item.source.registry === "bundled") {
    if (version.kind !== "semver") defects.push("version_registry_mismatch");
    if (item.source.revision !== null) defects.push("revision_forbidden");
  } else {
    if (version.kind !== "git") defects.push("version_registry_mismatch");
    if (item.source.revision === null) defects.push("revision_required");
    else if (version.kind === "git" && item.source.revision !== version.commit) {
      defects.push("version_revision_mismatch");
    }
  }

  if (item.materialization === "verified" && item.integrity === null) defects.push("integrity_required");
  if (item.materialization === "metadata" && item.integrity !== null) defects.push("integrity_forbidden");

  if (!isRelativeInsidePackage(item.entry)) defects.push("entry_not_relative");
  else if (item.integrity !== null && !(item.entry in item.integrity.files)) {
    defects.push("entry_not_in_package");
  }

  if (item.dependencies.some((name) => !CATALOG_NAME_PATTERN.test(name))) {
    defects.push("dependency_name_invalid");
  }
  if (item.dependencies.includes(item.name)) defects.push("dependency_self_reference");
  if (new Set(item.dependencies).size !== item.dependencies.length) {
    defects.push("dependency_duplicate");
  }

  return defects;
}

/** How a reinstall candidate relates to what is already installed. */
export type CatalogVersionRelation = "identical" | "newer" | "older" | "different";

/**
 * Classifies a candidate against an installed version.
 *
 * Semver is compared as semver. Two different commits are ordered only by
 * `committedAt`; equal or unusable timestamps stay `different` rather than
 * claiming one snapshot is newer.
 */
export function classifyCatalogVersion(
  existing: { version: string; committedAt: string | null },
  candidate: { version: string; committedAt: string | null },
): CatalogVersionRelation {
  if (existing.version === candidate.version) return "identical";
  const left = parseCatalogVersion(existing.version);
  const right = parseCatalogVersion(candidate.version);
  if (left === null || right === null || left.kind !== right.kind) return "different";
  if (left.kind === "semver" && right.kind === "semver") {
    const order = compareVersions(right.value, left.value);
    return order > 0 ? "newer" : order < 0 ? "older" : "identical";
  }
  const existingAt = Date.parse(existing.committedAt ?? "");
  const candidateAt = Date.parse(candidate.committedAt ?? "");
  if (!Number.isFinite(existingAt) || !Number.isFinite(candidateAt)) return "different";
  if (candidateAt > existingAt) return "newer";
  if (candidateAt < existingAt) return "older";
  return "different";
}

/** Runtime compatibility verdict surfaced before a mount (R7.5). */
export type CatalogRuntimeCompatibility =
  | { status: "compatible" }
  | { status: "incompatible"; required: string; runtime: string }
  | { status: "unknown"; required: string };

/**
 * Compares `compatibility.minHyperframesVersion` with the pinned runtime.
 *
 * An unparsable requirement is `unknown`, not silently compatible: the UI has to
 * say it cannot verify the requirement instead of implying it was checked.
 */
export function assessCatalogRuntimeCompatibility(
  item: CatalogItem,
  runtimeVersion: string = HYPERFRAMES_EXPECTED_VERSION,
): CatalogRuntimeCompatibility {
  const required = item.compatibility.minHyperframesVersion;
  if (required === null) return { status: "compatible" };
  if (!isSemver(required) || !isSemver(runtimeVersion)) return { status: "unknown", required };
  return compareVersions(runtimeVersion, required) >= 0
    ? { status: "compatible" }
    : { status: "incompatible", required, runtime: runtimeVersion };
}

/** Upstream item kinds a dependency closure may contain. */
export type CatalogDependencyKind = "block" | "component" | "example";

export interface CatalogDependencyNode {
  dependencies: readonly string[];
  kind: CatalogDependencyKind;
}

export type CatalogDependencyFailure =
  | { code: "dependency_missing"; name: string }
  | { code: "dependency_cycle"; name: string }
  | { code: "dependency_unsupported"; name: string };

/**
 * Resolves the dependency closure of one root into install order.
 *
 * The root itself is excluded, so the result is exactly `CatalogItem.dependencies`.
 * Only `hyperframes:component` may be pulled in as a dependency: an example is a
 * whole-project scaffold and a nested block would bring its own entry, so both
 * reject the entire package instead of being partially installed.
 */
export function orderCatalogDependencyClosure(
  root: string,
  lookup: (name: string) => CatalogDependencyNode | undefined,
): Result<string[], CatalogDependencyFailure> {
  const ordered: string[] = [];
  const settled = new Set<string>();
  const onStack = new Set<string>();

  const visit = (name: string, isRoot: boolean): CatalogDependencyFailure | null => {
    if (settled.has(name)) return null;
    if (onStack.has(name)) return { code: "dependency_cycle", name };
    const node = lookup(name);
    if (node === undefined) return { code: "dependency_missing", name };
    if (!isRoot && node.kind !== "component") return { code: "dependency_unsupported", name };
    onStack.add(name);
    for (const dependency of node.dependencies) {
      const failure = visit(dependency, false);
      if (failure) return failure;
    }
    onStack.delete(name);
    settled.add(name);
    if (!isRoot) ordered.push(name);
    return null;
  };

  const failure = visit(root, true);
  return failure ? err(failure) : ok(ordered);
}
