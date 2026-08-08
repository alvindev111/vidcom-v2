export type FetchTarget = (request: Request) => Response | Promise<Response>;

export interface RequestRouter {
  /** Serves one request against whatever target is current at this moment. */
  handle(request: Request): Promise<Response>;
  /** Replaces the API target. Synchronous, so no request can straddle the swap. */
  swapApi(target: FetchTarget): void;
  /** Replaces the static target, used when the packaged asset host is rebuilt. */
  swapStatic(target: FetchTarget): void;
}

const API_PREFIX = "/api/";

/**
 * Routes every request by reading the current targets, never by capturing them.
 *
 * Switching workspaces has to keep the port open and the browser session alive,
 * so the listener outlives the foundation behind it. If the listener closed over
 * a target, a switch would need a new listener, which means a new port and a
 * dead session — the thing this exists to avoid.
 *
 * The swap is a plain assignment. It cannot interleave with a request: JavaScript
 * runs it to completion, so every request sees either the old target or the new
 * one and never a half-applied pair.
 */
export function createRequestRouter(initial: {
  api: FetchTarget;
  static: FetchTarget;
}): RequestRouter {
  let api = initial.api;
  let staticHost = initial.static;

  return {
    async handle(request: Request): Promise<Response> {
      // Read at call time, not at construction: that is what makes the swap
      // visible to the very next request.
      const target = new URL(request.url).pathname.startsWith(API_PREFIX) ? api : staticHost;
      return target(request);
    },
    swapApi(target: FetchTarget): void {
      api = target;
    },
    swapStatic(target: FetchTarget): void {
      staticHost = target;
    },
  };
}
