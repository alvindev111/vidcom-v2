"use client";

import * as React from "react";
import { FilePlusIcon, FolderPlusIcon, PencilIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { FileNode } from "@/lib/studio/types";
import type { ProjectChanged } from "@/lib/studio/preview-reload";
import { assetKindFromName } from "@/lib/studio/asset-manager";
import { AssetDropzone } from "./asset-dropzone";
import { FileTreeItem } from "./file-tree-item";
import { useAssetManager } from "./use-asset-manager";

export function FileExplorer({
  tree,
  selectedPath,
  dirtyPaths,
  onSelect,
  projectId,
  projectRevision,
  entryContentHash,
  onProjectChanged,
}: {
  tree: FileNode[];
  selectedPath: string;
  /** Files with unsaved edits, marked in the tree as well as on the tab. */
  dirtyPaths: string[];
  onSelect: (path: string) => void;
  projectId: string;
  projectRevision: number;
  entryContentHash: string | null;
  onProjectChanged: ProjectChanged;
}) {
  const [expanded, setExpanded] = React.useState<string[]>([]);
  const [managedPath, setManagedPath] = React.useState("");
  const assets = useAssetManager(projectId, projectRevision, entryContentHash, onProjectChanged);

  const toggle = (path: string) =>
    setExpanded((current) =>
      current.includes(path)
        ? current.filter((item) => item !== path)
        : [...current, path],
    );

  const renderNodes = (nodes: FileNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const isExpanded = expanded.includes(node.path);
      return (
        <React.Fragment key={node.path}>
          <FileTreeItem
            node={node}
            depth={depth}
            selected={node.path === selectedPath}
            dirty={dirtyPaths.includes(node.path)}
            expanded={isExpanded}
            onSelect={onSelect}
            onToggle={toggle}
            onManage={(path) => {
              setManagedPath(path);
              void assets.inspect(path);
            }}
          />
          {node.kind === "folder" && isExpanded
            ? node.children?.length
              ? renderNodes(node.children, depth + 1)
              : renderEmpty(depth + 1)
            : null}
        </React.Fragment>
      );
    });

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-8 items-center gap-1 border-b pr-1 pl-2">
        <span className="text-muted-foreground grow text-[11px] font-medium tracking-widest uppercase">
          Files
        </span>
        <Button variant="ghost" size="icon" className="size-6" aria-label="New file" onClick={() => {
          const path = window.prompt("Project-relative file path", "assets/new-file.txt")?.trim();
          if (path) void assets.create(path, "file");
        }}>
          <FilePlusIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="New folder"
          onClick={() => {
            const path = window.prompt("Project-relative folder path", "assets/new-folder")?.trim();
            if (path) void assets.create(path, "folder");
          }}
        >
          <FolderPlusIcon className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="size-6" aria-label="Rename selected entry" disabled={!managedPath} onClick={() => {
          const to = window.prompt("New project-relative path", managedPath)?.trim();
          if (to && to !== managedPath) void assets.rename(managedPath, to);
        }}><PencilIcon className="size-3.5" /></Button>
        <Button variant="ghost" size="icon" className="size-6" aria-label="Delete selected entry" disabled={!managedPath} onClick={() => void assets.remove(managedPath)}>
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-px p-1">{renderNodes(tree, 0)}</div>
      </ScrollArea>
      {managedPath.startsWith("assets/") ? (
        <div className="border-t px-2 py-1.5 text-[11px]">
          <p className="truncate font-medium">{managedPath}</p>
          {assets.metadata?.status === "ok" ? (
            <p className="text-muted-foreground truncate">
              {assets.metadata.kind === "font"
                ? `${String(assets.metadata.family)} · ${String(assets.metadata.style)}`
                : `${String(assets.metadata.codec ?? "media")} · ${String(assets.metadata.byteSize)} bytes`}
            </p>
          ) : assets.metadata?.status === "unknown" ? (
            <p className="text-muted-foreground">Unknown: {String(assets.metadata.reason)}</p>
          ) : null}
          {assetKindFromName(managedPath) === "font" && assets.metadata?.status === "ok" ? (
            <Button type="button" size="sm" variant="outline" className="mt-1 h-7 w-full text-xs" onClick={() => void assets.applyFont(managedPath)}>
              Apply font to project
            </Button>
          ) : null}
        </div>
      ) : null}
      <AssetDropzone progress={assets.progress} error={assets.error} onUpload={(file) => void assets.upload(file)} onCancel={assets.cancelUpload} />
    </div>
  );
}

function renderEmpty(depth: number) {
  return (
    <span
      className="text-muted-foreground/60 py-1 text-xs italic"
      style={{ paddingLeft: `${depth * 12 + 24}px` }}
    >
      empty
    </span>
  );
}
