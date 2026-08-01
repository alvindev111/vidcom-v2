---
name: http-driver
description: >
  Guide for using @alvin0/http-driver — a fully typed per-service HTTP client
  for Axios and Fetch with SSE/NDJSON streaming, GraphQL, WebSocket,
  retry, caching, deduplication, middleware, and observability. Use when the
  developer asks about http-driver, building API clients, configuring services,
  streaming (SSE, NDJSON), GraphQL queries, WebSocket connections, upload/download
  progress, retry/cache/timeout, middleware, token refresh, or React/Vue hooks.
---

# @alvin0/http-driver

Fully typed, per-service HTTP client wrapping Axios and Fetch with a unified `ResponseFormat<T>`.

## When to Use

Activate this skill when the user:
- Asks how to set up or configure `@alvin0/http-driver`
- Needs to define services, build a driver, or make API calls
- Wants to add retry, caching, timeout, middleware, or observability
- Is implementing token refresh with request queuing
- Wants SSE streaming, NDJSON streaming, or real-time data
- Needs GraphQL query/mutation support
- Wants upload/download progress tracking
- Needs WebSocket with auto-reconnect
- Wants to integrate with React (SWR, TanStack Query, custom hooks) or Vue
- Asks about versioned API URLs, multipart uploads, or AbortController

## Core Architecture

```
ServiceApi[] → DriverBuilder → Driver (HttpDriverInstance & AxiosInstance)
                                 ├── execService<T>()           (Axios path)
                                 ├── execServiceByFetch<T>()     (Fetch path)
                                 ├── execServiceByStream()       (SSE streaming)
                                 ├── execServiceByNDJSON<T>()    (NDJSON streaming)
                                 └── getInfoURL()                (URL compilation)

Standalone utilities:
  createGraphQLClient()          — GraphQL query/mutation helper
  fetchWithDownloadProgress()    — Download progress tracking
  createUploadProgressBody()     — Upload progress tracking
  createWebSocketClient()        — WebSocket with auto-reconnect
  parseNDJSONStream()            — Raw NDJSON parser
```

Every call returns `ResponseFormat<T>`:
```ts
interface ResponseFormat<T = unknown> {
  ok: boolean;           // true if status 200-299
  status: number;
  data: T;
  problem: string | null;
  originalError: string | null;
  headers?: Headers | Record<string, string> | null;
  duration: number;      // ms
}
```

## Step-by-Step Setup

### 1. Define Services

```ts
import { MethodAPI, type ServiceApi } from "@alvin0/http-driver";

const services: ServiceApi[] = [
  { id: "users.list", url: "users", method: MethodAPI.get },
  { id: "users.detail", url: "users/{id}", method: MethodAPI.get },
  { id: "users.create", url: "users", method: MethodAPI.post },
];
```

`ServiceApi` fields:
- `id` (string) — unique identifier
- `url` (string) — supports `{param}` placeholders
- `method` (MethodAPI) — get, post, put, patch, delete, head, link, unlink
- `version?` — for URL version injection
- `timeout?` (number) — per-service timeout in ms
- `retry?` (RetryConfig) — per-service retry, overrides global
- `options?` — default request options

### 2. Build a Driver

```ts
import { DriverBuilder } from "@alvin0/http-driver";

const api = new DriverBuilder()
  .withBaseURL("https://api.example.com")
  .withServices(services)
  .build();
```

`build()` requires both `baseURL` and at least one service.

### 3. Make Requests

```ts
// Axios path
const res = await api.execService<User[]>({ id: "users.list" });

// Fetch path
const res = await api.execServiceByFetch<User>(
  { id: "users.detail", params: { id: "1" } }
);

// GET payload → query string automatically
await api.execService({ id: "users.list" }, { page: 1, limit: 10 });
// → GET /users?page=1&limit=10

// POST payload → request body
await api.execService({ id: "users.create" }, { name: "John", email: "j@x.com" });
```

## Builder Methods

### Resilience
```ts
.withRetry({ maxAttempts: 3, delay: 1000, backoff: "exponential", retryOn: [408, 429, 500, 502, 503, 504] })
.withCache({ enabled: true, ttl: 30000, getOnly: true })
.withTimeout(5000)  // global timeout in ms
```

