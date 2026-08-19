"use client";

import * as React from "react";

import { fetchApi } from "@/lib/api/services";
import {
  conflicts,
  reduceDraft,
  saveDisabled,
  savePrecondition,
  type DraftEntry,
  type DraftState,
} from "@/lib/studio/draft-store";
import { mutationChangeSeq, type ProjectChanged } from "@/lib/studio/preview-reload";
import type { SourceFile } from "@/lib/studio/types";
import { confirmDiscard, reportUnsaved } from "@/lib/studio/unsaved-guard";
import { useStudioSession } from "./studio-session-context";

export interface OpenFile {
  /** The file as last read from disk. */
  file: SourceFile;
  /** Editor contents; differs from `file.code` while there are unsaved edits. */
  draft: string;
  saving: boolean;
  error: string | null;
  /** Set while something changed underneath this draft (R8.1d). */
  conflict: {
    status: DraftEntry["incomingStatus"];
    resolution: DraftEntry["resolution"];
    /** The other version, once it has been read back; `null` = deleted outside. */
    incoming: string | null;
    saveDisabled: boolean;
  } | null;
}

interface FileMeta {
  code: string;
  foldableLines: number[];
}

/**
 * The editor's open files.
 *
 * Only `index.html` arrives with the page; every other file is fetched when it
 * is first opened. Drafts live in `draft-store.ts` rather than here: what
 * happens when a file changes under an unsaved edit is an ordering problem, and
 * this hook only performs the I/O the reducer asks for.
 */
