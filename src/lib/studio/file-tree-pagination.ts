import type { FileNode } from "./types";

export interface VisibleFileTreeRow {
  node: FileNode;
  depth: number;
}

/** Snapshot data remains useful to other panels; the explorer expands only server-owned pages. */
export function shallowFileTree(nodes: readonly FileNode[], limit = 200): FileNode[] {
  return nodes.slice(0, limit).map((node) => node.kind === "folder"
    ? { ...node, children: undefined }
    : node);
}

function mergeUnique(current: readonly FileNode[], incoming: readonly FileNode[]): FileNode[] {
  const byPath = new Map(current.map((node) => [node.path, node]));
  for (const node of incoming) byPath.set(node.path, node);
  return [...byPath.values()];
}

/** Replaces or appends one direct-child page without rebuilding unrelated branches. */
export function mergeFileTreePage(
  tree: readonly FileNode[],
  directory: string | null,
  entries: readonly FileNode[],
  append: boolean,
): FileNode[] {
  if (directory === null) return append ? mergeUnique(tree, entries) : [...entries];
  return tree.map((node) => {
    if (node.path === directory && node.kind === "folder") {
      return { ...node, children: append ? mergeUnique(node.children ?? [], entries) : [...entries] };
    }
    if (node.kind !== "folder" || node.children === undefined) return node;
    const children = mergeFileTreePage(node.children, directory, entries, append);
    return children === node.children ? node : { ...node, children };
  });
}

export function findFileTreeNode(nodes: readonly FileNode[], path: string): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.kind === "folder" && node.children) {
      const found = findFileTreeNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

/** Flattens expanded branches once; callers render only a bounded window of these rows. */
export function visibleFileTreeRows(
  nodes: readonly FileNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
  rows: VisibleFileTreeRow[] = [],
): VisibleFileTreeRow[] {
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === "folder" && expanded.has(node.path) && node.children) {
      visibleFileTreeRows(node.children, expanded, depth + 1, rows);
    }
  }
  return rows;
}
