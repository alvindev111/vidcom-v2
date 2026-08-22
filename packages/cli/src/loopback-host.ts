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
const PREVIEW_STATIC_PATHS = new Set(["/preview-host.html", "/preview-host.js"]);
const PREVIEW_HOST_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "frame-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

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
      const url = new URL(request.url);
      const isApi = url.pathname.startsWith(API_PREFIX);
      if (url.hostname === "preview.localhost" && !isApi && !PREVIEW_STATIC_PATHS.has(url.pathname)) {
        return new Response("preview host path is not allowed", { status: 403 });
      }
      const target = isApi ? api : staticHost;
      const response = await target(request);
      if (url.hostname !== "preview.localhost" || !PREVIEW_STATIC_PATHS.has(url.pathname)) return response;
      const headers = new Headers(response.headers);
      // The host and bridge script form one versioned protocol but keep stable
      // public names. Revalidation is not enough after a daemon upgrade: a
      // browser may pair a cached v1 script with a v2 editor and reject every
      // message before the preview document can load.
      headers.set("Cache-Control", "no-store");
      if (url.pathname === "/preview-host.html") {
        headers.set("Content-Security-Policy", PREVIEW_HOST_CSP);
        headers.set("Referrer-Policy", "no-referrer");
      }
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
    swapApi(target: FetchTarget): void {
      api = target;
    },
    swapStatic(target: FetchTarget): void {
      staticHost = target;
    },
  };
}
