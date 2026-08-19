import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import path from "node:path";

import { type RelPath } from "@vidcom/contracts";
import {
  canonicalizeJson,
  validateCatalogItem,
  type CatalogIntegrity,
  type CatalogItem,
  type Result,
} from "@vidcom/core";

import { normalizeBundledCatalogItem, type BundledCatalogItemInput } from "./normalize";

/** Manifest filename inside the frozen snapshot root. */
export const BUNDLED_CATALOG_MANIFEST_FILE = "manifest.json";

/** Directory inside the snapshot root that holds package bytes by target path. */
export const BUNDLED_CATALOG_FILES_DIR = "files";

/** Snapshot schema version; bumped whenever the on-disk shape changes. */
export const BUNDLED_CATALOG_SCHEMA_VERSION = 1;

const HASH_BUFFER_BYTES = 16 * 1024;

export type BundledCatalogFailure = {
  code:
    | "manifest_unreadable"
    | "manifest_invalid"
    | "item_invalid"
    | "file_missing"
    | "integrity_mismatch";
  name: string | null;
};

/**
 * Canonical manifest digest (Design §5.16).
 *
 * Covers displayed metadata as well as bytes, so a package cannot be shown with
 * one title and installed with another while still matching its file digests.
 */
export function catalogManifestDigest(item: CatalogItem): string {
  const canonical = canonicalizeJson({
    name: item.name,
    kind: item.kind,
    title: item.title,
    description: item.description,
    category: item.category,
    tags: item.tags,
    compatibility: item.compatibility,
    durationSeconds: item.durationSeconds,
    entry: item.entry,
    version: item.version,
    sourceRevision: item.source.revision,
    dependencies: item.dependencies,
    files: item.integrity === null
      ? {}
      : Object.fromEntries(
        Object.keys(item.integrity.files)
          .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
          .map((target) => [target, item.integrity!.files[target as RelPath]!]),
      ),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Streams a regular file into a sha256 digest with a bounded buffer. */
async function hashFile(target: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(target, "r");
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    for (let position = 0; ;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

interface RawBundledItem extends Omit<BundledCatalogItemInput, "integrity" | "entry"> {
  entry: string;
  integrity: CatalogIntegrity;
  upstream: { commit: string; committedAt: string | null } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Loads the frozen bundled catalog and verifies it against its own digests.
 *
 * Fails closed: an unreadable snapshot, a missing file or a digest drift is an
 * error, never an empty catalog, because an empty template rail is
 * indistinguishable from an offline network failure to the person using it.
 */
export async function loadBundledCatalog(
  root: string,
): Promise<Result<{ items: CatalogItem[] }, BundledCatalogFailure>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(root, BUNDLED_CATALOG_MANIFEST_FILE), "utf8"));
  } catch {
    return { ok: false, error: { code: "manifest_unreadable", name: null } };
  }
  if (!isRecord(raw) || raw.schemaVersion !== BUNDLED_CATALOG_SCHEMA_VERSION
    || !Array.isArray(raw.items)) {
    return { ok: false, error: { code: "manifest_invalid", name: null } };
  }

  const items: CatalogItem[] = [];
  for (const candidate of raw.items) {
    if (!isRecord(candidate) || typeof candidate.name !== "string") {
      return { ok: false, error: { code: "manifest_invalid", name: null } };
    }
    const declared = candidate as unknown as RawBundledItem;
    const normalized = normalizeBundledCatalogItem({
      ...declared,
      entry: declared.entry as RelPath,
    });
    if (!normalized.ok) {
      return { ok: false, error: { code: "item_invalid", name: declared.name } };
    }
    const item = normalized.item;
    for (const [target, digest] of Object.entries(item.integrity!.files)) {
      const actual = await hashFile(path.join(root, BUNDLED_CATALOG_FILES_DIR, target));
      if (actual === null) {
        return { ok: false, error: { code: "file_missing", name: item.name } };
      }
      if (actual !== digest) {
        return { ok: false, error: { code: "integrity_mismatch", name: item.name } };
      }
    }
    if (catalogManifestDigest(item) !== item.integrity!.manifest) {
      return { ok: false, error: { code: "integrity_mismatch", name: item.name } };
    }
    if (validateCatalogItem(item).length > 0) {
      return { ok: false, error: { code: "item_invalid", name: item.name } };
    }
    items.push(item);
  }
  if (items.length === 0) return { ok: false, error: { code: "manifest_invalid", name: null } };
  return { ok: true, value: { items } };
}
