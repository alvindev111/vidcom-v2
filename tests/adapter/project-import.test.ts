import { realpathSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  canonicalImportPaths,
  commitStaging,
  copyIntoStaging,
  digestTree,
  listStagingDirectories,
  recoverImportStaging,
  sourceIdentityOf,
  stagingPathFor,
  validateStagedProject,
  writeStagingMarker,
} from "@vidcom/adapter";
import { assertSourceUnchanged, planProjectImport, type AbsolutePath } from "@vidcom/core";
import { afterEach, describe, expect, it } from "vitest";

import { writeSampleProject } from "../support/sample-project";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<{ workspace: string; source: string }> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-import-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const source = path.join(root, "source");
  await mkdir(workspace, { recursive: true });
  await mkdir(source, { recursive: true });
  return { workspace, source };
}

function planFor(source: string, workspace: string, identity: string, taken: string[] = []) {
  const planned = planProjectImport({
    source: source as AbsolutePath,
    workspaceRoot: workspace as AbsolutePath,
    sourceIdentity: identity,
    taken,
  });
  if (!planned.ok) throw new Error(planned.error.message);
  return planned.value;
}

describe("import staging on a real filesystem", () => {
  it("stages inside the workspace so the commit is a rename", async () => {
    // The final step is a rename, and rename across devices fails with EXDEV.
    // Staging in the OS temp directory would turn an atomic commit into a copy
    // that can be interrupted halfway.
    const { workspace, source } = await scratch();
    const plan = planFor(source, workspace, await sourceIdentityOf(source));
    expect(path.dirname(stagingPathFor(plan, "op-1"))).toBe(workspace);
  });

  it("copies a real tree and commits it with a rename", async () => {
    const { workspace, source } = await scratch();
    await writeFile(path.join(source, "index.html"), "<!doctype html>", "utf8");
    await mkdir(path.join(source, "assets"), { recursive: true });
    await writeFile(path.join(source, "assets", "a.png"), "png", "utf8");

    const plan = planFor(source, workspace, await sourceIdentityOf(source));
    const staging = stagingPathFor(plan, "op-1");
    const report = await copyIntoStaging(source, staging);
    expect(report).toMatchObject({ files: 2, directories: 1 });
    expect(await commitStaging(staging, plan.target)).toBeNull();

    expect(await readFile(path.join(plan.target, "index.html"), "utf8")).toBe("<!doctype html>");
    expect(await readdir(workspace)).toEqual([plan.slug]);
  });

  it("leaves the original untouched", async () => {
    // The user still has the original after any outcome, and "still has" has to
    // mean unchanged — not even a timestamp.
    const { workspace, source } = await scratch();
    await writeFile(path.join(source, "index.html"), "original", "utf8");
    const before = await digestTree(source);

    const plan = planFor(source, workspace, await sourceIdentityOf(source));
    const staging = stagingPathFor(plan, "op-1");
    await copyIntoStaging(source, staging);
    await commitStaging(staging, plan.target);

    expect(await digestTree(source)).toBe(before);
    expect(await readFile(path.join(source, "index.html"), "utf8")).toBe("original");
  });

  it("refuses a real symlink rather than following it", async () => {
    const { workspace, source } = await scratch();
    await writeFile(path.join(source, "index.html"), "x", "utf8");
    await symlink(path.join(source, "index.html"), path.join(source, "link.html"));
    expect((await lstat(path.join(source, "link.html"))).isSymbolicLink()).toBe(true);

    const plan = planFor(source, workspace, await sourceIdentityOf(source));
    const result = await copyIntoStaging(source, stagingPathFor(plan, "op-1"));
    expect(result).toMatchObject({ code: "path_invalid" });
  });

  it("refuses a file swapped to a symlink after lstat instead of copying its target", async () => {
    const { workspace, source } = await scratch();
    const outside = path.join(path.dirname(source), "outside-secret.txt");
    const sourceFile = path.join(source, "index.html");
    await writeFile(sourceFile, "safe", "utf8");
    await writeFile(outside, "secret", "utf8");
    const plan = planFor(source, workspace, await sourceIdentityOf(source));
    let swapped = false;
    const result = await copyIntoStaging(source, stagingPathFor(plan, "op-race"), {
      expectedSourceIdentity: plan.sourceIdentity,
      async afterEntryStat(relativePath) {
        if (relativePath !== "index.html") return;
        await rm(sourceFile);
        await symlink(outside, sourceFile);
        swapped = true;
      },
    });
    expect(swapped).toBe(true);
    expect(result).toMatchObject({ code: "write_conflict" });
  });

  it("skips the rebuildable directories without failing", async () => {
    const { workspace, source } = await scratch();
    await mkdir(path.join(source, "node_modules", "left-pad"), { recursive: true });
    await writeFile(path.join(source, "node_modules", "left-pad", "index.js"), "x", "utf8");
    await mkdir(path.join(source, ".git"), { recursive: true });
    await writeFile(path.join(source, ".git", "HEAD"), "ref", "utf8");
    await writeFile(path.join(source, "index.html"), "x", "utf8");

    const plan = planFor(source, workspace, await sourceIdentityOf(source));
    const staging = stagingPathFor(plan, "op-1");
    await copyIntoStaging(source, staging);
    await commitStaging(staging, plan.target);
    expect((await readdir(plan.target)).sort()).toEqual(["index.html"]);
  });

  it("notices when the source was replaced between plan and copy", async () => {
    const { workspace, source } = await scratch();
    const plan = planFor(source, workspace, await sourceIdentityOf(source));

    await rm(source, { recursive: true, force: true });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "index.html"), "different project", "utf8");

    // A path can be repointed at something else and remain the same string,
    // which is why the identity is device, inode and inode change time rather
    // than the path. Linux hands the freed inode straight back, so `dev:ino`
    // alone repeats after a delete-and-recreate — this test caught that on CI.
    const now = await sourceIdentityOf(source);
    expect(assertSourceUnchanged(plan, now).ok).toBe(false);
  });
});

