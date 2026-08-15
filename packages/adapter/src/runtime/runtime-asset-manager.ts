import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { ErrorCode } from "@vidcom/contracts";
import type { ResolvedPath } from "@vidcom/core";

import { writeAtomic } from "../fs/atomic-write";
import {
  secureAppDataDirectorySync,
  type SyncCredentialCommandRunner,
} from "../fs/credential-store";
import { syncDirectory } from "../fs/durability";
import {
  AtomicDirectoryLock,
  type DirectoryLockLease,
} from "./atomic-directory-lock";
import { extractRuntimeArchive } from "./runtime-asset-extractor";
import {
  isPortableRuntimeArtifactVersion,
  parseEmbeddedRuntimeManifest,
  resolveRuntimeArchiveRoots,
  resolveRuntimeArchives,
  RUNTIME_CURRENT_FILENAME,
  RUNTIME_MANIFEST_FILENAME,
  RuntimeAssetError,
  type EmbeddedArchive,
  type EmbeddedRuntimeManifest,
  type RuntimeAssetSource,
  type RuntimePlatformTag,
} from "./runtime-asset-source";

const RUNTIME_STATE_SCHEMA_VERSION = 1 as const;
const RUNTIME_DIRECTORY = "native";
const RUNTIME_BOOTSTRAP_LOCK = "runtime-bootstrap.lock";
const READY_MARKER_PREFIX = ".ready-";
const TEMPORARY_SUFFIX = ".tmp";
const QUARANTINE_SUFFIX = ".quarantine";
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_INSTALLED_MANIFEST_BYTES = 64 * 1024 * 1024;
const RUNTIME_OWNER_FILENAME = ".vidcom-runtime-owner.json";
const RUNTIME_OWNER_AUTHORITY_DIRECTORY = ".runtime-owners";
const OWNER_NONCE_PATTERN = /^[0-9a-f]{64}$/u;

export type RuntimeArchiveInstallationState = "missing" | "ready" | "incomplete";
export type RuntimeInstallationState = "missing" | "ready" | "broken";

export interface RuntimeReadyMarker {
  schemaVersion: typeof RUNTIME_STATE_SCHEMA_VERSION;
  artifactVersion: string;
  archiveKey: string;
  archiveSha256: string;
  verifiedAt: string;
}

export interface RuntimeCurrentPointer {
  schemaVersion: typeof RUNTIME_STATE_SCHEMA_VERSION;
  artifactVersion: string;
  platform: RuntimePlatformTag;
  manifest: string;
}

interface RuntimeVersionOwner {
  schemaVersion: typeof RUNTIME_STATE_SCHEMA_VERSION;
  artifactVersion: string;
  manifestSha256: string;
  nonce: string;
}

export interface RuntimeArchiveInspection {
  key: string;
  version: string;
  root: string;
  state: RuntimeArchiveInstallationState;
  reason?: string;
}

export interface RuntimeAssetInspection {
  state: RuntimeInstallationState;
  artifactVersion: string;
  versionRoot: string;
  current: boolean;
  archives: readonly RuntimeArchiveInspection[];
}

export interface RuntimeAssetInstallation {
  artifactVersion: string;
  versionRoot: string;
  archiveRoots: Readonly<Record<string, string>>;
  extracted: readonly string[];
  reused: readonly string[];
}

/** Read-only projection selected by `native/current.json`. */
export interface PublishedRuntimeInstallation {
  manifest: EmbeddedRuntimeManifest;
  versionRoot: string;
  archiveRoots: Readonly<Record<string, string>>;
}

export interface RuntimePruneResult {
  pruned: readonly string[];
  retained: readonly string[];
  deferred: boolean;
}

export type RuntimeAssetManagerPhase =
  | "afterExtract"
  | "afterValidate"
  | "afterRename"
  | "beforeMarkerCommit"
  | "afterMarker";

export interface RuntimeAssetManagerHooks {
  onPhase?(phase: RuntimeAssetManagerPhase, archive: EmbeddedArchive): Promise<void>;
}

export interface RuntimeAssetManagerObserver {
  preparing?(archive: EmbeddedArchive): void | Promise<void>;
  ready?(archive: EmbeddedArchive): void | Promise<void>;
}

export interface RuntimeAssetManagerOptions {
  appDataRoot: string;
  source: RuntimeAssetSource;
  platform?: NodeJS.Platform;
  architecture?: NodeJS.Architecture;
  clock?: () => Date;
  lock?: AtomicDirectoryLock;
  observer?: RuntimeAssetManagerObserver;
  hooks?: RuntimeAssetManagerHooks;
  aclRunner?: SyncCredentialCommandRunner;
}

export interface RuntimeAssetLeaseOptions {
  lease?: DirectoryLockLease;
}

export interface RuntimeRepairOptions extends RuntimeAssetLeaseOptions {
  keys?: readonly string[];
}

