"use client";

import * as React from "react";

import {
  TimelineThumbnailLineSchema,
  type TimelineThumbnailLine,
} from "@vidcom/contracts";
import { apiUrl, fetchApi, type ApiPath } from "@/lib/api/services";
import {
  planTimelineThumbnailCells,
  type TimelineThumbnailViewport,
} from "@/lib/studio/timeline-thumbnail-layout";
import type { Scene } from "@/lib/studio/types";

const MAX_BATCH_MARKS = 256;

function chunks<Value>(values: readonly Value[]): Value[][] {
  const result: Value[][] = [];
  for (let index = 0; index < values.length; index += MAX_BATCH_MARKS) {
    result.push(values.slice(index, index + MAX_BATCH_MARKS));
  }
  return result;
}

export const TimelineThumbnailStrip = React.memo(function TimelineThumbnailStrip({
  projectId,
  scene,
  pixelsPerSecond,
  viewport,
}: {
  projectId: string;
  scene: Scene;
  pixelsPerSecond: number;
  viewport: TimelineThumbnailViewport;
}) {
  const cells = React.useMemo(() => planTimelineThumbnailCells({
    sceneStartSeconds: scene.start,
    durationSeconds: scene.duration,
    pixelsPerSecond,
    viewportStartPx: viewport.startPx,
    viewportWidthPx: viewport.widthPx,
  }), [pixelsPerSecond, scene.duration, scene.start, viewport.startPx, viewport.widthPx]);
  const signature = JSON.stringify(cells.map((cell) => cell.atSeconds));
  const [result, setResult] = React.useState<{
    signature: string;
    lines: ReadonlyMap<number, TimelineThumbnailLine>;
  }>({ signature: "", lines: new Map() });

  React.useEffect(() => {
    if (signature === "[]") return;
    const controller = new AbortController();
    const load = async () => {
      const lines = new Map<number, TimelineThumbnailLine>();
      const marks = JSON.parse(signature) as number[];
      for (const batch of chunks(marks)) {
        const response = await fetchApi(
          `/api/v1/projects/${encodeURIComponent(projectId)}/thumbnails`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sceneId: scene.id, atSeconds: batch, profile: "timeline-v1" }),
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error(`thumbnail request failed with ${response.status}`);
        for (const raw of (await response.text()).split("\n")) {
          if (!raw) continue;
          const line = TimelineThumbnailLineSchema.parse(JSON.parse(raw));
          lines.set(line.atSeconds, line);
        }
      }
      if (!controller.signal.aborted) setResult({ signature, lines });
    };
    void load().catch(() => {
      if (!controller.signal.aborted) setResult({ signature, lines: new Map() });
    });
    return () => controller.abort();
  }, [projectId, scene.id, signature]);

  const lines = result.signature === signature ? result.lines : new Map<number, TimelineThumbnailLine>();
  return (
    <span className="pointer-events-none absolute inset-0" aria-hidden="true">
      {cells.map((cell) => {
        const line = lines.get(cell.atSeconds);
        return line?.status === "ready" ? (
          // Immutable daemon-generated frames already match the exact rendered cell; image optimization adds no value.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={cell.index}
            alt=""
            src={apiUrl(line.url as ApiPath)}
            className="absolute inset-y-0 object-cover opacity-70"
            style={{ left: cell.leftPx, width: cell.widthPx }}
          />
        ) : (
          <span
            key={cell.index}
            title={line?.status === "placeholder" ? line.reason : "thumbnail loading"}
            className="bg-foreground/5 absolute inset-y-0 border-r border-white/10"
            style={{ left: cell.leftPx, width: cell.widthPx }}
          />
        );
      })}
    </span>
  );
});
