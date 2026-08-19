import { type RelPath } from "@vidcom/contracts";
import {
  CATALOG_METADATA_LIMITS,
  CATALOG_NAME_PATTERN,
  orderCatalogDependencyClosure,
  parseCatalogVersion,
  validateCatalogItem,
  type CatalogDependencyNode,
  type CatalogIntegrity,
  type CatalogItem,
  type CatalogItemKind,
} from "@vidcom/core";

/**
 * Normalizes the HyperFrames 0.7.86 registry schema into the VidCom catalog
 * contract (Design §5.16).
 *
 * The upstream boundary is validated here and nowhere else: `ItemType` is
 * `hyperframes:example | hyperframes:block | hyperframes:component`, there is no
 * version, no digest and no category, and `files[].target` is attacker-shaped
 * input. Every rejection returns stable diagnostics so a dropped item can be
 * logged once instead of being half-normalized.
 */

/** Stable diagnostics for a dropped registry item. */
export type CatalogNormalizationDefect =
  | "manifest_invalid"
  | "item_type_unsupported"
  | "name_mismatch"
  | "name_invalid"
  | "name_too_long"
  | "title_too_long"
  | "description_too_long"
  | "tag_too_long"
  | "too_many_tags"
  | "target_invalid"
  | "target_reserved"
  | "target_duplicate"
  | "entry_missing"
  | "entry_ambiguous"
  | "entry_not_in_package"
  | "preview_not_in_package"
  | "version_invalid"
  | "category_invalid"
  | "kind_unsupported"
  | "dependency_missing"
  | "dependency_cycle"
  | "dependency_unsupported"
  | "contract_violation";

export type CatalogNormalizationResult =
  | { ok: true; item: CatalogItem }
  | { ok: false; diagnostics: CatalogNormalizationDefect[] };

export interface UpstreamCatalogItemInput {
  /** `registry.json` entry, so a manifest cannot claim another item's identity. */
  entry: { name: string; type: string };
  /** Parsed `registry-item.json`; validated here, never trusted. */
  manifest: unknown;
  /** 40-hex commit the manifest was read at. */
  revision: string;
  committedAt: string | null;
  /** Dependency graph resolved at the same commit. */
  lookup: (name: string) => CatalogDependencyNode | undefined;
}

const UPSTREAM_RAW_BASE = "https://raw.githubusercontent.com/heygen-com/hyperframes";
const UPSTREAM_BLOCK_TYPE = "hyperframes:block";
const UPSTREAM_ITEM_TYPES = new Set([
  "hyperframes:example",
  UPSTREAM_BLOCK_TYPE,
  "hyperframes:component",
]);
const UPSTREAM_COMPOSITION_TYPE = "hyperframes:composition";
const UPSTREAM_FILE_TYPES = new Set([
  UPSTREAM_COMPOSITION_TYPE,
  "hyperframes:asset",
  "hyperframes:snippet",
  "hyperframes:style",
  "hyperframes:timeline",
]);

/** Project-owned targets a catalog package may never write. */
const RESERVED_TARGETS = new Set<string>(["index.html"]);

/** Versioned VidCom category rule; bumped whenever the table below changes. */
export const CATALOG_CATEGORY_RULE_VERSION = 1;

export interface CatalogCategoryRule {
  category: string;
  tags: readonly string[];
  nameIncludes: readonly string[];
}

/**
 * Fixed-priority category table.
 *
 * Upstream 0.7.86 does export `resolveBlockCategory`, but its result is an
 * upstream enum that can change between releases, and the category is covered by
 * our manifest digest. So VidCom owns a versioned table instead, with `Other` as
 * the explicit fallback and no inference left to the UI.
 */
