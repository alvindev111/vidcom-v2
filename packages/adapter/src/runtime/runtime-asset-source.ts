import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { ErrorCode, type ContentHash } from "@vidcom/contracts";

export const RUNTIME_MANIFEST_SCHEMA_VERSION = 1 as const;
export const RUNTIME_PLATFORM_TAGS = ["darwin-arm64", "win32-x64", "linux-x64"] as const;
export const RUNTIME_MOTION_PACKAGES = ["animejs", "gsap", "lottie-web", "motion", "three"] as const;
export const RUNTIME_MANIFEST_FILENAME = "runtime-manifest.json";
export const RUNTIME_ARCHIVE_DIRECTORY = "runtime-archives";
export const RUNTIME_CURRENT_FILENAME = "current.json";
export const MAX_RUNTIME_RELATIVE_PATH_LENGTH = 1024;
export const MAX_RUNTIME_PATH_SEGMENT_BYTES = 255;

export type RuntimePlatformTag = (typeof RUNTIME_PLATFORM_TAGS)[number];
export type RuntimeMotionPackage = (typeof RUNTIME_MOTION_PACKAGES)[number];
export type RuntimeArchiveKey = string;

export interface EmbeddedRuntimeEntry {
  path: string;
  sha256: ContentHash;
  mode: number;
}

export interface EmbeddedArchive {
  key: RuntimeArchiveKey;
  platform: RuntimePlatformTag;
  sha256: ContentHash;
  bytes: number;
  target: string;
  entries: readonly EmbeddedRuntimeEntry[];
}

export interface EmbeddedRuntimeManifest {
  schemaVersion: typeof RUNTIME_MANIFEST_SCHEMA_VERSION;
  artifactVersion: string;
  versions: {
    node: string;
    hyperframes: string;
    esbuild: string;
    ffmpeg: string;
    cpython: string;
    vieneu: string;
    motion: Readonly<Record<RuntimeMotionPackage, string>>;
  };
  pythonPackages: Readonly<Record<RuntimePlatformTag, readonly string[]>>;
  archives: readonly EmbeddedArchive[];
}

export interface RuntimeAssetSource {
  readManifest(): EmbeddedRuntimeManifest;
  readArchive(key: RuntimeArchiveKey): Uint8Array;
}

export class RuntimeAssetError extends Error {
  readonly name = "RuntimeAssetError";

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ARCHIVE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const ARTIFACT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const PYTHON_PACKAGE_PATTERN = /^[a-z0-9][a-z0-9.-]*==[^=\s]+$/u;
const READY_NAMESPACE_PATTERN = /^\.ready-/iu;
const WINDOWS_FORBIDDEN_PATH_CHARACTER_PATTERN = /[<>:"|?*\u0000-\u001f\u007f]/u;
const WINDOWS_RESERVED_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new RuntimeAssetError(ErrorCode.RuntimeManifestInvalid, message, details);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`${label} has unexpected keys`, { actual, expected: wanted });
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.trim() !== value) {
    return invalid(`${label} must be a canonical non-empty string`);
  }
  return value;
}

function contentHash(value: unknown, label: string): ContentHash {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    return invalid(`${label} must be a canonical sha256 content hash`);
  }
  return value as ContentHash;
}

function portablePathSegment(segment: string): boolean {
  return segment.length > 0
    && Buffer.byteLength(segment, "utf8") <= MAX_RUNTIME_PATH_SEGMENT_BYTES
    && segment !== "."
    && segment !== ".."
    && !segment.endsWith(".")
    && !segment.endsWith(" ")
    && !WINDOWS_FORBIDDEN_PATH_CHARACTER_PATTERN.test(segment)
    && !WINDOWS_RESERVED_DEVICE_PATTERN.test(segment);
}

