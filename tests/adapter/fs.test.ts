import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProjectId, RelPath } from "@vidcom/contracts";
import type { AbsolutePath, PathPurpose, ProjectRef, ResolvedPath } from "@vidcom/core";
import { mimeFromPath, PATH_REJECTION_MAP, resolveProjectPath, WorkspaceFs } from "@vidcom/adapter";
import { canCreateSymlinks } from "../support/platform";

// Creating a symlink needs Developer Mode or elevation on Windows. The escape
// rules themselves are platform-independent, so these cases are skipped only
// where the fixture cannot be built — a Windows host with Developer Mode on
// still runs them.
const itWithSymlinks = canCreateSymlinks ? it : it.skip;

let temporaryRoot: string;
let workspace: string;
let projectRoot: string;
let project: ProjectRef;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), "vidcom-fs-test-"));
  workspace = path.join(temporaryRoot, "workspace");
  projectRoot = path.join(workspace, "project-a");
  await mkdir(path.join(projectRoot, "compositions"), { recursive: true });
  await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
  await writeFile(path.join(projectRoot, "vidcom.json"), '{"id":"project_0001"}\n');
  await writeFile(path.join(projectRoot, "index.html"), "old");
  project = {
    id: "project_0001" as ProjectId,
    slug: "project-a",
    root: projectRoot as AbsolutePath,
    entry: "index.html" as RelPath,
  };
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("filesystem containment", () => {
  const purposes: PathPurpose[] = [
    "read-source",
    "read-asset",
    "write-source",
    "write-asset",
    "system-write",
  ];

  it.each(purposes)("rejects traversal and absolute paths for %s", async (purpose) => {
    await expect(resolveProjectPath(project, "../secret", purpose)).resolves.toEqual({
      ok: false,
      error: { reason: "invalid_syntax" },
    });
    await expect(resolveProjectPath(project, path.join(temporaryRoot, "secret"), purpose)).resolves.toEqual({
      ok: false,
      error: { reason: "invalid_syntax" },
    });
  });

  itWithSymlinks.each([
    ["read-source", "escape/scene.html", "escape"],
    ["write-source", "escape/scene.html", "escape"],
    ["read-asset", "assets/poster.png", "assets"],
    ["write-asset", "assets/poster.png", "assets"],
    ["system-write", "narration/scene.json", "narration"],
  ] as const)("rejects existing and missing targets through a %s symlink", async (purpose, target, link) => {
    const outside = path.join(temporaryRoot, `outside-${purpose}`);
    await mkdir(outside);
    await writeFile(path.join(outside, path.basename(target)), "outside");
    await symlink(outside, path.join(projectRoot, link), "dir");
    await expect(resolveProjectPath(project, target, purpose)).resolves.toEqual({
      ok: false,
      error: { reason: "symlink_escape" },
    });
    await expect(resolveProjectPath(project, `${link}/missing${path.extname(target)}`, purpose)).resolves.toEqual({
      ok: false,
      error: { reason: "symlink_escape" },
    });
  });
});

describe("allowlist and workspace I/O", () => {
  itWithSymlinks.each(["package.json", "AGENTS.md", ".env"])(
    "rejects an allowed-looking asset symlink whose canonical target is protected: %s",
    async (protectedName) => {
      await mkdir(path.join(projectRoot, "assets"));
      await writeFile(path.join(projectRoot, protectedName), "private");
      await symlink(path.join("..", protectedName), path.join(projectRoot, "assets", `${protectedName}.png`));

      await expect(
        resolveProjectPath(project, `assets/${protectedName}.png`, "read-asset"),
      ).resolves.toEqual({
        ok: false,
        error: { reason: "not_allowed_for_purpose" },
      });
    },
  );

  it("locks asset extension and MIME independently of client content", async () => {
    await mkdir(path.join(projectRoot, "assets"));
    await writeFile(path.join(projectRoot, "assets/payload.exe"), "PNG");
    await expect(resolveProjectPath(project, "assets/payload.exe", "read-asset")).resolves.toEqual({
      ok: false,
      error: { reason: "not_allowed_for_purpose" },
    });
    expect(mimeFromPath("assets/poster.PNG")).toBe("image/png");
    expect(mimeFromPath("assets/payload.exe")).toBeNull();
    expect(PATH_REJECTION_MAP.symlink_escape).toEqual(PATH_REJECTION_MAP.outside_project);
  });

  it("never resolves workspace-agent-kit paths against a project root", async () => {
    const adapter = new WorkspaceFs(workspace as AbsolutePath);
    await expect(adapter.resolve(project, "AGENTS.md", "workspace-agent-kit")).resolves.toEqual({
      ok: false,
      error: { reason: "not_allowed_for_purpose" },
    });
    await expect(resolveProjectPath(project, ".agents/skills/vidcom/SKILL.md", "workspace-agent-kit"))
      .resolves.toEqual({ ok: false, error: { reason: "not_allowed_for_purpose" } });
  });

  it("creates a missing target and reads hash, content, stat, tree and identity", async () => {
    const adapter = new WorkspaceFs(workspace as AbsolutePath);
    const resolved = await adapter.resolve(project, "compositions/new.html", "write-source");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    await adapter.writeAtomic(resolved.value, "new content");
    expect(await adapter.readFile(resolved.value)).toMatchObject({ content: "new content" });
    expect(await adapter.readHash(resolved.value)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await adapter.stat(resolved.value)).toMatchObject({ kind: "file", size: 11 });
    expect(await adapter.readProjectRef(project.id)).toMatchObject({ slug: "project-a" });
    expect(await adapter.readTree(project)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "compositions", kind: "folder" })]),
    );
    expect(await adapter.exists(resolved.value)).toBe(true);
    await adapter.deleteAtomic(resolved.value);
    expect(await adapter.exists(resolved.value)).toBe(false);
    await expect(adapter.deleteAtomic(resolved.value)).resolves.toBeUndefined();
  });

  itWithSymlinks("hashes only a no-follow regular-file capability", async () => {
    const adapter = new WorkspaceFs(workspace as AbsolutePath);
    const outside = path.join(temporaryRoot, "outside-hash.bin");
    const linked = path.join(projectRoot, "linked-hash.bin");
    await writeFile(outside, "outside");
    await symlink(outside, linked);

    await expect(adapter.readHash(linked as ResolvedPath)).rejects.toBeDefined();
  });

  it("preserves the old target when the process dies before rename", async () => {
    const target = path.join(projectRoot, "index.html") as ResolvedPath;
    const moduleUrl = pathToFileURL(path.resolve("packages/adapter/src/fs/atomic-write.ts")).href;
    const program = `import { writeAtomic } from ${JSON.stringify(moduleUrl)}; await writeAtomic(${JSON.stringify(
      target,
    )}, "replacement", { beforeRename: async () => { process.stdout.write("READY\\n"); await new Promise(() => {}); } });`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
      child.stderr.once("data", (chunk) => reject(new Error(String(chunk))));
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    expect(await readFile(target, "utf8")).toBe("old");
  });
});