export function useSourceFiles(projectId: string, _projectSlug: string, seed: SourceFile[]) {
  const studio = useStudioSession();
  const [drafts, dispatch] = React.useReducer(reduceDraft, undefined, (): DraftState => ({
    entries: Object.fromEntries(seed.map((file) => [file.path, {
      path: file.path,
      baseHash: file.version,
      baseRevision: 0,
      draft: file.code,
      acknowledgedChangeSeq: 0,
      incomingGeneration: 0,
      incomingStatus: "idle" as const,
      incoming: null,
      resolution: "editing" as const,
    }])),
  }));
  const meta = React.useRef<Record<string, FileMeta>>(
    Object.fromEntries(seed.map((file) => [file.path, { code: file.code, foldableLines: file.foldableLines }])),
  );
  const [order, setOrder] = React.useState<string[]>(() => seed.map((file) => file.path));
  const [activePath, setActivePath] = React.useState(seed[0]?.path ?? "");
  const [loading, setLoading] = React.useState<string | null>(null);
  const [openError, setOpenError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string | null>>({});
  const fetched = React.useRef<Record<string, number>>({});

  const readFile = React.useCallback(async (path: string) => {
    const response = await fetchApi(
      `/api/v1/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(path)}`,
    );
    if (response.status === 404) return { deleted: true as const };
    const payload = await response.json().catch(() => null) as {
      file?: { path: string; content: string; contentHash: string };
      error?: { message?: string };
    } | null;
    if (!response.ok || !payload?.file) throw new Error(payload?.error?.message ?? `could not open ${path}`);
    return { deleted: false as const, file: payload.file };
  }, [projectId]);

  // A durable event names paths but carries no bytes, so the reducer opens the
  // conflict gate first and the refetch below fills it in.
  React.useEffect(() => {
    if (studio.resyncSeq > 0) dispatch({ kind: "resynced", seq: studio.resyncSeq });
  }, [studio.resyncSeq]);

  React.useEffect(() => {
    const event = studio.sourceEvent;
    // An event that names no path changed no file this editor holds — preview
    // settings and thumbnails both look like this. Only a stream gap (`resync`)
    // means unknown writes went by.
    if (!event || event.paths.length === 0) return;
    dispatch({ kind: "external", paths: event.paths, seq: event.seq });
  }, [studio.sourceEvent]);

  React.useEffect(() => {
    for (const entry of Object.values(drafts.entries)) {
      if (entry.incomingStatus !== "loading") continue;
      if (fetched.current[entry.path] === entry.incomingGeneration) continue;
      fetched.current[entry.path] = entry.incomingGeneration;
      const generation = entry.incomingGeneration;
      const path = entry.path;
      void readFile(path)
        .then((result) => dispatch(result.deleted
          ? { kind: "incoming", path, generation, content: null, contentHash: null, revision: 0 }
          : {
              kind: "incoming",
              path,
              generation,
              content: result.file.content,
              contentHash: result.file.contentHash,
              revision: 0,
            }))
        .catch(() => dispatch({ kind: "incoming-failed", path, generation }));
    }
  }, [drafts, readFile]);

  // R8.1e: a file with no unsaved edits is refreshed silently. Asking about a
  // change to text the user never touched is a dialog with only one sane answer.
  React.useEffect(() => {
    for (const entry of Object.values(drafts.entries)) {
      if (entry.incomingStatus !== "ready") continue;
      const base = meta.current[entry.path];
      const incoming = entry.incoming?.content;
      if (!base || entry.draft !== base.code || incoming === undefined || incoming === null) continue;
      meta.current[entry.path] = { code: incoming, foldableLines: base.foldableLines };
      dispatch({ kind: "take", path: entry.path });
    }
  }, [drafts]);

  const dirtyPaths = Object.values(drafts.entries)
    .filter((entry) => entry.draft !== (meta.current[entry.path]?.code ?? ""))
    .map((entry) => entry.path);

  // The three exits that could drop a draft all read the same count.
  React.useEffect(() => {
    reportUnsaved(`source:${projectId}`, dirtyPaths.length);
    return () => reportUnsaved(`source:${projectId}`, 0);
  }, [dirtyPaths.length, projectId]);

  const openPath = React.useCallback(async (path: string) => {
    setOpenError(null);
    setActivePath(path);
    setOrder((current) => current.includes(path) ? current : [...current, path]);
    if (meta.current[path]) return;

    setLoading(path);
    try {
      const result = await readFile(path);
      if (result.deleted) throw new Error(`${path} is no longer in the project`);
      meta.current[path] = { code: result.file.content, foldableLines: [] };
      dispatch({
        kind: "opened",
        path,
        content: result.file.content,
        contentHash: result.file.contentHash,
        revision: 0,
      });
    } catch (cause) {
      setOpenError(cause instanceof Error ? cause.message : "could not open file");
      setOrder((current) => current.filter((item) => item !== path));
    } finally {
      setLoading(null);
    }
  }, [readFile]);

  /** Closing a tab with unsaved edits asks first; it used to drop them silently. */
  const close = React.useCallback((path: string) => {
    const entry = drafts.entries[path];
    const dirty = entry !== undefined && entry.draft !== (meta.current[path]?.code ?? "");
    if (dirty && !confirmDiscard()) return;
    setOrder((current) => {
      const next = current.filter((item) => item !== path);
      setActivePath((active) => active === path ? (next[next.length - 1] ?? "") : active);
      return next;
    });
    delete meta.current[path];
    dispatch({ kind: "discarded", path });
  }, [drafts]);

  const edit = React.useCallback((path: string, draft: string) => {
    setErrors((current) => ({ ...current, [path]: null }));
    dispatch({ kind: "edited", path, draft });
  }, []);

  const save = React.useCallback(async (path: string, onSaved?: ProjectChanged) => {
    const entry = drafts.entries[path];
    if (!entry || saveDisabled(entry)) return;
    if (entry.draft === meta.current[path]?.code && entry.resolution === "editing") return;

    setSaving(path);
    setErrors((current) => ({ ...current, [path]: null }));
    try {
      const response = await fetchApi(`/api/v1/projects/${encodeURIComponent(projectId)}/files`, studio.request({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, content: entry.draft, ...savePrecondition(entry) }),
      }));
      const payload = await response.json().catch(() => null) as {
        file?: { path: string; content: string; contentHash: string };
        changeSeq?: number | null;
        error?: { message?: string };
      } | null;
      if (!response.ok || !payload?.file) {
        setErrors((current) => ({
          ...current,
          [path]: payload?.error?.message ?? `save failed (${response.status})`,
        }));
        return;
      }
      meta.current[path] = {
        code: payload.file.content,
        foldableLines: meta.current[path]?.foldableLines ?? [],
      };
      dispatch({
        kind: "saved",
        path,
        contentHash: payload.file.contentHash,
        revision: 0,
        changeSeq: payload.changeSeq ?? null,
      });
      onSaved?.(mutationChangeSeq(payload));
    } catch (cause) {
      setErrors((current) => ({
        ...current,
        [path]: cause instanceof Error ? cause.message : "save failed",
      }));
    } finally {
      setSaving(null);
    }
  }, [drafts, projectId, studio]);

  /** Discard unsaved edits and go back to what is on disk. */
  const revert = React.useCallback((path: string) => {
    const base = meta.current[path];
    if (!base) return;
    dispatch({ kind: "edited", path, draft: base.code });
  }, []);

  const resolve = React.useCallback((path: string, choice: "keep" | "take" | "compare" | "retry") => {
    if (choice === "take") {
      const incoming = drafts.entries[path]?.incoming?.content;
      // Taking the other version makes it the new base, so the tab goes clean.
      if (incoming !== undefined && incoming !== null) {
        meta.current[path] = { code: incoming, foldableLines: meta.current[path]?.foldableLines ?? [] };
      }
    }
    dispatch({ kind: choice, path });
  }, [drafts]);

  const files: OpenFile[] = order.flatMap((path) => {
    const entry = drafts.entries[path];
    const base = meta.current[path];
    if (!entry || !base) return [];
    return [{
      file: {
        path,
        code: base.code,
        foldableLines: base.foldableLines,
        saved: entry.draft === base.code,
        version: entry.baseHash ?? "",
      },
      draft: entry.draft,
      saving: saving === path,
      error: errors[path] ?? null,
      conflict: entry.draft === base.code || (entry.incomingStatus === "idle" && entry.resolution !== "conflicted") ? null : {
        status: entry.incomingStatus,
        resolution: entry.resolution,
        incoming: entry.incoming?.content ?? null,
        saveDisabled: saveDisabled(entry),
      },
    }];
  });
  const active = files.find((item) => item.file.path === activePath) ?? null;

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
    resolve,
    /** Open drafts a set of changed paths would touch — used by the tests and the guard. */
    conflictsWith: (paths: readonly string[]) => conflicts(drafts, paths),
  };
}
