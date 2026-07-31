import { cn } from "@/lib/utils";
import { posterFor } from "@/lib/studio/poster";

export function ProjectThumbnail({
  title,
  index,
}: {
  title: string;
  index: number;
}) {
  const poster = posterFor(index);

  return (
    <div
      className={cn(
        "flex aspect-video items-center justify-center overflow-hidden p-4 text-center",
        poster.className,
      )}
    >
      <span className={cn("max-w-full", poster.labelClassName)}>{title}</span>
    </div>
  );
}
