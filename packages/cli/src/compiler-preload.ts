import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { CompilerGuard } from "@vidcom/adapter/compiler-guard";

import { earlyAppDataRoot, type EarlyAppDataOptions } from "./app-data-root";

const RUNTIME_MANIFEST_FILENAME = "runtime-manifest.json";
const ARTIFACT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;

interface RuntimeArchiveRecord {
  key: string;
  platform: string;
  target: string;
}

interface CompilerRuntimeManifest {
  artifactVersion: string;
  archives: RuntimeArchiveRecord[];
}

/** Dependencies injectable in ordering tests without replacing filesystem modules. */
export interface CompilerPreloadOptions extends EarlyAppDataOptions {
  architecture?: NodeJS.Architecture;
  readSeaManifest?: () => unknown | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function portablePath(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\\")
    || value.endsWith("/")
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) throw new Error(`${label} must be a normalized portable relative path`);
  return value;
}

function parseCompilerManifest(value: unknown): CompilerRuntimeManifest {
  const manifest = record(value, "runtime manifest");
  if (
    typeof manifest.artifactVersion !== "string"
    || !ARTIFACT_VERSION_PATTERN.test(manifest.artifactVersion)
    || !Array.isArray(manifest.archives)
  ) throw new Error("runtime manifest cannot configure the compiler");
  const archives = manifest.archives.map((candidate, index): RuntimeArchiveRecord => {
    const archive = record(candidate, `runtime archive ${index}`);
    if (typeof archive.key !== "string" || typeof archive.platform !== "string") {
      throw new Error(`runtime archive ${index} cannot configure the compiler`);
    }
    return {
      key: archive.key,
      platform: archive.platform,
      target: portablePath(archive.target, `runtime archive ${index} target`),
    };
  });
  return { artifactVersion: manifest.artifactVersion, archives };
}

function defaultSeaManifest(): unknown | null {
  const sea: unknown = process.getBuiltinModule?.("node:sea");
  if (
    !sea
    || typeof sea !== "object"
    || !("isSea" in sea)
    || typeof sea.isSea !== "function"
    || sea.isSea() !== true
    || !("getRawAsset" in sea)
    || typeof sea.getRawAsset !== "function"
  ) return null;
  return JSON.parse(new TextDecoder().decode(sea.getRawAsset(RUNTIME_MANIFEST_FILENAME)));
}

async function processRuntimeManifest(
  environment: NodeJS.ProcessEnv,
  readSeaManifest: () => unknown | null,
): Promise<unknown | null> {
  const embedded = readSeaManifest();
  if (embedded !== null) return embedded;
  const filesystemRoot = environment.VIDCOM_RUNTIME_ASSETS?.trim();
  if (!filesystemRoot) return null;
  return JSON.parse(await readFile(path.join(path.resolve(filesystemRoot), RUNTIME_MANIFEST_FILENAME), "utf8"));
}

/** Resolves the native esbuild executable shipped by the pinned HyperFrames dependency. */
export function resolveDevelopmentEsbuildBinary(
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
): string {
  const platformPackage = platform === "darwin" && architecture === "arm64"
    ? "@esbuild/darwin-arm64/bin/esbuild"
    : platform === "linux" && architecture === "x64"
      ? "@esbuild/linux-x64/bin/esbuild"
      : platform === "win32" && architecture === "x64"
        ? "@esbuild/win32-x64/esbuild.exe"
        : null;
  if (!platformPackage) throw new Error(`the compiler is unavailable on ${platform}-${architecture}`);
  const requireFromPreload = createRequire(import.meta.url);
  const corePackage = requireFromPreload.resolve("@hyperframes/core/package.json");
  const requireFromCore = createRequire(corePackage);
  const esbuildPackage = requireFromCore.resolve("esbuild/package.json");
  return createRequire(esbuildPackage).resolve(platformPackage);
}

/** Resolves the future extracted esbuild path directly from an embedded runtime manifest. */
export function resolveArtifactEsbuildBinary(input: {
  appDataRoot: string;
  manifest: unknown;
  platform?: NodeJS.Platform;
  architecture?: NodeJS.Architecture;
}): string {
  const platform = input.platform ?? process.platform;
  const architecture = input.architecture ?? process.arch;
  const manifest = parseCompilerManifest(input.manifest);
  const platformTag = `${platform}-${architecture}`;
  const archives = manifest.archives.filter((archive) => archive.key === "node" && archive.platform === platformTag);
  const archive = archives[0];
  if (!archive || archives.length !== 1) {
    throw new Error(`runtime manifest must contain one node archive for ${platformTag}`);
  }
  return path.join(
    path.resolve(input.appDataRoot),
    "native",
    manifest.artifactVersion,
    archive.target,
    "bin",
    platform === "win32" ? "esbuild.exe" : "esbuild",
  );
}

/**
 * Configures esbuild before the CLI imports its adapter barrel or HyperFrames.
 *
 * Artifact paths come from the embedded manifest even on a cold install, when
 * extraction has not created the binary yet. esbuild snapshots the path while
 * its JavaScript module is evaluated; the file itself only needs to exist by
 * the later compiler operation.
 */
export async function configureCompilerBeforeRuntime(options: CompilerPreloadOptions = {}): Promise<string> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const appDataRoot = await earlyAppDataRoot(options);
  if (!environment.VIDCOM_APP_DATA) {
    // The settings file is read before the runtime graph exists. Pin that same
    // authority so legacy command resolvers cannot reopen the platform default
    // after esbuild was configured for a different installation.
    environment.VIDCOM_APP_DATA = appDataRoot;
  }
  const manifest = await processRuntimeManifest(environment, options.readSeaManifest ?? defaultSeaManifest);
  const esbuildBinaryPath = manifest === null
    ? resolveDevelopmentEsbuildBinary(platform, architecture)
    : resolveArtifactEsbuildBinary({ appDataRoot, manifest, platform, architecture });
  const guard = new CompilerGuard({ esbuildBinaryPath, environment });
  guard.configure();
  return esbuildBinaryPath;
}
