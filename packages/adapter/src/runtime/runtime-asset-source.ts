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

function artifactVersion(value: unknown): string {
  const version = nonEmptyString(value, "artifactVersion");
  if (
    !ARTIFACT_VERSION_PATTERN.test(version)
    || version.toLowerCase() === RUNTIME_CURRENT_FILENAME
  ) {
    return invalid("artifactVersion must be a portable path segment", { artifactVersion: version });
  }
  return version;
}

function portableRelativePath(value: unknown, label: string): string {
  const pathname = nonEmptyString(value, label);
  if (
    pathname.includes("\\")
    || pathname.endsWith("/")
    || path.posix.isAbsolute(pathname)
    || path.win32.isAbsolute(pathname)
    || path.posix.normalize(pathname) !== pathname
    || pathname.split("/").some((part) => part === "" || part === "." || part === "..")
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

function parseEntries(value: unknown, archiveKey: string): readonly EmbeddedRuntimeEntry[] {
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
  const paths = entries.map((entry) => entry.path).sort();
  for (let index = 0; index < paths.length - 1; index += 1) {
    if (paths[index + 1]?.startsWith(`${paths[index]}/`)) {
      invalid(`archive ${archiveKey} entry cannot be the parent of another file`, {
        parent: paths[index],
        child: paths[index + 1],
      });
    }
  }
  return Object.freeze(entries);
}

function parseArchives(value: unknown): readonly EmbeddedArchive[] {
  if (!Array.isArray(value) || value.length === 0) invalid("manifest must declare at least one archive");
  const seen = new Set<string>();
  const archives = value.map((candidate, index): EmbeddedArchive => {
    const archive = object(candidate, `archive ${index}`);
    exactKeys(archive, ["key", "platform", "sha256", "bytes", "target", "entries"], `archive ${index}`);
    const key = nonEmptyString(archive.key, `archive ${index} key`);
    if (!ARCHIVE_KEY_PATTERN.test(key) || key === RUNTIME_MANIFEST_FILENAME) {
      invalid(`archive key ${key} is not portable`);
    }
    if (seen.has(key)) invalid(`manifest declares duplicate archive key ${key}`);
    seen.add(key);
    return Object.freeze({
      key,
      platform: platform(archive.platform, `archive ${key} platform`),
      sha256: contentHash(archive.sha256, `archive ${key} sha256`),
      bytes: positiveInteger(archive.bytes, `archive ${key} bytes`),
      target: portableRelativePath(archive.target, `archive ${key} target`),
      entries: parseEntries(archive.entries, key),
    });
  });
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
