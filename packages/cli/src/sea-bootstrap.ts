import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import {
  createRequire,
  isBuiltin,
  Module,
  registerHooks,
} from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ErrorCode,
  RuntimeAssetManager,
  RuntimeAssetError,
  SeaRuntimeAssetSource,
  validatePackagedRuntimeManifest,
  type EmbeddedArchive,
  type EmbeddedRuntimeEntry,
} from "@vidcom/adapter/runtime-bootstrap";

import { earlyAppDataRoot } from "./app-data-root";

export const SEA_BOOT_ARCHIVE_KEY = "node";
export const SEA_BOOT_RELATIVE_PATH = "cli/boot.cjs";
export const SEA_INTEGRITY_ARGUMENT = "--vidcom-sea-integrity";
export const SEA_PRIMARY_BUNDLE_ASSET = "__vidcom/primary.cjs";
export const SEA_PRIMARY_LOADER_PROTOCOL = "vidcom-sea-primary-loader-v1";

type RawAssetReader = (key: string) => ArrayBuffer;

interface SeaModule {
  isSea(): boolean;
  getAssetKeys(): string[];
  getRawAsset(key: string): ArrayBuffer;
}

export interface SeaIntegrityReport {
  schemaVersion: 1;
  assets: readonly {
    key: string;
    bytes: number;
    sha256: string;
  }[];
}

interface BootModule {
  runBootstrappedCli(argv: readonly string[]): number | Promise<number>;
}

interface CompilableModule extends Module {
  _compile(source: string, filename: string): void;
}

interface FileIdentity {
  dev: number | bigint;
  ino: number | bigint;
  size: number | bigint;
  nlink: number | bigint;
  mtimeMs: number | bigint;
  ctimeMs: number | bigint;
}

/** Explicit seams used by real-archive tests; production uses the current SEA. */
export interface SeaBootstrapOptions {
  appDataRoot?: string;
  rawAsset?: RawAssetReader;
  platform?: NodeJS.Platform;
  architecture?: NodeJS.Architecture;
  afterBootVerified?: (bootPath: string) => void | Promise<void>;
}

export interface PreparedSeaBootstrap {
  bootPath: string;
  extracted: readonly string[];
  reused: readonly string[];
}

interface VerifiedBootEntry {
  archiveRoot: string;
  bootPath: string;
  canonicalArchiveRoot: string;
  canonicalBootPath: string;
  metadata: Awaited<ReturnType<typeof lstat>>;
  generationArchives: readonly VerifiedArchiveBoundary[];
  source: string;
}

interface VerifiedArchiveBoundary {
  key: string;
  archiveRoot: string;
  canonicalArchiveRoot: string;
  entries: readonly EmbeddedRuntimeEntry[];
}

interface ModuleArchiveBoundary {
  entries: ReadonlyMap<string, EmbeddedRuntimeEntry>;
  allowedRoots: ReadonlySet<string>;
}

interface InternalPreparedSeaBootstrap extends PreparedSeaBootstrap {
  verified: VerifiedBootEntry;
}

const verifiedModuleRoots = new Map<string, ModuleArchiveBoundary>();
const moduleGenerationScope = new AsyncLocalStorage<ReadonlySet<string>>();
let moduleBoundaryRegistered = false;

function invalid(message: string, details?: Record<string, unknown>): RuntimeAssetError {
  return new RuntimeAssetError(ErrorCode.RuntimeManifestInvalid, message, details);
}