/** Shared guard for manifest versions and persisted active-version pointers. */
export function isPortableRuntimeArtifactVersion(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && value.trim() === value
    && ARTIFACT_VERSION_PATTERN.test(value)
    && value.toLowerCase() !== RUNTIME_CURRENT_FILENAME
    && portablePathSegment(value);
}

function artifactVersion(value: unknown): string {
  if (!isPortableRuntimeArtifactVersion(value)) {
    return invalid("artifactVersion must be a portable path segment", { artifactVersion: value });
  }
  return value;
}

function portableRelativePath(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_RUNTIME_RELATIVE_PATH_LENGTH
    || value.trim() !== value
  ) {
    return invalid(
      `${label} must be a canonical path no longer than ${MAX_RUNTIME_RELATIVE_PATH_LENGTH} characters`,
    );
  }
  const pathname = value;
  const segments = pathname.split("/");
  if (
    pathname.includes("\\")
    || pathname.endsWith("/")
    || path.posix.isAbsolute(pathname)
    || path.win32.isAbsolute(pathname)
    || path.posix.normalize(pathname) !== pathname
    || segments.some((part) => !portablePathSegment(part))
  ) {
    return invalid(`${label} must be a normalized portable relative path`, { path: pathname });
  }
  return pathname;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return invalid(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function fileMode(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0o777) {
    return invalid(`${label} must be a POSIX mode between 0000 and 0777`);
  }
  return value as number;
}

function platform(value: unknown, label: string): RuntimePlatformTag {
  if (typeof value !== "string" || !RUNTIME_PLATFORM_TAGS.includes(value as RuntimePlatformTag)) {
    return invalid(`${label} is unsupported`, { supported: RUNTIME_PLATFORM_TAGS });
  }
  return value as RuntimePlatformTag;
}

function declaredParentPath(paths: ReadonlySet<string>, child: string): string | undefined {
  let parent = path.posix.dirname(child);
  while (parent !== ".") {
    if (paths.has(parent)) return parent;
    parent = path.posix.dirname(parent);
  }
  return undefined;
}

function ownershipPath(pathname: string, platformTag: RuntimePlatformTag): string {
  if (platformTag === "linux-x64") return pathname;
  return (platformTag === "darwin-arm64" ? pathname.normalize("NFC") : pathname).toLowerCase();
}

function parseEntries(
  value: unknown,
  archiveKey: string,
  platformTag: RuntimePlatformTag,
): readonly EmbeddedRuntimeEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    return invalid(`archive ${archiveKey} must declare at least one entry`);
  }
  const seen = new Set<string>();
  const entries = value.map((candidate, index): EmbeddedRuntimeEntry => {
    const entry = object(candidate, `archive ${archiveKey} entry ${index}`);
    exactKeys(entry, ["path", "sha256", "mode"], `archive ${archiveKey} entry ${index}`);
    const entryPath = portableRelativePath(entry.path, `archive ${archiveKey} entry ${index} path`);
    if (READY_NAMESPACE_PATTERN.test(entryPath.split("/", 1)[0] ?? "")) {
      invalid(`archive ${archiveKey} entry collides with the ready-marker namespace`, {
        path: entryPath,
      });
    }
    if (seen.has(entryPath)) invalid(`archive ${archiveKey} declares duplicate entry ${entryPath}`);
    seen.add(entryPath);
    return Object.freeze({
      path: entryPath,
      sha256: contentHash(entry.sha256, `archive ${archiveKey} entry ${entryPath} sha256`),
      mode: fileMode(entry.mode, `archive ${archiveKey} entry ${entryPath} mode`),
    });
  });
  const originalByOwnershipPath = new Map<string, string>();
  for (const entry of entries) {
    const ownership = ownershipPath(entry.path, platformTag);
    const previous = originalByOwnershipPath.get(ownership);
    if (previous !== undefined) {
      invalid(`archive ${archiveKey} declares paths that alias on ${platformTag}`, {
        current: previous,
        next: entry.path,
      });
    }
    originalByOwnershipPath.set(ownership, entry.path);
  }
  const paths = new Set(originalByOwnershipPath.keys());
  for (const [ownedChild, child] of originalByOwnershipPath) {
    const ownedParent = declaredParentPath(paths, ownedChild);
    if (ownedParent !== undefined) {
      invalid(`archive ${archiveKey} entry cannot be the parent of another file`, {
        parent: originalByOwnershipPath.get(ownedParent),
        child,
      });
    }
  }
  return Object.freeze(entries);
}

