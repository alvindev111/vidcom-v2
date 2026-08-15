"use client";

import * as React from "react";
import type { ProjectSummaryDto } from "@vidcom/contracts";

import { HomeHeader } from "@/components/home/home-header";
import { ProjectGrid } from "@/components/home/project-grid";
import { WorkspacePicker, type WorkspacePickerApi } from "@/components/workspace/workspace-picker";
import { apiError, ensureBrowserSession } from "@/lib/api/browser-session";
import { callService, serviceRequest } from "@/lib/api/services";

interface BrowseRoot { displayPath: string; token: string }
interface BrowseEntry { name: string; isDirectory: boolean; token?: string }

const workspacePickerApi: WorkspacePickerApi = {
  async roots() {
    const result = await callService<{ roots: BrowseRoot[] }>("v1.system.roots");
    return result.roots.map((root) => ({ label: root.displayPath, token: root.token }));
  },
  async list(token, cursor) {
    const page = await callService<{ entries: BrowseEntry[]; cursor?: string }>("v1.system.entries", {
      body: { token, ...(cursor === undefined ? {} : { cursor }) },
    });
    return {
      entries: page.entries,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    };
  },
  createDirectory(parentToken, name) {
    return callService<BrowseEntry>("v1.system.createDirectory", { body: { parentToken, name } });
  },
  async activate(selectionToken) {
    await callService("v1.workspace.activate", { body: { selectionToken } });
    window.location.reload();
  },
};

export default function Home() {
  const [projects, setProjects] = React.useState<ProjectSummaryDto[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [needsWorkspace, setNeedsWorkspace] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    void ensureBrowserSession()
      .then(() => callService<{ workspaceRoot: string | null }>("v1.system.workspace"))
      .then((workspace) => {
        if (workspace.workspaceRoot === null) {
          if (active) setNeedsWorkspace(true);
          return null;
        }
        const request = serviceRequest("v1.projects.list");
        return fetch(request.url, request.init);
      })
      .then(async (response) => {
        if (response === null) return;
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

  if (!loading && needsWorkspace) return <WorkspacePicker api={workspacePickerApi} />;

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