export const CATALOG_CATEGORY_RULES: readonly CatalogCategoryRule[] = Object.freeze([
  { category: "Transitions", tags: ["transitions", "transition"], nameIncludes: ["transition", "wipe"] },
  { category: "Captions", tags: ["captions", "caption", "subtitles"], nameIncludes: ["caption", "subtitle"] },
  { category: "Text effects", tags: ["text-effects", "text-effect", "typography"], nameIncludes: ["text"] },
  { category: "Code animation", tags: ["code-animation", "code"], nameIncludes: ["code"] },
  { category: "Data", tags: ["data", "chart", "charts"], nameIncludes: ["chart"] },
  { category: "Scenes", tags: ["scenes", "scene"], nameIncludes: [] },
  { category: "Social", tags: ["social"], nameIncludes: [] },
  { category: "VFX", tags: ["vfx", "effects", "effect"], nameIncludes: [] },
]);

export const CATALOG_CATEGORY_FALLBACK = "Other";

/** Resolves a category from canonical tags first, then the item name. */
export function resolveCatalogCategory(item: { name: string; tags: readonly string[] }): string {
  const tags = new Set(item.tags.map((tag) => tag.toLowerCase()));
  for (const rule of CATALOG_CATEGORY_RULES) {
    if (rule.tags.some((tag) => tags.has(tag))) return rule.category;
  }
  const name = item.name.toLowerCase();
  for (const rule of CATALOG_CATEGORY_RULES) {
    if (rule.nameIncludes.some((needle) => name.includes(needle))) return rule.category;
  }
  return CATALOG_CATEGORY_FALLBACK;
}

function canonicalTags(tags: readonly string[]): string[] {
  const canonical = [...new Set(tags.map((tag) => tag.normalize("NFC")))];
  return canonical.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function codePoints(value: string): number {
  return [...value.normalize("NFC")].length;
}

/** Canonicalizes a package-relative target, or null when it may not be written. */
export function canonicalizeCatalogTarget(target: string): RelPath | null {
  if (typeof target !== "string" || target.length === 0) return null;
  if (target.startsWith("/") || target.startsWith("\\") || /^[a-zA-Z]:/.test(target)) return null;
  const segments = target.normalize("NFC").split(/[/\\]/);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return segments.join("/") as RelPath;
}

interface UpstreamFile {
  target: string;
  type: string;
}

interface UpstreamManifest {
  name: string;
  title: string;
  description: string;
  tags: string[];
  minCliVersion: string | null;
  registryDependencies: string[];
  files: UpstreamFile[];
  duration: number;
  width: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  return typeof value === "string" ? value : undefined;
}

/** Strict structural validation of one upstream block manifest. */
function readUpstreamManifest(raw: unknown): UpstreamManifest | null {
  if (!isRecord(raw)) return null;
  const { name, title, description, tags, minCliVersion, registryDependencies, files } = raw;
  if (typeof name !== "string" || typeof title !== "string" || typeof description !== "string") return null;
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))) return null;
  const minimum = optionalString(minCliVersion);
  if (minimum === undefined) return null;
  if (registryDependencies !== undefined
    && (!Array.isArray(registryDependencies)
      || registryDependencies.some((dependency) => typeof dependency !== "string"))) return null;
  if (!Array.isArray(files) || files.length === 0) return null;
  const parsedFiles: UpstreamFile[] = [];
  for (const file of files) {
    if (!isRecord(file)) return null;
    if (typeof file.target !== "string" || typeof file.path !== "string") return null;
    if (typeof file.type !== "string" || !UPSTREAM_FILE_TYPES.has(file.type)) return null;
    parsedFiles.push({ target: file.target, type: file.type });
  }
  // Blocks are standalone compositions upstream, so both fields are required.
  if (!isRecord(raw.dimensions)) return null;
  const { width, height } = raw.dimensions;
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return null;
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return null;
  if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration <= 0) return null;
  return {
    name,
    title,
    description,
    tags: (tags as string[] | undefined) ?? [],
    minCliVersion: minimum,
    registryDependencies: (registryDependencies as string[] | undefined) ?? [],
    files: parsedFiles,
    duration: raw.duration,
    width,
  };
}

