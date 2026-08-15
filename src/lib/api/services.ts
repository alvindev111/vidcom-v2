import { resolveApiBaseUrl, type ApiBaseUrlSource } from "./base-url";

export type ServiceMethod = "GET" | "POST" | "PUT" | "DELETE";
export type ApiPath = `/api/${string}`;

export type ApiRequestInit = Omit<RequestInit, "credentials"> & {
  source?: ApiBaseUrlSource;
};

/** Resolves one API path against the daemon selected at runtime. */
export function apiUrl(path: ApiPath, source?: ApiBaseUrlSource): string {
  return `${resolveApiBaseUrl(source)}${path}`;
}

/** Builds a credentialed request for a dynamic API path. */
export function apiRequest(
  path: ApiPath,
  init: ApiRequestInit = {},
): { url: string; init: RequestInit } {
  const { source, ...requestInit } = init;
  return {
    url: apiUrl(path, source),
    init: { ...requestInit, credentials: "include" },
  };
}

/** Executes a dynamic API request without letting callers omit the session. */
export function fetchApi(path: ApiPath, init: ApiRequestInit = {}): Promise<Response> {
  const request = apiRequest(path, init);
  return fetch(request.url, request.init);
}

/** Opens a reconnecting, cross-origin credentialed server-sent event stream. */
export function openApiEventSource(
  path: ApiPath,
  source?: ApiBaseUrlSource,
  EventSourceConstructor: typeof EventSource = EventSource,
): EventSource {
  return new EventSourceConstructor(apiUrl(path, source), { withCredentials: true });
}

export interface ServiceDefinition {
  method: ServiceMethod;
  /** Path under the API root, already including `v1`. */
  path: ApiPath;
}

/**
 * Every fixed HTTP call the UI makes, named `v1.<domain>.<action>`.
 *
 * One catalog rather than URLs scattered through components: a route that moves
 * is then one edit, and a route that no longer exists fails to resolve here
 * instead of at the moment a user clicks something. Parameterized routes use
 * `fetchApi`, which still owns runtime-base resolution and credentials.
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
  return apiUrl(SERVICE_CATALOG[id].path, source);
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
  return apiRequest(definition.path, {
    source: init.source,
    method: definition.method,
    ...init.body === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(init.body),
    },
    ...init.signal ? { signal: init.signal } : {},
  });
}

/**
 * Opens a server-sent event stream for one catalog entry.
 *
 * This request builder is for fetch-based consumers that need an abort signal
 * or Last-Event-ID header. Reconnecting browser consumers use
 * `openApiEventSource`, which explicitly opts into cross-origin credentials.
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

/** Structured HTTP failure kept intact for form and picker error states. */
export class ServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "ServiceError";
  }
}

/** Executes one catalog request and leaves response parsing to the caller. */
export function fetchService(
  id: ServiceId,
  init: ServiceRequestInit = {},
): Promise<Response> {
  const request = serviceRequest(id, init);
  return fetch(request.url, request.init);
}

/** Executes one catalog entry and parses its JSON response. */
export async function callService<Value>(
  id: ServiceId,
  init: ServiceRequestInit = {},
): Promise<Value> {
  const response = await fetchService(id, init);
  const payload = await response.json().catch(() => null) as {
    error?: { code?: string; message?: string };
  } | null;
  if (!response.ok) {
    throw new ServiceError(
      payload?.error?.code ?? "request_failed",
      payload?.error?.message ?? `Request failed (${response.status}).`,
      response.status,
    );
  }
  return payload as Value;
}
