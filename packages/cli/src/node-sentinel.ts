import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseEmbeddedRuntimeManifest,
  parseRuntimeCurrentPointer,
  parseRuntimeReadyMarker,
  RUNTIME_CURRENT_FILENAME,
  resolveRuntimeArchiveRoots,
} from "@vidcom/adapter";
import { ErrorCode } from "@vidcom/contracts";

export const NODE_SENTINEL = "--vidcom-node";

export class NodeSentinelError extends Error {
  readonly name = "NodeSentinelError";
  constructor(readonly code: ErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

/**
 * Runs a runtime script as if this executable were `node`.
 *
 * The artifact ships one binary, so anything that used to call `node script.js`
 * has to call the artifact instead. Without a sentinel the artifact re-enters
 * its own command parser and silently starts the app: `parseVidcomCommand`
 * treats every argv beginning with `--` as `vidcom app`, so the wrong behaviour
 * produces no error at all.
 *
 * The sentinel is internal. It is dispatched before the public parser and MUST
 * NOT appear in help or in the published mode list.
 */
export function isNodeSentinel(argv: readonly string[]): boolean {
  return argv[0] === NODE_SENTINEL;
}

const STATE_FILE_MAX_BYTES = 1024 * 1024;
const INSTALLED_MANIFEST_MAX_BYTES = 64 * 1024 * 1024;

interface RuntimeDirectoryIdentity {
  device: string;
  inode: string;
  birthtimeNs: string;
}

/** Canonical directory plus the filesystem identity that was verified. */
export interface VerifiedHyperframesRoot {
  path: string;
  identity: RuntimeDirectoryIdentity;
}

function invalid(message: string, details?: Record<string, unknown>): NodeSentinelError {
  return new NodeSentinelError(ErrorCode.RuntimeManifestInvalid, message, details);
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function cause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function canonicalDirectory(pathname: string, label: string): Promise<string> {
  try {
    const metadata = await lstat(pathname);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw invalid(`${label} is not a verified runtime directory`, { path: pathname });
    }
    return await realpath(pathname);
  } catch (error) {
    if (error instanceof NodeSentinelError) throw error;
    throw invalid(`${label} is unavailable`, { path: pathname, cause: cause(error) });
  }
}

function directoryIdentity(metadata: Awaited<ReturnType<typeof lstat>>): RuntimeDirectoryIdentity {
  return {
    device: String(metadata.dev),
    inode: String(metadata.ino),
    birthtimeNs: "birthtimeNs" in metadata
      ? String(metadata.birthtimeNs)
      : String(metadata.birthtimeMs),
  };
}

async function captureDirectoryAuthority(pathname: string, label: string): Promise<VerifiedHyperframesRoot> {
  const canonical = await canonicalDirectory(pathname, label);
  const metadata = await lstat(canonical, { bigint: true });
  return Object.freeze({
    path: canonical,
    identity: Object.freeze(directoryIdentity(metadata)),
  });
}

async function assertDirectoryAuthority(
  authority: VerifiedHyperframesRoot,
  label: string,
): Promise<void> {
  try {
    const pathname = path.resolve(authority.path);
    const metadata = await lstat(pathname, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw invalid(`${label} was substituted after verification`, { path: pathname });
    }
    const canonical = await realpath(pathname);
    const actual = directoryIdentity(metadata);
    if (
      canonical !== authority.path
      || actual.device !== authority.identity.device
      || actual.inode !== authority.identity.inode
      || actual.birthtimeNs !== authority.identity.birthtimeNs
    ) {
      throw invalid(`${label} no longer matches the verified runtime authority`, {
        path: pathname,
        canonical,
      });
    }
  } catch (error) {
    if (error instanceof NodeSentinelError) throw error;
    throw invalid(`${label} is unavailable`, { path: authority.path, cause: cause(error) });
  }
}

async function readStateFile(
  pathname: string,
  label: string,
  containmentRoot: string,
  maxBytes: number = STATE_FILE_MAX_BYTES,
): Promise<unknown> {
  try {
    const metadata = await lstat(pathname);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || metadata.size <= 0
      || metadata.size > maxBytes
    ) {
      throw invalid(`${label} is not a verified runtime state file`, { path: pathname });
    }
    const canonical = await realpath(pathname);
    if (!isContained(containmentRoot, canonical)) {
      throw invalid(`${label} escaped the verified runtime root`, { path: canonical });
    }
    return JSON.parse(await readFile(canonical, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof NodeSentinelError) throw error;
    throw invalid(`${label} is unavailable or invalid`, { path: pathname, cause: cause(error) });
  }
}

/**
 * Resolves the only directory the internal Node shim may execute from.
 *
 * This is deliberately read-only. The shim is needed by a child process while
 * the artifact is already booting, so resolving it must not run extraction,
 * database migration, workspace selection, or open a listener. The published
 * current pointer, installed manifest, and matching ready marker are the full
 * authority chain.
 */
export async function resolveVerifiedHyperframesRoot(appDataRoot: string): Promise<VerifiedHyperframesRoot> {
  const nativeRootPath = path.join(path.resolve(appDataRoot), "native");
  const nativeRoot = await canonicalDirectory(nativeRootPath, "runtime native root");
  const currentValue = await readStateFile(
    path.join(nativeRootPath, RUNTIME_CURRENT_FILENAME),
    "runtime current pointer",
    nativeRoot,
  );
  const current = parseRuntimeCurrentPointer(currentValue);
  if (!current) throw invalid("runtime current pointer is invalid");

  const hostPlatform = `${process.platform}-${process.arch}`;
  if (current.platform !== hostPlatform) {
    throw invalid("runtime current pointer belongs to a different platform", {
      current: current.platform,
      host: hostPlatform,
    });
  }

  const manifestPath = path.resolve(nativeRootPath, current.manifest);
  if (!isContained(nativeRootPath, manifestPath)) {
    throw invalid("runtime current pointer escaped the native root", { manifest: current.manifest });
  }
  const versionRootPath = path.dirname(manifestPath);
  const versionRoot = await canonicalDirectory(versionRootPath, "runtime version root");
  if (!isContained(nativeRoot, versionRoot)) {
    throw invalid("runtime version root escaped the native root", { path: versionRoot });
  }

  const manifestValue = await readStateFile(
    manifestPath,
    "installed runtime manifest",
    versionRoot,
    INSTALLED_MANIFEST_MAX_BYTES,
  );
  let manifest: ReturnType<typeof parseEmbeddedRuntimeManifest>;
  try {
    manifest = parseEmbeddedRuntimeManifest(manifestValue);
  } catch (error) {
    throw invalid("installed runtime manifest is invalid", { cause: cause(error) });
  }
  if (manifest.artifactVersion !== current.artifactVersion) {
    throw invalid("installed runtime manifest does not match the current artifact version", {
      current: current.artifactVersion,
      installed: manifest.artifactVersion,
    });
  }

  const archives = manifest.archives.filter(
    (archive) => archive.key === "hyperframes" && archive.platform === current.platform,
  );
  const archive = archives[0];
  if (!archive || archives.length !== 1) {
    throw invalid("current runtime manifest does not name exactly one hyperframes archive");
  }

  const hyperframesPath = resolveRuntimeArchiveRoots([archive], versionRootPath)[archive.key]!;
  const hyperframesRoot = await canonicalDirectory(hyperframesPath, "hyperframes runtime root");
  if (!isContained(versionRoot, hyperframesRoot)) {
    throw invalid("hyperframes runtime root escaped the current version", { path: hyperframesRoot });
  }
  const authority = await captureDirectoryAuthority(hyperframesRoot, "hyperframes runtime root");
  const markerValue = await readStateFile(
    path.join(hyperframesPath, `.ready-${archive.sha256.slice("sha256:".length)}`),
    "hyperframes ready marker",
    hyperframesRoot,
  );
  const marker = parseRuntimeReadyMarker(markerValue);
  if (
    !marker
    || marker.artifactVersion !== current.artifactVersion
    || marker.archiveKey !== archive.key
    || marker.archiveSha256 !== archive.sha256
  ) {
    throw invalid("hyperframes ready marker does not match the current runtime manifest");
  }
  await assertDirectoryAuthority(authority, "hyperframes runtime root");
  return authority;
}

/**
 * Imports the named script with `process.argv` rewritten to look like Node's.
 *
 * Only a script inside the verified runtime root may be imported: this entry
 * point turns an argument into executed code, so an unconstrained path here
 * would run anything the caller names.
 */
export async function runNodeSentinel(
  argv: readonly string[],
  runtimeRoot: string | VerifiedHyperframesRoot,
  importModule: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<void> {
  const [, script, ...rest] = argv;
  if (!script) {
    throw new NodeSentinelError(
      ErrorCode.RuntimeManifestInvalid,
      `${NODE_SENTINEL} requires a script path`,
    );
  }
  const authority = typeof runtimeRoot === "string"
    ? await captureDirectoryAuthority(runtimeRoot, "node sentinel runtime root")
    : runtimeRoot;
  await assertDirectoryAuthority(authority, "node sentinel runtime root");
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(script));
    const scriptMetadata = await lstat(resolved);
    if (!scriptMetadata.isFile() || scriptMetadata.nlink !== 1) {
      throw new Error("the script is not a regular single-link file");
    }
  } catch (error) {
    throw invalid("the node sentinel script or runtime root is unavailable", {
      script: path.resolve(script),
      runtimeRoot: authority.path,
      cause: cause(error),
    });
  }
  await assertDirectoryAuthority(authority, "node sentinel runtime root");
  if (!isContained(authority.path, resolved)) {
    throw new NodeSentinelError(
      ErrorCode.RuntimeManifestInvalid,
      "the node sentinel may only run a script inside the verified runtime root",
      { script: resolved, runtimeRoot: authority.path },
    );
  }

  // The script reads process.argv expecting Node's shape: execPath, script,
  // then its own arguments. Leaving the sentinel in place would make every
  // downstream argument index off by one.
  const original = process.argv;
  process.argv = [process.argv[0] ?? process.execPath, resolved, ...rest];
  try {
    await assertDirectoryAuthority(authority, "node sentinel runtime root");
    await importModule(pathToFileURL(resolved).href);
  } finally {
    process.argv = original;
  }
}
