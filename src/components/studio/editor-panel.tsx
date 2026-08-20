"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
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
  onRecreate,
  onRevert,
  onResolve,
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
  onRecreate: () => void;
  onRevert: () => void;
  onResolve: (choice: "keep" | "take" | "compare" | "retry") => void;
}) {
  const [comparing, setComparing] = React.useState(false);
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
  const conflict = active.conflict;
  const deletedOutside = conflict?.sourceStatus === "deleted";

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

      {conflict ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5" role="alert">
          <span className="min-w-0 flex-1 text-[11px] text-amber-700 dark:text-amber-300">
            {conflict.status === "loading" ? "Checking what changed outside the editor…"
              : conflict.status === "failed" ? "Could not read the file that changed outside. Your edits are still here."
              : deletedOutside ? "This file was deleted outside the editor. Recreate it or close the tab."
              : conflict.resolution === "resolved-keep" ? "Keeping your version; the next save overwrites the other one."
              : conflict.resolution === "resolved-take" ? "Using the version from outside."
              : "This file changed outside the editor."}
          </span>
          {conflict.status === "failed" ? (
            <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => onResolve("retry")}>Try again</Button>
          ) : null}
          {conflict.status === "ready" ? (
            deletedOutside ? (
              <>
                <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={onRecreate}>
                  Recreate
                </Button>
                <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => onClose(active.file.path)}>
                  Close
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => { setComparing(false); onResolve("keep"); }}>
                  Keep mine
                </Button>
                <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => { setComparing(false); onResolve("take"); }}>
                  Use theirs
                </Button>
                <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => { setComparing((current) => !current); onResolve("compare"); }}>
                  {comparing ? "Hide comparison" : "Compare"}
                </Button>
              </>
            )
          ) : null}
        </div>
      ) : null}

      {/* Keyed by path so switching tabs builds a fresh editor for the new
          language instead of re-flowing the previous document. */}
      <div className="flex min-h-0 flex-1">
        {comparing && conflict?.incoming !== null && conflict?.incoming !== undefined ? (
          <pre
            aria-label="Version from outside the editor"
            className="bg-muted/40 min-h-0 w-1/2 overflow-auto border-r p-2 font-mono text-[11px] whitespace-pre-wrap"
          >
            {conflict.incoming}
          </pre>
        ) : null}
        <div className="min-h-0 flex-1">
          <CodeEditor
            // Also keyed by the base hash: resolving a conflict replaces the
            // text, and a stale editor would keep showing the version the user
            // just chose against.
            key={`${active.file.path}:${active.file.version}`}
            path={active.file.path}
            initialCode={active.draft}
            onChange={onEdit}
            onSave={onSave}
          />
        </div>
      </div>

      <EditorFooter
        path={active.file.path}
        dirty={dirty}
        saving={active.saving}
        error={active.error}
        saveBlocked={conflict?.saveDisabled ?? false}
        onSave={onSave}
        onRevert={onRevert}
      />
    </div>
  );
}
