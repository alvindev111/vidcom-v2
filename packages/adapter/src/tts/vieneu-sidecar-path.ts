import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Sidecar assets sit one directory per sidecar, both in the repo and after extraction. */
const SIDECAR_DIRECTORY = "vieneu";
const WORKER_SCRIPT = "worker.py";

/**
 * Directory holding the VieNeu sidecar's `worker.py`, preferring a packaged
 * build's extracted copy over the source checkout.
 *
 * The extraction root wins when it actually contains the worker, not merely
 * when it was supplied: production entry points always pass a root, but in a
 * source checkout that directory does not exist yet, and resolving to it
 * unconditionally reported the sidecar as missing during development.
 *
 * The checkout fallback is correct only where `packages/adapter/sidecars` is on
 * disk. A Node SEA binary has no such directory, which is why the packaging
 * step must extract the sidecar and name the root — see
 * `defaultNativeDependenciesRoot`.
 *
 * Touches the filesystem (one `existsSync`).
 */
export function vieneuSidecarRoot(extractionRoot?: string): string {
  // Joined from this module's own directory rather than written as
  // `new URL("../../sidecars/…", import.meta.url)`: Turbopack resolves that form
  // statically at build time and fails the Next production build, because the
  // target is a runtime asset directory and not a module it can bundle.
  const checkout = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "sidecars", SIDECAR_DIRECTORY);
  if (!extractionRoot) return checkout;
  const extracted = join(extractionRoot, SIDECAR_DIRECTORY);
  return existsSync(join(extracted, WORKER_SCRIPT)) ? extracted : checkout;
}

/** Default sidecar invocation: the ambient interpreter running the shipped worker. */
export function defaultVieNeuCommand(extractionRoot?: string): readonly string[] {
  return [
    process.platform === "win32" ? "python" : "python3",
    join(vieneuSidecarRoot(extractionRoot), WORKER_SCRIPT),
  ];
}
