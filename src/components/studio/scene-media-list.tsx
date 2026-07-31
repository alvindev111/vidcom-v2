import { FileAudioIcon, FilmIcon } from "lucide-react";

import { formatTimecode } from "@/lib/studio/format";
import type { SceneMedia } from "@/lib/studio/types";

export function SceneMediaList({ media }: { media: SceneMedia[] }) {
  if (media.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        No image, video or audio elements in this scene.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {media.map((item, index) => (
        <li
          key={`${item.src}-${index}`}
          className="bg-muted/40 flex items-center gap-3 rounded-md border p-2"
        >
          <span className="bg-background grid h-10 w-16 shrink-0 place-items-center overflow-hidden rounded border">
            {item.kind === "image" ? (
              // Project asset served by the files route; next/image would need a
              // loader config for a path it cannot know the dimensions of.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.url}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : item.kind === "video" ? (
              <FilmIcon className="text-muted-foreground size-4" />
            ) : (
              <FileAudioIcon className="text-muted-foreground size-4" />
            )}
          </span>

          <span className="min-w-0 grow">
            <span className="block truncate font-mono text-xs">{item.src}</span>
            <span className="text-muted-foreground block font-mono text-[10px]">
              {item.kind}
              {item.start != null
                ? ` · ${formatTimecode(item.start)}${
                    item.duration != null
                      ? ` → ${formatTimecode(item.start + item.duration)}`
                      : ""
                  }`
                : ""}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
