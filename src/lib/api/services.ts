import { resolveApiBaseUrl, type ApiBaseUrlSource } from "./base-url";

export type ServiceMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface ServiceDefinition {
  method: ServiceMethod;
  /** Path under the API root, already including `v1`. */
  path: string;
}

/**
 * Every HTTP call the UI makes, named `v1.<domain>.<action>`.
 *
 * One catalog rather than URLs scattered through components: a route that moves
 * is then one edit, and a route that no longer exists fails to resolve here
 * instead of at the moment a user clicks something.
 *
 * The paths already contain `v1`, so nothing may prepend a version. Automatic
 * version injection on top of these produces `/api/v1/v1/...`, which 404s in a
 * way that looks like a missing route rather than a doubled prefix.
 */
export const SERVICE_CATALOG = {
  "v1.system.roots": { method: "GET", path: "/api/v1/system/filesystem/roots" },
  "v1.system.entries": { method: "POST", path: "/api/v1/system/filesystem/entries" },
  "v1.system.createDirectory": { method: "POST", path: "/api/v1/system/directories" },
  "v1.system.workspace": { method: "GET", path: "/api/v1/system/workspace" },
  "v1.system.runtime": { method: "GET", path: "/api/v1/system/runtime" },
  "v1.workspace.activate": { method: "PUT", path: "/api/v1/workspace/active" },
  "v1.projects.list": { method: "GET", path: "/api/v1/projects" },
  "v1.projects.create": { method: "POST", path: "/api/v1/projects" },
  "v1.auth.exchange": { method: "POST", path: "/api/v1/auth/exchange" },
  "v1.health": { method: "GET", path: "/api/v1/health" },
  "v1.events.stream": { method: "GET", path: "/api/v1/events" },
} as const satisfies Record<string, ServiceDefinition>;

export type ServiceId = keyof typeof SERVICE_CATALOG;

export function serviceUrl(id: ServiceId, source?: ApiBaseUrlSource): string {
  return `${resolveApiBaseUrl(source)}${SERVICE_CATALOG[id].path}`;
}

export interface ServiceRequestInit {
  body?: unknown;
  signal?: AbortSignal;
  source?: ApiBaseUrlSource;
}

/**
 * Builds the arguments for one catalog call.
 *
 * Returns a url and an init rather than a `Request`, because a same-origin base
 * is the empty string and `new Request("/api/...")` throws in Node while
 * working in a browser. Building the object here would make every call site
 * untestable outside a browser, and the natural way to "fix" that is to add a
 * DOM environment nobody approved.
 *
 * `credentials: "include"` on every call: the session is a cookie, and a
 * request that omits it is answered as anonymous — which reads as a permissions
 * bug rather than a missing header.
 */
export function serviceRequest(
  id: ServiceId,
  init: ServiceRequestInit = {},
): { url: string; init: RequestInit } {
  const definition = SERVICE_CATALOG[id];
  return {
    url: serviceUrl(id, init.source),
    init: {
      method: definition.method,
      credentials: "include",
      ...init.body === undefined ? {} : {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(init.body),
      },
      ...init.signal ? { signal: init.signal } : {},
    },
  };
}

/**
 * Opens a server-sent event stream for one catalog entry.
 *
 * `fetch` rather than `EventSource`: `EventSource` cannot send credentials
 * cross-origin and cannot be aborted, and both matter here — the session is a
 * cookie, and a stream that outlives the component holding it keeps the
 * connection and the server-side subscription alive after the user has moved
 * on.
 */
export function serviceStream(
  id: ServiceId,
  init: ServiceRequestInit & { lastEventId?: string } = {},
): { url: string; init: RequestInit } {
  const base = serviceRequest(id, init);
  return {
    url: base.url,
    init: {
      ...base.init,
      headers: {
        ...base.init.headers as Record<string, string> | undefined,
        Accept: "text/event-stream",
        ...init.lastEventId ? { "Last-Event-ID": init.lastEventId } : {},
      },
    },
  };
}
