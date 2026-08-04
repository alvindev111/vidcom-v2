import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AbsolutePath, JobId, ProjectDirectoryPort, WorkspaceOperationJournalPort } from "@vidcom/core";
import { PLATFORM_PRESETS, WorkspaceMutationCoordinator } from "@vidcom/core";
import { initializeDatabase } from "@vidcom/adapter";
import type { ProjectId, RelPath } from "@vidcom/contracts";

import { createApplication, createInfrastructure, createMcpRegistry, hashContent } from "../../packages/cli/src/composition-root";
import { createSequentialIdPort } from "../support/deterministic";
import { dbAll, dbOne } from "../support/database";

const roots: string[] = [];
const now = "2026-08-04T16:45:00.000Z";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-lifecycle-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  const initialized = await initializeDatabase(path.join(root, "app-data"));
  await initialized.destroy();
  const infrastructure = createInfrastructure({
    appDataRoot: path.join(root, "app-data"),
    workspaceRoot: workspaceRoot as AbsolutePath,
    clock: { now: () => new Date(now) },
    ids: createSequentialIdPort(),
  });
  const lease = await infrastructure.lease.acquire(workspaceRoot as AbsolutePath, "test:lifecycle");
  if (!lease.ok) throw new Error("workspace lease denied");
  return {
    root,
    workspaceRoot,
    infrastructure,
    leaseId: lease.leaseId,
    application: createApplication(infrastructure, lease.leaseId),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProjectLifecycle on real SQLite and filesystem", () => {
  it("creates one complete authored project with exactly one revision", async () => {
    const value = await fixture();
    try {
      const result = await value.application.lifecycle.create({
        name: "Launch Video",
        preset: PLATFORM_PRESETS[0]!,
      });
      expect(result).toMatchObject({ ok: true, value: { slug: "launch-video" } });
      const projectRoot = path.join(value.workspaceRoot, "launch-video");
      await expect(Promise.all([
        readFile(path.join(projectRoot, "vidcom.json"), "utf8"),
        readFile(path.join(projectRoot, "hyperframes.json"), "utf8"),
        readFile(path.join(projectRoot, "preview-settings.json"), "utf8"),
        readFile(path.join(projectRoot, "index.html"), "utf8"),
      ])).resolves.toHaveLength(4);
      expect(dbOne(value.infrastructure.database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 1 });
      expect(dbOne(value.infrastructure.database, "SELECT COUNT(*) AS count FROM project_registry WHERE deleted_at IS NULL"))
        .toEqual({ count: 1 });
    } finally {
      await value.infrastructure.database.destroy();
    }
  });

  it("keeps pre-publish create crashes invisible and recovers a post-rename DB-settle crash", async () => {
    const value = await fixture();
    const files = [
      { path: "vidcom.json" as RelPath, content: '{"id":"project_atomic"}\n' },
      { path: "hyperframes.json" as RelPath, content: "{}\n" },
      { path: "preview-settings.json" as RelPath, content: "{}\n" },
      { path: "index.html" as RelPath, content: "<main></main>\n" },
    ];
    const proxy = <Target extends object>(target: Target, fail: PropertyKey): Target => new Proxy(target, {
      get(instance, property) {
        if (property === fail) return async () => { throw new Error(`injected ${String(property)} failure`); };
        const value = Reflect.get(instance, property, instance) as unknown;
        return typeof value === "function" ? value.bind(instance) : value;
      },
    });
    const coordinator = (directories: ProjectDirectoryPort, journal: WorkspaceOperationJournalPort) =>
      new WorkspaceMutationCoordinator({
        workspace: value.infrastructure.workspace,
        journal,
        lease: value.infrastructure.lease,
        leaseId: value.leaseId,
        hashContent,
        directories,
        clock: value.infrastructure.clock,
      });
    try {
      for (const [index, boundary] of ["stageCreate", "writeStagedFiles", "publishCreate"].entries()) {
        const slug = `pre-publish-${index}`;
        const result = await coordinator(
          proxy(value.infrastructure.projectDirectories, boundary),
          value.infrastructure.workspaceOperations,
        ).createProjectRoot({
          workspaceRoot: value.workspaceRoot as AbsolutePath,
          slug,
          projectId: `project_pre_${index}` as ProjectId,
          files,
          actor: "user",
        });
        expect(result, `${boundary}: ${JSON.stringify(result)}`)
          .toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
        await expect(stat(path.join(value.workspaceRoot, slug))).rejects.toMatchObject({ code: "ENOENT" });
      }

      for (const [index, boundary] of ["begin", "setDirectoryPaths", "markStepCaptured"].entries()) {
        const slug = `journal-pre-publish-${index}`;
        const result = await coordinator(
          value.infrastructure.projectDirectories,
          proxy(value.infrastructure.workspaceOperations, boundary),
        ).createProjectRoot({
          workspaceRoot: value.workspaceRoot as AbsolutePath,
          slug,
          projectId: `project_journal_pre_${index}` as ProjectId,
          files,
          actor: "user",
        });
        expect(result, `${boundary}: ${JSON.stringify(result)}`)
          .toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
        await expect(stat(path.join(value.workspaceRoot, slug))).rejects.toMatchObject({ code: "ENOENT" });
      }

      const post = await coordinator(
        value.infrastructure.projectDirectories,
        proxy(value.infrastructure.workspaceOperations, "commitProjectLifecycle"),
      ).createProjectRoot({
        workspaceRoot: value.workspaceRoot as AbsolutePath,
        slug: "post-publish",
        projectId: "project_post_publish" as ProjectId,
        files,
        actor: "user",
      });
      expect(post).toMatchObject({ ok: false, error: { code: "recovery_required" } });
      expect((await stat(path.join(value.workspaceRoot, "post-publish"))).isDirectory()).toBe(true);
      await expect(coordinator(
        value.infrastructure.projectDirectories,
        value.infrastructure.workspaceOperations,
      ).recoverPending(value.workspaceRoot as AbsolutePath)).resolves.toEqual([
        { operationId: expect.any(Number), terminal: "recovered" },
      ]);
      expect(dbOne(value.infrastructure.database, "SELECT id, slug FROM project_registry WHERE id = 'project_post_publish'"))
        .toEqual({ id: "project_post_publish", slug: "post-publish" });
    } finally {
      await value.infrastructure.database.destroy();
    }
  });

  it("adopts a candidate by changing only vidcom.json", async () => {
    const value = await fixture();
    const candidate = path.join(value.workspaceRoot, "candidate");
    await mkdir(candidate);
    const files = {
      "hyperframes.json": "{}\n",
      "index.html": '<main data-composition-id="main" data-width="1920" data-height="1080" data-duration="0"></main>\n',
      "notes.md": "user-owned\n",
    };
    await Promise.all(Object.entries(files).map(([name, content]) => writeFile(path.join(candidate, name), content)));
    const before = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, hashContent(content)]));
    try {
      await expect(value.application.lifecycle.adopt({ slug: "candidate" })).resolves.toMatchObject({ ok: true });
      for (const [name, expected] of Object.entries(before)) {
        expect(hashContent(await readFile(path.join(candidate, name)))).toBe(expected);
      }
      expect(JSON.parse(await readFile(path.join(candidate, "vidcom.json"), "utf8"))).toMatchObject({
        schemaVersion: 1,
        platform: { presetId: "horizontal-youtube" },
      });
    } finally {
      await value.infrastructure.database.destroy();
    }
  });

  it("replaces a corrupted recovery identity through the bootstrap journal", async () => {
    const value = await fixture();
    try {
      const created = await value.application.lifecycle.create({
        name: "Recover Identity",
        preset: PLATFORM_PRESETS[0]!,
      });
      if (!created.ok) throw new Error(created.error.message);
      const marker = path.join(value.workspaceRoot, "recover-identity", "vidcom.json");
      const identity = JSON.parse(await readFile(marker, "utf8"));
      const broken = "{broken identity";
      await writeFile(marker, broken);
      const entry = (await value.application.scanWorkspace()).find((item) => item.kind === "project"
        && item.state === "invalid" && item.invalidKind === "identity");
      if (!entry || !("entryId" in entry)) throw new Error("identity recovery entry missing");

      await expect(value.application.lifecycle.replaceIdentity({
        entryId: entry.entryId,
        identity,
        expectedContentHash: hashContent(broken),
      })).resolves.toEqual({ ok: true, value: { projectId: created.value.projectId } });

      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual(identity);
      expect(value.infrastructure.entries.resolve(entry.entryId)).toBeNull();
      expect(dbOne(value.infrastructure.database, "SELECT COUNT(*) AS count FROM revision"))
        .toEqual({ count: 2 });
      expect(dbOne(value.infrastructure.database, `SELECT project_id AS projectId, action
        FROM audit_entry ORDER BY id DESC LIMIT 1`)).toEqual({
        projectId: created.value.projectId,
        action: "file.write",
      });
    } finally {
      await value.infrastructure.database.destroy();
    }
  });

  it("renames without changing ProjectId and blocks rename/delete while a job runs", async () => {
    const value = await fixture();
    try {
      const created = await value.application.lifecycle.create({ name: "Before", preset: PLATFORM_PRESETS[1]! });
      if (!created.ok) throw new Error(created.error.message);
      const projectId = created.value.projectId;
      const queued = await value.infrastructure.jobs.enqueue({
        id: "job_lifecycle_block" as JobId,
        projectId,
        type: "render",
        input: {},
        inputHash: hashContent("{}"),
        idempotencyKey: null,
      });
      if ("conflict" in queued) throw new Error("unexpected enqueue conflict");
      await value.infrastructure.jobs.claim(queued.job.id as JobId, "worker");
      await expect(value.application.lifecycle.rename({ kind: "project", projectId }, "After"))
        .resolves.toMatchObject({ ok: false, error: { code: "write_conflict" } });
      await expect(value.application.lifecycle.remove(
        { kind: "project", projectId },
        { actor: "user", confirmed: true },
      )).resolves.toMatchObject({ ok: false, error: { code: "write_conflict" } });
      await value.infrastructure.jobs.finish(queued.job.id as JobId, { status: "cancelled" });
      await expect(value.application.lifecycle.rename({ kind: "project", projectId }, "After"))
        .resolves.toEqual({ ok: true, value: { slug: "after" } });
      expect(JSON.parse(await readFile(path.join(value.workspaceRoot, "after", "vidcom.json"), "utf8")).id)
        .toBe(projectId);
      expect(dbOne(value.infrastructure.database, "SELECT id, slug FROM project_registry WHERE deleted_at IS NULL"))
        .toEqual({ id: projectId, slug: "after" });
    } finally {
      await value.infrastructure.database.destroy();
    }
  });

  it("recovers a published rename with the same ProjectId and handles entryId rename/delete without persisting it", async () => {
    const value = await fixture();
    const proxy = <Target extends object>(target: Target, fail: PropertyKey): Target => new Proxy(target, {
      get(instance, property) {
        if (property === fail) return async () => { throw new Error(`injected ${String(property)} failure`); };
        const member = Reflect.get(instance, property, instance) as unknown;
        return typeof member === "function" ? member.bind(instance) : member;
      },
    });
    try {
      const created = await value.application.lifecycle.create({ name: "Recover Rename", preset: PLATFORM_PRESETS[0]! });
      if (!created.ok) throw new Error(created.error.message);
      const failing = new WorkspaceMutationCoordinator({
        workspace: value.infrastructure.workspace,
        journal: proxy(value.infrastructure.workspaceOperations, "commitProjectLifecycle"),
        lease: value.infrastructure.lease,
        leaseId: value.leaseId,
        hashContent,
        directories: value.infrastructure.projectDirectories,
        clock: value.infrastructure.clock,
      });
      await expect(failing.renameProjectRoot({
        workspaceRoot: value.workspaceRoot as AbsolutePath,
        projectId: created.value.projectId,
        fromSlug: "recover-rename",
        toSlug: "recovered-name",
        actor: "user",
      })).resolves.toMatchObject({ ok: false, error: { code: "recovery_required" } });
      const recovering = new WorkspaceMutationCoordinator({
        workspace: value.infrastructure.workspace,
        journal: value.infrastructure.workspaceOperations,
        lease: value.infrastructure.lease,
        leaseId: value.leaseId,
        hashContent,
        directories: value.infrastructure.projectDirectories,
        clock: value.infrastructure.clock,
      });
      await expect(recovering.recoverPending(value.workspaceRoot as AbsolutePath))
        .resolves.toEqual([{ operationId: expect.any(Number), terminal: "recovered" }]);
      expect(dbOne(value.infrastructure.database, "SELECT id, slug FROM project_registry WHERE deleted_at IS NULL"))
        .toEqual({ id: created.value.projectId, slug: "recovered-name" });

      const broken = path.join(value.workspaceRoot, "broken-entry");
      await mkdir(broken);
      await writeFile(path.join(broken, "vidcom.json"), "{broken");
      await writeFile(path.join(broken, "notes.md"), "keep in backup\n");
      const first = (await value.application.scanWorkspace()).find((item) => item.kind === "project"
        && item.state === "invalid" && item.invalidKind === "identity");
      if (!first || !("entryId" in first)) throw new Error("invalid recovery entry missing");
      await expect(value.application.lifecycle.rename({ kind: "entry", entryId: first.entryId }, "Renamed Broken"))
        .resolves.toEqual({ ok: true, value: { slug: "renamed-broken" } });
      expect(value.infrastructure.entries.resolve(first.entryId)).toMatchObject({ slug: "renamed-broken" });
      const second = (await value.application.scanWorkspace()).find((item) => item.kind === "project"
        && item.state === "invalid" && item.invalidKind === "identity");
      if (!second || !("entryId" in second)) throw new Error("renamed recovery entry missing");
      const removed = await value.application.lifecycle.remove(
        { kind: "entry", entryId: second.entryId },
        { actor: "user", confirmed: true },
      );
      expect(removed).toMatchObject({ ok: true, value: { backupId: expect.any(String) } });
      await expect(stat(path.join(value.workspaceRoot, "renamed-broken"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(dbOne(value.infrastructure.database, `SELECT project_id AS projectId, workspace_root AS workspaceRoot,
        slug FROM backup_manifest WHERE id = ?`, removed.ok ? removed.value.backupId : "missing"))
        .toEqual({ projectId: null, workspaceRoot: value.workspaceRoot, slug: "renamed-broken" });
      expect(JSON.stringify(dbAll(value.infrastructure.database, "SELECT * FROM backup_manifest"))).not.toContain(second.entryId);
      expect(dbOne(value.infrastructure.database, "SELECT type, project_id AS projectId FROM event_outbox WHERE type = 'workspace.changed' ORDER BY seq DESC LIMIT 1"))
        .toEqual({ type: "workspace.changed", projectId: null });
    } finally {
      await value.infrastructure.database.destroy();
    }
  });

  it("verifies backup before quarantine deletion and rejects entryId at a business boundary", async () => {
    const value = await fixture();
    try {
      const created = await value.application.lifecycle.create({ name: "Disposable", preset: PLATFORM_PRESETS[0]! });
      if (!created.ok) throw new Error(created.error.message);
      const removed = await value.application.lifecycle.remove(
        { kind: "project", projectId: created.value.projectId },
        { actor: "user", confirmed: true },
      );
      expect(removed).toMatchObject({ ok: true, value: { backupId: expect.any(String) } });
      if (!removed.ok) throw new Error(removed.error.message);
      expect(await value.infrastructure.backups.verify(removed.value.backupId)).toBe(true);
      await expect(stat(path.join(value.workspaceRoot, "disposable"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(dbOne(value.infrastructure.database, "SELECT deleted_at AS deletedAt FROM project_registry WHERE id = ?", created.value.projectId))
        .toEqual({ deletedAt: now });
      expect(dbAll(value.infrastructure.database, "SELECT action FROM audit_entry WHERE action = 'project.delete'"))
        .toEqual([{ action: "project.delete" }]);

      const broken = path.join(value.workspaceRoot, "broken");
      await mkdir(broken);
      await writeFile(path.join(broken, "vidcom.json"), "{broken");
      const entry = (await value.application.scanWorkspace()).find((item) => item.kind === "project"
        && item.state === "invalid" && item.invalidKind === "identity");
      if (!entry || !("entryId" in entry)) throw new Error("invalid recovery entry missing");
      const tools = createMcpRegistry(value.infrastructure, value.application);
      await expect(tools.invoke("save_file", {
        projectId: entry.entryId,
        path: "index.html",
        content: "<main></main>",
        expectedContentHash: null,
      }, {
        era: "modern",
        protocolVersion: "2025-06-18",
        credentialId: "test-credential",
        requestInput: async (): Promise<never> => { throw new Error("input not expected"); },
      })).resolves.toMatchObject({ ok: false, error: { code: "schema_invalid" } });
    } finally {
      await value.infrastructure.database.destroy();
    }
  });

  it("renames and deletes an unregistered identity-invalid entry without persisting entryId", async () => {
    const value = await fixture();
    const broken = path.join(value.workspaceRoot, "broken-recovery");
    await mkdir(broken);
    await writeFile(path.join(broken, "vidcom.json"), '{"secret":"must-survive", broken');
    await writeFile(path.join(broken, "notes.md"), "recoverable user bytes\n");
    try {
      const scanned = await value.application.scanWorkspace();
      const invalid = scanned.find((item) => item.kind === "project" && item.state === "invalid"
        && item.invalidKind === "identity");
      if (!invalid || !("entryId" in invalid)) throw new Error("identity-invalid entry missing");
      const entryId = invalid.entryId;
      await expect(value.application.lifecycle.rename({ kind: "entry", entryId }, "Renamed Recovery"))
        .resolves.toEqual({ ok: true, value: { slug: "renamed-recovery" } });
      expect(value.infrastructure.entries.resolve(entryId)).toMatchObject({
        slug: "renamed-recovery",
        root: await realpath(path.join(value.workspaceRoot, "renamed-recovery")),
      });
      expect(dbOne(value.infrastructure.database, "SELECT COUNT(*) AS count FROM project_registry"))
        .toEqual({ count: 0 });

      const removed = await value.application.lifecycle.remove(
        { kind: "entry", entryId },
        { actor: "user", confirmed: true },
      );
      expect(removed).toMatchObject({ ok: true, value: { backupId: expect.any(String) } });
      if (!removed.ok) throw new Error(removed.error.message);
      expect(value.infrastructure.entries.resolve(entryId)).toBeNull();
      expect(await value.infrastructure.backups.verify(removed.value.backupId)).toBe(true);
      const manifest = await value.infrastructure.backups.read(removed.value.backupId);
      expect(manifest).toMatchObject({ projectId: null, slug: "renamed-recovery" });
      expect(JSON.stringify(manifest)).not.toContain(entryId);
      expect(dbOne(value.infrastructure.database, "SELECT type, project_id AS projectId FROM event_outbox ORDER BY seq DESC LIMIT 1"))
        .toEqual({ type: "workspace.changed", projectId: null });
      await expect(stat(path.join(value.workspaceRoot, "renamed-recovery"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await value.infrastructure.database.destroy();
    }
  });

  it("binds an external deletion approval to an unregistered location and consumes it atomically", async () => {
    const value = await fixture();
    const broken = path.join(value.workspaceRoot, "approved-recovery");
    await mkdir(broken);
    await writeFile(path.join(broken, "vidcom.json"), "{broken");
    await writeFile(path.join(broken, "notes.md"), "approved bytes\n");
    try {
      const invalid = (await value.application.scanWorkspace()).find((item) => item.kind === "project"
        && item.state === "invalid" && item.invalidKind === "identity");
      if (!invalid || !("entryId" in invalid)) throw new Error("identity-invalid entry missing");

      const planned = await value.application.lifecycle.planRemove({ kind: "entry", entryId: invalid.entryId });
      expect(planned).toMatchObject({
        ok: true,
        value: { binding: { projectId: null, target: expect.stringMatching(/^location:/) } },
      });
      if (!planned.ok) throw new Error(planned.error.message);
      const requestId = await value.infrastructure.approvalRequests.request(
        planned.value.binding,
        planned.value.summary,
      );
      const issued = await value.infrastructure.approvalAdmin.issue(requestId, "cli");
      if (!issued.ok) throw new Error(issued.error.message);

      const removed = await value.application.lifecycle.remove(
        { kind: "entry", entryId: invalid.entryId },
        { actor: "cli-external", confirmed: true, grantId: issued.value },
      );
      expect(removed).toMatchObject({ ok: true, value: { backupId: expect.any(String) } });
      expect(dbOne(value.infrastructure.database, "SELECT status FROM approval_grant WHERE id = ?", issued.value))
        .toEqual({ status: "consumed" });
      expect(dbOne(value.infrastructure.database, "SELECT grant_id AS grantId, status FROM workspace_operation WHERE grant_id = ?", issued.value))
        .toEqual({ grantId: issued.value, status: "committed" });
      expect(JSON.stringify(dbAll(value.infrastructure.database, "SELECT * FROM workspace_operation")))
        .not.toContain(invalid.entryId);
      await expect(stat(broken)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await value.infrastructure.database.destroy();
    }
  });
});
