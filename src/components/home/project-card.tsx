import Link from "next/link";

import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/studio/poster";
import type { HyperframesProject } from "@/lib/hyperframes/projects.server";
import { ProjectThumbnail } from "./project-thumbnail";

export function ProjectCard({
  project,
  index,
}: {
  project: HyperframesProject;
  index: number;
}) {
  const href = `/projects/${project.slug}`;
  const duration = formatDuration(project.duration);

  return (
    <div className="bg-card hover:border-studio-accent/60 overflow-hidden rounded-lg border transition-colors">
      <Link href={href} className="block" aria-label={`Open ${project.title}`}>
        <ProjectThumbnail title={project.title} index={index} />
      </Link>

      <div className="flex items-center gap-2 border-t px-3 py-2.5">
        <Link href={href} className="min-w-0 grow">
          <span className="block truncate text-sm font-medium">
            {project.title}
          </span>
          <span className="text-muted-foreground block font-mono text-[11px]">
            {duration ? `${duration} · ` : ""}
            {project.width}×{project.height}
          </span>
        </Link>

        <Button
          asChild
          variant="outline"
          size="sm"
          className="text-studio-accent border-studio-accent/50 h-7 shrink-0 rounded-full px-3 text-xs"
        >
          <Link href={href}>Open</Link>
        </Button>
      </div>
    </div>
  );
}
