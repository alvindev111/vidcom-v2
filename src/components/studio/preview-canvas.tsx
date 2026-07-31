"use client";

import type * as React from "react";

/**
 * Letterboxes the real player to the composition's aspect ratio. The player
 * element is appended into the inner div by useHyperframesPlayer, which is why
 * that div has no React children of its own — overlays are siblings so React
 * never reconciles around an imperatively mounted node.
 */
export function PreviewCanvas({
  containerRef,
  aspectRatio,
  ready,
  error,
}: {
  containerRef: React.Ref<HTMLDivElement>;
  aspectRatio: number;
  ready: boolean;
  error: string | null;
}) {
  return (
    <div
      className="grid min-h-0 flex-1 place-items-center bg-black/85 p-2"
      // A size container lets the frame below letterbox itself with cq units:
      // width tracks the shorter axis, so the aspect ratio is never violated.
      style={{ containerType: "size" }}
    >
      <div
        className="relative overflow-hidden bg-black"
        style={{
          aspectRatio,
          width: `min(100cqw, ${100 * aspectRatio}cqh)`,
        }}
      >
        <div ref={containerRef} className="absolute inset-0" />

        {!ready && !error ? (
          <span className="pointer-events-none absolute inset-0 z-10 grid place-items-center font-mono text-xs text-neutral-400">
            loading composition…
          </span>
        ) : null}
        {error ? (
          <span className="absolute inset-0 z-10 grid place-items-center px-6 text-center font-mono text-xs text-red-400">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}