function assertNonOverlappingTargets(
  archives: readonly Pick<EmbeddedArchive, "target">[],
  label: string,
  platformTag: RuntimePlatformTag,
): void {
  const originalByOwnershipPath = new Map<string, string>();
  for (const archive of archives) {
    const ownership = ownershipPath(archive.target, platformTag);
    const previous = originalByOwnershipPath.get(ownership);
    if (previous !== undefined) {
      invalid(`${label} overlap`, { current: previous, next: archive.target });
    }
    originalByOwnershipPath.set(ownership, archive.target);
  }
  const targets = new Set(originalByOwnershipPath.keys());
  for (const [ownedChild, child] of originalByOwnershipPath) {
    const ownedParent = declaredParentPath(targets, ownedChild);
    if (ownedParent !== undefined) {
      invalid(`${label} overlap`, {
        current: originalByOwnershipPath.get(ownedParent),
        next: child,
      });
    }
  }
}

function parseArchives(value: unknown): readonly EmbeddedArchive[] {
  if (!Array.isArray(value) || value.length === 0) invalid("manifest must declare at least one archive");
  const seen = new Set<string>();
  const archives = value.map((candidate, index): EmbeddedArchive => {
    const archive = object(candidate, `archive ${index}`);
    exactKeys(archive, ["key", "platform", "sha256", "bytes", "target", "entries"], `archive ${index}`);
    const key = nonEmptyString(archive.key, `archive ${index} key`);
    if (
      !ARCHIVE_KEY_PATTERN.test(key)
      || !portablePathSegment(key)
      || key === RUNTIME_MANIFEST_FILENAME
    ) {
      invalid(`archive key ${key} is not portable`);
    }
    if (seen.has(key)) invalid(`manifest declares duplicate archive key ${key}`);
    seen.add(key);
    const platformTag = platform(archive.platform, `archive ${key} platform`);
    const target = portableRelativePath(archive.target, `archive ${key} target`);
    const targetNamespace = target.split("/", 1)[0]?.toLowerCase();
    if (targetNamespace === RUNTIME_MANIFEST_FILENAME || targetNamespace === RUNTIME_CURRENT_FILENAME) {
      invalid(`archive ${key} target collides with the installed runtime metadata namespace`, {
        target,
      });
    }
    return Object.freeze({
      key,
      platform: platformTag,
      sha256: contentHash(archive.sha256, `archive ${key} sha256`),
      bytes: positiveInteger(archive.bytes, `archive ${key} bytes`),
      target,
      entries: parseEntries(archive.entries, key, platformTag),
    });
  });
  for (const platformTag of RUNTIME_PLATFORM_TAGS) {
    assertNonOverlappingTargets(
      archives.filter((archive) => archive.platform === platformTag),
      `runtime archive targets on ${platformTag}`,
      platformTag,
    );
  }
  return Object.freeze(archives);
}

function parseMotionVersions(value: unknown): Readonly<Record<RuntimeMotionPackage, string>> {
  const motion = object(value, "manifest versions.motion");
  exactKeys(motion, RUNTIME_MOTION_PACKAGES, "manifest versions.motion");
  return Object.freeze(Object.fromEntries(
    RUNTIME_MOTION_PACKAGES.map((name) => [name, nonEmptyString(motion[name], `motion version ${name}`)]),
  ) as Record<RuntimeMotionPackage, string>);
}

