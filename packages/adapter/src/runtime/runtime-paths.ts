import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ErrorCode } from "@vidcom/contracts";

import { RuntimeAssetError } from "./runtime-asset-source";

/** Every filesystem location the render toolchain needs, resolved in one place. */
export interface RuntimePaths {
  /** Keeps artifact-only fail-closed behaviour explicit at downstream seams. */
  mode: "artifact" | "development";
  hyperframesCliPath: string;
  hyperframesPackagePath: string;
  motionLibraryRoot: string;
  nativeDependenciesRoot: string;
  browserCacheRoot: string;
  /**
   * Directory holding the shipped background-music audio.
   *
   * Always a path, never a required archive. The other locations decide whether
   * the product can render at all, so a missing one is a bootstrap error; missing
   * music only means the four shipped tracks report `available: false`, which the
   * BGM surface already models. Turning that into a failed boot would trade a
   * visible gap for a dead install.
   */
  bgmAssetRoot: string;
}

export const RUNTIME_PATH_NAMES = [
  "hyperframesCliPath",
  "hyperframesPackagePath",
  "motionLibraryRoot",
  "nativeDependenciesRoot",
  "browserCacheRoot",
  "bgmAssetRoot",
] as const;

export type RuntimePathName = (typeof RUNTIME_PATH_NAMES)[number];

export interface ArtifactRuntimePathsInput {
  mode: "artifact";
  /** The verified `<app-data>/native/<version>` root the manager published. */
  versionRoot: string;
  archiveRoots: Readonly<Record<string, string>>;
  appDataRoot: string;
}

export interface DevelopmentRuntimePathsInput {
  mode: "development";
  appDataRoot: string;
  /** Injectable so a test can prove the artifact path never reaches it. */
  resolve?: (specifier: string) => string;
}

export type RuntimePathsInput = ArtifactRuntimePathsInput | DevelopmentRuntimePathsInput;

const requireFromRuntime = createRequire(import.meta.url);

function missing(names: readonly RuntimePathName[]): never {
  throw new RuntimeAssetError(
    ErrorCode.RuntimeManifestInvalid,
    `packaged runtime paths are incomplete: ${names.join(", ")}`,
    { missing: [...names] },
  );
}

/**
 * Resolves every runtime path from one authority.
 *
 * Two modes, deliberately not one with fallbacks. In an artifact all five paths
 * come from the extracted runtime and **all five are required**: a missing one
 * is a coded error at bootstrap, not a render that fails halfway through with a
 * confusing message. `require.resolve` is unreachable on that path — there are
 * no `node_modules` inside a packaged binary, so reaching for it would be a
 * silent fallback to something that cannot exist.
 *
 * Development keeps resolving through `require.resolve`, which is what a source
 * checkout actually has.
 */
export function resolveRuntimePaths(input: RuntimePathsInput): RuntimePaths {
  if (input.mode === "artifact") return artifactPaths(input);
  return developmentPaths(input);
}

function artifactPaths(input: ArtifactRuntimePathsInput): RuntimePaths {
  const hyperframes = input.archiveRoots.hyperframes;
  const node = input.archiveRoots.node;
  const absent: RuntimePathName[] = [];
  if (!hyperframes) absent.push("hyperframesCliPath", "hyperframesPackagePath", "motionLibraryRoot");
  if (!node) absent.push("nativeDependenciesRoot");
  if (!input.appDataRoot) absent.push("browserCacheRoot");
  if (absent.length > 0) missing([...new Set(absent)]);

  const paths: RuntimePaths = {
    mode: "artifact",
    hyperframesCliPath: path.join(hyperframes!, "bin", "hyperframes.mjs"),
    hyperframesPackagePath: path.join(hyperframes!, "package.json"),
    motionLibraryRoot: path.join(hyperframes!, "motion-libraries"),
    nativeDependenciesRoot: node!,
    browserCacheRoot: path.join(input.appDataRoot, "browser-cache"),
    // Where the `bgm` archive extracts to, whether or not this build shipped it.
    bgmAssetRoot: input.archiveRoots.bgm ?? path.join(input.versionRoot, "bgm"),
  };
  assertComplete(paths);
  return paths;
}

function developmentPaths(input: DevelopmentRuntimePathsInput): RuntimePaths {
  const resolve = input.resolve
    ?? ((specifier: string) => requireFromRuntime.resolve(specifier));
  const paths: RuntimePaths = {
    mode: "development",
    hyperframesCliPath: resolve("hyperframes/bin/hyperframes.mjs"),
    hyperframesPackagePath: resolve("hyperframes/package.json"),
    motionLibraryRoot: path.join(input.appDataRoot, "motion-libraries"),
    nativeDependenciesRoot: path.join(input.appDataRoot, "native"),
    browserCacheRoot: path.join(input.appDataRoot, "browser-cache"),
    // Relative to this module rather than a resolved specifier: the audio is
    // committed inside this package, and adding a third `require.resolve` here
    // would widen what development mode depends on for no gain.
    bgmAssetRoot: path.join(fileURLToPath(new URL("../../assets/bgm", import.meta.url))),
  };
  assertComplete(paths);
  return paths;
}

/** Rejects an empty or relative path before it reaches a spawn or an import. */
export function assertComplete(paths: Partial<RuntimePaths>): asserts paths is RuntimePaths {
  if (paths.mode !== "artifact" && paths.mode !== "development") {
    throw new RuntimeAssetError(
      ErrorCode.RuntimeManifestInvalid,
      "runtime path mode is missing or invalid",
      { missing: ["mode"] },
    );
  }
  const absent = RUNTIME_PATH_NAMES.filter((name) => {
    const value = paths[name];
    return typeof value !== "string" || value.length === 0 || !path.isAbsolute(value);
  });
  if (absent.length > 0) missing(absent);
}
