"use client";

import * as React from "react";
import type { ProjectSummaryDto } from "@vidcom/contracts";

import { HomeHeader } from "@/components/home/home-header";
import { ProjectGrid } from "@/components/home/project-grid";
import { apiError, ensureBrowserSession } from "@/lib/api/browser-session";

export default function Home() {
  const [projects, setProjects] = React.useState<ProjectSummaryDto[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    void ensureBrowserSession()
      .then(() => fetch("/api/v1/projects"))
      .then(async (response) => {
        if (!response.ok) throw new Error(await apiError(response));
        const payload = await response.json() as { projects: ProjectSummaryDto[] };
        if (active) setProjects(payload.projects);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load projects.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  return (
    <div className="mx-auto w-full max-w-[1800px] p-6">
      <HomeHeader projectCount={projects.length} />
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      {loading ? <p className="text-muted-foreground text-sm">Loading projects…</p> : <ProjectGrid projects={projects} />}
      {!loading && !error && projects.length === 0 ? (
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