export interface RuntimePruneOptions extends RuntimeAssetLeaseOptions {
  gracePeriodMs: number;
  startupSucceededAt: Date;
  isVersionInUse(version: string): boolean | Promise<boolean>;
}

function incomplete(message: string, details?: Record<string, unknown>): RuntimeAssetError {
  return new RuntimeAssetError(ErrorCode.RuntimeExtractionIncomplete, message, details);
}

function integrityFailureMessage(reason: string): string {
  if (reason === "checksum_mismatch") return "extracted runtime file does not match its manifest hash";
  if (reason === "symlink") return "extracted runtime contains a symbolic link";
  if (reason === "hard_link") return "extracted runtime entry is not a singly-linked regular file";
  return "extracted runtime failed deep integrity verification";
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

async function syncRenameParents(
  sourceParent: string,
  destinationParent: string,
  platform: NodeJS.Platform,
): Promise<void> {
  // Destination first: after a crash it is safer to retain two names than to
  // durably remove the source before the newly published/quarantined name is
  // known durable.
  await syncDirectory(destinationParent, platform);
  if (destinationParent !== sourceParent) {
    await syncDirectory(sourceParent, platform);
  }
}

async function pathKind(pathname: string): Promise<"absent" | "directory" | "file" | "invalid"> {
  try {
    const value = await lstat(pathname);
    if (value.isSymbolicLink()) return "invalid";
    if (value.isDirectory()) return "directory";
    if (value.isFile() && value.nlink === 1) return "file";
    return "invalid";
  } catch (error) {
    if (hasCode(error, "ENOENT")) return "absent";
    if (hasCode(error, "ENOTDIR") || hasCode(error, "ELOOP")) return "invalid";
    throw error;
  }
}

/** Creates, canonicalizes and secures app-data before any lock or runtime bytes are touched. */
export async function prepareRuntimeAppDataRoot(
  directory: string,
  platform: NodeJS.Platform = process.platform,
  aclRunner?: SyncCredentialCommandRunner,
): Promise<string> {
  if (
    !path.isAbsolute(directory)
    || path.resolve(directory) !== directory
    || path.dirname(directory) === directory
  ) {
    throw new TypeError("runtime app-data root must be a normalized absolute non-root path");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await pathKind(directory) !== "directory") {
    throw incomplete("runtime app-data path is not a real directory");
  }
  const canonical = await realpath(directory);
  if (await pathKind(canonical) !== "directory") {
    throw incomplete("runtime app-data canonical path is not a real directory");
  }
  secureAppDataDirectorySync(canonical, platform, aclRunner);
  if (platform !== "win32") await chmod(canonical, 0o700);
  await syncDirectory(path.dirname(canonical), platform);
  return canonical;
}

async function prepareTargetParent(
  versionRoot: string,
  target: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const directory = path.dirname(target);
  const relative = path.relative(versionRoot, directory);
  if (
    relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw incomplete("runtime archive target parent escaped its version root", { target });
  }
  let current = versionRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const parent = current;
    current = path.join(current, segment);
    const kind = await pathKind(current);
    if (kind === "absent") {
      await mkdir(current, { recursive: false, mode: 0o700 });
      await syncDirectory(parent, platform);
      continue;
    }
    if (kind !== "directory") {
      throw incomplete("runtime archive target parent is not a real directory", {
        target,
        parent: current,
      });
    }
  }
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]) ? record : undefined;
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

/** Strict parser for installed state; invalid persisted bytes are recoverable and return `undefined`. */
export function parseRuntimeReadyMarker(value: unknown): RuntimeReadyMarker | undefined {
  const marker = exactObject(
    value,
    ["schemaVersion", "artifactVersion", "archiveKey", "archiveSha256", "verifiedAt"],
  );
  if (
    marker?.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION
    || typeof marker.artifactVersion !== "string"
    || marker.artifactVersion.length === 0
    || typeof marker.archiveKey !== "string"
    || marker.archiveKey.length === 0
    || typeof marker.archiveSha256 !== "string"
    || !HASH_PATTERN.test(marker.archiveSha256)
    || !canonicalTimestamp(marker.verifiedAt)
  ) return undefined;
  return Object.freeze({
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    artifactVersion: marker.artifactVersion,
    archiveKey: marker.archiveKey,
    archiveSha256: marker.archiveSha256,
    verifiedAt: marker.verifiedAt,
  });
}

/** Strict parser for the active-version pointer; invalid persisted bytes are recoverable. */
export function parseRuntimeCurrentPointer(value: unknown): RuntimeCurrentPointer | undefined {
  const pointer = exactObject(value, ["schemaVersion", "artifactVersion", "platform", "manifest"]);
  if (
    pointer?.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION
    || !isPortableRuntimeArtifactVersion(pointer.artifactVersion)
    || (pointer.platform !== "darwin-arm64"
      && pointer.platform !== "win32-x64"
      && pointer.platform !== "linux-x64")
    || typeof pointer.manifest !== "string"
    || pointer.manifest !== `${pointer.artifactVersion}/${RUNTIME_MANIFEST_FILENAME}`
  ) return undefined;
  return Object.freeze({
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    artifactVersion: pointer.artifactVersion,
    platform: pointer.platform,
    manifest: pointer.manifest,
  });
}

