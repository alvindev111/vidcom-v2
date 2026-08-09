import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createProjectImportJobDependencies,
  createStartProjectImport,
} from "@vidcom/cli";
import { ErrorCode } from "@vidcom/contracts";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<{ workspace: string; source: string }> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-import-svc-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const source = path.join(root, "outside", "fixture");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(source, "scenes"), { recursive: true });
  await writeFile(path.join(source, "index.html"), "<!doctype html><title>x</title>\n", "utf8");
  await writeFile(path.join(source, "scenes", "one.html"), "<section></section>\n", "utf8");
  return { workspace, source };
}

describe("start project import", () => {
  it("refuses a token it did not hand out", async () => {
    // The only accepted way in. A path a client can type is a path any page can
    // send, and the whole point of browse is that the server acts only on
    // directories it handed out itself.
    const start = createStartProjectImport({
      workspaceRoot: "/w",
      takenSlugs: () => Promise.resolve([]),
      resolveSelection: () => null,
      enqueue: () => Promise.reject(new Error("must not be reached")),
    });
    expect(await start({ selectionToken: "forged" })).toMatchObject({
      ok: false,
      error: { code: ErrorCode.BrowseTokenInvalid },
    });
  });

  it("plans before queuing, so an overlapping source is refused while the caller listens", async () => {
    const { workspace } = await scratch();
    const inside = path.join(workspace, "already-here");
    await mkdir(inside, { recursive: true });
    let queued = 0;
    const start = createStartProjectImport({
      workspaceRoot: workspace,
      takenSlugs: () => Promise.resolve([]),
      resolveSelection: () => ({ canonicalPath: inside }),
      enqueue: () => {
        queued += 1;
        return Promise.resolve({ ok: true, value: { id: "job_1" } });
      },
    });
    const result = await start({ selectionToken: "held" });
    expect(result.ok).toBe(false);
    // Refused here rather than inside a job the caller has to go and read.
    expect(queued).toBe(0);
  });

  it("returns the job id the client will poll", async () => {
    const { workspace, source } = await scratch();
    const start = createStartProjectImport({
      workspaceRoot: workspace,
      takenSlugs: () => Promise.resolve([]),
      resolveSelection: () => ({ canonicalPath: source }),
      enqueue: () => Promise.resolve({ ok: true, value: { id: "job_7" } }),
    });
    expect(await start({ selectionToken: "held", targetName: "Imported" }))
      .toEqual({ ok: true, value: { jobId: "job_7" } });
  });
});

describe("project import job dependencies on a real filesystem", () => {
  it("stages, commits and leaves the source untouched", async () => {
    const { workspace, source } = await scratch();
    const backfilled: string[] = [];
    const dependencies = createProjectImportJobDependencies({
      takenSlugs: () => Promise.resolve([]),
      backfill: (target) => {
        backfilled.push(target);
        return Promise.resolve();
      },
    });

    const planned = await dependencies.plan({ source, workspaceRoot: workspace });
    const copied = await dependencies.copy(source, planned.staging);
    expect(copied.files).toBeGreaterThan(0);
    await dependencies.commit(planned.staging, planned.target);
    await dependencies.backfill(planned.target);

    expect(await readFile(path.join(planned.target, "index.html"), "utf8")).toContain("<title>x</title>");
    expect(await readFile(path.join(planned.target, "scenes", "one.html"), "utf8")).toContain("section");
    expect(backfilled).toEqual([planned.target]);

    // Import copies; it never moves. A user who imported the wrong folder has
    // lost nothing.
    expect(await readFile(path.join(source, "index.html"), "utf8")).toContain("<title>x</title>");
    // And nothing staged is left behind in the workspace.
    expect((await readdir(workspace)).filter((entry) => entry.includes(".tmp"))).toEqual([]);
  });

  it("discards its staging without touching the workspace", async () => {
    const { workspace, source } = await scratch();
    const dependencies = createProjectImportJobDependencies({
      takenSlugs: () => Promise.resolve([]),
      backfill: () => Promise.resolve(),
    });
    const planned = await dependencies.plan({ source, workspaceRoot: workspace });
    await dependencies.copy(source, planned.staging);
    await dependencies.discard(planned.staging);
    expect(await readdir(workspace)).toEqual([]);
    expect(await readFile(path.join(source, "index.html"), "utf8")).toContain("<title>x</title>");
  });

  it("gives every attempt its own staging directory", async () => {
    // Two imports of the same source must not share one, or recovery cannot say
    // whose leftovers it found.
    const { workspace, source } = await scratch();
    const dependencies = createProjectImportJobDependencies({
      takenSlugs: () => Promise.resolve([]),
      backfill: () => Promise.resolve(),
    });
    const first = await dependencies.plan({ source, workspaceRoot: workspace });
    const second = await dependencies.plan({ source, workspaceRoot: workspace });
    expect(first.staging).not.toBe(second.staging);
  });
});
