"use client";

import { CodeEditor } from "./code-editor";
import { EditorFooter } from "./editor-footer";
import { EditorTabBar } from "./editor-tab-bar";
import type { OpenFile } from "./use-source-files";

export function EditorPanel({
  files,
  active,
  activePath,
  dirtyPaths,
  loading,
  openError,
  onActivate,
  onClose,
  onEdit,
  onSave,
  onRevert,
}: {
  files: OpenFile[];
  active: OpenFile | null;
  activePath: string;
  dirtyPaths: string[];
  /** Path currently being fetched, if any. */
  loading: string | null;
  openError: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onEdit: (code: string) => void;
  onSave: () => void;
  onRevert: () => void;
}) {
  if (!active) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-xs">
        {loading ? (
          <span className="font-mono">opening {loading}…</span>
        ) : (
          <>
            <span>No file open</span>
            <span className="text-muted-foreground/70">
              Pick a file on the left to read or edit it.
            </span>
          </>
        )}
        {openError ? (
          <span className="text-destructive mt-2" role="alert">
            {openError}
          </span>
        ) : null}
      </div>
    );
  }

  const dirty = dirtyPaths.includes(active.file.path);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorTabBar
        files={files.map((entry) => entry.file)}
        activePath={activePath}
        dirtyPaths={dirtyPaths}
        onActivate={onActivate}
        onClose={onClose}
      />

      {openError ? (
        <p
          className="text-destructive border-b px-3 py-1.5 text-[11px]"
          role="alert"
        >
          {openError}
        </p>
      ) : null}

      {/* Keyed by path so switching tabs builds a fresh editor for the new
          language instead of re-flowing the previous document. */}
      <div className="min-h-0 flex-1">
        <CodeEditor
          key={active.file.path}
          path={active.file.path}
          initialCode={active.file.code}
          onChange={onEdit}
          onSave={onSave}
        />
      </div>

      <EditorFooter
        path={active.file.path}
        dirty={dirty}
        saving={active.saving}
        error={active.error}
        onSave={onSave}
        onRevert={onRevert}
      />
    </div>
  );
}
