import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceFs } from "@vidcom/adapter";
import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import type { AbsolutePath, JournalId, ProjectRef, ResolvedPath } from "@vidcom/core";

const roots: string[] = [];
const journalId = 31 as JournalId;

function hash(content: string): ContentHash {
  return `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;
}

async function missing(pathname: string): Promise<boolean> {
  try { await access(pathname); return false; }
  catch { return true; }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-mutation-lease-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const projectRoot = path.join(workspaceRoot, "project");
  await mkdir(path.join(projectRoot, "assets"), { recursive: true });
  await writeFile(path.join(projectRoot, "vidcom.json"), '{"id":"project_lease"}\n');
  await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
  await writeFile(path.join(projectRoot, "index.html"), "entry");
  const project: ProjectRef = {
    id: "project_lease" as ProjectId,
    slug: "project",
    root: projectRoot as AbsolutePath,
    entry: "index.html" as RelPath,
  };
  return { root, projectRoot, project, workspace: new WorkspaceFs(workspaceRoot as AbsolutePath) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("mutation parent identity lease", () => {
  it("rejects a real-directory replacement between resolve and capture", async () => {
    const value = await fixture();
    const parent = path.join(value.projectRoot, "assets");
    const moved = path.join(value.projectRoot, "assets-before");
    const leased = await value.workspace.resolveMutation(value.project, "assets/new.html", "authored-write");
    if (!leased.ok) throw new Error("fixture path did not resolve");
    await rename(parent, moved);
    await mkdir(parent);

    const captured = await value.workspace.captureForMutation(
      leased.value.target,
      null,
      journalId,
      0,
      { lease: leased.value },
    );

    expect(captured).toEqual({ ok: false, error: { actualState: "other" } });
    expect(await missing(path.join(parent, "new.html"))).toBe(true);
    expect(await missing(path.join(moved, "new.html"))).toBe(true);
  });

  it("rejects a symlink that appears in an initially absent parent chain", async () => {
    const value = await fixture();
    const outside = path.join(value.root, "outside");
    await mkdir(outside);
    const leased = await value.workspace.resolveMutation(
      value.project,
      "future/nested/new.html",
      "authored-write",
    );
    if (!leased.ok) throw new Error("fixture path did not resolve");
    await symlink(outside, path.join(value.projectRoot, "future"), process.platform === "win32" ? "junction" : "dir");

    const captured = await value.workspace.captureForMutation(
      leased.value.target,
      null,
      journalId,
      3,
      { lease: leased.value },
    );

    expect(captured).toEqual({ ok: false, error: { actualState: "other" } });
    expect(await missing(path.join(outside, "nested", "new.html"))).toBe(true);
  });

  it("keeps the rollback in the stable project root and blocks publish through a swapped parent symlink", async () => {
    const value = await fixture();
    const parent = path.join(value.projectRoot, "assets");
    const moved = path.join(value.projectRoot, "assets-before");
    const outside = path.join(value.root, "outside");
    const target = path.join(parent, "clip.html");
    await writeFile(target, "old");
    await mkdir(outside);
    const leased = await value.workspace.resolveMutation(value.project, "assets/clip.html", "authored-write");
    if (!leased.ok) throw new Error("fixture path did not resolve");
    const captured = await value.workspace.captureForMutation(
      leased.value.target,
      hash("old"),
      journalId,
      1,
      { lease: leased.value },
    );
    if (!captured.ok) throw new Error("fixture target was not captured");

    expect(path.dirname(captured.value.rollbackPath!)).toBe(leased.value.canonicalRoot);
    await rename(parent, moved);
    await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");

    await expect(value.workspace.publishCaptured(captured.value, "new")).resolves.toBe(false);
    expect(await missing(path.join(outside, "clip.html"))).toBe(true);
    expect(await readFile(captured.value.rollbackPath!, "utf8")).toBe("old");
  });

  it("blocks publish into a same-path real-directory replacement", async () => {
    const value = await fixture();
    const parent = path.join(value.projectRoot, "assets");
    const moved = path.join(value.projectRoot, "assets-before");
    const target = path.join(parent, "clip.html") as ResolvedPath;
    await writeFile(target, "old");
    const leased = await value.workspace.resolveMutation(value.project, "assets/clip.html", "authored-write");
    if (!leased.ok) throw new Error("fixture path did not resolve");
    const captured = await value.workspace.captureForMutation(
      leased.value.target,
      hash("old"),
      journalId,
      2,
      { lease: leased.value },
    );
    if (!captured.ok) throw new Error("fixture target was not captured");
    await rename(parent, moved);
    await mkdir(parent);

    await expect(value.workspace.publishCaptured(captured.value, "new")).resolves.toBe(false);
    expect(await missing(target)).toBe(true);
    expect(await readFile(captured.value.rollbackPath!, "utf8")).toBe("old");
  });

  it("refuses to rebase unrelated parent replacements during a journal-owned restore", async () => {
    const value = await fixture();
    const parent = path.join(value.projectRoot, "assets");
    const nested = path.join(parent, "nested");
    await mkdir(nested);
    const leased = await value.workspace.resolveMutation(
      value.project,
      "assets/nested/clip.html",
      "authored-write",
    );
    if (!leased.ok) throw new Error("fixture path did not resolve");
    await rename(parent, path.join(value.projectRoot, "assets-before"));
    await mkdir(nested, { recursive: true });

    await expect(value.workspace.refreshMutationPath(
      leased.value,
      parent as ResolvedPath,
    )).resolves.toBeNull();
  });

  it("settles safely with a live OS file handle instead of losing a locked entry", async () => {
    const value = await fixture();
    const target = path.join(value.projectRoot, "assets", "locked.html") as ResolvedPath;
    await writeFile(target, "locked-old");
    const leased = await value.workspace.resolveMutation(value.project, "assets/locked.html", "authored-write");
    if (!leased.ok) throw new Error("fixture path did not resolve");
    const handle = await open(target, "r");
    try {
      let captured: Awaited<ReturnType<WorkspaceFs["captureForMutation"]>>;
      try {
        captured = await value.workspace.captureForMutation(
          leased.value.target,
          hash("locked-old"),
          journalId,
          4,
          { lease: leased.value },
        );
      } catch (error) {
        expect(["EACCES", "EPERM", "EBUSY"]).toContain((error as NodeJS.ErrnoException).code);
        expect(await readFile(target, "utf8")).toBe("locked-old");
        return;
      }
      if (!captured.ok) throw new Error("locked target changed before capture");
      await expect(value.workspace.restoreCaptured(captured.value, null)).resolves.toBe(true);
      expect(await readFile(target, "utf8")).toBe("locked-old");
    } finally {
      await handle.close();
    }
  });

  it("canonicalizes case-only aliases according to the runner filesystem", async () => {
    const value = await fixture();
    await writeFile(path.join(value.projectRoot, "assets", "Case.html"), "case");
    const exact = await value.workspace.resolveMutation(value.project, "assets/Case.html", "authored-write");
    const folded = await value.workspace.resolveMutation(value.project, "assets/case.html", "authored-write");
    if (!exact.ok || !folded.ok) throw new Error("case fixture did not resolve");
    const caseInsensitive = !await missing(path.join(value.projectRoot, "assets", "case.html"));

    expect(folded.value.target === exact.value.target).toBe(caseInsensitive);
    expect(await readFile(exact.value.target, "utf8")).toBe("case");
  });
});
