"use client";

import * as React from "react";
import { ImageOffIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";

import type { ApiRequestInit } from "@/lib/api/services";
import {
  acquireStoryboardThumbnail,
  forgetStoryboardThumbnailFailure,
  peekStoryboardThumbnail,
  type StoryboardThumbnailRequest,
  type StoryboardThumbnailResult,
} from "@/lib/studio/storyboard-thumbnail";

export function StoryboardThumbnail({
  request,
  requestInit,
}: {
  request: StoryboardThumbnailRequest;
  requestInit: ApiRequestInit;
}) {
  const hostRef = React.useRef<HTMLSpanElement>(null);
  const generation = React.useRef(0);
  const [visible, setVisible] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  const [result, setResult] = React.useState<StoryboardThumbnailResult | null>(() =>
    peekStoryboardThumbnail(request));

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (typeof IntersectionObserver === "undefined") {
      let cancelled = false;
      queueMicrotask(() => { if (!cancelled) setVisible(true); });
      return () => { cancelled = true; };
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      {
        root: host.closest('[data-slot="scroll-area-viewport"]'),
        rootMargin: "100% 0px",
      },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    const currentGeneration = ++generation.current;
    queueMicrotask(() => {
      if (generation.current !== currentGeneration) return;
      const cached = peekStoryboardThumbnail(request);
      setResult((current) => cached ?? (current?.status === "ready" ? current : null));
    });
  }, [request]);

  React.useEffect(() => {
    if (!visible) return;
    const currentGeneration = ++generation.current;
    const acquired = acquireStoryboardThumbnail(request, requestInit);
    queueMicrotask(() => {
      if (generation.current === currentGeneration) {
        setResult((current) => peekStoryboardThumbnail(request) ?? (current?.status === "ready" ? current : null));
      }
    });
    void acquired.promise.then((next) => {
      if (generation.current === currentGeneration) setResult(next);
    }).catch((cause: unknown) => {
      if (generation.current === currentGeneration && !(cause instanceof DOMException && cause.name === "AbortError")) {
        setResult({ status: "failed", reason: cause instanceof Error ? cause.message : "thumbnail failed" });
      }
    });
    return () => {
      generation.current += 1;
      acquired.release();
    };
  }, [request, requestInit, retry, visible]);

  const state = result?.status ?? (visible ? "loading" : "idle");
  return (
    <span ref={hostRef} data-storyboard-thumbnail-state={state} className="pointer-events-none absolute inset-0 z-20">
      {result?.status === "ready" ? (
        // Immutable daemon-generated frames already match this compact card.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={result.src}
          alt={`Thumbnail for ${request.sceneId}`}
          className="h-full w-full object-cover"
        />
      ) : result?.status === "failed" ? (
        <span className="text-muted-foreground absolute inset-0 grid place-items-center gap-1 bg-black/80 p-2 text-center text-[10px]">
          <ImageOffIcon className="size-4" />
          <span className="max-w-full truncate" title={result.reason}>{result.reason}</span>
          <button
            type="button"
            aria-label={`Retry thumbnail for ${request.sceneId}`}
            onClick={(event) => {
              event.stopPropagation();
              forgetStoryboardThumbnailFailure(request);
              setResult(null);
              setRetry((value) => value + 1);
            }}
            className="pointer-events-auto relative z-20 inline-flex min-h-6 items-center gap-1 rounded border border-white/20 bg-white/10 px-1.5 py-0.5 text-white hover:bg-white/20"
          >
            <RefreshCwIcon className="size-3" /> Retry
          </button>
        </span>
      ) : (
        <span className="text-muted-foreground absolute inset-0 grid place-items-center bg-foreground/5">
          <LoaderCircleIcon className={visible ? "size-4 animate-spin" : "size-4 opacity-40"} />
          <span className="sr-only">{visible ? "Loading thumbnail" : "Thumbnail queued"}</span>
        </span>
      )}
    </span>
  );
}
