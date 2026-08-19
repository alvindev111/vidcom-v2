"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import type { StudioSnapshotResponse } from "@vidcom/contracts";

import { StudioShell } from "@/components/studio/studio-shell";
import { StudioSessionProvider } from "@/components/studio/studio-session-context";
import { apiError, ensureBrowserSession } from "@/lib/api/browser-session";
import { apiUrl, fetchApi } from "@/lib/api/services";
import { createUlid } from "@/lib/studio/ids";
import type { PreviewSettings } from "@/lib/studio/preview-settings";
import {
  consumeStudioEvents,
  historyPath,
  isStudioResync,
  latestStudioChangeSeq,
  studioEventChangeSeq,
  studioEventPath,
  studioEventPaths,
  studioRequestInit,
  type StudioEvent,
  type StudioSourceEvent,
} from "@/lib/studio/studio-session";
import { installUnloadGuard } from "@/lib/studio/unsaved-guard";
import type { RootTrack, Scene, SourceFile } from "@/lib/studio/types";

import { SHELL_SENTINEL } from "./shell-sentinel";

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

async function requireOk(response: Response): Promise<void> {
  if (!response.ok) throw new Error(await apiError(response));
}

function MountedStudio({
  snapshot,
  loadSnapshot,
}: {
  snapshot: StudioSnapshotResponse;
  loadSnapshot: () => Promise<void>;
}) {
  const studioSessionId = React.useRef(createUlid());
  const projectId = snapshot.project.id;
  const [attached, setAttached] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [eventRevision, setEventRevision] = React.useState(0);
  const [externalChangeSeq, setExternalChangeSeq] = React.useState<number | null>(null);
  const [shellGeneration, setShellGeneration] = React.useState(0);
  const [sourceEvent, setSourceEvent] = React.useState<StudioSourceEvent | null>(null);
  const [resyncSeq, setResyncSeq] = React.useState(0);

  // Closing the browser is one of the three ways a draft can be lost, and the
  // only one the app cannot intercept itself.
  React.useEffect(() => installUnloadGuard(), []);

  const studioInit = React.useCallback(
    (init = {}) => studioRequestInit(studioSessionId.current, init),
    [],
  );
  const sessionRequest = React.useCallback(
    (method: "POST" | "DELETE", keepalive = false) => fetchApi(
      historyPath(projectId, "session"),
      studioInit({ method, keepalive }),
    ),
    [projectId, studioInit],
  );

  React.useEffect(() => {
    let active = true;
    const detach = () => void sessionRequest("DELETE", true).catch(() => undefined);
    const pagehide = () => detach();
    window.addEventListener("pagehide", pagehide);
    void sessionRequest("POST")
      .then(requireOk)
      .then(() => {
        if (active) setAttached(true);
        else detach();
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not attach studio history.");
      });
    return () => {
      active = false;
      window.removeEventListener("pagehide", pagehide);
      detach();
    };
  }, [sessionRequest]);

  React.useEffect(() => {
    if (!attached) return;
    const controller = new AbortController();
    let queued: ReturnType<typeof setTimeout> | null = null;
    let queuedChangeSeq: number | null = null;
    let lastEventId: string | undefined;
    const refresh = (event: StudioEvent) => {
      try {
        const payload = JSON.parse(event.data) as { projectId?: string };
        if (payload.projectId && payload.projectId !== projectId) return;
      } catch { /* resync remains a refresh signal */ }
      // Drafts resolve per event, not per debounce window: a coalesced refresh
      // would hide which files actually moved.
      if (isStudioResync(event)) {
        const seq = Number(event.id);
        setResyncSeq((current) => Math.max(current, Number.isSafeInteger(seq) ? seq : current + 1));
      } else {
        const touched = studioEventPaths(event, projectId);
        if (touched) setSourceEvent((current) => current && current.seq >= touched.seq ? current : touched);
      }
      queuedChangeSeq = latestStudioChangeSeq(queuedChangeSeq, event, projectId);
      // The newest durable event this tab has actually received, stamped where
      // it can be observed: it is the start of the "outside write to visible
      // frame" window the budget is measured over.
      const received = studioEventChangeSeq(event, projectId);
      if (received !== null) document.documentElement.dataset.studioEventSeq = String(received);
      if (queued) clearTimeout(queued);
      queued = setTimeout(() => {
        if (queuedChangeSeq !== null) {
          const latest = queuedChangeSeq;
          queuedChangeSeq = null;
          setExternalChangeSeq((current) => current === null ? latest : Math.max(current, latest));
        }
        setEventRevision((current) => current + 1);
        void loadSnapshot().catch(() => undefined);
      }, 75);
    };
    const reconnect = async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetchApi(
            studioEventPath(projectId),
            studioInit({
              signal: controller.signal,
              headers: {
                Accept: "text/event-stream",
                ...(lastEventId === undefined ? {} : { "Last-Event-ID": lastEventId }),
              },
            }),
          );
          await requireOk(response);
          const consumed = await consumeStudioEvents(response, (event) => {
            if (event.id !== null) lastEventId = event.id;
            refresh(event);
          });
          if (consumed !== null) lastEventId = consumed;
        } catch {
          if (controller.signal.aborted) return;
        }
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, 250);
          controller.signal.addEventListener("abort", () => {
            window.clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    };
    void reconnect();
    return () => {
      controller.abort();
      if (queued) clearTimeout(queued);
    };
  }, [attached, loadSnapshot, projectId, studioInit]);

  const resetHistory = React.useCallback(async (reloadSource: boolean) => {
    setAttached(false);
    await requireOk(await sessionRequest("DELETE"));
    await requireOk(await sessionRequest("POST"));
    if (reloadSource) {
      await loadSnapshot();
      setShellGeneration((current) => current + 1);
    }
    setEventRevision((current) => current + 1);
    setAttached(true);
  }, [loadSnapshot, sessionRequest]);

  if (error) return <div className="text-destructive p-6 text-sm">{error}</div>;
  if (!attached) return <div className="text-muted-foreground p-6 text-sm">Attaching studio history…</div>;

  return (
    <StudioSessionProvider
      eventRevision={eventRevision}
      sourceEvent={sourceEvent}
      resyncSeq={resyncSeq}
      request={studioInit}
      resetHistory={resetHistory}
    >
      <StudioShell
        key={shellGeneration}
        projectId={snapshot.project.id}
        projectSlug={snapshot.project.slug}
        previewUrl={apiUrl(`/api/v1/projects/${encodeURIComponent(snapshot.project.id)}/preview`)}
        aspectRatio={snapshot.project.width / snapshot.project.height}
        authoredDuration={snapshot.project.duration}
        frameRate={snapshot.frameRate}
        tree={snapshot.tree}
        files={[sourceFile(snapshot)]}
        scenes={snapshot.scenes as Scene[]}
        rootTrack={snapshot.rootTrack as RootTrack | null}
        previewSettings={snapshot.previewSettings as PreviewSettings}
        previewSettingsRevision={snapshot.previewSettingsRevision}
        projectRevision={snapshot.project.revision}
        externalChangeSeq={externalChangeSeq}
        onRefresh={loadSnapshot}
      />
    </StudioSessionProvider>
  );
}

