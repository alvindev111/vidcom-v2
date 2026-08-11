import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabase } from "@vidcom/adapter";
import type { AbsolutePath } from "@vidcom/core";
import type { ProjectId } from "@vidcom/contracts";

import { createApplication, createInfrastructure, createMcpRegistry } from "../../packages/cli/src/composition-root";
import { createSequentialIdPort } from "../support/deterministic";
import { dbAll } from "../support/database";

const roots: string[] = [];
const now = "2026-08-10T09:00:00.000Z";
const INTEGRATION_TIMEOUT_MS = 20_000;
const request = {
  era: "modern" as const,
  protocolVersion: "2025-06-18",
  credentialId: "test-credential",
  requestInput: async (): Promise<never> => { throw new Error("input not expected"); },
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-headless-"));
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
  const lease = await infrastructure.lease.acquire(workspaceRoot as AbsolutePath, "test:headless");
  if (!lease.ok) throw new Error("workspace lease denied");
  const application = createApplication(infrastructure, lease.leaseId);
  return {
    workspaceRoot,
    infrastructure,
    application,
    tools: createMcpRegistry(infrastructure, application),
  };
}

function value<Value>(result: { ok: true; value: Value } | { ok: false; error: unknown }): Value {
  if (!result.ok) throw new Error(`tool failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Proves the surface an agent host reaches without any UI.
 *
 * Every write tool here must own its audit through a real journal: a tool whose
 * mutation lands without durable ownership fails inside the registry with an
 * internal error, which no fake-backed suite can catch.
 */
describe("headless MCP parity on real SQLite and filesystem", () => {
  it("creates, dresses, narrates and renames a project without touching HTTP", async () => {
    const fixed = await fixture();
    try {
      const created = value(await fixed.tools.invoke("create_project", {
        name: "Headless Launch",
        presetId: "vertical-shorts",
      }, request)) as { projectId: ProjectId; slug: string };
      expect(created.slug).toBe("headless-launch");

      const context = value(await fixed.tools.invoke("get_project_context", {
        projectId: created.projectId,
      }, request)) as { previewSettings: { bgm: { track: unknown } }; entityRevision: number };
      expect(context.previewSettings.bgm.track).toBeNull();

      // Nobody uploaded this: it stands for a track copied into the project by
      // hand, which is exactly what the headless flow has to be able to find.
      const bgmDirectory = path.join(fixed.workspaceRoot, created.slug, "preview-assets", "bgm");
      await mkdir(bgmDirectory, { recursive: true });
      await writeFile(path.join(bgmDirectory, "theme.mp3"), "ID3 headless");

      const assets = value(await fixed.tools.invoke("list_project_assets", {
        projectId: created.projectId,
        directory: "preview-assets/bgm",
      }, request)) as { assets: Array<{ path: string; kind: string; referencedByPreviewSettings: boolean }> };
      expect(assets.assets).toEqual([{
        path: "preview-assets/bgm/theme.mp3",
        kind: "audio",
        byteSize: 12,
        modifiedAt: expect.any(String),
        referencedByPreviewSettings: false,
      }]);

      const dressed = value(await fixed.tools.invoke("set_preview_settings", {
        projectId: created.projectId,
        patch: {
          bgm: { enabled: true, volume: 0.4, track: { name: "theme.mp3", path: "preview-assets/bgm/theme.mp3" } },
        },
        expectedRevision: context.entityRevision,
      }, request)) as { previewSettings: { bgm: { enabled: boolean; track: { path: string } } } };
      expect(dressed.previewSettings.bgm).toMatchObject({
        enabled: true,
        volume: 0.4,
        track: { path: "preview-assets/bgm/theme.mp3" },
      });

      const root = value(await fixed.tools.invoke("read_composition", {
        projectId: created.projectId,
        path: "index.html",
      }, request)) as { contentHash: string };
      const scene = value(await fixed.tools.invoke("create_scene", {
        projectId: created.projectId,
        title: "Opening",
        duration: 4,
        expectedContentHash: root.contentHash,
      }, request)) as { scene: { id: string } };

      const sidecar = value(await fixed.tools.invoke("get_narration_cues", {
        projectId: created.projectId,
        sceneId: scene.scene.id,
      }, request)) as { contentHash: string | null };
      const written = value(await fixed.tools.invoke("replace_narration_cues", {
        projectId: created.projectId,
        sceneId: scene.scene.id,
        cues: [{ cueId: "cue-1", text: "Xin chào", voice: "vi-VN", offsetSeconds: 0 }],
        expectedContentHash: sidecar.contentHash,
      }, request)) as { contentHash: string };

      const patched = value(await fixed.tools.invoke("patch_narration_cue", {
        projectId: created.projectId,
        sceneId: scene.scene.id,
        cueId: "cue-1",
        text: "Chào bạn",
        expectedContentHash: written.contentHash,
      }, request)) as { cues: Array<{ text: string; staleSince: string | null }> };
      expect(patched.cues[0]).toMatchObject({ text: "Chào bạn", staleSince: now });

      expect(value(await fixed.tools.invoke("get_narration_cues", {
        projectId: created.projectId,
        sceneId: scene.scene.id,
      }, request))).toMatchObject({ cues: [{ cueId: "cue-1", text: "Chào bạn" }] });

      expect(value(await fixed.tools.invoke("rename_project", {
        projectId: created.projectId,
        name: "Headless Launch Final",
      }, request))).toEqual({ slug: "headless-launch-final" });

      // Every mutation above came from a tool, so each committed revision must
      // carry a durable `tool:` audit row naming the invocation that made it.
      const audited = await dbAll<{ action: string }>(
        fixed.infrastructure.database,
        "SELECT action FROM audit_entry WHERE action LIKE 'tool:%' AND revision_id IS NOT NULL ORDER BY id",
      );
      expect(audited.map(({ action }) => action)).toEqual([
        "tool:create_project",
        "tool:set_preview_settings",
        "tool:create_scene",
        "tool:replace_narration_cues",
        "tool:patch_narration_cue",
      ]);
      // A rename creates no project revision, so its audit row is the only proof.
      expect(await dbAll<{ action: string }>(
        fixed.infrastructure.database,
        "SELECT action FROM audit_entry WHERE action = 'tool:rename_project'",
      )).toHaveLength(1);
    } finally {
      await fixed.infrastructure.database.destroy();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it("adopts a folder dropped into the workspace and refuses a missing BGM track", async () => {
    const fixed = await fixture();
    try {
      const dropped = path.join(fixed.workspaceRoot, "dropped-project");
      await mkdir(dropped);
      await writeFile(path.join(dropped, "hyperframes.json"), "{}\n");
      await writeFile(
        path.join(dropped, "index.html"),
        '<main data-composition-id="root" data-width="1080" data-height="1920" data-duration="4"></main>\n',
      );

      const adopted = value(await fixed.tools.invoke("adopt_project", {
        slug: "dropped-project",
      }, request)) as { projectId: ProjectId };

      const context = value(await fixed.tools.invoke("get_project_context", {
        projectId: adopted.projectId,
      }, request)) as { entityRevision: number };

      await expect(fixed.tools.invoke("set_preview_settings", {
        projectId: adopted.projectId,
        patch: { bgm: { track: { name: "ghost.mp3", path: "preview-assets/bgm/ghost.mp3" } } },
        expectedRevision: context.entityRevision,
      }, request)).resolves.toMatchObject({ ok: false, error: { code: "no_file" } });

      const audited = await dbAll<{ action: string }>(
        fixed.infrastructure.database,
        "SELECT action FROM audit_entry WHERE action LIKE 'tool:%' AND revision_id IS NOT NULL ORDER BY id",
      );
      expect(audited.map(({ action }) => action)).toEqual(["tool:adopt_project"]);
    } finally {
      await fixed.infrastructure.database.destroy();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it("deletes a project only after an approval grant is issued", async () => {
    const fixed = await fixture();
    try {
      const created = value(await fixed.tools.invoke("create_project", {
        name: "Disposable",
        presetId: "horizontal-youtube",
      }, request)) as { projectId: ProjectId };

      // Legacy era so the approval arrives as an error carrying its request id;
      // the modern era raises InputRequiredSignal, which only a transport answers.
      await expect(fixed.tools.invoke("delete_project", {
        projectId: created.projectId,
        confirmed: true,
      }, { ...request, era: "legacy" })).resolves.toMatchObject({
        ok: false,
        error: { code: "approval_required" },
      });

      const requested = await dbAll<{ id: string; status: string }>(
        fixed.infrastructure.database,
        "SELECT id, status FROM approval_grant ORDER BY rowid DESC LIMIT 1",
      );
      const grant = requested[0];
      if (!grant) throw new Error("approval request was not recorded");
      expect(grant.status).toBe("requested");
      const issued = await fixed.infrastructure.approvalAdmin.issue(grant.id, "cli");
      expect(issued).not.toBeNull();

      const removed = value(await fixed.tools.invoke("delete_project", {
        projectId: created.projectId,
        confirmed: true,
        grantId: grant.id,
      }, request)) as { backupId: string };
      expect(removed.backupId).toMatch(/./);
      expect(value(await fixed.tools.invoke("list_projects", {}, request)))
        .toMatchObject({ projects: [] });
    } finally {
      await fixed.infrastructure.database.destroy();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