describe("staged project validation", () => {
  it.each([
    ["hyperframes.json", ["vidcom.json", "index.html"]],
    ["vidcom.json", ["hyperframes.json", "index.html"]],
    ["index.html", ["hyperframes.json", "vidcom.json"]],
  ] as const)("refuses a project missing %s before publication", async (missing, present) => {
    const { workspace } = await scratch();
    const staging = path.join(workspace, ".validate.tmp");
    await mkdir(staging);
    for (const name of present) {
      const content = name === "vidcom.json" ? '{"id":"project_valid"}' : "{}";
      await writeFile(path.join(staging, name), content, "utf8");
    }
    expect(await validateStagedProject(staging)).toMatchObject({
      code: "path_invalid",
      message: expect.stringContaining(missing),
    });
  });

  it("refuses malformed config and an empty ProjectId", async () => {
    const { workspace } = await scratch();
    const staging = path.join(workspace, ".validate-invalid.tmp");
    await mkdir(staging);
    await writeFile(path.join(staging, "index.html"), "<!doctype html>", "utf8");
    await writeFile(path.join(staging, "hyperframes.json"), "[]", "utf8");
    await writeFile(path.join(staging, "vidcom.json"), '{"id":""}', "utf8");
    expect(await validateStagedProject(staging)).toMatchObject({ message: expect.stringContaining("hyperframes.json") });
    await writeFile(path.join(staging, "hyperframes.json"), "{}", "utf8");
    expect(await validateStagedProject(staging)).toMatchObject({ message: expect.stringContaining("ProjectId") });
  });

  it("bounds marker reads instead of materializing an arbitrarily large config", async () => {
    const { workspace } = await scratch();
    const staging = path.join(workspace, ".validate-large.tmp");
    await mkdir(staging);
    await writeFile(path.join(staging, "index.html"), "<!doctype html>", "utf8");
    await writeFile(path.join(staging, "vidcom.json"), '{"id":"project_large"}', "utf8");
    await writeFile(path.join(staging, "hyperframes.json"), "x".repeat(1_024 * 1_024 + 1), "utf8");
    expect(await validateStagedProject(staging)).toMatchObject({ code: "too_large" });
  });
});

describe("canonical import paths", () => {
  it("collapses a physical directory alias before overlap planning", async () => {
    const { workspace } = await scratch();
    const alias = path.join(path.dirname(workspace), "workspace-alias");
    await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
    const canonical = await canonicalImportPaths(alias, workspace);
    expect(canonical.source).toBe(canonical.workspaceRoot);
    expect(planProjectImport({
      ...canonical,
      sourceIdentity: await sourceIdentityOf(canonical.source),
      taken: [],
    }).ok).toBe(false);
  });
});

