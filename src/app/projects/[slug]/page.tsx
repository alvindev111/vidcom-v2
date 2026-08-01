"use client";

import * as React from "react";
import type { StudioSnapshotResponse } from "@vidcom/contracts";

import { StudioShell } from "@/components/studio/studio-shell";
import { apiError, ensureBrowserSession } from "@/lib/api/browser-session";
import type { PreviewSettings } from "@/lib/studio/preview-settings";
import type { RootTrack, Scene, SourceFile } from "@/lib/studio/types";

type ComposerParams = { params: Promise<{ slug: string }> };

function sourceFile(snapshot: StudioSnapshotResponse): SourceFile {
  const content = snapshot.entryFile.content;
  const lines = content.split("\n");
  const indent = (line: string) => line.length - line.trimStart().length;
  return {
    path: snapshot.entryFile.path,
    code: content,
    foldableLines: lines.reduce<number[]>((result, line, index) => {
      const next = lines[index + 1];
      if (line.trim() && next?.trim() && indent(next) > indent(line)) result.push(index + 1);
      return result;
    }, []),
    saved: true,
    version: snapshot.entryFile.contentHash,
  };
}

export default function ComposerPage({ params }: ComposerParams) {
  const { slug: projectId } = React.use(params);
  const [snapshot, setSnapshot] = React.useState<StudioSnapshotResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const loadSnapshot = React.useCallback(async () => {
    await ensureBrowserSession();
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/studio-snapshot`, { cache: "no-store" });
    if (!response.ok) throw new Error(await apiError(response));
    setSnapshot(await response.json() as StudioSnapshotResponse);
    setError(null);
  }, [projectId]);

  React.useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void loadSnapshot().catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not open the studio.");
      });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [loadSnapshot]);

  const activeProjectId = snapshot?.project.id;
  React.useEffect(() => {
    if (!activeProjectId) return;
    const events = new EventSource("/api/v1/events");
    let queued: ReturnType<typeof setTimeout> | null = null;
    const refresh = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as { projectId?: string };
        if (payload.projectId && payload.projectId !== activeProjectId) return;
      } catch { /* resync payloads are still a refresh signal */ }
      if (queued) clearTimeout(queued);
      queued = setTimeout(() => void loadSnapshot().catch(() => {}), 75);
    };
    for (const type of ["file.changed", "project.changed", "resync"]) events.addEventListener(type, refresh);
    return () => {
      if (queued) clearTimeout(queued);
      events.close();
    };
  }, [activeProjectId, loadSnapshot]);

  if (error) return <div className="text-destructive p-6 text-sm">{error}</div>;
  if (!snapshot) return <div className="text-muted-foreground p-6 text-sm">Loading studio…</div>;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <StudioShell
        projectId={snapshot.project.id}
        projectSlug={snapshot.project.slug}
        previewUrl={`/api/v1/projects/${snapshot.project.id}/preview`}
        aspectRatio={snapshot.project.width / snapshot.project.height}
        authoredDuration={snapshot.project.duration}
        tree={snapshot.tree}
        files={[sourceFile(snapshot)]}
        scenes={snapshot.scenes as Scene[]}
        rootTrack={snapshot.rootTrack as RootTrack | null}
        previewSettings={snapshot.previewSettings as PreviewSettings}
        previewSettingsRevision={snapshot.previewSettingsRevision}
        onRefresh={loadSnapshot}
      />
    </div>
  );
}