/**
 * Reads the slug from the address bar, not from `params`.
 *
 * A static export renders one file for this route, so Next has no per-slug
 * params to hand in — the sentinel below is the only value it ever sees. The
 * real slug is in the URL the browser is on, which is the one source that is
 * correct for every project.
 */
export function projectSlugFromPath(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)\/?$/u.exec(pathname);
  if (!match?.[1]) return null;
  const slug = decodeURIComponent(match[1]);
  return slug === SHELL_SENTINEL ? null : slug;
}

export default function ComposerClient() {
  // `usePathname`, not a one-shot read of `window.location`: the router updates
  // the address bar as part of the transition, so a value captured while this
  // component first mounts is still the page the user came *from*. Opening a
  // project from the list is a client navigation, and reading once left
  // `projectId` null there — nothing to fetch, no error, "Loading studio…"
  // forever. Reloading appeared to fix it only because a fresh load already has
  // the right URL before anything mounts.
  const projectId = projectSlugFromPath(usePathname());
  const [snapshot, setSnapshot] = React.useState<StudioSnapshotResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const loadSnapshot = React.useCallback(async () => {
    // The prerendered shell carries the sentinel rather than a project, so
    // there is genuinely nothing to fetch. Returning is not a failure state.
    if (!projectId) return;
    await ensureBrowserSession();
    const response = await fetchApi(
      `/api/v1/projects/${encodeURIComponent(projectId)}/studio-snapshot`,
      { cache: "no-store" },
    );
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

  if (error) return <div className="text-destructive p-6 text-sm">{error}</div>;
  if (!snapshot) return <div className="text-muted-foreground p-6 text-sm">Loading studio…</div>;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <MountedStudio key={snapshot.project.id} snapshot={snapshot} loadSnapshot={loadSnapshot} />
    </div>
  );
}
