import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AppSettingsStore,
  initializeDatabase,
  migrateDatabase,
  openVidcomDatabase,
} from "@vidcom/adapter";
import { type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  EntryRegistry,
  type AbsolutePath,
  type ProjectContext,
  type ProjectRef,
} from "@vidcom/core";
import {
  createApplication,
  createInfrastructure,
  hashContent,
} from "../../packages/cli/src/composition-root";
import { selectWorkspace } from "../../packages/cli/src/workspace-selection";

import { dbOne, dbRun } from "../support/database";
import { writeSampleProject } from "../support/sample-project";

const run = promisify(execFile);
const roots: string[] = [];
const now = "2026-08-04T00:00:00.000Z";
const clock = { now: () => new Date(now) };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const composition = (id = "scene-a") => `<!doctype html><html><body>
  <main data-composition-id="main" data-width="320" data-height="180" data-duration="1">
    <section data-composition-id="${id}" data-start="0" data-duration="1"></section>
  </main></body></html>`;

async function runtimeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-project-state-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const appDataRoot = path.join(root, "app-data");
  const projectRoot = path.join(workspaceRoot, "project");
  await mkdir(projectRoot, { recursive: true });
  const projectId = "project_state" as ProjectId;
  const preview = '{"fps":30,"resolution":{"width":320,"height":180},"safeZones":[],"background":"#000000","deviceScaleFactor":1}\n';
  await Promise.all([
    writeFile(path.join(projectRoot, "vidcom.json"), `${JSON.stringify({ id: projectId })}\n`),
    writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n"),
    writeFile(path.join(projectRoot, "index.html"), composition()),
    writeFile(path.join(projectRoot, "preview-settings.json"), preview),
  ]);
  const initialized = await initializeDatabase(appDataRoot);
  await initialized.destroy();
  const infrastructure = createInfrastructure({
    appDataRoot,
    workspaceRoot: workspaceRoot as AbsolutePath,
    clock,
  });
  dbRun(infrastructure.database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, 'project', ?, ?)`,
  projectId, workspaceRoot, now, now);
  dbRun(infrastructure.database, `INSERT INTO entity_state
    (project_id, entity, revision, content_hash, backing_path, last_actor, updated_at)
    VALUES (?, 'preview-settings', 0, ?, 'preview-settings.json', 'system', ?)`,
  projectId, hashContent(preview), now);
  const lease = await infrastructure.lease.acquire(workspaceRoot as AbsolutePath, "test:project-state");
  if (!lease.ok) throw new Error("workspace lease was denied");
  const application = createApplication(infrastructure, lease.leaseId);
  const ref: ProjectRef = {
    id: projectId,
    slug: "project",
    root: projectRoot as AbsolutePath,
    entry: "index.html" as RelPath,
  };
  return { root, workspaceRoot, appDataRoot, projectRoot, projectId, infrastructure, application, ref };
}

describe("workspace discovery and project state on real SQLite/filesystem", () => {
  it("opens an empty cwd and keeps an invalid cwd marker ahead of saved active workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-workspace-selection-"));
    roots.push(root);
    const empty = path.join(root, "empty");
    const active = path.join(root, "active");
    const workspace = path.join(root, "workspace");
    const invalidProject = path.join(workspace, "broken");
    const appData = path.join(root, "app-data");
    await Promise.all([mkdir(empty), mkdir(active), mkdir(invalidProject, { recursive: true })]);
    await writeFile(path.join(invalidProject, "vidcom.json"), "{broken\n");
    const database = await initializeDatabase(appData);
    try {
      await expect(selectWorkspace({ appDataRoot: appData, cwd: empty, database })).resolves.toBe(empty);
      await expect(selectWorkspace({ explicit: active, appDataRoot: appData, database })).resolves.toBe(active);
      await expect(selectWorkspace({ appDataRoot: appData, cwd: invalidProject, database }))
        .resolves.toBe(workspace);
    } finally {
      await database.destroy();
    }
  });

  it("warns with the deleted active path before falling back to cwd", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-active-fallback-"));
    roots.push(root);
    const active = path.join(root, "active");
    const cwd = path.join(root, "cwd");
    const appData = path.join(root, "app-data");
    await Promise.all([mkdir(active), mkdir(cwd)]);
    // Recorded directly: resolving a workspace no longer writes one, so the
    // saved value has to be planted rather than produced as a side effect.
    // Only FoundationManager.activate records an active workspace now.
    const database = openVidcomDatabase(appData);
    try {
      await migrateDatabase(database);
      new AppSettingsStore(database).set("active_workspace", active);
      await rm(active, { recursive: true });
      const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      await expect(selectWorkspace({ appDataRoot: appData, cwd, database })).resolves.toBe(cwd);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(active), {
        code: "active_workspace_unreadable",
      });
    } finally {
      await database.destroy();
    }
  });

  it("keeps entry IDs session-local, idempotent, revocable, and workspace-scoped", () => {
    let sequence = 0;
    const registry = new EntryRegistry({ newId: () => `entry_${++sequence}` });
    const workspaceA = "/workspace-a" as AbsolutePath;
    const workspaceB = "/workspace-b" as AbsolutePath;
    const first = registry.mint(workspaceA, "broken", "/workspace-a/broken" as AbsolutePath);
    expect(registry.mint(workspaceA, "broken", "/workspace-a/broken" as AbsolutePath)).toBe(first);
    expect(registry.resolve(first)?.workspaceRoot).toBe(workspaceA);
    registry.revoke(first);
    expect(registry.resolve(first)).toBeNull();
    const second = registry.mint(workspaceB, "broken", "/workspace-b/broken" as AbsolutePath);
    registry.clear();
    expect(registry.resolve(second)).toBeNull();
  });

  it("classifies all workspace states and never overwrites malformed strict identity", async () => {
    const value = await runtimeFixture();
    const fullIdentity = value.application.identity.serialize({
      schemaVersion: 1,
      id: "project_empty" as ProjectId,
      platform: null,
      render: { defaultPresetId: "horizontal-youtube", outputDirectory: "renders" },
      narration: { defaultProviderId: null, defaultVoiceId: null },
      createdAt: now,
      updatedAt: now,
    });
    await Promise.all([
      mkdir(path.join(value.workspaceRoot, "empty")),
      mkdir(path.join(value.workspaceRoot, "broken-identity")),
      mkdir(path.join(value.workspaceRoot, "broken-composition")),
      mkdir(path.join(value.workspaceRoot, "candidate")),
      mkdir(path.join(value.workspaceRoot, ".ignored")),
    ]);
    await Promise.all([
      writeFile(path.join(value.workspaceRoot, "empty", "vidcom.json"), fullIdentity),
      writeFile(path.join(value.workspaceRoot, "broken-identity", "vidcom.json"),
        `${JSON.stringify({ ...JSON.parse(fullIdentity), id: "project_bad", secretValue: "must-survive" })}\n`),
      writeFile(path.join(value.workspaceRoot, "broken-composition", "vidcom.json"),
        fullIdentity.replace("project_empty", "project_bad_composition")),
      writeFile(path.join(value.workspaceRoot, "broken-composition", "index.html"), "<not-a-composition>"),
      writeFile(path.join(value.workspaceRoot, "candidate", "hyperframes.json"), "{}\n"),
      writeFile(path.join(value.workspaceRoot, ".ignored", "vidcom.json"), fullIdentity),
    ]);
    try {
      await expect(value.application.openProject(value.projectId)).resolves.toMatchObject({ ok: true });
      const entries = await value.application.scanWorkspace();
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ slug: "project", state: "authored", sceneCount: 1 }),
        expect.objectContaining({ slug: "empty", state: "empty", sceneCount: 0 }),
        expect.objectContaining({ slug: "broken-identity", state: "invalid", invalidKind: "identity" }),
        expect.objectContaining({ slug: "broken-composition", state: "invalid", invalidKind: "composition" }),
        { kind: "candidate", slug: "candidate" },
      ]));
      expect(entries.some((entry) => entry.slug === ".ignored")).toBe(false);
      const malformed = await readFile(path.join(value.workspaceRoot, "broken-identity", "vidcom.json"), "utf8");
      expect(malformed).toContain("must-survive");
      await expect(value.application.identity.read(
        path.join(value.workspaceRoot, "broken-identity") as AbsolutePath,
      )).resolves.toMatchObject({ ok: false, reason: { field: "secretValue" } });
    } finally {
      await value.infrastructure.database.destroy();
    }
  });

  it("lazy-backfills prototypes and keeps only deterministic context payload visible to git", async () => {
    const value = await runtimeFixture();
    await run("git", ["init"], { cwd: value.projectRoot });
    await run("git", ["config", "user.email", "vidcom@example.test"], { cwd: value.projectRoot });
    await run("git", ["config", "user.name", "VidCom Test"], { cwd: value.projectRoot });
    await run("git", ["add", "."], { cwd: value.projectRoot });
    await run("git", ["commit", "-m", "fixture"], { cwd: value.projectRoot });
    try {
      await expect(value.application.openProject(value.projectId)).resolves.toMatchObject({ ok: true });
      const identity = JSON.parse(await readFile(path.join(value.projectRoot, "vidcom.json"), "utf8"));
      expect(identity).toMatchObject({
        schemaVersion: 1,
        id: value.projectId,
        platform: { presetId: "custom", width: 320, height: 180, fps: 30 },
      });
      const context: ProjectContext = {
        slug: "project",
        state: "authored",
        platform: identity.platform,
        sceneCount: 1,
        durationSeconds: 1,
        scenes: [{ id: "scene-a", start: 0, duration: 1, trackIndex: 0 }],
        narration: { cueCount: 0, staleSceneIds: [] },
        openIssues: [],
      };
      await expect(value.application.state.writeContext(value.ref, context)).resolves.toMatchObject({ ok: true });
      await run("git", ["add", ".vidcom/.gitignore", ".vidcom/context/project-context.md", "vidcom.json"], {
        cwd: value.projectRoot,
      });
      await run("git", ["commit", "-m", "open project"], { cwd: value.projectRoot });
      await value.application.state.log(value.ref, {
        at: now,
        level: "info",
        message: "opened",
        detail: { token: "must-not-leak", safe: "kept" },
      });
      await value.application.state.reconcile(value.ref);
      expect((await run("git", ["status", "--porcelain"], { cwd: value.projectRoot })).stdout).toBe("");
      expect((await run("git", ["ls-files", ".vidcom"], { cwd: value.projectRoot })).stdout.trim().split(/\r?\n/))
        .toEqual([".vidcom/.gitignore", ".vidcom/context/project-context.md"]);
      expect(await readFile(path.join(value.projectRoot, ".vidcom/logs/2026-08-04.jsonl"), "utf8"))
        .toContain('"token":"[REDACTED]"');
      await expect(value.application.state.pruneLogs(value.ref, 0)).resolves.toEqual({ deleted: 1 });
    } finally {
      await value.infrastructure.database.destroy();
    }
  }, 15_000);

  it("lazy-backfills all three shipped prototype identities from their real compositions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-prototype-backfill-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const appDataRoot = path.join(root, "app-data");
    await mkdir(workspaceRoot);
    // Legacy markers: id only, no platform — the exact state backfill repairs.
    const slugs = ["portrait-sample", "square-sample", "landscape-sample"] as const;
    const shapes: Record<(typeof slugs)[number], { width: number; height: number }> = {
      "portrait-sample": { width: 1080, height: 1920 },
      "square-sample": { width: 1080, height: 1080 },
      "landscape-sample": { width: 1920, height: 1080 },
    };
    for (const slug of slugs) {
      await writeSampleProject(workspaceRoot, { slug, id: `project_${slug}`, ...shapes[slug] });
    }
    const initialized = await initializeDatabase(appDataRoot);
    await initialized.destroy();
    const infrastructure = createInfrastructure({
      appDataRoot,
      workspaceRoot: workspaceRoot as AbsolutePath,
      clock,
    });
    const lease = await infrastructure.lease.acquire(workspaceRoot as AbsolutePath, "test:prototype-backfill");
    if (!lease.ok) throw new Error("workspace lease was denied");
    const application = createApplication(infrastructure, lease.leaseId);
    try {
      for (const slug of slugs) {
        const marker = JSON.parse(await readFile(path.join(workspaceRoot, slug, "vidcom.json"), "utf8")) as { id: string };
        dbRun(infrastructure.database, `INSERT INTO project_registry
          (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
        marker.id, workspaceRoot, slug, now, now);
        const ref = await infrastructure.workspace.readProjectRef(marker.id as ProjectId);
        if (!ref) throw new Error(`prototype ${slug} was not discovered`);
        const result = await application.identity.backfillPlatform(ref);
        expect(result).toMatchObject({ ok: true, value: { schemaVersion: 1, platform: expect.any(Object) } });
        const disk = JSON.parse(await readFile(path.join(workspaceRoot, slug, "vidcom.json"), "utf8"));
        expect(disk).toMatchObject({ id: marker.id, schemaVersion: 1, platform: expect.any(Object) });
      }
    } finally {
      await infrastructure.database.destroy();
    }
  }, 15_000);

  it("rebuilds projection only from SQLite and never imports tampered .vidcom rows", async () => {
    const value = await runtimeFixture();
    try {
      await expect(value.application.openProject(value.projectId)).resolves.toMatchObject({ ok: true });
      await value.infrastructure.jobs.enqueue({
        id: "job_projection" as never,
        projectId: value.projectId,
        type: "noop",
        input: {},
        inputHash: hashContent("{}"),
        idempotencyKey: null,
      });
      await value.infrastructure.jobs.finish("job_projection" as never, { status: "succeeded", result: { ok: true } });
      await mkdir(path.join(value.projectRoot, ".vidcom/jobs"), { recursive: true });
      await writeFile(path.join(value.projectRoot, ".vidcom/jobs/index.jsonl"),
        '{"jobId":"job_from_projection","status":"succeeded"}\n');
      const sourceBefore = await value.infrastructure.journal.latestSourceRevision(value.projectId);
      const jobsBefore = dbOne(value.infrastructure.database, "SELECT COUNT(*) AS count FROM job");
      await value.application.state.reconcile(value.ref);
      expect(await readFile(path.join(value.projectRoot, ".vidcom/jobs/index.jsonl"), "utf8"))
        .not.toContain("job_from_projection");
      expect(dbOne(value.infrastructure.database, "SELECT COUNT(*) AS count FROM job")).toEqual(jobsBefore);
      expect(await value.infrastructure.journal.latestSourceRevision(value.projectId)).toBe(sourceBefore);
    } finally {
      await value.infrastructure.database.destroy();
    }
  });

});
