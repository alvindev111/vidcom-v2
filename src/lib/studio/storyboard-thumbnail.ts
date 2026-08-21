import {
  TimelineThumbnailLineSchema,
  representativeSceneTime,
  type TimelineThumbnailLine,
} from "@vidcom/contracts";

import { apiUrl, fetchApi, type ApiPath, type ApiRequestInit } from "@/lib/api/services";

const READY_CACHE_LIMIT = 512;

export interface StoryboardThumbnailRequest {
  projectId: string;
  projectRevision: number;
  sceneId: string;
  duration: number;
  frameRate: number;
}

export interface ReadyStoryboardThumbnail {
  status: "ready";
  src: string;
}

export interface FailedStoryboardThumbnail {
  status: "failed";
  reason: string;
}

export type StoryboardThumbnailResult = ReadyStoryboardThumbnail | FailedStoryboardThumbnail;

interface PendingRequest {
  controller: AbortController;
  consumers: number;
  promise: Promise<StoryboardThumbnailResult>;
}

const readyCache = new Map<string, ReadyStoryboardThumbnail>();
const failureCache = new Map<string, FailedStoryboardThumbnail>();
const pendingRequests = new Map<string, PendingRequest>();

export function storyboardThumbnailKey(input: StoryboardThumbnailRequest): string {
  const atSeconds = representativeSceneTime(input.duration, input.frameRate);
  return [
    input.projectId,
    input.projectRevision,
    input.sceneId,
    input.duration,
    input.frameRate,
    atSeconds,
  ].join(":");
}

function cacheReady(key: string, value: ReadyStoryboardThumbnail): void {
  failureCache.delete(key);
  readyCache.delete(key);
  readyCache.set(key, value);
  while (readyCache.size > READY_CACHE_LIMIT) {
    const oldest = readyCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    readyCache.delete(oldest);
  }
}

function cacheFailure(key: string, value: FailedStoryboardThumbnail): void {
  failureCache.delete(key);
  failureCache.set(key, value);
  while (failureCache.size > READY_CACHE_LIMIT) {
    const oldest = failureCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    failureCache.delete(oldest);
  }
}

async function requestThumbnail(
  input: StoryboardThumbnailRequest,
  requestInit: ApiRequestInit,
  signal: AbortSignal,
): Promise<StoryboardThumbnailResult> {
  const atSeconds = representativeSceneTime(input.duration, input.frameRate);
  const response = await fetchApi(
    `/api/v1/projects/${encodeURIComponent(input.projectId)}/thumbnails`,
    {
      ...requestInit,
      method: "POST",
      headers: { ...requestInit.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ sceneId: input.sceneId, atSeconds: [atSeconds], profile: "timeline-v1" }),
      signal,
    },
  );
  if (!response.ok) return { status: "failed", reason: `HTTP ${response.status}` };

  const rawLine = (await response.text()).split("\n").find(Boolean);
  if (!rawLine) return { status: "failed", reason: "empty response" };
  const line: TimelineThumbnailLine = TimelineThumbnailLineSchema.parse(JSON.parse(rawLine));
  return line.status === "ready"
    ? { status: "ready", src: apiUrl(line.url as ApiPath) }
    : { status: "failed", reason: line.reason };
}

export function acquireStoryboardThumbnail(
  input: StoryboardThumbnailRequest,
  requestInit: ApiRequestInit,
): { promise: Promise<StoryboardThumbnailResult>; release: () => void } {
  const key = storyboardThumbnailKey(input);
  const cached = readyCache.get(key);
  if (cached) {
    readyCache.delete(key);
    readyCache.set(key, cached);
    return { promise: Promise.resolve(cached), release: () => undefined };
  }
  const failed = failureCache.get(key);
  if (failed) return { promise: Promise.resolve(failed), release: () => undefined };

  let pending = pendingRequests.get(key);
  if (!pending) {
    const controller = new AbortController();
    pending = {
      controller,
      consumers: 0,
      promise: Promise.resolve({ status: "failed", reason: "not started" }),
    };
    pending.promise = requestThumbnail(input, requestInit, controller.signal)
      .then((result) => {
        if (result.status === "ready") cacheReady(key, result);
        else cacheFailure(key, result);
        return result;
      })
      .finally(() => {
        if (pendingRequests.get(key) === pending) pendingRequests.delete(key);
      });
    pendingRequests.set(key, pending);
  }
  pending.consumers += 1;
  let released = false;
  return {
    promise: pending.promise,
    release: () => {
      if (released) return;
      released = true;
      pending!.consumers -= 1;
      if (pending!.consumers === 0 && pendingRequests.get(key) === pending) {
        pending!.controller.abort(new DOMException("thumbnail left the viewport", "AbortError"));
      }
    },
  };
}

export function peekStoryboardThumbnail(
  input: StoryboardThumbnailRequest,
): StoryboardThumbnailResult | null {
  const key = storyboardThumbnailKey(input);
  return readyCache.get(key) ?? failureCache.get(key) ?? null;
}

export function forgetStoryboardThumbnailFailure(input: StoryboardThumbnailRequest): void {
  failureCache.delete(storyboardThumbnailKey(input));
}

export function resetStoryboardThumbnailCache(): void {
  for (const pending of pendingRequests.values()) pending.controller.abort();
  pendingRequests.clear();
  readyCache.clear();
  failureCache.clear();
}
