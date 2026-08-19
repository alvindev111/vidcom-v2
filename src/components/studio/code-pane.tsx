"use client";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { FileNode, SourceFile } from "@/lib/studio/types";
import type { ProjectChanged } from "@/lib/studio/preview-reload";
import { EditorPanel } from "./editor-panel";
import { FileExplorer } from "./file-explorer";
import { useSourceFiles } from "./use-source-files";

/** Source-code side of the Code tab: the project's files and the open editor. */
export function CodePane({
  projectId,
  projectSlug,
  tree,
  files,
  onProjectChanged,
  projectRevision,
}: {
  projectId: string;
  projectSlug: string;
  tree: FileNode[];
  /** Files shipped with the page — the entry composition. */
  files: SourceFile[];
  /** Called after a save so the preview rebuilds against the new source. */
  onProjectChanged: ProjectChanged;
  projectRevision: number;
}) {
  const source = useSourceFiles(projectId, projectSlug, files);

  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel defaultSize="26" minSize="12">
        <FileExplorer
          tree={tree}
          selectedPath={source.activePath}
          dirtyPaths={source.dirtyPaths}
          onSelect={(path) => void source.openPath(path)}
          projectId={projectId}
          projectRevision={projectRevision}
          entryContentHash={files.find((file) => file.path === "index.html")?.version ?? null}
          onProjectChanged={onProjectChanged}
        />
      </ResizablePanel>

      <ResizableHandle />

      <ResizablePanel defaultSize="74" minSize="30">
        <EditorPanel
          files={source.files}
          active={source.active}
          activePath={source.activePath}
          dirtyPaths={source.dirtyPaths}
          loading={source.loading}
          openError={source.openError}
          onActivate={(path) => void source.openPath(path)}
          onClose={source.close}
          onEdit={(code) => source.edit(source.activePath, code)}
          onSave={() => void source.save(source.activePath, onProjectChanged)}
          onRevert={() => source.revert(source.activePath)}
          onResolve={(choice) => source.resolve(source.activePath, choice)}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