function checkMetadataBounds(
  values: { name: string; title: string; description: string | null; tags: readonly string[] },
): CatalogNormalizationDefect[] {
  const defects: CatalogNormalizationDefect[] = [];
  if (!CATALOG_NAME_PATTERN.test(values.name)) defects.push("name_invalid");
  if (codePoints(values.name) > CATALOG_METADATA_LIMITS.name) defects.push("name_too_long");
  if (codePoints(values.title) > CATALOG_METADATA_LIMITS.title) defects.push("title_too_long");
  if (values.description !== null
    && codePoints(values.description) > CATALOG_METADATA_LIMITS.description) {
    defects.push("description_too_long");
  }
  if (values.tags.some((tag) => codePoints(tag) > CATALOG_METADATA_LIMITS.tag)) defects.push("tag_too_long");
  if (values.tags.length > CATALOG_METADATA_LIMITS.tags) defects.push("too_many_tags");
  return defects;
}

function checkTargets(targets: readonly string[]): CatalogNormalizationDefect[] {
  const defects: CatalogNormalizationDefect[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const canonical = canonicalizeCatalogTarget(target);
    if (canonical === null) {
      if (!defects.includes("target_invalid")) defects.push("target_invalid");
      continue;
    }
    if (RESERVED_TARGETS.has(canonical)) {
      if (!defects.includes("target_reserved")) defects.push("target_reserved");
      continue;
    }
    if (seen.has(canonical) && !defects.includes("target_duplicate")) defects.push("target_duplicate");
    seen.add(canonical);
  }
  return defects;
}

function dependencyDefect(code: string): CatalogNormalizationDefect {
  return code === "dependency_cycle" || code === "dependency_unsupported"
    ? code
    : "dependency_missing";
}

export function normalizeUpstreamCatalogItem(
  input: UpstreamCatalogItemInput,
): CatalogNormalizationResult {
  if (input.entry.type !== UPSTREAM_BLOCK_TYPE) {
    return { ok: false, diagnostics: ["item_type_unsupported"] };
  }
  if (!isRecord(input.manifest) || typeof input.manifest.type !== "string"
    || !UPSTREAM_ITEM_TYPES.has(input.manifest.type)
    || input.manifest.type !== UPSTREAM_BLOCK_TYPE) {
    return {
      ok: false,
      diagnostics: [isRecord(input.manifest) && input.manifest.type !== undefined
        ? "item_type_unsupported"
        : "manifest_invalid"],
    };
  }

  const manifest = readUpstreamManifest(input.manifest);
  if (manifest === null) return { ok: false, diagnostics: ["manifest_invalid"] };
  if (manifest.name !== input.entry.name) return { ok: false, diagnostics: ["name_mismatch"] };

  const tags = canonicalTags(manifest.tags);
  const bounds = checkMetadataBounds({
    name: manifest.name,
    title: manifest.title,
    description: manifest.description,
    tags,
  });
  if (bounds.length > 0) return { ok: false, diagnostics: bounds };

  const targetDefects = checkTargets(manifest.files.map((file) => file.target));
  if (targetDefects.length > 0) return { ok: false, diagnostics: targetDefects };

  const compositions = manifest.files.filter((file) => file.type === UPSTREAM_COMPOSITION_TYPE);
  if (compositions.length === 0) return { ok: false, diagnostics: ["entry_missing"] };
  if (compositions.length > 1) return { ok: false, diagnostics: ["entry_ambiguous"] };
  const entry = canonicalizeCatalogTarget(compositions[0]!.target)!;

  // The root is described by this manifest, not by the graph lookup, so a
  // registry that cannot serve the root's own entry is not a missing dependency.
  const closure = orderCatalogDependencyClosure(manifest.name, (name) => (
    name === manifest.name
      ? { dependencies: manifest.registryDependencies, kind: "block" as const }
      : input.lookup(name)
  ));
  if (!closure.ok) return { ok: false, diagnostics: [dependencyDefect(closure.error.code)] };

  const item: CatalogItem = {
    name: manifest.name,
    kind: "block",
    title: manifest.title.normalize("NFC"),
    description: manifest.description.length > 0 ? manifest.description.normalize("NFC") : null,
    tags,
    category: resolveCatalogCategory({ name: manifest.name, tags }),
    version: `git:${input.revision}`,
    integrity: null,
    materialization: "metadata",
    source: {
      registry: "hyperframes",
      url: `${UPSTREAM_RAW_BASE}/${input.revision}/registry/blocks/${manifest.name}/registry-item.json`,
      revision: input.revision,
      committedAt: input.committedAt,
    },
    dependencies: closure.value,
    compatibility: {
      aspectRatios: null,
      minWidth: manifest.width,
      fps: null,
      minHyperframesVersion: manifest.minCliVersion,
    },
    durationSeconds: manifest.duration,
    entry,
    preview: null,
  };

  const contract = validateCatalogItem(item);
  return contract.length === 0 ? { ok: true, item } : { ok: false, diagnostics: ["contract_violation"] };
}