function currentSea(): SeaModule | null {
  const candidate: unknown = process.getBuiltinModule?.("node:sea");
  if (
    !candidate
    || typeof candidate !== "object"
    || !("isSea" in candidate)
    || !("getAssetKeys" in candidate)
    || !("getRawAsset" in candidate)
    || typeof candidate.isSea !== "function"
    || typeof candidate.getAssetKeys !== "function"
    || typeof candidate.getRawAsset !== "function"
  ) return null;
  return candidate as SeaModule;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * Reports the bytes that the running SEA can actually read from its injected
 * blob. The build verifier calls this hidden protocol before publication; a
 * snapshot on disk is not proof that postject embedded the same generation.
 */
export function seaIntegrityReport(sea: Pick<SeaModule, "getAssetKeys" | "getRawAsset">): SeaIntegrityReport {
  const keys = [...sea.getAssetKeys()].sort(compareUtf8);
  if (new Set(keys).size !== keys.length || keys.some((key) => key.length === 0)) {
    throw invalid("the SEA asset key set is invalid");
  }
  if (!keys.includes(SEA_PRIMARY_BUNDLE_ASSET)) {
    throw invalid("the SEA does not carry its primary bundle as a verifiable asset");
  }
  return {
    schemaVersion: 1,
    assets: keys.map((key) => {
      const bytes = new Uint8Array(sea.getRawAsset(key));
      return {
        key,
        bytes: bytes.byteLength,
        sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      };
    }),
  };
}

function productionRawAsset(): RawAssetReader {
  const sea = currentSea();
  if (!sea || !sea.isSea()) throw invalid("the SEA runtime asset source is unavailable");
  return (key) => sea.getRawAsset(key);
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === code;
}

function archiveBoundaryForParent(
  parentUrl: string | undefined,
): { root: string; boundary: ModuleArchiveBoundary } | undefined {
  if (!parentUrl?.startsWith("file:")) return undefined;
  let parentPath: string;
  try {
    parentPath = path.resolve(fileURLToPath(parentUrl));
  } catch {
    return undefined;
  }
  const matches = [...verifiedModuleRoots.entries()]
    .filter(([root]) => isContained(root, parentPath));
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) {
    throw invalid("verified runtime archive roots overlap for a module parent", { parent: parentPath });
  }
  const [root, boundary] = matches[0]!;
  try {
    const canonicalParent = realpathSync(parentPath);
    if (!isContained(root, canonicalParent)) {
      throw invalid("a verified runtime module parent escaped its archive", {
        parent: parentPath,
      });
    }
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    // A module that was removed after loading remains governed by the root its
    // canonical filename originally belonged to.
  }
  return { root, boundary };
}

function inspectModulePath(archiveRoot: string, modulePath: string): Stats {
  if (!path.isAbsolute(modulePath) || !isContained(archiveRoot, modulePath) || modulePath === archiveRoot) {
    throw invalid("a runtime module path escaped the verified node archive");
  }
  const rootMetadata = lstatSync(archiveRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw invalid("the verified node archive root is not a real directory");
  }
  const relative = path.relative(archiveRoot, modulePath);
  let current = archiveRoot;
  const segments = relative.split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) {
      throw invalid("a runtime module path contains a symbolic link");
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      throw invalid("a runtime module parent is not a real directory");
    }
    if (index === segments.length - 1) {
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw invalid("a runtime module must be a singly-linked regular file");
      }
      return metadata;
    }
  }
  throw invalid("a runtime module path is absent");
}

function authenticateModule(
  archiveRoot: string,
  entries: ReadonlyMap<string, EmbeddedRuntimeEntry>,
  modulePath: string,
): Buffer {
  const relative = path.relative(archiveRoot, modulePath).split(path.sep).join("/");
  const entry = entries.get(relative);
  if (!entry) {
    throw invalid("a runtime module is not declared by its verified archive", {
      module: relative,
    });
  }
  const before = inspectModulePath(archiveRoot, modulePath);
  const bytes = readFileSync(modulePath);
  const after = inspectModulePath(archiveRoot, modulePath);
  if (!hasSameIdentity(before, after)) {
    throw invalid("a runtime module changed while it was being authenticated", {
      module: relative,
    });
  }
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== entry.sha256) {
    throw invalid("a runtime module does not match its manifest hash", {
      module: relative,
    });
  }
  return bytes;
}

function moduleBoundaryForPath(
  roots: ReadonlySet<string>,
  modulePath: string,
): { root: string; boundary: ModuleArchiveBoundary } | undefined {
  const matches = [...roots]
    .filter((root) => isContained(root, modulePath) && root !== modulePath);
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) {
    throw invalid("verified runtime archive roots overlap for a module path", { module: modulePath });
  }
  const root = matches[0]!;
  const boundary = verifiedModuleRoots.get(root);
  if (!boundary || boundary.allowedRoots !== roots) {
    throw invalid("the verified runtime generation authority is unavailable");
  }
  return { root, boundary };
}

function registeredBoundaryForPath(
  modulePath: string,
): { root: string; boundary: ModuleArchiveBoundary } | undefined {
  const matches = [...verifiedModuleRoots.entries()]
    .filter(([root]) => isContained(root, modulePath) && root !== modulePath);
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) {
    throw invalid("verified runtime archive roots overlap for a loaded module", { module: modulePath });
  }
  const [root, boundary] = matches[0]!;
  return { root, boundary };
}

