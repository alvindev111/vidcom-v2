import type { ProjectSummaryDto } from "@vidcom/contracts";
import { NewProjectCard } from "./new-project-card";
import { ProjectCard } from "./project-card";

export function ProjectGrid({
  projects,
}: {
  projects: ProjectSummaryDto[];
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      <NewProjectCard />
      {projects.map((project, index) => (
        <ProjectCard key={project.slug} project={project} index={index} />
      ))}
    </div>
  );
}
