"use client";

import * as React from "react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { FileNode, SourceFile } from "@/lib/studio/types";
import { EditorPanel } from "./editor-panel";
import { FileExplorer } from "./file-explorer";

/** Source-code side of the Code tab: the project's files and the open editor. */
export function CodePane({
  tree,
  files,
}: {
  tree: FileNode[];
  files: SourceFile[];
}) {
  const [selectedPath, setSelectedPath] = React.useState(files[0]?.path ?? "");

  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel defaultSize="26" minSize="12">
        <FileExplorer
          tree={tree}
          selectedPath={selectedPath}
          onSelect={setSelectedPath}
        />
      </ResizablePanel>

      <ResizableHandle />

      <ResizablePanel defaultSize="74" minSize="30">
        <EditorPanel
          files={files}
          activePath={selectedPath}
          onActivate={setSelectedPath}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
