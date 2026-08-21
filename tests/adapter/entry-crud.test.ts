import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceFs } from "@vidcom/adapter";
import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import type { AbsolutePath, ProjectRef } from "@vidcom/core";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(bytes: Uint8Array): ContentHash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
}

describe("WorkspaceFs staged entry source", () => {
  it("opens a no-follow hash-verified hard-link capability and discards only its owned temp", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-entry-source-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const projectRoot = path.join(workspaceRoot, "project");
    await mkdir(path.join(projectRoot, "assets"), { recursive: true });
    await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
    await writeFile(path.join(projectRoot, "vidcom.json"), `${JSON.stringify({ id: "project_entry_source" })}\n`);
    await writeFile(path.join(projectRoot, "index.html"), "<main></main>");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const source = path.join(projectRoot, "assets", "source.bin");
    await writeFile(source, bytes);
    const ref: ProjectRef = {
      id: "project_entry_source" as ProjectId,
      slug: "project",
      root: projectRoot as AbsolutePath,
      entry: "index.html" as RelPath,
    };
    const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);

    const handle = await workspace.openStagedSource(ref, "assets/source.bin" as RelPath, digest(bytes));
    expect(handle.source.contentHash).toBe(digest(bytes));
    await expect(readFile(handle.source.sourcePath)).resolves.toEqual(Buffer.from(bytes));
    await expect(readFile(source)).resolves.toEqual(Buffer.from(bytes));

    await handle.discard();
    await handle.discard();
    await expect(access(handle.source.sourcePath)).rejects.toThrow();
    await expect(readFile(source)).resolves.toEqual(Buffer.from(bytes));
    await expect(workspace.openStagedSource(
      ref,
      "assets/source.bin" as RelPath,
      digest(new TextEncoder().encode("wrong")),
    ))
      .rejects.toThrow("hash changed");
  });
});
