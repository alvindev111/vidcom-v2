import { type ContentHash, type RelPath } from "@vidcom/contracts";

import { err, ok, type Result } from "../error/result";
import { isVerifiedCatalogItem, type CatalogItem, type VerifiedCatalogItem } from "./catalog";

/**
 * The check every catalog install must pass before a `CompositeRequest` exists
 * (Design §5.16b).
 *
 * All four rules are here rather than spread across the adapter and the route:
 * an unverified item, an escaping path, a duplicate target, a file set that
 * differs from the manifest in either direction, a wrong file digest or a wrong
 * manifest digest each mean zero writes. The digest itself is computed by the
 * adapter that owns hashing; Core decides what a match means.
 */

export type CatalogPackageRejection =
  | { code: "not_verified" }
  | { code: "path_escape"; path: string }
  | { code: "path_duplicate"; path: RelPath }
  | { code: "file_set_mismatch"; missing: RelPath[]; unexpected: RelPath[] }
  | { code: "file_digest_mismatch"; path: RelPath }
  | { code: "manifest_digest_mismatch" }
  | { code: "entry_not_in_package" };

export interface CatalogPackageFileDigest {
  path: RelPath;
  contentHash: ContentHash;
}

/** True when a package-relative target stays inside the project. */
export function isContainedPackagePath(target: string): boolean {
  if (target.length === 0 || target.startsWith("/") || target.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(target)) return false;
  return !target.split(/[/\\]/).some((segment) => segment === "" || segment === "." || segment === "..");
}

function sorted(values: Iterable<RelPath>): RelPath[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function verifyCatalogPackage(input: {
  item: CatalogItem;
  files: readonly CatalogPackageFileDigest[];
  /** Digest recomputed from the current item by the hashing adapter. */
  manifestDigest: string;
}): Result<VerifiedCatalogItem, CatalogPackageRejection> {
  const { item, files, manifestDigest } = input;
  if (!isVerifiedCatalogItem(item)) return err({ code: "not_verified" });

  const declared = Object.keys(item.integrity.files) as RelPath[];
  for (const target of [...declared, ...files.map((file) => file.path)]) {
    if (!isContainedPackagePath(target)) return err({ code: "path_escape", path: target });
  }

  const seen = new Set<RelPath>();
  for (const file of files) {
    if (seen.has(file.path)) return err({ code: "path_duplicate", path: file.path });
    seen.add(file.path);
  }

  const expected = new Set(declared);
  const missing = sorted([...expected].filter((target) => !seen.has(target)));
  const unexpected = sorted([...seen].filter((target) => !expected.has(target)));
  if (missing.length > 0 || unexpected.length > 0) {
    return err({ code: "file_set_mismatch", missing, unexpected });
  }

  for (const file of files) {
    if (file.contentHash !== `sha256:${item.integrity.files[file.path]}`) {
      return err({ code: "file_digest_mismatch", path: file.path });
    }
  }
  if (manifestDigest !== item.integrity.manifest) return err({ code: "manifest_digest_mismatch" });
  if (!expected.has(item.entry)) return err({ code: "entry_not_in_package" });
  return ok(item);
}

/** Metadata mounted beside a package instance, and read back from the source. */
export interface CatalogProvenance {
  name: string;
  title: string;
  description: string | null;
  category: string;
  tags: string[];
  registry: "bundled" | "hyperframes";
  version: string;
  integrity: string;
}

/** Projects a verified item into the exact provenance object that gets mounted. */
export function catalogProvenanceOf(item: VerifiedCatalogItem): CatalogProvenance {
  return {
    name: item.name,
    title: item.title,
    description: item.description,
    category: item.category,
    tags: [...item.tags],
    registry: item.source.registry,
    version: item.version,
    integrity: item.integrity.manifest,
  };
}

/** Parses mounted provenance; anything not matching the exact shape is null. */
export function parseCatalogProvenance(value: string): CatalogProvenance | null {
  let raw: unknown;
  try {
    raw = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const strings = ["name", "title", "category", "version", "integrity"] as const;
  if (strings.some((key) => typeof record[key] !== "string")) return null;
  if (record.description !== null && typeof record.description !== "string") return null;
  if (record.registry !== "bundled" && record.registry !== "hyperframes") return null;
  if (!Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== "string")) return null;
  return {
    name: record.name as string,
    title: record.title as string,
    description: record.description as string | null,
    category: record.category as string,
    tags: record.tags as string[],
    registry: record.registry,
    version: record.version as string,
    integrity: record.integrity as string,
  };
}
