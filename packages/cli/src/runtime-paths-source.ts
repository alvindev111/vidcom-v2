import { resolveRuntimePaths, type RuntimePaths } from "@vidcom/adapter";

/**
 * The one place every entrypoint gets its runtime paths.
 *
 * There are five modes that build a composition root, and this exists because
 * missing one of them is the easy mistake: the forgotten mode is usually the
 * least used, so the break shows up long after the change that caused it, in
 * the one place nobody was testing.
 *
 * A packaged build passes the verified version root the asset manager
 * published; a source checkout resolves from `node_modules`. Both come back
 * complete — every field or none — because a half-filled set is what produces
 * paths that look valid and point at nothing.
 */
export function runtimePathsFor(appDataRoot: string): RuntimePaths {
  return resolveRuntimePaths({ mode: "development", appDataRoot });
}