function parseVersions(value: unknown): EmbeddedRuntimeManifest["versions"] {
  const versions = object(value, "manifest versions");
  exactKeys(
    versions,
    ["node", "hyperframes", "esbuild", "ffmpeg", "cpython", "vieneu", "motion"],
    "manifest versions",
  );
  return Object.freeze({
    node: nonEmptyString(versions.node, "Node version"),
    hyperframes: nonEmptyString(versions.hyperframes, "HyperFrames version"),
    esbuild: nonEmptyString(versions.esbuild, "esbuild version"),
    ffmpeg: nonEmptyString(versions.ffmpeg, "FFmpeg version"),
    cpython: nonEmptyString(versions.cpython, "CPython version"),
    vieneu: nonEmptyString(versions.vieneu, "VieNeu version"),
    motion: parseMotionVersions(versions.motion),
  });
}

function parsePythonPackages(value: unknown): EmbeddedRuntimeManifest["pythonPackages"] {
  const packages = object(value, "manifest pythonPackages");
  exactKeys(packages, RUNTIME_PLATFORM_TAGS, "manifest pythonPackages");
  return Object.freeze(Object.fromEntries(RUNTIME_PLATFORM_TAGS.map((tag) => {
    const platformPackages = packages[tag];
    if (!Array.isArray(platformPackages) || platformPackages.length === 0) {
      invalid(`manifest pythonPackages.${tag} must be a non-empty array`);
    }
    const parsed = platformPackages.map((candidate, index) => {
      const packagePin = nonEmptyString(candidate, `pythonPackages.${tag}[${index}]`);
      if (!PYTHON_PACKAGE_PATTERN.test(packagePin)) {
        invalid(`python package ${packagePin} is not a normalized exact pin`, { platform: tag });
      }
      return packagePin;
    });
    const names = parsed.map((packagePin) => packagePin.slice(0, packagePin.indexOf("==")));
    const canonicalNames = [...new Set(names)].sort();
    if (canonicalNames.length !== names.length || canonicalNames.some((item, index) => item !== names[index])) {
      invalid(`manifest pythonPackages.${tag} must be unique and sorted`);
    }
    return [tag, Object.freeze(parsed)] as const;
  })) as Record<RuntimePlatformTag, readonly string[]>);
}

/** Strictly parses the build-authoritative embedded runtime manifest. */
export function parseEmbeddedRuntimeManifest(value: unknown): EmbeddedRuntimeManifest {
  const manifest = object(value, "runtime manifest");
  exactKeys(
    manifest,
    ["schemaVersion", "artifactVersion", "versions", "pythonPackages", "archives"],
    "runtime manifest",
  );
  if (manifest.schemaVersion !== RUNTIME_MANIFEST_SCHEMA_VERSION) {
    invalid("runtime manifest schema version is unsupported", {
      actual: manifest.schemaVersion,
      supported: RUNTIME_MANIFEST_SCHEMA_VERSION,
    });
  }
  return Object.freeze({
    schemaVersion: RUNTIME_MANIFEST_SCHEMA_VERSION,
    artifactVersion: artifactVersion(manifest.artifactVersion),
    versions: parseVersions(manifest.versions),
    pythonPackages: parsePythonPackages(manifest.pythonPackages),
    archives: parseArchives(manifest.archives),
  });
}

