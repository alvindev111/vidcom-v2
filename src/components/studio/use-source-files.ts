"use client";

import * as React from "react";

import { fetchApi } from "@/lib/api/services";
import type { SourceFile } from "@/lib/studio/types";
import { useStudioSession } from "./studio-session-context";

export interface OpenFile {
  /** The file as last read from disk. */
  file: SourceFile;
  /** Editor contents; differs from `file.code` while there are unsaved edits. */
  draft: string;
  saving: boolean;
  error: string | null;
}

/**
 * The editor's open files.
 *
 * Only `index.html` arrives with the page; every other file is fetched when it
 * is first opened, so the project's whole tree is browsable without shipping it
 * all up front. Saving is explicit — the agent is the main author of these
 * files, so a manual edit should land only when the user asks for it.
 */
export function useSourceFiles(projectId: string, _projectSlug: string, seed: SourceFile[]) {
  const studio = useStudioSession();
  const [open, setOpen] = React.useState<Record<string, OpenFile>>(() =>
    Object.fromEntries(
      seed.map((file) => [
        file.path,
        { file, draft: file.code, saving: false, error: null },
      ]),
    ),
  );
  const [order, setOrder] = React.useState<string[]>(() =>
    seed.map((file) => file.path),
  );
  const [activePath, setActivePath] = React.useState(seed[0]?.path ?? "");
  const [loading, setLoading] = React.useState<string | null>(null);
  const [openError, setOpenError] = React.useState<string | null>(null);

  const openPath = React.useCallback(
    async (path: string) => {
      setOpenError(null);
      setActivePath(path);
      setOrder((current) =>
        current.includes(path) ? current : [...current, path],
      );

      // Already loaded: keep the draft, including unsaved edits.
      if (open[path]) return;

      setLoading(path);
      try {
        const response = await fetchApi(
          `/api/v1/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(path)}`,
        );
        const payload = (await response.json().catch(() => null)) as {
          file?: { path: string; content: string; contentHash: string };
          error?: { message?: string };
        } | null;

        if (!response.ok || !payload?.file) {
          setOpenError(payload?.error?.message ?? `could not open ${path}`);
          setOrder((current) => current.filter((item) => item !== path));
          return;
        }

        const file: SourceFile = {
          path: payload.file.path,
          code: payload.file.content,
          foldableLines: [],
          saved: true,
          version: payload.file.contentHash,
        };
        setOpen((current) => ({
          ...current,
          [path]: { file, draft: file.code, saving: false, error: null },
        }));
      } catch (cause) {
        setOpenError(cause instanceof Error ? cause.message : "could not open file");
        setOrder((current) => current.filter((item) => item !== path));
      } finally {
        setLoading(null);
      }
    },
    [open, projectId],
  );

  const close = React.useCallback((path: string) => {
    setOrder((current) => {
      const next = current.filter((item) => item !== path);
      setActivePath((active) =>
        active === path ? (next[next.length - 1] ?? "") : active,
      );
      return next;
    });
    // The draft is dropped with the tab — reopening reads the file fresh.
    setOpen((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
  }, []);

  const edit = React.useCallback((path: string, draft: string) => {
    setOpen((current) => {
      const entry = current[path];
      if (!entry) return current;
      return { ...current, [path]: { ...entry, draft, error: null } };
    });
  }, []);

  const save = React.useCallback(
    async (path: string, onSaved?: () => void) => {
      const entry = open[path];
      if (!entry || entry.draft === entry.file.code) return;

      setOpen((current) => {
        const item = current[path];
        return item
          ? { ...current, [path]: { ...item, saving: true, error: null } }
          : current;
      });

      try {
        const response = await fetchApi(`/api/v1/projects/${encodeURIComponent(projectId)}/files`, studio.request({
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path,
            content: entry.draft,
            expectedContentHash: entry.file.version,
          }),
        }));
        const payload = (await response.json().catch(() => null)) as {
          file?: { path: string; content: string; contentHash: string };
          error?: { message?: string };
        } | null;

        if (!response.ok || !payload?.file) {
          setOpen((current) => {
            const item = current[path];
            return item
              ? {
                  ...current,
                  [path]: {
                    ...item,
                    saving: false,
                    error: payload?.error?.message ?? `save failed (${response.status})`,
                  },
                }
              : current;
          });
          return;
        }

        // `file.code` is what is now on disk; the draft matches it, so the tab
        // goes clean.
        const saved: SourceFile = {
          path: payload.file.path,
          code: payload.file.content,
          foldableLines: entry.file.foldableLines,
          saved: true,
          version: payload.file.contentHash,
        };
        setOpen((current) => ({
          ...current,
          [path]: { file: saved, draft: saved.code, saving: false, error: null },
        }));
        onSaved?.();
      } catch (cause) {
        setOpen((current) => {
          const item = current[path];
          return item
            ? {
                ...current,
                [path]: {
                  ...item,
                  saving: false,
                  error: cause instanceof Error ? cause.message : "save failed",
                },
              }
            : current;
        });
      }
    },
    [open, projectId, studio],
  );

  /** Discard unsaved edits and go back to what is on disk. */
  const revert = React.useCallback(
    (path: string) =>
      setOpen((current) => {
        const entry = current[path];
        return entry
          ? {
              ...current,
              [path]: { ...entry, draft: entry.file.code, error: null },
            }
          : current;
      }),
    [],
  );

  const files = order.map((path) => open[path]).filter(Boolean);
  const active = open[activePath] ?? null;
  const dirtyPaths = files
    .filter((entry) => entry.draft !== entry.file.code)
    .map((entry) => entry.file.path);

  return {
    files,
    active,
    activePath,
    dirtyPaths,
    loading,
    openError,
    openPath,
    close,
    edit,
    save,
    revert,
  };
}
