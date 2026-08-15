import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  sourceIdentityOf,
} from "@vidcom/adapter";
import {
  createProjectImportJobDependencies,
  createStartProjectImport,
} from "@vidcom/cli";
import { ErrorCode } from "@vidcom/contracts";
import type { WorkspaceOperationJournalPort } from "@vidcom/core";
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
  await writeFile(path.join(source, "hyperframes.json"), "{}\n", "utf8");
  await writeFile(path.join(source, "vidcom.json"), '{"id":"project_import_fixture"}\n', "utf8");
  await writeFile(path.join(source, "scenes", "one.html"), "<section></section>\n", "utf8");
  return { workspace, source };
}

const findNoExisting = () => Promise.resolve(null);

function journal(): WorkspaceOperationJournalPort {
  let nextId = 0;
  return {
    begin: () => Promise.resolve(++nextId as never),
    setDirectoryPaths: () => Promise.resolve(),
    commit: () => Promise.resolve(),
    abort: () => Promise.resolve(),
    orphan: () => Promise.resolve(),
  } as unknown as WorkspaceOperationJournalPort;
}

function filesystemDependencies(input: { backfill(target: string): Promise<void> }) {
  return createProjectImportJobDependencies({
    takenSlugs: () => Promise.resolve([]),
    backfill: input.backfill,
    journal: journal(),
    leaseId: "lease_test",
    now: () => "2026-08-09T00:00:00.000Z",
  });
}

async function planInput(source: string, workspaceRoot: string) {
  return { source, sourceIdentity: await sourceIdentityOf(source), workspaceRoot };
}

async function selection(canonicalPath: string) {
  const [device, inode] = (await sourceIdentityOf(canonicalPath)).split(":", 2) as [string, string];
  return { canonicalPath, identity: { device, inode } };
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
      findExisting: findNoExisting,
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
    const held = await selection(inside);
    let queued = 0;
    const start = createStartProjectImport({
      workspaceRoot: workspace,
      takenSlugs: () => Promise.resolve([]),
      resolveSelection: () => held,
      findExisting: findNoExisting,
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

  it("refuses a physical workspace alias before queuing", async () => {
    const { workspace } = await scratch();
    const alias = path.join(path.dirname(workspace), "workspace-link");
    await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
    const held = await selection(alias);
    let queued = false;
    const start = createStartProjectImport({
      workspaceRoot: workspace,
      takenSlugs: () => Promise.resolve([]),
      resolveSelection: () => held,
      findExisting: findNoExisting,
      enqueue: () => {
        queued = true;
        return Promise.resolve({ ok: true, value: { id: "job_alias" } });
      },
    });
    expect((await start({ selectionToken: "held" })).ok).toBe(false);
    expect(queued).toBe(false);
  });

  it("returns the job id the client will poll", async () => {
    const { workspace, source } = await scratch();
    const held = await selection(source);
    const start = createStartProjectImport({
      workspaceRoot: workspace,
      takenSlugs: () => Promise.resolve([]),
      resolveSelection: () => held,
      findExisting: findNoExisting,
      enqueue: () => Promise.resolve({ ok: true, value: { id: "job_7" } }),
    });
    expect(await start({ selectionToken: "held", targetName: "Imported" }))
      .toEqual({ ok: true, value: { jobId: "job_7" } });
  });

  it("reuses an active import, conflicts after success, and permits a failed retry", async () => {
    const { workspace, source } = await scratch();
    const held = await selection(source);
    let status: "queued" | "succeeded" | "failed" | null = null;
    let existingKey: string | null = null;
    let enqueues = 0;
    const start = createStartProjectImport({
      workspaceRoot: workspace,
      takenSlugs: () => Promise.resolve([]),
      resolveSelection: () => held,
      findExisting: (key) => Promise.resolve(existingKey === key && status
        ? { id: "job_original", status }
        : null),
      enqueue: (input) => {
        enqueues += 1;
        existingKey = input.idempotencyKey;
        status = "queued";
        return Promise.resolve({ ok: true, value: { id: "job_original" } });
      },
    });

    expect(await start({ selectionToken: "held" })).toEqual({ ok: true, value: { jobId: "job_original" } });
    expect(await start({ selectionToken: "held" })).toEqual({ ok: true, value: { jobId: "job_original" } });
    expect(enqueues).toBe(1);
    status = "succeeded";
    expect(await start({ selectionToken: "held" })).toMatchObject({
      ok: false,
      error: { code: ErrorCode.ProjectImportConflict },
    });
    status = "failed";
    expect(await start({ selectionToken: "held" })).toEqual({ ok: true, value: { jobId: "job_original" } });
    expect(enqueues).toBe(2);
  });
});

describe("project import job dependencies on a real filesystem", () => {
  it("stages, commits and leaves the source untouched", async () => {
    const { workspace, source } = await scratch();
    const backfilled: string[] = [];
    const dependencies = filesystemDependencies({
      backfill: (target) => {
        backfilled.push(target);
        return Promise.resolve();
      },
    });

    const input = await planInput(source, workspace);
    const planned = await dependencies.plan(input);
    const copied = await dependencies.copy(planned.source, input.sourceIdentity, planned.staging);
    expect(copied.files).toBeGreaterThan(0);
    await dependencies.validate(planned.staging);
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
    const dependencies = filesystemDependencies({
      backfill: () => Promise.resolve(),
    });
    const input = await planInput(source, workspace);
    const planned = await dependencies.plan(input);
    await dependencies.copy(planned.source, input.sourceIdentity, planned.staging);
    await dependencies.discard(planned.staging);
    expect(await readdir(workspace)).toEqual([]);
    expect(await readFile(path.join(source, "index.html"), "utf8")).toContain("<title>x</title>");
  });

  it("gives every attempt its own staging directory", async () => {
    // Two imports of the same source must not share one, or recovery cannot say
    // whose leftovers it found.
    const { workspace, source } = await scratch();
    const dependencies = filesystemDependencies({
      backfill: () => Promise.resolve(),
    });
    const input = await planInput(source, workspace);
    const first = await dependencies.plan(input);
    const second = await dependencies.plan(input);
    expect(first.staging).not.toBe(second.staging);
  });
});
