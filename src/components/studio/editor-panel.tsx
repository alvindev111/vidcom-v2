"use client";

import * as React from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { SourceFile } from "@/lib/studio/types";
import { CodeView } from "./code-view";
import { EditorFooter } from "./editor-footer";
import { EditorTabBar } from "./editor-tab-bar";

export function EditorPanel({
  files,
  activePath,
  onActivate,
}: {
  files: SourceFile[];
  activePath: string;
  onActivate: (path: string) => void;
}) {
  const [closed, setClosed] = React.useState<string[]>([]);
  const openFiles = files.filter((file) => !closed.includes(file.path));
  const active =
    openFiles.find((file) => file.path === activePath) ?? openFiles[0];

  if (!active) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        No file open
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <EditorTabBar
        files={openFiles}
        activePath={active.path}
        onActivate={onActivate}
        onClose={(path) => setClosed((current) => [...current, path])}
      />

      <ScrollArea className="min-h-0 flex-1">
        <CodeView code={active.code} foldableLines={active.foldableLines} />
      </ScrollArea>

      <EditorFooter path={active.path} saved={active.saved} />
    </div>
  );
}
