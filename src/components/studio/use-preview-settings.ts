"use client";

import * as React from "react";

import { fetchApi } from "@/lib/api/services";
import {
  mergePreviewSettings,
  sceneSettings,
  type PreviewSettings,
  type PreviewSettingsPatch,
  type SceneSettings,
} from "@/lib/studio/preview-settings";
import { mutationChangeSeq, type ProjectChanged } from "@/lib/studio/preview-reload";
import { useStudioSession } from "./studio-session-context";

/**
 * Owns the project's preview settings for the whole studio.
 *
 * It lives above both panes because both write to it — the preview editor sets
 * the look, and the timeline's per-lane eye toggles the same `hidden` flag the
 * scene detail does. Edits apply locally first so dragging a colour or a slider
 * never waits on a round trip, then the server's normalized copy wins.
 */
export function usePreviewSettings(
  projectId: string,
  initial: PreviewSettings,
  initialRevision: number,
  onSaved: ProjectChanged,
) {
  const studio = useStudioSession();
  const [settings, setSettings] = React.useState(initial);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const revision = React.useRef(initialRevision);
  const queue = React.useRef(Promise.resolve());
  const pendingCount = React.useRef(0);

  /**
   * The current settings, readable synchronously.
   *
   * Two edits can land in one React batch (drag a slider, tick a box), and the
   * second has to merge onto the first. A `setSettings(current => …)` updater
   * would see it, but the request has to be fired outside the updater — React
   * calls updaters twice under StrictMode, which sent every write to the server
   * twice.
   */
  const latest = React.useRef(settings);
  const apply = React.useCallback((next: PreviewSettings) => {
    latest.current = next;
    setSettings(next);
  }, []);

  // Re-seed when the server sends a fresh copy after a refresh.
  const [seeded, setSeeded] = React.useState(initial);
  if (seeded !== initial) {
    setSeeded(initial);
    setSettings(initial);
  }

  React.useEffect(() => {
    revision.current = initialRevision;
  }, [initial, initialRevision]);

  // Mirrors state rather than being written during render; `apply` keeps the two
  // in step synchronously for edits that arrive in the same batch.
  React.useEffect(() => {
    latest.current = settings;
  }, [settings]);

  const save = React.useCallback(
    async (request: () => Promise<Response>) => {
      pendingCount.current += 1;
      setPending(true);
      setError(null);
      const operation = queue.current.catch(() => {}).then(async () => {
       try {
        const response = await request();
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
          previewSettings?: PreviewSettings;
          revision?: number;
          changeSeq?: number | null;
        } | null;

        if (!response.ok) {
          setError(payload?.error?.message ?? `save failed (${response.status})`);
          return;
        }
        if (payload?.previewSettings) apply(payload.previewSettings);
        if (payload?.revision !== undefined) revision.current = payload.revision;
        // The preview document is built with these values baked in, so it has
        // to be rebuilt for the change to show.
        onSaved(mutationChangeSeq(payload));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "save failed");
      } finally {
        pendingCount.current -= 1;
        if (pendingCount.current === 0) setPending(false);
      }
      });
      queue.current = operation;
      await operation;
    },
    [apply, onSaved],
  );

  const patch = React.useCallback(
    (value: PreviewSettingsPatch) => {
      apply(mergePreviewSettings(latest.current, value));
      void save(() =>
        fetchApi(`/api/v1/projects/${encodeURIComponent(projectId)}/preview-settings`, studio.request({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ patch: value, expectedRevision: revision.current }),
        })),
      );
    },
    [apply, projectId, save, studio],
  );

  const patchScene = React.useCallback(
    (sceneId: string, value: Partial<SceneSettings>) => {
      const merged = {
        scenes: {
          [sceneId]: { ...sceneSettings(latest.current, sceneId), ...value },
        },
      };
      apply(mergePreviewSettings(latest.current, merged));
      void save(() =>
        fetchApi(`/api/v1/projects/${encodeURIComponent(projectId)}/preview-settings`, studio.request({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ patch: merged, expectedRevision: revision.current }),
        })),
      );
    },
    [apply, projectId, save, studio],
  );

  const uploadBgm = React.useCallback(
    (file: File) => {
      const body = new FormData();
      body.append("file", file);
      body.append("expectedRevision", String(revision.current));
      void save(() =>
        fetchApi(`/api/v1/projects/${encodeURIComponent(projectId)}/assets/bgm`, studio.request({
          method: "POST",
          body,
        })),
      );
    },
    [projectId, save, studio],
  );

  /**
   * The revision the next write must send.
   *
   * A getter rather than state: the value is authoritative in the ref that every
   * response updates, and re-rendering the studio because a precondition moved
   * would be a render for nobody to see.
   */
  const currentRevision = React.useCallback(() => revision.current, []);

  return { settings, pending, error, patch, patchScene, uploadBgm, currentRevision };
}
