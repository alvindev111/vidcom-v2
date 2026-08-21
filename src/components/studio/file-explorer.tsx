"use client";

import * as React from "react";
import { FilePlusIcon, FolderPlusIcon, PencilIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchApi } from "@/lib/api/services";
import {
  findFileTreeNode,
  mergeFileTreePage,
  shallowFileTree,
  visibleFileTreeRows,
} from "@/lib/studio/file-tree-pagination";
import type { FileNode } from "@/lib/studio/types";
import type { ProjectChanged } from "@/lib/studio/preview-reload";
import { assetKindFromName } from "@/lib/studio/asset-manager";
import { AssetDropzone } from "./asset-dropzone";
import { FileCrudDialog, type FileCrudIntent } from "./file-crud-dialog";
import { FileTreeItem } from "./file-tree-item";
import { PendingMountList } from "./pending-mount-list";
import { useAssetManager } from "./use-asset-manager";
import { useMountDrop } from "./use-mount-drop";

const TREE_PAGE_SIZE = 200;
const INITIAL_RENDER_ROWS = 300;

interface TreePagePayload {
  directory: string | null;
  entries: FileNode[];
  nextCursor: string | null;
  totalEntries: number;
}

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
  const [nodes, setNodes] = React.useState<FileNode[]>(() => shallowFileTree(tree, TREE_PAGE_SIZE));
  const [pages, setPages] = React.useState<Record<string, { nextCursor: string | null; totalEntries: number }>>(
    () => ({ "": { nextCursor: tree.length > TREE_PAGE_SIZE ? String(TREE_PAGE_SIZE) : null, totalEntries: tree.length } }),
  );
  const [loadingDirectories, setLoadingDirectories] = React.useState<string[]>([]);
  const [treeError, setTreeError] = React.useState<string | null>(null);
  const [renderRows, setRenderRows] = React.useState(INITIAL_RENDER_ROWS);
  const requests = React.useRef(new Set<AbortController>());
  const [managedPath, setManagedPath] = React.useState("");
  const [crudIntent, setCrudIntent] = React.useState<FileCrudIntent | null>(null);
  const [crudValue, setCrudValue] = React.useState("");
  const crudOpener = React.useRef<HTMLElement | null>(null);
  const assets = useAssetManager(projectId, projectRevision, entryContentHash, onProjectChanged);
  const drops = useMountDrop({ projectId, revision: projectRevision, entryContentHash, onProjectChanged });
  // The list survives restarts, so it is read once the panel mounts rather than
  // only after a drop this session.
  const { refreshPending } = drops;
  React.useEffect(() => { void refreshPending(); }, [refreshPending]);
  React.useEffect(() => () => {
    for (const request of requests.current) request.abort();
    requests.current.clear();
  }, []);

  const loadDirectory = React.useCallback(async (directory: string | null, cursor: string | null) => {
    const key = directory ?? "";
    const request = new AbortController();
    requests.current.add(request);
    setLoadingDirectories((current) => current.includes(key) ? current : [...current, key]);
    setTreeError(null);
    try {
      const query = new URLSearchParams({ limit: String(TREE_PAGE_SIZE) });
      if (directory !== null) query.set("directory", directory);
      if (cursor !== null) query.set("cursor", cursor);
      const response = await fetchApi(
        `/api/v1/projects/${encodeURIComponent(projectId)}/tree?${query.toString()}`,
        { cache: "no-store", signal: request.signal },
      );
      const payload = await response.json().catch(() => null) as TreePagePayload | { error?: { message?: string } } | null;
      if (!response.ok || !payload || !("entries" in payload)) {
        throw new Error(payload && "error" in payload ? payload.error?.message : "Project tree page could not be read.");
      }
      setNodes((current) => mergeFileTreePage(current, directory, payload.entries, cursor !== null));
      setPages((current) => ({ ...current, [key]: {
        nextCursor: payload.nextCursor,
        totalEntries: payload.totalEntries,
      } }));
    } catch (cause) {
      if (!request.signal.aborted) {
        setTreeError(cause instanceof Error ? cause.message : "Project tree page could not be read.");
      }
    } finally {
      requests.current.delete(request);
      setLoadingDirectories((current) => current.filter((item) => item !== key));
    }
  }, [projectId]);

  const toggle = React.useCallback((path: string) => {
    const opening = !expanded.includes(path);
    if (!opening) {
      setExpanded((current) => current.filter((item) => item !== path));
      return;
    }
    const node = findFileTreeNode(nodes, path);
    if (node?.kind === "folder" && node.children === undefined) void loadDirectory(path, null);
    setExpanded((current) => current.includes(path) ? current : [...current, path]);
  }, [expanded, loadDirectory, nodes]);

  const expandedSet = React.useMemo(() => new Set(expanded), [expanded]);
  const dirtySet = React.useMemo(() => new Set(dirtyPaths), [dirtyPaths]);
  const visibleRows = React.useMemo(
    () => visibleFileTreeRows(nodes, expandedSet),
    [expandedSet, nodes],
  );

  return (
    <div className="flex h-full flex-col bg-sidebar" data-project-revision={projectRevision}>
      <div className="flex h-8 items-center gap-1 border-b pr-1 pl-2">
        <span className="text-muted-foreground grow text-[11px] font-medium tracking-widest uppercase">
          Files
        </span>
        <Button variant="ghost" size="icon" className="size-6" aria-label="New file" onClick={() => {
          crudOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setCrudValue("assets/new-file.txt");
          setCrudIntent({ action: "create", kind: "file" });
        }}>
          <FilePlusIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="New folder"
          onClick={() => {
            crudOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setCrudValue("assets/new-folder");
            setCrudIntent({ action: "create", kind: "folder" });
          }}
        >
          <FolderPlusIcon className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="size-6" aria-label="Rename selected entry" disabled={!managedPath} onClick={() => {
          crudOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setCrudValue(managedPath);
          setCrudIntent({ action: "rename", path: managedPath });
        }}><PencilIcon className="size-3.5" /></Button>
        <Button variant="ghost" size="icon" className="size-6" aria-label="Delete selected entry" disabled={!managedPath} onClick={() => {
          crudOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setCrudValue("");
          setCrudIntent({ action: "delete", path: managedPath });
        }}>
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-px p-1">
          {visibleRows.slice(0, renderRows).map(({ node, depth }) => {
            const isExpanded = expandedSet.has(node.path);
            const page = pages[node.path];
            return (
              <React.Fragment key={node.path}>
                <FileTreeItem
                  node={node}
                  depth={depth}
                  selected={node.path === selectedPath}
                  dirty={dirtySet.has(node.path)}
                  expanded={isExpanded}
                  onSelect={onSelect}
                  onToggle={toggle}
                  onManage={(path) => {
                    setManagedPath(path);
                    void assets.inspect(path);
                  }}
                />
                {node.kind === "folder" && isExpanded && node.children?.length === 0
                  ? renderEmpty(depth + 1)
                  : null}
                {node.kind === "folder" && isExpanded && page?.nextCursor ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 justify-start text-xs"
                    style={{ paddingLeft: `${(depth + 1) * 12 + 24}px` }}
                    disabled={loadingDirectories.includes(node.path)}
                    onClick={() => void loadDirectory(node.path, page.nextCursor)}
                  >
                    {loadingDirectories.includes(node.path) ? "Loading…" : `Load more (${page.totalEntries})`}
                  </Button>
                ) : null}
              </React.Fragment>
            );
          })}
          {visibleRows.length > renderRows ? (
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setRenderRows((value) => value + INITIAL_RENDER_ROWS)}>
              Show more files
            </Button>
          ) : null}
          {pages[""]?.nextCursor ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={loadingDirectories.includes("")}
              onClick={() => void loadDirectory(null, pages[""]!.nextCursor)}
            >
              {loadingDirectories.includes("") ? "Loading…" : `Load more root entries (${pages[""]!.totalEntries})`}
            </Button>
          ) : null}
          {treeError ? <p role="alert" className="text-destructive px-2 py-1 text-xs">{treeError}</p> : null}
        </div>
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
      <PendingMountList
        items={drops.pending}
        onRetry={(operationId) => void drops.retryMount(operationId)}
        onDiscard={(operationId) => void drops.abandonMount(operationId)}
      />
      {drops.error ? <p role="alert" className="text-destructive border-t px-2 py-1.5 text-[11px]">{drops.error}</p> : null}
      <AssetDropzone progress={assets.progress} error={assets.error} onUpload={(file) => void assets.upload(file)} onCancel={assets.cancelUpload} />
      <FileCrudDialog
        intent={crudIntent}
        value={crudValue}
        onValueChange={setCrudValue}
        onOpenChange={(open) => { if (!open) setCrudIntent(null); }}
        onRestoreFocus={() => crudOpener.current?.focus()}
        onSubmit={() => {
          if (!crudIntent) return;
          const value = crudValue.trim();
          if (crudIntent.action === "create") void assets.create(value, crudIntent.kind);
          else if (crudIntent.action === "rename") void assets.rename(crudIntent.path, value);
          else void assets.remove(crudIntent.path);
          setCrudIntent(null);
        }}
      />
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
