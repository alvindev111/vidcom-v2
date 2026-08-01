"use client";

import * as React from "react";

import {
  mergePreviewSettings,
  sceneSettings,
  type PreviewSettings,
  type PreviewSettingsPatch,
  type SceneSettings,
} from "@/lib/studio/preview-settings";

/**
 * Owns the project's preview settings for the whole studio.
 *
 * It lives above both panes because both write to it — the preview editor sets
 * the look, and the timeline's per-lane eye toggles the same `hidden` flag the
 * scene detail does. Edits apply locally first so dragging a colour or a slider
 * never waits on a round trip, then the server's normalized copy wins.
 */
export function usePreviewSettings(
  projectSlug: string,
  initial: PreviewSettings,
  onSaved: () => void,
) {
  const [settings, setSettings] = React.useState(initial);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

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

  // Mirrors state rather than being written during render; `apply` keeps the two
  // in step synchronously for edits that arrive in the same batch.
  React.useEffect(() => {
    latest.current = settings;
  }, [settings]);

  const save = React.useCallback(
    async (request: () => Promise<Response>) => {
      setPending(true);
      setError(null);
      try {
        const response = await request();
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
          settings?: PreviewSettings;
        } | null;

        if (!response.ok) {
          setError(payload?.error ?? `save failed (${response.status})`);
          return;
        }
        if (payload?.settings) apply(payload.settings);
        // The preview document is built with these values baked in, so it has
        // to be rebuilt for the change to show.
        onSaved();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "save failed");
      } finally {
        setPending(false);
      }
    },
    [apply, onSaved],
  );

  const patch = React.useCallback(
    (value: PreviewSettingsPatch) => {
      apply(mergePreviewSettings(latest.current, value));
      void save(() =>
        fetch(`/api/hf/${projectSlug}/preview-settings`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(value),
        }),
      );
    },
    [apply, projectSlug, save],
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
        fetch(`/api/hf/${projectSlug}/preview-settings`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(merged),
        }),
      );
    },
    [apply, projectSlug, save],
  );

  const uploadBgm = React.useCallback(
    (file: File) => {
      const body = new FormData();
      body.append("file", file);
      void save(() =>
        fetch(`/api/hf/${projectSlug}/preview-settings`, { method: "POST", body }),
      );
    },
    [projectSlug, save],
  );

  return { settings, pending, error, patch, patchScene, uploadBgm };
}