function registerModuleGeneration(
  archives: readonly VerifiedArchiveBoundary[],
): ReadonlySet<string> {
  const allowedRoots = new Set(archives.map((archive) => archive.canonicalArchiveRoot));
  if (allowedRoots.size !== archives.length) {
    throw invalid("a verified runtime generation contains duplicate archive roots");
  }
  for (const candidate of allowedRoots) {
    for (const existing of verifiedModuleRoots.keys()) {
      if (candidate === existing) continue;
      if (isContained(candidate, existing) || isContained(existing, candidate)) {
        throw invalid("verified runtime archive roots overlap across generations", {
          candidate,
          existing,
        });
      }
    }
  }
  const boundaries = archives.map((archive) => ({
    root: archive.canonicalArchiveRoot,
    boundary: {
      entries: new Map(archive.entries.map((entry) => [entry.path, entry])),
      allowedRoots,
    } satisfies ModuleArchiveBoundary,
  }));
  // Node consults package metadata before producing the resolved module URL.
  // Authenticate those small authority files eagerly; code/native leaves are
  // authenticated on every non-builtin resolution below.
  for (const { root, boundary } of boundaries) {
    for (const entry of boundary.entries.values()) {
      if (!entry.path.startsWith("node_modules/") || !entry.path.endsWith("/package.json")) continue;
      authenticateModule(root, boundary.entries, path.join(root, ...entry.path.split("/")));
    }
  }
  for (const { root, boundary } of boundaries) verifiedModuleRoots.set(root, boundary);
  if (moduleBoundaryRegistered) return allowedRoots;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = archiveBoundaryForParent(context.parentURL);
      const activeRoots = moduleGenerationScope.getStore();
      if (activeRoots && parent && parent.boundary.allowedRoots !== activeRoots) {
        throw invalid("a runtime module parent belongs to another verified generation");
      }
      const allowedRoots = activeRoots ?? parent?.boundary.allowedRoots;
      if (!allowedRoots || isBuiltin(specifier)) return nextResolve(specifier, context);
      const resolved = nextResolve(specifier, context);
      if (!resolved.url.startsWith("file:")) {
        throw invalid("a verified runtime module resolved outside the filesystem archive", {
          specifier,
          resolved: resolved.url,
        });
      }
      let canonicalModule: string;
      const resolvedPath = path.resolve(fileURLToPath(resolved.url));
      try {
        canonicalModule = realpathSync(resolvedPath);
      } catch (error) {
        throw invalid("a verified runtime module could not be canonicalized", {
          specifier,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      const lexicalTarget = moduleBoundaryForPath(allowedRoots, resolvedPath);
      const canonicalTarget = moduleBoundaryForPath(allowedRoots, canonicalModule);
      if (!lexicalTarget || !canonicalTarget || lexicalTarget.root !== canonicalTarget.root) {
        throw invalid("a non-builtin runtime module escaped its verified product generation", {
          specifier,
        });
      }
      authenticateModule(lexicalTarget.root, lexicalTarget.boundary.entries, resolvedPath);
      return resolved;
    },
    load(url, context, nextLoad) {
      if (!url.startsWith("file:")) return nextLoad(url, context);
      const modulePath = path.resolve(fileURLToPath(url));
      const target = registeredBoundaryForPath(modulePath);
      if (!target) return nextLoad(url, context);
      const source = authenticateModule(target.root, target.boundary.entries, modulePath);
      const loaded = nextLoad(url, context);
      return loaded.format === "addon" ? loaded : { ...loaded, source };
    },
  });
  moduleBoundaryRegistered = true;
  return allowedRoots;
}

function hasSameIdentity(
  before: FileIdentity,
  after: FileIdentity,
): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.nlink === after.nlink
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

async function inspectBootPath(archiveRoot: string, bootPath: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  const relative = path.relative(archiveRoot, bootPath);
  if (
    !path.isAbsolute(archiveRoot)
    || path.resolve(archiveRoot) !== archiveRoot
    || !isContained(archiveRoot, bootPath)
    || relative === ""
  ) {
    throw invalid("the extracted SEA boot path escaped its archive root");
  }

  const rootMetadata = await lstat(archiveRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw invalid("the extracted SEA boot archive root is not a real directory");
  }

  let current = archiveRoot;
  const segments = relative.split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw invalid("the extracted SEA boot path contains a symbolic link");
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      throw invalid("the extracted SEA boot parent is not a real directory");
    }
    if (
      index === segments.length - 1
      && (!metadata.isFile() || metadata.nlink !== 1)
    ) {
      throw invalid("the extracted SEA boot entry must be a singly-linked regular file");
    }
    if (index === segments.length - 1) return metadata;
  }
  throw invalid("the extracted SEA boot entry is absent");
}

