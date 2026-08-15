import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const SEA_DIRECTORY = path.join(REPOSITORY_ROOT, "dist", "sea");
export const PRIMARY_BUNDLE_PATH = path.join(SEA_DIRECTORY, "bootstrap.cjs");
export const SECONDARY_BUNDLE_PATH = path.join(SEA_DIRECTORY, "secondary", "boot.cjs");
export const SEA_MAIN_LOADER_PATH = path.join(
  REPOSITORY_ROOT,
  "packages",
  "cli",
  "src",
  "sea-main-loader.cjs",
);

export function runtimeInputPath(platformTag) {
  return path.join(REPOSITORY_ROOT, "dist", "runtime-inputs", `${platformTag}.json`);
}

export function runtimeStageRoot(platformTag) {
  return path.join(REPOSITORY_ROOT, "dist", "runtime-stage", platformTag);
}

export function runtimeConfigPath(platformTag) {
  return path.join(runtimeStageRoot(platformTag), ".build", "runtime-config.json");
}

export function runtimeAssetRoot(platformTag) {
  return path.join(REPOSITORY_ROOT, "dist", "runtime-assets", platformTag);
}

export function runtimeManifestPath(platformTag) {
  return path.join(runtimeAssetRoot(platformTag), "runtime-manifest.json");
}

export function runtimeArchivePath(platformTag, archiveKey) {
  return path.join(runtimeAssetRoot(platformTag), "runtime-archives", `${archiveKey}.tar.gz`);
}
