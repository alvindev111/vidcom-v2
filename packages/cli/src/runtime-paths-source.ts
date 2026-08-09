import path from "node:path";

import {
  ErrorCode,
} from "@vidcom/contracts";
import {
  FilesystemRuntimeAssetSource,
  migrateDatabase,
  RuntimeAssetError,
  SeaRuntimeAssetSource,
  resolveRuntimePaths,
  type RuntimeAssetSource,
  type RuntimePaths,
} from "@vidcom/adapter";

import { BootstrapCoordinator, type PreparedRuntime } from "./bootstrap-coordinator";
import { reconcileBridgeCredential } from "./bridge-credential";

interface SeaModule {
  isSea(): boolean;
  getRawAsset(key: string): ArrayBuffer;
}

function seaModule(): SeaModule | null {
  const seaApi = process.getBuiltinModule?.("node:sea") as SeaModule | undefined;
  return seaApi?.isSea() === true ? seaApi : null;
}

/** Chooses embedded assets in an artifact and an explicit filesystem source in development. */
export function runtimeAssetSourceForProcess(): RuntimeAssetSource | null {
  const sea = seaModule();
  if (sea) return new SeaRuntimeAssetSource((key) => sea.getRawAsset(key));
  const filesystemRoot = process.env.VIDCOM_RUNTIME_ASSETS?.trim();
  if (filesystemRoot) return new FilesystemRuntimeAssetSource(path.resolve(filesystemRoot));
  return null;
}

/** Runs the one bootstrap authority used by app, serve, MCP and recovery. */
export function prepareRuntimeForCli(
  appDataRoot: string,
  options: {
    repair?: boolean;
    assetSource?: RuntimeAssetSource | null;
    migrate?: typeof migrateDatabase;
  } = {},
): Promise<PreparedRuntime> {
  return new BootstrapCoordinator({
    reconcileCredential: ({ appDataRoot: root, database }) =>
      reconcileBridgeCredential({ appDataRoot: root, database }).then(() => undefined),
    ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
  }).prepare({
    appDataRoot,
    assetSource: options.assetSource === undefined
      ? runtimeAssetSourceForProcess()
      : options.assetSource,
    ...(options.repair === undefined ? {} : { repair: options.repair }),
  });
}

/**
 * The one place every entrypoint gets its runtime paths.
 *
 * Several modes build a composition root, and this exists because
 * missing one of them is the easy mistake: the forgotten mode is usually the
 * least used, so the break shows up long after the change that caused it, in
 * the one place nobody was testing.
 *
 * A packaged build passes the verified version root the asset manager
 * published; a source checkout resolves from `node_modules`. Both come back
 * complete — every field or none — because a half-filled set is what produces
 * paths that look valid and point at nothing.
 */
export function runtimePathsFor(
  appDataRoot: string,
  prepared?: Pick<PreparedRuntime, "versionRoot" | "archiveRoots">,
): RuntimePaths {
  if (prepared?.versionRoot) {
    return resolveRuntimePaths({
      mode: "artifact",
      appDataRoot,
      versionRoot: prepared.versionRoot,
      archiveRoots: prepared.archiveRoots,
    });
  }
  if (seaModule()) {
    throw new RuntimeAssetError(
      ErrorCode.RuntimeManifestInvalid,
      "the packaged runtime was not prepared before resolving runtime paths",
    );
  }
  return resolveRuntimePaths({ mode: "development", appDataRoot });
}