async function canonicalContainedBootPath(
  archiveRoot: string,
  bootPath: string,
): Promise<{ archiveRoot: string; bootPath: string }> {
  const [realArchiveRoot, realBootPath] = await Promise.all([
    realpath(archiveRoot),
    realpath(bootPath),
  ]);
  if (!isContained(realArchiveRoot, realBootPath) || realArchiveRoot === realBootPath) {
    throw invalid("the extracted SEA boot path is not real-contained by its archive root");
  }
  return { archiveRoot: realArchiveRoot, bootPath: realBootPath };
}

async function verifyArchiveBoundaries(
  archives: readonly EmbeddedArchive[],
  archiveRoots: Readonly<Record<string, string>>,
): Promise<readonly VerifiedArchiveBoundary[]> {
  const verified = await Promise.all(archives.map(async (archive): Promise<VerifiedArchiveBoundary> => {
    const archiveRoot = archiveRoots[archive.key];
    if (!archiveRoot || !path.isAbsolute(archiveRoot) || path.resolve(archiveRoot) !== archiveRoot) {
      throw invalid("an extracted runtime archive root is unavailable or not normalized", {
        archive: archive.key,
      });
    }
    const metadata = await lstat(archiveRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw invalid("an extracted runtime archive root is not a real directory", {
        archive: archive.key,
      });
    }
    return {
      key: archive.key,
      archiveRoot,
      canonicalArchiveRoot: await realpath(archiveRoot),
      entries: archive.entries,
    };
  }));
  for (const [index, archive] of verified.entries()) {
    for (const other of verified.slice(index + 1)) {
      if (
        isContained(archive.canonicalArchiveRoot, other.canonicalArchiveRoot)
        || isContained(other.canonicalArchiveRoot, archive.canonicalArchiveRoot)
      ) {
        throw invalid("extracted runtime archive roots overlap after canonicalization", {
          current: archive.key,
          next: other.key,
        });
      }
    }
  }
  return verified;
}

async function verifyBootEntry(
  archive: VerifiedArchiveBoundary,
  entry: EmbeddedRuntimeEntry,
  generationArchives: readonly VerifiedArchiveBoundary[],
): Promise<VerifiedBootEntry> {
  if (entry.path !== SEA_BOOT_RELATIVE_PATH) {
    throw invalid("the node runtime archive does not declare the fixed SEA boot entry");
  }
  const bootPath = path.join(archive.archiveRoot, ...SEA_BOOT_RELATIVE_PATH.split("/"));
  const before = await inspectBootPath(archive.archiveRoot, bootPath);
  const canonical = await canonicalContainedBootPath(archive.archiveRoot, bootPath);
  const bytes = await readFile(bootPath);
  const after = await inspectBootPath(archive.archiveRoot, bootPath);
  const canonicalAfter = await canonicalContainedBootPath(archive.archiveRoot, bootPath);
  if (!hasSameIdentity(before, after)) {
    throw invalid("the extracted SEA boot entry changed while it was being verified");
  }
  if (
    canonicalAfter.archiveRoot !== canonical.archiveRoot
    || canonicalAfter.bootPath !== canonical.bootPath
  ) {
    throw invalid("the extracted SEA boot entry changed its canonical path while it was being verified");
  }
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== entry.sha256) {
    throw invalid("the extracted SEA boot entry does not match its manifest hash");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw invalid("the extracted SEA boot entry is not valid UTF-8", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    archiveRoot: archive.archiveRoot,
    bootPath,
    canonicalArchiveRoot: canonical.archiveRoot,
    canonicalBootPath: canonical.bootPath,
    metadata: after,
    generationArchives,
    source,
  };
}

async function prepareVerifiedSeaBootstrap(
  options: SeaBootstrapOptions = {},
): Promise<InternalPreparedSeaBootstrap> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const source = new SeaRuntimeAssetSource(options.rawAsset ?? productionRawAsset());
  const manifest = source.readManifest();
  const appDataRoot = options.appDataRoot ?? await earlyAppDataRoot();
  const validated = validatePackagedRuntimeManifest(
    appDataRoot,
    manifest,
    platform,
    architecture,
  );
  const hostArchives = validated.archives;
  const nodeArchives = hostArchives.filter((archive) => archive.key === SEA_BOOT_ARCHIVE_KEY);
  if (nodeArchives.length !== 1) {
    throw invalid("the embedded runtime manifest must declare exactly one node archive");
  }
  const nodeArchive = nodeArchives[0]!;
  const bootEntries = nodeArchive.entries.filter((entry) => entry.path === SEA_BOOT_RELATIVE_PATH);
  if (bootEntries.length !== 1) {
    throw invalid("the node runtime archive must declare exactly one fixed SEA boot entry");
  }

  const installation = await new RuntimeAssetManager({
    appDataRoot,
    source,
    platform,
    architecture,
  }).ensureAll();
  const generationArchives = await verifyArchiveBoundaries(hostArchives, installation.archiveRoots);
  const nodeBoundary = generationArchives.find((archive) => archive.key === nodeArchive.key);
  if (!nodeBoundary) throw invalid("the extracted node runtime archive root is unavailable");
  const verified = await verifyBootEntry(nodeBoundary, bootEntries[0]!, generationArchives);
  return {
    bootPath: verified.canonicalBootPath,
    extracted: installation.extracted,
    reused: installation.reused,
    verified,
  };
}

