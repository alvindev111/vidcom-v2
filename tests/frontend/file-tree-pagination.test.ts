import { describe, expect, it } from "vitest";

import {
  mergeFileTreePage,
  shallowFileTree,
  visibleFileTreeRows,
} from "../../src/lib/studio/file-tree-pagination";
import type { FileNode } from "../../src/lib/studio/types";

const tree: FileNode[] = [{
  path: "assets",
  name: "assets",
  kind: "folder",
  children: [{ path: "assets/old.txt", name: "old.txt", kind: "file" }],
}, { path: "index.html", name: "index.html", kind: "file" }];

describe("file tree pagination", () => {
  it("drops recursive snapshot children and merges direct pages without duplicates", () => {
    const shallow = shallowFileTree(tree);
    expect(shallow[0]).toEqual({ path: "assets", name: "assets", kind: "folder", children: undefined });
    const first = mergeFileTreePage(shallow, "assets", [
      { path: "assets/a.txt", name: "a.txt", kind: "file" },
    ], false);
    const second = mergeFileTreePage(first, "assets", [
      { path: "assets/a.txt", name: "a.txt", kind: "file" },
      { path: "assets/b.txt", name: "b.txt", kind: "file" },
    ], true);
    expect((second[0] as FileNode).children?.map((node) => node.path)).toEqual([
      "assets/a.txt", "assets/b.txt",
    ]);
  });

  it("flattens only expanded branches for a bounded render window", () => {
    const loaded = mergeFileTreePage(shallowFileTree(tree), "assets", [
      { path: "assets/a.txt", name: "a.txt", kind: "file" },
    ], false);
    expect(visibleFileTreeRows(loaded, new Set()).map(({ node }) => node.path)).toEqual([
      "assets", "index.html",
    ]);
    expect(visibleFileTreeRows(loaded, new Set(["assets"]))).toMatchObject([
      { node: { path: "assets" }, depth: 0 },
      { node: { path: "assets/a.txt" }, depth: 1 },
      { node: { path: "index.html" }, depth: 0 },
    ]);
  });
});