function parseManifestBytes(bytes: Uint8Array, source: string): EmbeddedRuntimeManifest {
  try {
    return parseEmbeddedRuntimeManifest(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  } catch (error) {
    if (error instanceof RuntimeAssetError) throw error;
    throw new RuntimeAssetError(
      ErrorCode.RuntimeManifestInvalid,
      `runtime manifest from ${source} is not valid JSON`,
      { source },
    );
  }
}

function knownArchive(manifest: EmbeddedRuntimeManifest, key: RuntimeArchiveKey): void {
  if (!manifest.archives.some((archive) => archive.key === key)) {
    invalid(`runtime archive ${key} is not declared by the manifest`, { key });
  }
}

/** Resolves all archives for one host and reports the supported platform set on mismatch. */
export function resolveRuntimeArchives(
  manifest: EmbeddedRuntimeManifest,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArchitecture: NodeJS.Architecture = process.arch,
): readonly EmbeddedArchive[] {
  const requested = `${hostPlatform}-${hostArchitecture}`;
  const supported = [...new Set(manifest.archives.map((archive) => archive.platform))].sort();
  const archives = manifest.archives.filter((archive) => archive.platform === requested);
  if (archives.length === 0) {
    throw new RuntimeAssetError(
      ErrorCode.RuntimeManifestInvalid,
      `runtime archives for ${requested} are unavailable; supported platforms: ${supported.join(", ")}`,
      { requested, supported },
    );
  }
  return Object.freeze([...archives]);
}

/**
 * Maps manifest archive keys to their build-authoritative publish targets.
 *
 * `key` identifies the embedded archive; `target` says where its verified
 * contents live inside the selected version. Keeping this in one helper avoids
 * the dangerous split where extraction publishes by key while a consumer reads
 * the target declared by the manifest (or vice versa).
 */
export function resolveRuntimeArchiveRoots(
  archives: readonly EmbeddedArchive[],
  versionRoot: string,
): Readonly<Record<string, string>> {
  if (!path.isAbsolute(versionRoot)) {
    invalid("runtime version root must be absolute", { versionRoot });
  }
  for (const platformTag of RUNTIME_PLATFORM_TAGS) {
    assertNonOverlappingTargets(
      archives.filter((archive) => archive.platform === platformTag),
      `runtime archive targets on ${platformTag}`,
      platformTag,
    );
  }
  return Object.freeze(Object.fromEntries(
    archives.map((archive) => [archive.key, path.join(versionRoot, archive.target)]),
  ));
}

type RawAssetReader = (key: string) => ArrayBuffer;
const requireFromRuntimeSource = createRequire(import.meta.url);

function readSeaRawAsset(key: string): ArrayBuffer {
  const sea = requireFromRuntimeSource("node:sea") as { getRawAsset(assetKey: string): ArrayBuffer };
  return sea.getRawAsset(key);
}

/** Reads assets embedded in a Node SEA image through `node:sea.getRawAsset`. */
export class SeaRuntimeAssetSource implements RuntimeAssetSource {
  private manifest: EmbeddedRuntimeManifest | null = null;

  constructor(private readonly rawAsset: RawAssetReader = readSeaRawAsset) {}

  readManifest(): EmbeddedRuntimeManifest {
    this.manifest ??= parseManifestBytes(
      new Uint8Array(this.rawAsset(RUNTIME_MANIFEST_FILENAME)),
      `SEA asset ${RUNTIME_MANIFEST_FILENAME}`,
    );
    return this.manifest;
  }

  readArchive(key: RuntimeArchiveKey): Uint8Array {
    knownArchive(this.readManifest(), key);
    return new Uint8Array(this.rawAsset(`${RUNTIME_ARCHIVE_DIRECTORY}/${key}.tar.gz`));
  }
}

/** Filesystem source used by development, build validation, and real-filesystem tests. */
export class FilesystemRuntimeAssetSource implements RuntimeAssetSource {
  private manifest: EmbeddedRuntimeManifest | null = null;
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  readManifest(): EmbeddedRuntimeManifest {
    const filename = path.join(this.root, RUNTIME_MANIFEST_FILENAME);
    this.manifest ??= parseManifestBytes(readFileSync(filename), filename);
    return this.manifest;
  }

  readArchive(key: RuntimeArchiveKey): Uint8Array {
    knownArchive(this.readManifest(), key);
    return Uint8Array.from(readFileSync(path.join(this.root, RUNTIME_ARCHIVE_DIRECTORY, `${key}.tar.gz`)));
  }
}