- Retry: per-service `retry` in ServiceApi overrides global
- Cache: only caches successful (`ok: true`) GET responses. Max 1000 entries with LRU eviction and automatic periodic cleanup of expired entries
- Timeout: uses `AbortSignal.timeout()` when available (Node 17.3+, modern browsers), falls back to `AbortController` + `setTimeout` with `unref()`. Skipped if `signal` already set
- Bodyless requests (GET, HEAD, DELETE) are automatically deduplicated — concurrent same-URL calls share one in-flight request

### Middleware (onion model)
```ts
import type { MiddlewareFn } from "@alvin0/http-driver";

const logger: MiddlewareFn = async (ctx, next) => {
  console.log(`→ ${ctx.method} ${ctx.url}`);
  await next();
  console.log(`← ${ctx.response?.status}`);
};

builder.use(logger);
```

Middleware can short-circuit by not calling `next()`. Calling `next()` multiple times is safe — the core function only executes once.

### Observability
```ts
builder
  .onRequest(({ url, method, serviceId, timestamp }) => { /* log */ })
  .onResponse(({ serviceId, status, duration, ok }) => { /* metrics */ });
```

### Versioning (disabled by default)
```ts
// Simple
builder.enableVersioning().withGlobalVersion(1);
// → /v1/users

// Custom template (auto-enables)
builder.withVersionTemplate("{baseURL}/api/{version}/{endpoint}");
// → /api/v1/users

// Full config
builder.withVersionConfig({
  enabled: true,
  position: "prefix",  // "after-base" | "before-endpoint" | "prefix" | "custom"
  prefix: "v",
  defaultVersion: 1,
});
// → https://v1.api.example.com/users
```

Position strategies:
- `after-base` (default): `baseURL/v1/endpoint`
- `before-endpoint`: `baseURL/v1/endpoint` (version inserted between base and endpoint)
- `prefix`: `v1.baseURL/endpoint` (version as subdomain)
- `custom`: uses `template` with `{baseURL}`, `{version}`, `{endpoint}` placeholders

Service-level `version` overrides global.

### Axios Transforms
```ts
// Sync
builder.withAddRequestTransformAxios((req) => { req.headers = { ...req.headers, "X-App": "demo" }; });
builder.withAddResponseTransformAxios((resp) => { /* ApiResponseLike shape */ });

// Async (registrar pattern)
builder.withAddAsyncRequestTransformAxios((register) => {
  register(async (req) => { req.headers.Authorization = `Bearer ${await getToken()}`; });
});
builder.withAddAsyncResponseTransformAxios((register) => {
  register(async (res) => { /* async work */ });
});
```

### Fetch Transforms
```ts
builder.withAddRequestTransformFetch((url, opts) => ({
  url: url + "?via=fetch",
  requestOptions: { ...opts, headers: { ...opts.headers, "X-Fetch": "1" } },
}));
builder.withAddTransformResponseFetch((response) => ({
  ...response, data: { wrapped: true, original: response.data },
}));
```

### Token Refresh Interceptor
```ts
builder.withHandleInterceptorErrorAxios(
  (axiosInstance, processQueue, isRefreshing, addToQueue) => async (error) => {
    if (error?.response?.status === 401 && !isRefreshing.value) {
      isRefreshing.value = true;
      try {
        const { data } = await axiosInstance.post("/auth/refresh");
        processQueue(null, data.token);       // resolve all queued
        return axiosInstance.request(error.config);
      } catch (refreshError) {
        processQueue(refreshError, null);      // reject all queued
        return Promise.reject(refreshError);
      } finally {
        isRefreshing.value = false;
      }
    }
    if (isRefreshing.value) {
      return new Promise((resolve, reject) => {
        addToQueue(
          (token) => { error.config.headers.Authorization = `Bearer ${token}`; resolve(axiosInstance.request(error.config)); },
          reject
        );
      });
    }
    return Promise.reject(error);
  }
);
```

Key: `isRefreshing` is `{ value: boolean }` (by reference). `addToQueue` pushes to internal queue. `processQueue` resolves/rejects all at once.

