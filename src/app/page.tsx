import { HomeHeader } from "@/components/home/home-header";
import { ProjectGrid } from "@/components/home/project-grid";
import { listProjects } from "@/lib/hyperframes/projects.server";

// The project list is whatever is on disk under projects/, so read it per request.
export const dynamic = "force-dynamic";

export default function Home() {
  const projects = listProjects();

  return (
    <div className="mx-auto w-full max-w-[1800px] p-6">
      <HomeHeader projectCount={projects.length} />
      <ProjectGrid projects={projects} />
      {projects.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No projects yet — scaffold one with{" "}
          <code className="font-mono">
            bunx hyperframes init projects/&lt;name&gt; --example blank
          </code>
          .
        </p>
      ) : null}
    </div>
  );
}