/** Extracts the exact-host runtime and returns only a verified secondary entry. */
export async function prepareSeaBootstrap(
  options: SeaBootstrapOptions = {},
): Promise<PreparedSeaBootstrap> {
  const prepared = await prepareVerifiedSeaBootstrap(options);
  return {
    bootPath: prepared.bootPath,
    extracted: prepared.extracted,
    reused: prepared.reused,
  };
}

async function assertVerifiedBootUnchanged(verified: VerifiedBootEntry): Promise<void> {
  const metadata = await inspectBootPath(verified.archiveRoot, verified.bootPath);
  const canonical = await canonicalContainedBootPath(verified.archiveRoot, verified.bootPath);
  if (
    !hasSameIdentity(verified.metadata, metadata)
    || canonical.archiveRoot !== verified.canonicalArchiveRoot
    || canonical.bootPath !== verified.canonicalBootPath
  ) {
    throw invalid("the extracted SEA boot entry changed after verification");
  }
}

function compileVerifiedBoot(verified: VerifiedBootEntry): unknown {
  const requireFromBoot = createRequire(verified.canonicalBootPath);
  const loaded = new Module(verified.canonicalBootPath) as CompilableModule;
  loaded.filename = verified.canonicalBootPath;
  loaded.paths = (requireFromBoot.resolve.paths("__vidcom_sea_bootstrap_resolution__") ?? [])
    .filter((candidate) => isContained(verified.canonicalArchiveRoot, path.resolve(candidate)));
  loaded._compile(verified.source, verified.canonicalBootPath);
  return loaded.exports;
}

/** Loads the verified secondary CJS and delegates the original CLI arguments. */
export async function runSeaBootstrap(
  argv: readonly string[],
  options: SeaBootstrapOptions = {},
): Promise<number> {
  const prepared = await prepareVerifiedSeaBootstrap(options);
  await options.afterBootVerified?.(prepared.bootPath);
  await assertVerifiedBootUnchanged(prepared.verified);
  const generationRoots = registerModuleGeneration(prepared.verified.generationArchives);
  return moduleGenerationScope.run(generationRoots, async () => {
    const loaded = compileVerifiedBoot(prepared.verified);
    if (
      !loaded
      || typeof loaded !== "object"
      || !("runBootstrappedCli" in loaded)
      || typeof loaded.runBootstrappedCli !== "function"
    ) {
      throw invalid("the extracted SEA boot module does not export runBootstrappedCli");
    }
    return (loaded as BootModule).runBootstrappedCli(argv);
  });
}

const embeddedSea = currentSea();
if (embeddedSea?.isSea() === true) {
  const loaderProtocol = (globalThis as Record<string, unknown>).__VIDCOM_SEA_PRIMARY_LOADER__;
  if (loaderProtocol !== SEA_PRIMARY_LOADER_PROTOCOL) {
    process.stderr.write("runtime_manifest_invalid\n");
    process.exitCode = 1;
  } else if (process.argv.length === 3 && process.argv[2] === SEA_INTEGRITY_ARGUMENT) {
    try {
      process.stdout.write(`${JSON.stringify(seaIntegrityReport(embeddedSea))}\n`);
      process.exitCode = 0;
    } catch (error: unknown) {
      process.stderr.write(`${error instanceof RuntimeAssetError ? error.code : "internal_error"}\n`);
      process.exitCode = 1;
    }
  } else {
    void runSeaBootstrap(process.argv.slice(2)).then((exitCode) => {
      process.exitCode = exitCode;
    }).catch((error: unknown) => {
      process.stderr.write(`${error instanceof RuntimeAssetError ? error.code : "internal_error"}\n`);
      process.exitCode = 1;
    });
  }
}