## SSE Streaming
```ts
// Service: { id: "chat.stream", url: "api/chat", method: MethodAPI.post }
const result = await api.execServiceByStream(
  { id: "chat.stream" },
  { prompt: "hello", stream: true }
);

if (result.ok) {
  for await (const event of result.stream) {
    // event: { event: "message", data: "...", id: "", retry?: number }
    console.log(event.data);
  }
}
result.abort(); // stop anytime
```
Returns `StreamResponseFormat` with `stream: AsyncGenerator<SSEEvent>`, `abort()`, `ok`, `status`, `headers`.
Auto-sets `Accept: text/event-stream`. Supports POST (JSON body) and GET.

## NDJSON Streaming
```ts
// Service: { id: "logs.stream", url: "api/logs", method: MethodAPI.get }
const result = await api.execServiceByNDJSON<LogEntry>({ id: "logs.stream" });

for await (const entry of result.stream) {
  console.log(entry.timestamp, entry.message); // typed LogEntry
}
```
Returns `NDJSONStreamResponseFormat<T>` with `stream: AsyncGenerator<T>`, `abort()`.
Auto-sets `Accept: application/x-ndjson`. Skips malformed lines.

## GraphQL
```ts
import { createGraphQLClient } from "@alvin0/http-driver";

// Service: { id: "graphql", url: "graphql", method: MethodAPI.post }
const gql = createGraphQLClient(api, "graphql");

const result = await gql.query<{ users: User[] }>(
  `query($limit: Int) { users(limit: $limit) { id name } }`,
  { limit: 10 }
);
// result.data.data.users

const mutation = await gql.mutation<{ createUser: User }>(
  `mutation($input: CreateUserInput!) { createUser(input: $input) { id } }`,
  { input: { name: "John" } }
);

// Use Fetch instead of Axios
const gqlFetch = createGraphQLClient(api, "graphql", { useFetch: true });
```
Wrapper over `execService`/`execServiceByFetch`. Auto-formats `{ query, variables }` payload.

## Upload & Download Progress
```ts
import { fetchWithDownloadProgress, createUploadProgressBody } from "@alvin0/http-driver";

// Download
const res = await fetch(url);
const buffer = await fetchWithDownloadProgress(res, ({ loaded, total, percent }) => {
  console.log(`${percent}%`); // -1 if total unknown
});

// Upload
const { body } = createUploadProgressBody(jsonString, (info) => console.log(info.percent));
await fetch(url, { method: "POST", body });
```
Standalone utilities. Work with any fetch call. `percent` is -1 when Content-Length unknown.

## WebSocket
```ts
import { createWebSocketClient } from "@alvin0/http-driver";

const ws = createWebSocketClient({
  url: "wss://api.example.com/ws",
  autoReconnect: true,
  maxReconnectAttempts: 5,
  reconnectDelay: 1000,
  reconnectBackoff: "exponential",
});

ws.onOpen(() => console.log("Connected"));
ws.onMessage<ChatMessage>((msg) => console.log(msg.data));
ws.onError((err) => console.error(err));
ws.onClose(() => console.log("Disconnected"));

ws.send({ type: "subscribe", channel: "updates" }); // auto JSON.stringify
ws.close();
ws.reconnect();
console.log(ws.state); // "connecting" | "open" | "closing" | "closed"
```
Auto-reconnect with exponential backoff. JSON auto-parse on receive, auto-stringify on send.

## React / Vue Integration

### SWR
```ts
export function useUser(id: string) {
  return useSWR(
    id ? ["users.detail", id] : null,
    () => api.execService<User>({ id: "users.detail", params: { id } })
      .then(res => { if (!res.ok) throw res; return res.data; })
  );
}
```

### TanStack Query
```ts
export function useUsers() {
  return useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const res = await api.execService<User[]>({ id: "users.list" });
      if (!res.ok) throw res;
      return res.data;
    },
  });
}
```