async function readJson(
  pathname: string,
  maxBytes = MAX_STATE_BYTES,
): Promise<unknown | undefined> {
  try {
    const metadata = await lstat(pathname);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || metadata.size <= 0
      || metadata.size > maxBytes
    ) return undefined;
    return JSON.parse(await readFile(pathname, "utf8")) as unknown;
  } catch (error) {
    if (hasCode(error, "ENOENT") || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Rejects both lexical escapes and links anywhere from the version root to the target. */
async function isRealContainedDirectory(versionRoot: string, target: string): Promise<boolean> {
  if (!isContainedPath(versionRoot, target) || await pathKind(versionRoot) !== "directory") {
    return false;
  }
  const relative = path.relative(versionRoot, target);
  let current = versionRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (await pathKind(current) !== "directory") return false;
  }
  try {
    const [realVersionRoot, realTarget] = await Promise.all([
      realpath(versionRoot),
      realpath(target),
    ]);
    return isContainedPath(realVersionRoot, realTarget);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

/** True when something between the version root and the target is not a directory. */
async function hasNonDirectoryAncestor(versionRoot: string, target: string): Promise<boolean> {
  let current = path.dirname(target);
  while (current.startsWith(versionRoot) && current !== versionRoot && current !== path.dirname(current)) {
    const kind = await pathKind(current);
    if (kind !== "absent" && kind !== "directory") return true;
    current = path.dirname(current);
  }
  return false;
}

async function inspectArchiveInstallation(
  archive: EmbeddedArchive,
  artifactVersion: string,
  versionRoot: string,
  root: string,
): Promise<RuntimeArchiveInspection> {
  const kind = await pathKind(root);
  if (kind === "absent") {
    // "Absent" only when the whole chain is genuinely absent. A parent that is
    // a file makes the target unreachable, and the two platforms describe that
    // differently — POSIX reports ENOTDIR, Windows reports ENOENT, so the same
    // corrupt install read as `missing` on one and `target_not_directory` on
    // the other. The distinction is worth keeping rather than papering over:
    // a missing install is re-extracted, a corrupt one has something in the way
    // that has to be removed first.
    if (await hasNonDirectoryAncestor(versionRoot, root)) {
      return { key: archive.key, version: artifactVersion, root, state: "incomplete", reason: "target_not_directory" };
    }
    return { key: archive.key, version: artifactVersion, root, state: "missing" };
  }
  if (kind !== "directory" || !await isRealContainedDirectory(versionRoot, root)) {
    return { key: archive.key, version: artifactVersion, root, state: "incomplete", reason: "target_not_directory" };
  }
  const markerPath = path.join(root, markerName(archive));
  if (await pathKind(markerPath) !== "file") {
    return { key: archive.key, version: artifactVersion, root, state: "incomplete", reason: "marker_missing" };
  }
  const marker = parseRuntimeReadyMarker(await readJson(markerPath));
  if (
    !marker
    || marker.artifactVersion !== artifactVersion
    || marker.archiveKey !== archive.key
    || marker.archiveSha256 !== archive.sha256
  ) {
    return { key: archive.key, version: artifactVersion, root, state: "incomplete", reason: "marker_invalid" };
  }
  return { key: archive.key, version: artifactVersion, root, state: "ready" };
}

/**
 * Reads the active installed runtime without extracting, migrating or taking a
 * bootstrap lock. Diagnostic entrypoints use this to inspect the exact version
 * the daemon would consume instead of guessing unversioned paths under
 * `<app-data>/native`.
 */
export async function readPublishedRuntimeInstallation(
  appDataRoot: string,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArchitecture: NodeJS.Architecture = process.arch,
): Promise<PublishedRuntimeInstallation | null> {
  const normalizedRoot = path.resolve(appDataRoot);
  if (
    !path.isAbsolute(appDataRoot)
    || normalizedRoot !== appDataRoot
    || path.dirname(normalizedRoot) === normalizedRoot
  ) return null;

  const nativeRoot = path.join(normalizedRoot, RUNTIME_DIRECTORY);
  if (await pathKind(nativeRoot) !== "directory") return null;
  const current = parseRuntimeCurrentPointer(await readJson(
    path.join(nativeRoot, RUNTIME_CURRENT_FILENAME),
  ));
  if (!current || current.platform !== `${hostPlatform}-${hostArchitecture}`) return null;

  const versionRoot = path.join(nativeRoot, current.artifactVersion);
  if (await pathKind(versionRoot) !== "directory") return null;
  const manifestPath = path.join(versionRoot, RUNTIME_MANIFEST_FILENAME);
  const rawManifest = await readJson(manifestPath, MAX_INSTALLED_MANIFEST_BYTES);
  if (rawManifest === undefined) return null;
  try {
    const manifest = parseEmbeddedRuntimeManifest(rawManifest);
    if (manifest.artifactVersion !== current.artifactVersion) return null;
    const archives = resolveRuntimeArchives(manifest, hostPlatform, hostArchitecture);
    if (!await exactRegularFileMatches(
      manifestPath,
      stableJson(manifestProjection(manifest, archives)),
    )) return null;
    const archiveRoots = resolveRuntimeArchiveRoots(archives, versionRoot);
    const inspected = await Promise.all(archives.map((archive) => inspectArchiveInstallation(
      archive,
      manifest.artifactVersion,
      versionRoot,
      archiveRoots[archive.key]!,
    )));
    if (inspected.some((archive) => archive.state !== "ready")) return null;
    return {
      manifest,
      versionRoot,
      archiveRoots,
    };
  } catch (error) {
    if (error instanceof RuntimeAssetError) return null;
    throw error;
  }
}

async function exactRegularFileMatches(pathname: string, expected: string): Promise<boolean> {
  try {
    const metadata = await lstat(pathname);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || metadata.size !== Buffer.byteLength(expected, "utf8")
    ) return false;
    return await readFile(pathname, "utf8") === expected;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function parseRuntimeVersionOwner(value: unknown): RuntimeVersionOwner | undefined {
  const owner = exactObject(
    value,
    ["schemaVersion", "artifactVersion", "manifestSha256", "nonce"],
  );
  if (
    owner?.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION
    || !isPortableRuntimeArtifactVersion(owner.artifactVersion)
    || typeof owner.manifestSha256 !== "string"
    || !HASH_PATTERN.test(owner.manifestSha256)
    || typeof owner.nonce !== "string"
    || !OWNER_NONCE_PATTERN.test(owner.nonce)
  ) return undefined;
  return Object.freeze({
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    artifactVersion: owner.artifactVersion,
    manifestSha256: owner.manifestSha256,
    nonce: owner.nonce,
  });
}

function markerName(archive: EmbeddedArchive): string {
  return `${READY_MARKER_PREFIX}${archive.sha256.slice("sha256:".length)}`;
}

function isOwnedSiblingName(name: string, archiveKey: string): boolean {
  const prefix = `.${archiveKey}.`;
  if (!name.startsWith(prefix)) return false;
  const suffix = name.endsWith(TEMPORARY_SUFFIX)
    ? TEMPORARY_SUFFIX
    : name.endsWith(QUARANTINE_SUFFIX) ? QUARANTINE_SUFFIX : undefined;
  if (!suffix) return false;
  return UUID_V4_PATTERN.test(name.slice(prefix.length, -suffix.length));
}

function platformFor(archives: readonly EmbeddedArchive[]): RuntimePlatformTag {
  const platform = archives[0]?.platform;
  if (!platform || archives.some((archive) => archive.platform !== platform)) {
    throw new RuntimeAssetError(
      ErrorCode.RuntimeManifestInvalid,
      "resolved runtime archives must belong to exactly one platform",
    );
  }
  return platform;
}

function manifestProjection(
  manifest: EmbeddedRuntimeManifest,
  archives: readonly EmbeddedArchive[],
): EmbeddedRuntimeManifest {
  return {
    schemaVersion: manifest.schemaVersion,
    artifactVersion: manifest.artifactVersion,
    versions: manifest.versions,
    pythonPackages: manifest.pythonPackages,
    archives,
  };
}

/** Owns verified runtime archives under one absolute app-data root. */
export class RuntimeAssetManager {
  readonly appDataRoot: string;
  readonly nativeRoot: string;
  readonly lock: AtomicDirectoryLock;
  private readonly source: RuntimeAssetSource;
  private readonly platform: NodeJS.Platform;
  private readonly architecture: NodeJS.Architecture;
  private readonly clock: () => Date;
  private readonly observer: RuntimeAssetManagerObserver;
  private readonly hooks: RuntimeAssetManagerHooks;
  private readonly aclRunner: SyncCredentialCommandRunner | undefined;

  constructor(options: RuntimeAssetManagerOptions) {
    if (
      !path.isAbsolute(options.appDataRoot)
      || path.resolve(options.appDataRoot) !== options.appDataRoot
      || path.dirname(options.appDataRoot) === options.appDataRoot
    ) {
      throw new TypeError("runtime app-data root must be a normalized absolute path");
    }
    this.appDataRoot = options.appDataRoot;
    this.nativeRoot = path.join(options.appDataRoot, RUNTIME_DIRECTORY);
    this.source = options.source;
    this.platform = options.platform ?? process.platform;
    this.architecture = options.architecture ?? process.arch;
    this.clock = options.clock ?? (() => new Date());
    this.observer = options.observer ?? {};
    this.hooks = options.hooks ?? {};
    this.aclRunner = options.aclRunner;
    this.lock = options.lock
      ?? new AtomicDirectoryLock(path.join(this.appDataRoot, RUNTIME_BOOTSTRAP_LOCK));
    if (path.resolve(this.lock.lockPath) !== path.join(this.appDataRoot, RUNTIME_BOOTSTRAP_LOCK)) {
      throw new TypeError("runtime manager lock must be the app-data runtime-bootstrap lock");
    }
  }

  /** Reads installed markers and pointers without reading any embedded archive bytes. */
  async inspect(): Promise<RuntimeAssetInspection> {
    await this.prepareAppDataRoot();
    const { manifest, archives, versionRoot } = this.resolve();
    return this.inspectResolved(manifest, archives, versionRoot);
  }

  /** Reuses complete archives and atomically prepares only missing/incomplete ones. */
  async ensureAll(options: RuntimeAssetLeaseOptions = {}): Promise<RuntimeAssetInstallation> {
    return this.install(new Set(), options.lease);
  }

  /** Re-extracts selected archives through a temp/swap publication; never writes in place. */
  async repair(options: RuntimeRepairOptions = {}): Promise<RuntimeAssetInstallation> {
    await this.prepareAppDataRoot();
    const { archives } = this.resolve();
    const required = new Set(archives.map((archive) => archive.key));
    const force = new Set(options.keys ?? required);
    const unknown = [...force].filter((key) => !required.has(key));
    if (unknown.length > 0) {
      throw new RuntimeAssetError(
        ErrorCode.RuntimeManifestInvalid,
        "runtime repair requested an archive outside the host manifest",
        { unknown },
      );
    }
    return this.install(force, options.lease);
  }

  /**
   * Removes only old, manager-owned version directories after an explicit grace
   * period and an external in-use authority says the version is unused.
   */
  async pruneOldVersions(options: RuntimePruneOptions): Promise<RuntimePruneResult> {
    if (!Number.isSafeInteger(options.gracePeriodMs) || options.gracePeriodMs < 0) {
      throw new TypeError("runtime prune gracePeriodMs must be a non-negative safe integer");
    }
    if (!Number.isFinite(options.startupSucceededAt.getTime())) {
      throw new TypeError("runtime prune startupSucceededAt must be valid");
    }
    await this.prepareAppDataRoot();
    const { manifest } = this.resolve();
    await this.prepareRoot(this.nativeRoot);
    return this.withLease(options.lease, async () => {
      if (this.clock().getTime() < options.startupSucceededAt.getTime() + options.gracePeriodMs) {
        return { pruned: [], retained: [], deferred: true };
      }
      const pointer = parseRuntimeCurrentPointer(await readJson(
        path.join(this.nativeRoot, RUNTIME_CURRENT_FILENAME),
      ));
      if (!pointer) return { pruned: [], retained: [], deferred: true };

      const pruned: string[] = [];
      const retained: string[] = [];
      const entries = await readdir(this.nativeRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
        if (entry.name === manifest.artifactVersion || entry.name === pointer.artifactVersion) {
          retained.push(entry.name);
          continue;
        }
        const versionRoot = path.join(this.nativeRoot, entry.name);
        const owner = await this.ownedVersion(versionRoot, entry.name);
        if (!owner) continue;
        if (await options.isVersionInUse(entry.name)) {
          retained.push(entry.name);
          continue;
        }
        const quarantine = path.join(
          this.nativeRoot,
          `.prune-${entry.name}-${randomUUID()}${QUARANTINE_SUFFIX}`,
        );
        await rename(versionRoot, quarantine);
        await syncDirectory(this.nativeRoot, this.platform);
        await rm(quarantine, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        await syncDirectory(this.nativeRoot, this.platform);
        const authority = this.ownerAuthorityPath(owner);
        if (await exactRegularFileMatches(authority, stableJson(owner))) {
          await rm(authority, { force: true });
          await syncDirectory(path.dirname(authority), this.platform);
        }
        pruned.push(entry.name);
      }
      return { pruned, retained, deferred: false };
    });
  }

  private resolve(): {
    manifest: EmbeddedRuntimeManifest;
    archives: readonly EmbeddedArchive[];
    versionRoot: string;
  } {
    let manifest: EmbeddedRuntimeManifest;
    try {
      manifest = this.source.readManifest();
    } catch (error) {
      if (error instanceof RuntimeAssetError) throw error;
      throw new RuntimeAssetError(
        ErrorCode.RuntimeManifestInvalid,
        "embedded runtime manifest could not be read",
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    const archives = resolveRuntimeArchives(manifest, this.platform, this.architecture);
    if (archives.some((archive) => {
      const namespace = archive.target.split("/", 1)[0]?.toLowerCase();
      return namespace === RUNTIME_OWNER_FILENAME
        || namespace === RUNTIME_OWNER_AUTHORITY_DIRECTORY;
    })) {
      throw new RuntimeAssetError(
        ErrorCode.RuntimeManifestInvalid,
        "runtime archive target collides with the version ownership record",
      );
    }
    const versionRoot = path.join(this.nativeRoot, manifest.artifactVersion);
    // Validate target overlap before creating any runtime namespace beneath app-data.
    resolveRuntimeArchiveRoots(archives, versionRoot);
    return {
      manifest,
      archives,
      versionRoot,
    };
  }

  private async prepareRoot(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await pathKind(directory) !== "directory") {
      throw incomplete("runtime app-data path is not a real directory");
    }
    secureAppDataDirectorySync(directory, this.platform, this.aclRunner);
    if (this.platform !== "win32") await chmod(directory, 0o700);
    await syncDirectory(path.dirname(directory), this.platform);
  }

  private async prepareAppDataRoot(): Promise<void> {
    const canonical = await prepareRuntimeAppDataRoot(
      this.appDataRoot,
      this.platform,
      this.aclRunner,
    );
    if (canonical !== this.appDataRoot) {
      throw incomplete("runtime app-data root must use its canonical path");
    }
  }

  private async withLease<T>(
    lease: DirectoryLockLease | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!lease) return this.lock.runExclusive(operation);
    if (!this.lock.ownsLease(lease)) {
      throw incomplete("runtime bootstrap lease belongs to a different app-data root");
    }
    await lease.assertHeld();
    return operation();
  }

  private async inspectResolved(
    manifest: EmbeddedRuntimeManifest,
    archives: readonly EmbeddedArchive[],
    versionRoot: string,
  ): Promise<RuntimeAssetInspection> {
    const roots = resolveRuntimeArchiveRoots(archives, versionRoot);
    const inspected = await Promise.all(archives.map((archive) => this.inspectArchive(
      archive,
      manifest.artifactVersion,
      versionRoot,
      roots[archive.key]!,
    )));
    const projection = manifestProjection(manifest, archives);
    const current = await this.currentMatches(manifest, archives)
      && await this.installedManifestMatches(versionRoot, projection);
    const ready = inspected.every((archive) => archive.state === "ready");
    const missing = inspected.every((archive) => archive.state === "missing") && !current;
    return {
      state: ready && current ? "ready" : missing ? "missing" : "broken",
      artifactVersion: manifest.artifactVersion,
      versionRoot,
      current,
      archives: inspected,
    };
  }

  private async inspectArchive(
    archive: EmbeddedArchive,
    artifactVersion: string,
    versionRoot: string,
    root: string,
  ): Promise<RuntimeArchiveInspection> {
    return inspectArchiveInstallation(archive, artifactVersion, versionRoot, root);
  }

  private async currentMatches(
    manifest: EmbeddedRuntimeManifest,
    archives: readonly EmbeddedArchive[],
  ): Promise<boolean> {
    const pointer = parseRuntimeCurrentPointer(await readJson(
      path.join(this.nativeRoot, RUNTIME_CURRENT_FILENAME),
    ));
    return pointer?.artifactVersion === manifest.artifactVersion
      && pointer.platform === platformFor(archives);
  }

  private async installedManifestMatches(
    versionRoot: string,
    expected: EmbeddedRuntimeManifest,
  ): Promise<boolean> {
    return exactRegularFileMatches(
      path.join(versionRoot, RUNTIME_MANIFEST_FILENAME),
      stableJson(expected),
    );
  }

  private ownerAuthorityPath(owner: RuntimeVersionOwner): string {
    return path.join(this.nativeRoot, RUNTIME_OWNER_AUTHORITY_DIRECTORY, `${owner.nonce}.json`);
  }

  private async ownedVersion(
    versionRoot: string,
    version: string,
  ): Promise<RuntimeVersionOwner | undefined> {
    const owner = parseRuntimeVersionOwner(await readJson(
      path.join(versionRoot, RUNTIME_OWNER_FILENAME),
    ));
    if (!owner || owner.artifactVersion !== version) return undefined;
    const manifestPath = path.join(versionRoot, RUNTIME_MANIFEST_FILENAME);
    const value = await readJson(manifestPath, MAX_INSTALLED_MANIFEST_BYTES);
    if (value === undefined) return undefined;
    try {
      const manifest = parseEmbeddedRuntimeManifest(value);
      const expected = stableJson(manifest);
      if (
        manifest.artifactVersion !== version
        || owner.manifestSha256 !== sha256(expected)
        || !await exactRegularFileMatches(manifestPath, expected)
        || !await exactRegularFileMatches(this.ownerAuthorityPath(owner), stableJson(owner))
      ) return undefined;
      return owner;
    } catch {
      return undefined;
    }
  }

  private async install(
    force: ReadonlySet<string>,
    lease: DirectoryLockLease | undefined,
  ): Promise<RuntimeAssetInstallation> {
    try {
      await this.prepareAppDataRoot();
      const { manifest, archives, versionRoot } = this.resolve();
      await this.prepareRoot(this.nativeRoot);
      return await this.withLease(lease, async () => {
        await this.prepareRoot(versionRoot);
        const extracted: string[] = [];
        const reused: string[] = [];
        const roots = resolveRuntimeArchiveRoots(archives, versionRoot);
        const effectiveForce = new Set(force);
        const before = await this.inspectResolved(manifest, archives, versionRoot);
        const readyCount = before.archives.filter((archive) => archive.state === "ready").length;
        const hasSiblings = await this.hasOwnedSiblings(versionRoot, archives);
        if (readyCount > 0) {
          if (readyCount !== archives.length) {
            for (const archive of archives) effectiveForce.add(archive.key);
          } else {
            if (hasSiblings) {
              for (const archive of archives) {
                await this.cleanupOwnedSiblings(versionRoot, archive.key);
              }
            }
            const integrity = await this.inspectIntegrity(manifest, archives, versionRoot, roots);
            if (!integrity.ok) {
              if (force.size === 0) {
                throw new RuntimeAssetError(ErrorCode.RuntimeManifestInvalid, integrityFailureMessage(
                  integrity.issue.reason,
                ), {
                  archive: integrity.issue.archiveKey,
                  path: integrity.issue.path,
                  reason: integrity.issue.reason,
                });
              }
            } else if (effectiveForce.size === 0 && before.state === "ready") {
              await this.publishVersionOwnership(manifest, archives, versionRoot);
              return {
                artifactVersion: manifest.artifactVersion,
                versionRoot,
                archiveRoots: roots,
                extracted: [],
                reused: archives.map((archive) => archive.key),
              };
            }
          }
        }
        for (const archive of archives) {
          const root = roots[archive.key]!;
          const state = await this.inspectArchive(
            archive,
            manifest.artifactVersion,
            versionRoot,
            root,
          );
          if (!effectiveForce.has(archive.key) && state.state === "ready") {
            await this.cleanupOwnedSiblings(versionRoot, archive.key);
            reused.push(archive.key);
            continue;
          }
          await this.installArchive(manifest, archive, versionRoot, root);
          extracted.push(archive.key);
        }

        const ready = await Promise.all(archives.map((archive) => this.inspectArchive(
          archive,
          manifest.artifactVersion,
          versionRoot,
          roots[archive.key]!,
        )));
        if (ready.some((archive) => archive.state !== "ready")) {
          throw incomplete("runtime archives were not all ready after extraction", {
            incomplete: ready.filter((archive) => archive.state !== "ready").map((archive) => archive.key),
          });
        }
        await this.publishMetadata(manifest, archives, versionRoot);
        const inspection = await this.inspectResolved(manifest, archives, versionRoot);
        if (inspection.state !== "ready") {
          throw incomplete("runtime metadata publication did not produce a ready installation");
        }
        return {
          artifactVersion: manifest.artifactVersion,
          versionRoot,
          archiveRoots: roots,
          extracted,
          reused,
        };
      });
    } catch (error) {
      if (error instanceof RuntimeAssetError) throw error;
      throw incomplete("runtime asset installation failed", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async inspectIntegrity(
    manifest: EmbeddedRuntimeManifest,
    archives: readonly EmbeddedArchive[],
    versionRoot: string,
    archiveRoots: Readonly<Record<string, string>>,
  ) {
    const { inspectPublishedRuntimeIntegrity } = await import("./runtime-integrity");
    return inspectPublishedRuntimeIntegrity({
      manifest: manifestProjection(manifest, archives),
      versionRoot,
      archiveRoots,
    }, this.platform, this.architecture);
  }

  private async installArchive(
    manifest: EmbeddedRuntimeManifest,
    archive: EmbeddedArchive,
    versionRoot: string,
    target: string,
  ): Promise<void> {
    await this.cleanupOwnedSiblings(versionRoot, archive.key);
    await this.observer.preparing?.(archive);
    const temporary = path.join(versionRoot, `.${archive.key}.${randomUUID()}${TEMPORARY_SUFFIX}`);
    let quarantine: string | undefined;
    let published = false;
    let markerCommitted = false;
    try {
      let bytes: Uint8Array;
      try {
        bytes = this.source.readArchive(archive.key);
      } catch (error) {
        if (error instanceof RuntimeAssetError) throw error;
        throw new RuntimeAssetError(
          ErrorCode.RuntimeManifestInvalid,
          `embedded runtime archive ${archive.key} could not be read`,
          { archive: archive.key, cause: error instanceof Error ? error.message : String(error) },
        );
      }
      await extractRuntimeArchive({
        bytes,
        archive,
        destination: temporary,
        platform: this.platform,
        aclRunner: this.aclRunner,
        hooks: {
          afterExtract: async () => this.hooks.onPhase?.("afterExtract", archive),
        },
      });
      await this.hooks.onPhase?.("afterValidate", archive);

      await prepareTargetParent(versionRoot, target, this.platform);

      if (await pathKind(target) !== "absent") {
        quarantine = path.join(
          versionRoot,
          `.${archive.key}.${randomUUID()}${QUARANTINE_SUFFIX}`,
        );
        await rename(target, quarantine);
        await syncRenameParents(path.dirname(target), versionRoot, this.platform);
      }
      await rename(temporary, target);
      published = true;
      await syncRenameParents(versionRoot, path.dirname(target), this.platform);
      await this.hooks.onPhase?.("afterRename", archive);

      const marker: RuntimeReadyMarker = {
        schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
        artifactVersion: manifest.artifactVersion,
        archiveKey: archive.key,
        archiveSha256: archive.sha256,
        verifiedAt: this.clock().toISOString(),
      };
      await writeAtomic(
        path.join(target, markerName(archive)) as ResolvedPath,
        stableJson(marker),
        { beforeRename: async () => this.hooks.onPhase?.("beforeMarkerCommit", archive) },
      );
      markerCommitted = true;
      await this.hooks.onPhase?.("afterMarker", archive);
      if (quarantine) {
        await rm(quarantine, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        quarantine = undefined;
        await syncDirectory(versionRoot, this.platform);
      }
      await this.observer.ready?.(archive);
    } catch (error) {
      if (!markerCommitted) {
        if (published) {
          await rm(target, { recursive: true, force: true })
            .then(() => syncDirectory(path.dirname(target), this.platform))
            .catch(() => {});
        }
        await rm(temporary, { recursive: true, force: true })
          .then(() => syncDirectory(versionRoot, this.platform))
          .catch(() => {});
        if (quarantine && await pathKind(target) === "absent") {
          try {
            await rename(quarantine, target);
            quarantine = undefined;
            await syncRenameParents(versionRoot, path.dirname(target), this.platform);
          } catch {
            // Preserve the quarantine for a later owned cleanup rather than deleting
            // the only prior installation after a failed repair swap.
          }
        }
      }
      if (error instanceof RuntimeAssetError) throw error;
      throw incomplete(`runtime archive ${archive.key} could not be published`, {
        archive: archive.key,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async cleanupOwnedSiblings(versionRoot: string, archiveKey: string): Promise<void> {
    const entries = await readdir(versionRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (
        !entry.isDirectory()
        || entry.isSymbolicLink()
        || !isOwnedSiblingName(entry.name, archiveKey)
      ) continue;
      const owned = path.join(versionRoot, entry.name);
      if (path.dirname(owned) !== versionRoot) {
        throw incomplete("runtime cleanup target escaped its version root");
      }
      await rm(owned, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
    await syncDirectory(versionRoot, this.platform);
  }

  private async hasOwnedSiblings(
    versionRoot: string,
    archives: readonly EmbeddedArchive[],
  ): Promise<boolean> {
    if (await pathKind(versionRoot) !== "directory") return false;
    const entries = await readdir(versionRoot, { withFileTypes: true });
    return entries.some((entry) =>
      entry.isDirectory()
      && !entry.isSymbolicLink()
      && archives.some((archive) => isOwnedSiblingName(entry.name, archive.key)));
  }

  private async publishMetadata(
    manifest: EmbeddedRuntimeManifest,
    archives: readonly EmbeddedArchive[],
    versionRoot: string,
  ): Promise<void> {
    const projection = manifestProjection(manifest, archives);
    if (!await this.installedManifestMatches(versionRoot, projection)) {
      await writeAtomic(
        path.join(versionRoot, RUNTIME_MANIFEST_FILENAME) as ResolvedPath,
        stableJson(projection),
      );
    }
    await this.publishVersionOwnership(manifest, archives, versionRoot);
    const pointer: RuntimeCurrentPointer = {
      schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      artifactVersion: manifest.artifactVersion,
      platform: platformFor(archives),
      manifest: `${manifest.artifactVersion}/${RUNTIME_MANIFEST_FILENAME}`,
    };
    if (!await this.currentMatches(manifest, archives)) {
      await writeAtomic(
        path.join(this.nativeRoot, RUNTIME_CURRENT_FILENAME) as ResolvedPath,
        stableJson(pointer),
      );
    }
  }

  private async publishVersionOwnership(
    manifest: EmbeddedRuntimeManifest,
    archives: readonly EmbeddedArchive[],
    versionRoot: string,
  ): Promise<void> {
    const projection = manifestProjection(manifest, archives);
    const manifestSha256 = sha256(stableJson(projection));
    const existing = await this.ownedVersion(versionRoot, manifest.artifactVersion);
    if (existing?.manifestSha256 === manifestSha256) return;

    const owner: RuntimeVersionOwner = {
      schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      artifactVersion: manifest.artifactVersion,
      manifestSha256,
      nonce: randomBytes(32).toString("hex"),
    };
    const authorityDirectory = path.join(this.nativeRoot, RUNTIME_OWNER_AUTHORITY_DIRECTORY);
    await this.prepareRoot(authorityDirectory);
    await writeAtomic(
      this.ownerAuthorityPath(owner) as ResolvedPath,
      stableJson(owner),
    );
    await writeAtomic(
      path.join(versionRoot, RUNTIME_OWNER_FILENAME) as ResolvedPath,
      stableJson(owner),
    );
  }
}