/** A curated bundled package declaration, frozen in the repo. */
export interface BundledCatalogItemInput {
  name: string;
  kind: CatalogItemKind;
  title: string;
  description: string | null;
  category: string;
  tags: readonly string[];
  version: string;
  entry: RelPath;
  durationSeconds: number | null;
  compatibility: CatalogItem["compatibility"];
  preview: CatalogItem["preview"];
  integrity: CatalogIntegrity;
  dependencies: readonly string[];
}

/**
 * Normalizes a curated bundled item.
 *
 * A bundled template is a VidCom scene package, not an upstream example: it
 * declares its entry explicitly, that entry has to be inside the verified file
 * set, and it may never target the project root entry.
 */
export function normalizeBundledCatalogItem(
  input: BundledCatalogItemInput,
): CatalogNormalizationResult {
  if (input.kind !== "template" && input.kind !== "block") {
    return { ok: false, diagnostics: ["kind_unsupported"] };
  }
  const tags = canonicalTags(input.tags);
  const bounds = checkMetadataBounds({
    name: input.name,
    title: input.title,
    description: input.description,
    tags,
  });
  if (bounds.length > 0) return { ok: false, diagnostics: bounds };

  const version = parseCatalogVersion(input.version);
  if (version === null || version.kind !== "semver") return { ok: false, diagnostics: ["version_invalid"] };

  const files = Object.keys(input.integrity.files);
  // The entry is one of these targets, so it is checked with them rather than
  // appended, which would look like a duplicate target.
  const targetDefects = checkTargets(files);
  const entryDefects = checkTargets([input.entry]).filter((defect) => defect !== "target_duplicate");
  const allTargetDefects = [...new Set([...entryDefects, ...targetDefects])];
  if (allTargetDefects.length > 0) return { ok: false, diagnostics: allTargetDefects };

  const category = input.category.normalize("NFC");
  if (category.length === 0) return { ok: false, diagnostics: ["category_invalid"] };

  const item: CatalogItem = {
    name: input.name,
    kind: input.kind,
    title: input.title.normalize("NFC"),
    description: input.description === null ? null : input.description.normalize("NFC"),
    tags,
    category,
    version: version.value,
    integrity: input.integrity,
    materialization: "verified",
    source: { registry: "bundled", url: null, revision: null, committedAt: null },
    dependencies: [...input.dependencies],
    compatibility: input.compatibility,
    durationSeconds: input.durationSeconds,
    entry: input.entry,
    preview: input.preview,
  };

  if (input.preview !== null && !(input.preview.path in input.integrity.files)) {
    return { ok: false, diagnostics: ["preview_not_in_package"] };
  }
  const contract = validateCatalogItem(item);
  if (contract.length > 0) {
    return {
      ok: false,
      diagnostics: contract.includes("entry_not_in_package")
        ? ["entry_not_in_package"]
        : ["contract_violation"],
    };
  }
  return { ok: true, item };
}
