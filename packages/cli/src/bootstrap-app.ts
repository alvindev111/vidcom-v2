import { Hono } from "hono";

import { servesBridgeRoutes, type FoundationState } from "./foundation-state";

/**
 * Route prefixes the daemon serves before any workspace is chosen.
 *
 * Deliberately short. Anything that reads or writes a workspace has no meaning
 * yet, and registering it so it can answer "not ready" is what made the old
 * failure ambiguous.
 */
export const BOOTSTRAP_ROUTE_PREFIXES = [
  "/v1/auth",
  "/v1/system",
  "/v1/health",
] as const;

/** Prefixes that exist only while a workspace is genuinely owned. */
export const WORKSPACE_ROUTE_PREFIXES = [
  "/api/bridge",
] as const;

/**
 * Builds the route surface for a given foundation state.
 *
 * The bridge routes are **absent** rather than refusing while no workspace is
 * owned. A route that answers 403 or 503 still tells a caller the daemon
 * believes it has a workspace, and that ambiguity is exactly what made the old
 * lease-loss bug hard to see: the route stayed registered, so the failure
 * looked like a permissions problem rather than a daemon that no longer owned
 * anything.
 *
 * Choosing a workspace from `cwd` is not done here either. Silently adopting
 * the directory a process happened to start in is how a render lands in the
 * wrong workspace with nothing to show for it.
 */
export function createRouteSurface(state: FoundationState): Hono {
  const app = new Hono();
  for (const prefix of BOOTSTRAP_ROUTE_PREFIXES) {
    app.get(prefix, (c) => c.json({ ok: true }));
    app.get(`${prefix}/*`, (c) => c.json({ ok: true }));
  }
  if (servesBridgeRoutes(state)) {
    for (const prefix of WORKSPACE_ROUTE_PREFIXES) {
      app.all(`${prefix}/*`, (c) => c.json({ ok: true }));
    }
  }
  return app;
}

/** Route prefixes a given state actually registers, for auditing the surface. */
export function registeredPrefixes(state: FoundationState): readonly string[] {
  return servesBridgeRoutes(state)
    ? [...BOOTSTRAP_ROUTE_PREFIXES, ...WORKSPACE_ROUTE_PREFIXES]
    : [...BOOTSTRAP_ROUTE_PREFIXES];
}
