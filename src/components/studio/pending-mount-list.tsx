"use client";

import { RotateCcwIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatTimecode } from "@/lib/studio/format";
import type { PendingMountItem } from "./use-mount-drop";

/**
 * Uploads that never made it onto the timeline (R11.3b).
 *
 * These survive the app being closed, so the list has to say what each one was
 * for — which file, where it was headed, and why it stopped — rather than
 * leaving an unexplained file in Media.
 */
export function PendingMountList({ items, onRetry, onDiscard }: {
  items: PendingMountItem[];
  onRetry(operationId: string): void;
  onDiscard(operationId: string): void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="border-t px-2 py-1.5" aria-label="Uploaded, not mounted">
      <p className="text-muted-foreground text-[10px] font-medium uppercase">Uploaded, not mounted</p>
      <ul className="mt-1 flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.operationId} className="flex items-center gap-1.5 text-[11px]">
            <span className="min-w-0 grow">
              <span className="block truncate font-medium">{item.assetPath}</span>
              <span className="text-muted-foreground block truncate">
                {formatTimecode(item.atSeconds)} · track {item.trackIndex + 1}
                {item.lastFailure ? ` · ${item.lastFailure.message}` : ""}
              </span>
            </span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label={`Try mounting ${item.assetPath} again`}
              onClick={() => onRetry(item.operationId)}
            >
              <RotateCcwIcon className="size-3" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label={`Discard the pending mount of ${item.assetPath}`}
              onClick={() => onDiscard(item.operationId)}
            >
              <XIcon className="size-3" />
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground mt-1 text-[10px]">
        Discarding leaves the file in Media; only the mount is dropped.
      </p>
    </section>
  );
}