describe("import recovery", () => {
  it("finishes an operation the database says completed", async () => {
    const { workspace, source } = await scratch();
    await writeFile(path.join(source, "index.html"), "x", "utf8");
    const plan = planFor(source, workspace, await sourceIdentityOf(source));
    const staging = stagingPathFor(plan, "op-1");
    await copyIntoStaging(source, staging);
    await writeStagingMarker(staging, {
      operationId: "op-1",
      slug: plan.slug,
      source,
      target: plan.target,
      startedAt: "2026-08-09T00:00:00.000Z",
    });

    // Only the rename was left, so recovery does the rename.
    expect(await recoverImportStaging(workspace, () => Promise.resolve(true)))
      .toEqual([{ staging, action: "committed" }]);
    expect(await readdir(plan.target)).toEqual(["index.html"]);
  });

  it("clears an operation that never completed", async () => {
    // A partial copy is worth nothing, and leaving it makes the next import
    // pick a different slug to avoid a directory nobody wants.
    const { workspace, source } = await scratch();
    const plan = planFor(source, workspace, await sourceIdentityOf(source));
    const staging = stagingPathFor(plan, "op-1");
    await writeStagingMarker(staging, {
      operationId: "op-1",
      slug: plan.slug,
      source,
      target: plan.target,
      startedAt: "2026-08-09T00:00:00.000Z",
    });

    expect(await recoverImportStaging(workspace, () => Promise.resolve(false)))
      .toEqual([{ staging, action: "removed" }]);
    expect(await readdir(workspace)).toEqual([]);
  });

  it("keeps the marker until the rename has actually happened", async () => {
    // Found by reviewing the diff, not by a failure. Removing the marker first
    // and then failing the rename leaves a staging directory no recovery can
    // recognise again — rubbish in the user's workspace that nothing cleans up.
    const { workspace, source } = await scratch();
    await writeFile(path.join(source, "index.html"), "x", "utf8");
    const plan = planFor(source, workspace, await sourceIdentityOf(source));
    const staging = stagingPathFor(plan, "op-1");
    await copyIntoStaging(source, staging);
    await writeStagingMarker(staging, {
      operationId: "op-1",
      slug: plan.slug,
      source,
      target: plan.target,
      startedAt: "2026-08-09T00:00:00.000Z",
    });

    // The target already exists, so the rename cannot succeed.
    await mkdir(plan.target, { recursive: true });
    await writeFile(path.join(plan.target, "keep.txt"), "mine", "utf8");
    expect(await commitStaging(staging, plan.target)).not.toBeNull();

    // Still recoverable: the marker is where it was.
    expect((await listStagingDirectories(workspace)).map((entry) => entry.staging)).toEqual([staging]);
  });

  it("never touches a directory that has no marker", async () => {
    // A directory that merely looks temporary may be something a person made,
    // and deleting it would be this code guessing.
    const { workspace } = await scratch();
    const impostor = path.join(workspace, ".notes.vidcom-import-op-9.tmp");
    await mkdir(impostor, { recursive: true });
    await writeFile(path.join(impostor, "keep.txt"), "mine", "utf8");

    expect(await listStagingDirectories(workspace)).toEqual([]);
    expect(await recoverImportStaging(workspace, () => Promise.resolve(false))).toEqual([]);
    expect(await readFile(path.join(impostor, "keep.txt"), "utf8")).toBe("mine");
  });

  it("leaves nothing behind when an import fails", async () => {
    const { workspace, source } = await scratch();
    await symlink(source, path.join(source, "loop"));
    const plan = planFor(source, workspace, await sourceIdentityOf(source));
    const staging = stagingPathFor(plan, "op-1");
    const result = await copyIntoStaging(source, staging);
    expect(result).toMatchObject({ code: "path_invalid" });

    await rm(staging, { recursive: true, force: true });
    expect(await readdir(workspace)).toEqual([]);
  });
});

describe("import of a real project directory", () => {
  it.each([
    ["landscape", { width: 1920, height: 1080 }],
    ["portrait", { width: 1080, height: 1920 }],
  ])("imports a %s project with its identity and sub-composition", async (_shape, size) => {
    // A generated project rather than a committed one: the shapes an import has
    // to survive are a marker, an identity, a sub-composition directory and
    // preview settings, and those are written here where they can be read.
    const { workspace } = await scratch();
    const outside = await mkdtemp(path.join(tmpdir(), "vidcom-import-source-"));
    roots.push(outside);
    const sample = await writeSampleProject(outside, {
      slug: "sample",
      id: "project_import_sample",
      ...size,
    });
    const plan = planFor(sample.root, workspace, await sourceIdentityOf(sample.root));
    const staging = stagingPathFor(plan, "op-1");
    const report = await copyIntoStaging(sample.root, staging);
    expect(report, JSON.stringify(report)).toMatchObject({ files: expect.any(Number) });
    expect(await commitStaging(staging, plan.target)).toBeNull();
    const landed = await readdir(plan.target);
    expect(landed).toContain("vidcom.json");
    expect(landed).toContain("compositions");
  }, 60_000);
});

describe("import into a workspace that already has the name", () => {
  it("puts the second copy beside the first", async () => {
    const { workspace, source } = await scratch();
    await writeFile(path.join(source, "index.html"), "x", "utf8");
    await cp(source, path.join(workspace, "source"), { recursive: true });

    const plan = planFor(source, workspace, await sourceIdentityOf(source), ["source"]);
    expect(plan.slug).toBe("source-2");
    const staging = stagingPathFor(plan, "op-2");
    await copyIntoStaging(source, staging);
    expect(await commitStaging(staging, plan.target)).toBeNull();
    expect((await readdir(workspace)).sort()).toEqual(["source", "source-2"]);
  });
});
