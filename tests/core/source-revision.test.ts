import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AppDataAssetStager,
  initializeDatabase,
  LargePreviousContentStore,
  MutationJournal,
  WorkspaceFs,
  WorkspaceLease,
} from "@vidcom/adapter";
import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import {
  WriteAuthority,
  inferMutationPurpose,
  type AbsolutePath,
  type ClockPort,
  type DerivedMutationRequest,
  type DerivedMutationPath,
  type ProjectRef,
  type SourceMutationRequest,
} from "@vidcom/core";

import { createSequentialIdPort } from "../support/deterministic";
import { dbRun } from "../support/database";

const clock: ClockPort = { now: () => new Date("2026-08-04T12:00:00.000Z") };
const projectId = "project_source_revision" as ProjectId;
const digest = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

let cleanupRoot: string | null = null;
let closeDatabase: (() => Promise<void>) | null = null;

afterEach(async () => {
  await closeDatabase?.();
  closeDatabase = null;
  if (cleanupRoot) await rm(cleanupRoot, { recursive: true, force: true });
  cleanupRoot = null;
});

describe("source revision boundary with real SQLite and filesystem", () => {
  it("locks the six-row mutation method and path purpose table", () => {
    expect([
      inferMutationPurpose("source", "vidcom.json" as RelPath),
      inferMutationPurpose("source", "assets/logo.png" as RelPath),
      inferMutationPurpose("source", "index.html" as RelPath),
      inferMutationPurpose("derived", ".vidcom/state.json" as RelPath),
      inferMutationPurpose("derived", "renders/final.mp4" as RelPath),
      inferMutationPurpose("workspace", "AGENTS.md" as RelPath),
    ]).toEqual([
      "system-write",
      "write-asset",
      "write-source",
      "state-write",
      "write-asset",
      "workspace-agent-kit",
    ]);
    expect(inferMutationPurpose("source", "snapshots/state.json" as RelPath)).toBeNull();
    expect(inferMutationPurpose("derived", "index.html" as RelPath)).toBeNull();
    expect(inferMutationPurpose("workspace", "index.html" as RelPath)).toBeNull();
  });

  it("keeps a completed render from making a current snapshot stale", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-source-revision-"));
    cleanupRoot = root;
    const workspaceRoot = path.join(root, "workspace");
    const projectRoot = path.join(workspaceRoot, "project");
    const appDataRoot = path.join(root, "app-data");
    await mkdir(path.join(projectRoot, ".vidcom"), { recursive: true });
    await mkdir(path.join(projectRoot, "snapshots"), { recursive: true });
    await mkdir(path.join(projectRoot, "renders"), { recursive: true });
    await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
    await writeFile(path.join(projectRoot, "vidcom.json"), JSON.stringify({ id: projectId }));
    await writeFile(path.join(projectRoot, "index.html"), "source-0");

    const database = await initializeDatabase(appDataRoot);
    closeDatabase = () => database.destroy();
    dbRun(database, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
    projectId, workspaceRoot, "project", clock.now().toISOString(), clock.now().toISOString());

    const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
    const journal = new MutationJournal(database, clock, new LargePreviousContentStore(appDataRoot));
    const lease = new WorkspaceLease(database, clock, createSequentialIdPort());
    const acquired = await lease.acquire(workspaceRoot as AbsolutePath, "test:source-revision");
    if (!acquired.ok) throw new Error("test lease was denied");
    const ref: ProjectRef = {
      id: projectId,
      slug: "project",
      root: projectRoot as AbsolutePath,
      entry: "index.html" as RelPath,
    };
    if (false) {
      const sourceContract: SourceMutationRequest = {
        kind: "file",
        ref,
        path: "index.html" as RelPath,
        content: "forbidden-purpose",
        expectedContentHash: null,
        // @ts-expect-error D.1: source callers cannot select a path purpose.
        purpose: "state-write",
      };
      const authoredPath = "index.html" as RelPath;
      const derivedContract: DerivedMutationRequest = {
        ref,
        writes: [{
          // @ts-expect-error D.2: a general authored path is not a DerivedMutationPath.
          path: authoredPath,
          content: "forbidden-derived-path",
        }],
        producedByJobId: null,
        computedAtSourceRevision: 0,
      };
      void sourceContract;
      void derivedContract;
    }
    const authority = new WriteAuthority({
      workspace,
      journal,
      compositeJournal: journal,
      lease,
      leaseId: acquired.leaseId,
      hashContent: digest,
      stagedAssets: new AppDataAssetStager(appDataRoot),
      invalidate() {},
      notifyEvents() {},
    });

    const source = await authority.mutateSource({
      kind: "file",
      ref,
      path: "index.html" as RelPath,
      content: "source-1",
      expectedContentHash: digest("source-0"),
    }, "user");
    expect(source).toMatchObject({ ok: true, value: { revision: 1 } });

    const snapshotState = {
      schemaVersion: 1,
      sourceRevision: 1,
      snapshots: { complete: true, computedAtSourceRevision: 1 },
      lastRender: null,
    };
    const snapshot = await authority.mutateDerived({
      ref,
      writes: [
        { path: "snapshots/scene-1.png" as DerivedMutationPath, content: new Uint8Array([1, 2, 3]) },
        { path: ".vidcom/state.json" as DerivedMutationPath, content: `${JSON.stringify(snapshotState)}\n` },
      ],
      producedByJobId: "job_snapshot_1" as never,
      computedAtSourceRevision: 1,
    }, "system");
    expect(snapshot).toMatchObject({ ok: true });
    expect(await journal.latestSourceRevision(projectId)).toBe(1);

    const renderState = {
      ...snapshotState,
      lastRender: { artifactPath: "renders/final.mp4", computedAtSourceRevision: 1 },
    };
    const renderCompletion = await authority.mutateDerived({
      ref,
      writes: [
        { path: "renders/final.mp4" as DerivedMutationPath, content: new Uint8Array([4, 5, 6]) },
        { path: ".vidcom/state.json" as DerivedMutationPath, content: `${JSON.stringify(renderState)}\n` },
      ],
      producedByJobId: "job_render_1" as never,
      computedAtSourceRevision: 1,
    }, "system");
    expect(renderCompletion).toMatchObject({ ok: true });

    const sourceRevisionAfterRender = await journal.latestSourceRevision(projectId);
    const persisted = JSON.parse(await readFile(path.join(projectRoot, ".vidcom/state.json"), "utf8")) as {
      sourceRevision: number;
      snapshots: { computedAtSourceRevision: number };
    };
    expect(sourceRevisionAfterRender).toBe(1);
    expect(persisted.sourceRevision).toBe(1);
    expect(persisted.snapshots.computedAtSourceRevision < sourceRevisionAfterRender!).toBe(false);
  });
});
