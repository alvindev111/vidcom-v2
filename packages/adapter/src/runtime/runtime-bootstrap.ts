/**
 * Narrow runtime surface bundled into the primary SEA bootstrap.
 *
 * Keep this entry point free of the adapter barrel: importing that barrel
 * evaluates the application/runtime graph before the extracted compiler and
 * native dependency roots have been configured.
 */
export { RuntimeAssetManager } from "./runtime-asset-manager";
export {
  PACKAGED_RUNTIME_MIGRATION_ENTRIES,
  validatePackagedRuntimeManifest,
  type ValidatedPackagedRuntimeManifest,
} from "./packaged-runtime-manifest";
export {
  parseEmbeddedRuntimeManifest,
  resolveRuntimeArchives,
  RuntimeAssetError,
  SeaRuntimeAssetSource,
  type EmbeddedArchive,
  type EmbeddedRuntimeEntry,
  type EmbeddedRuntimeManifest,
  type RuntimeAssetSource,
} from "./runtime-asset-source";
export { ErrorCode } from "@vidcom/contracts";
