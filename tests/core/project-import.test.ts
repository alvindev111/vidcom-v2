import type { AbsolutePath } from "@vidcom/core";
import {
  assertNoOverlap,
  assertSourceUnchanged,
  availableSlug,
  contains,
  importDecision,
  importRefusal,
  planProjectImport,
  slugFor,
} from "@vidcom/core";
import { describe, expect, it } from "vitest";

const workspace = "/work/videos" as AbsolutePath;

function plan(source: string, taken: string[] = [], targetName?: string) {
  return planProjectImport({
    source: source as AbsolutePath,
    workspaceRoot: workspace,
    sourceIdentity: "dev:ino",
    taken,
    ...(targetName === undefined ? {} : { targetName }),
  });
}

describe("import overlap", () => {
  it.each([
    ["the workspace itself", "/work/videos"],
    ["a directory inside the workspace", "/work/videos/swiss-grid"],
    ["a parent of the workspace", "/work"],
  ])("refuses %s", (_label, source) => {
    // All three recurse: a source inside the workspace copies itself into its
    // own subtree until the disk fills, and a source that contains the
    // workspace does the same thing one level up.
    const result = assertNoOverlap(source as AbsolutePath, workspace);
    expect(result.ok).toBe(false);
  });

  it("accepts a source that merely shares a prefix", () => {
    // `/work/videos-archive` is not inside `/work/videos`, and a string prefix
    // test says it is.
    expect(assertNoOverlap("/work/videos-archive" as AbsolutePath, workspace).ok).toBe(true);
    expect(contains("/work/video", "/work/videos")).toBe(false);
  });

  it("refuses before anything is planned", () => {
    expect(plan("/work/videos/inner").ok).toBe(false);
  });

  it("folds case only when the caller says the filesystem does", () => {
    // Core is not allowed to ask which filesystem it is on, and guessing wrong
    // either refuses a legal import or allows a recursive one.
    const source = "/WORK/VIDEOS" as AbsolutePath;
    expect(assertNoOverlap(source, workspace).ok).toBe(true);
    expect(assertNoOverlap(source, workspace, { caseInsensitive: true }).ok).toBe(false);
  });
});

describe("import naming", () => {
  it("turns a folder name into a slug a filesystem will not argue about", () => {
    expect(slugFor("Swiss Grid v2")).toBe("swiss-grid-v2");
    expect(slugFor("  ---  ")).toBe("project");
  });

  it("counts up rather than overwriting or refusing", () => {
    // Overwriting destroys a project; refusing makes the user rename a folder
    // before an import they already asked for.
    expect(availableSlug("swiss-grid", [])).toBe("swiss-grid");
    expect(availableSlug("swiss-grid", ["swiss-grid"])).toBe("swiss-grid-2");
    expect(availableSlug("swiss-grid", ["swiss-grid", "swiss-grid-2"])).toBe("swiss-grid-3");
  });

  it("takes the name from the source folder when none is given", () => {
    const planned = plan("/elsewhere/Swiss Grid");
    expect(planned.ok && planned.value.slug).toBe("swiss-grid");
    expect(planned.ok && planned.value.target).toBe("/work/videos/swiss-grid");
  });

  it("prefers the name the caller asked for", () => {
    const planned = plan("/elsewhere/swiss-grid", [], "My Copy");
    expect(planned.ok && planned.value.slug).toBe("my-copy");
  });
});

describe("import source binding", () => {
  it("stops when the source is no longer what was planned", () => {
    // Between planning and copying somebody can move or replace the source, and
    // copying whatever now sits at that path is the worst outcome available.
    const planned = plan("/elsewhere/swiss-grid");
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(assertSourceUnchanged(planned.value, "dev:ino").ok).toBe(true);
    expect(assertSourceUnchanged(planned.value, "dev:other").ok).toBe(false);
  });
});

describe("import copy rules", () => {
  it.each(["node_modules", ".git", ".hyperframes"])("skips %s at any depth", (name) => {
    expect(importDecision(`${name}/thing`, "file").copy).toBe(false);
    expect(importDecision(`src/${name}/thing`, "file").copy).toBe(false);
    // Skipping these is not a refusal: they are rebuildable, and an import that
    // failed on one would refuse most real projects.
    expect(importRefusal(`src/${name}/thing`, "file")).toBeNull();
  });

  it("refuses a symlink instead of following or skipping it", () => {
    // Following one copies data from outside the source; skipping it silently
    // produces a project missing something the original had.
    expect(importDecision("assets/link", "symlink").copy).toBe(false);
    expect(importRefusal("assets/link", "symlink")).not.toBeNull();
  });

  it("refuses anything that is not a file or a directory", () => {
    expect(importRefusal("dev/fifo", "other")).not.toBeNull();
  });

  it("copies ordinary files and directories", () => {
    expect(importDecision("index.html", "file").copy).toBe(true);
    expect(importDecision("assets", "directory").copy).toBe(true);
  });
});