### Custom React Hook
```ts
export function useService<T>(idService: { id: string; params?: Record<string, string | number> } | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ResponseFormat | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!idService) return;
    let cancelled = false;
    setLoading(true);
    api.execService<T>(idService).then(res => {
      if (cancelled) return;
      res.ok ? (setData(res.data), setError(null)) : (setError(res), setData(null));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [idService?.id, JSON.stringify(idService?.params)]);

  return { data, error, loading };
}
```

## AbortController
```ts
const controller = new AbortController();
const promise = api.execService({ id: "users.list" }, undefined, { signal: controller.signal });
controller.abort();
// → { ok: false, status: 408, problem: "timeout" }
```

## Multipart Upload
```ts
// Set Content-Type to multipart/form-data — library removes header so browser sets boundary
// Nested objects use bracket notation: parent[child], arrays: items[0]
await api.execServiceByFetch(
  { id: "upload" }, { file: myFile, meta: { tag: "doc" } },
  { headers: { "Content-Type": "multipart/form-data" } }
);
// FormData keys: file, meta[tag]
```

## Service ID Convention
Use enum with namespaced pattern `v{version}.{domain}.{resource}.{action}`:
```ts
export enum UserServiceIds {
  List = "v1.users.list",
  Detail = "v1.users.detail",
  Create = "v1.users.create",
}
```

## Common Mistakes

1. Forgetting `enableVersioning()` — version in ServiceApi is ignored by default
2. Not checking `res.ok` — the library never throws on HTTP errors, always returns ResponseFormat
3. Using `any` for generics — use `execService<User>()` for type safety
4. Setting `Content-Type: multipart/form-data` manually on Axios path — Axios handles it automatically with FormData
5. Not passing `params` for URL placeholders — `{id}` in URL requires `params: { id: "123" }`
6. Forgetting to iterate `result.stream` — SSE/NDJSON streams must be consumed with `for await...of`
7. Not calling `result.abort()` when done with streams — prevents resource leaks
8. Using `execServiceByStream` for NDJSON — use `execServiceByNDJSON` instead (different parser)
9. Using special characters in URL params without awareness — params are automatically `encodeURIComponent`-encoded
10. Not calling `cache.destroy()` when disposing a long-lived driver — the periodic cleanup timer keeps running

## Validation

The setup is correct when:
- `build()` does not throw
- `execService` / `execServiceByFetch` returns `ResponseFormat` with `ok: true` for successful calls
- URL placeholders are replaced correctly (check with `getInfoURL`)
- Retry fires on configured status codes (check with `onResponse` hook)
- Cache returns same response object on second identical GET call
- `execServiceByStream` yields `SSEEvent` objects with `event`, `data`, `id` fields
- `execServiceByNDJSON` yields typed objects matching the generic parameter
- `createGraphQLClient` sends `{ query, variables }` as POST body
- WebSocket `onMessage` receives parsed JSON objects


## Important Notes

1. `build()` requires both `baseURL` and at least one service, otherwise throws.
2. Bodyless requests (GET, HEAD, DELETE) automatically dedup concurrent calls to the same URL.
3. Cache only stores successful (`ok: true`) responses. Max 1000 entries with LRU eviction.
4. Retry does NOT retry on 4xx (except 408, 429) by default.
5. Per-service `timeout` and `retry` override global config.
6. Version injection is DISABLED by default — must call `enableVersioning()`.
7. The built driver is also a full `AxiosInstance` — `api.get()`, `api.post()` etc. work directly.
8. `execServiceByStream` returns `AsyncGenerator<SSEEvent>` — iterate with `for await...of`.
9. `execServiceByNDJSON` returns `AsyncGenerator<T>` — each yield is one parsed JSON line.
10. `createGraphQLClient` wraps the driver's `execService`/`execServiceByFetch` — not a separate connection.
11. `createWebSocketClient` is standalone — does NOT go through the driver.
12. Progress utilities are standalone — work with any `fetch` call.
13. URL params (`{id}`) are automatically encoded with `encodeURIComponent` — safe for special characters.
14. FormData uses bracket notation (`parent[child]`, `items[0]`) compatible with Express, Django, Rails, Spring.
15. 204 No Content and 304 Not Modified responses return `data: null` instead of throwing parse errors.
16. Middleware `next()` is safe to call multiple times — the core function only executes once.
