import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AppDataAssetStager,
  migrateDatabase,
  MutationJournal,
  openVidcomDatabase,
  reconcileStagedAssets,
  WorkspaceFs,
} from "@vidcom/adapter";
import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  reconcilePendingMutations,
  type AbsolutePath,
  type ProjectRef,
} from "@vidcom/core";
import { afterEach, describe, expect, it } from "vitest";
import { dbOne, dbRun } from "../support/database";

const roots: string[] = [];
const projectId = "project_bgm" as ProjectId;
const clock = { now: () => new Date("2026-08-01T00:00:00.000Z") };
const hash = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function fixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `vidcom-bgm-${name}-`));
  roots.push(root);
  const appData = path.join(root, "app-data");
  const workspaceRoot = path.join(root, "workspace");
  const projectRoot = path.join(workspaceRoot, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
  await writeFile(path.join(projectRoot, "vidcom.json"), `${JSON.stringify({ id: projectId })}\n`);
  await writeFile(path.join(projectRoot, "index.html"), '<main data-composition-id="root"></main>');
  const oldSettings = `${JSON.stringify(DEFAULT_PREVIEW_SETTINGS)}\n`;
  const targetPath = `preview-assets/bgm/${name}.mp3` as RelPath;
  const newSettings = `${JSON.stringify({
    ...DEFAULT_PREVIEW_SETTINGS,
    bgm: { ...DEFAULT_PREVIEW_SETTINGS.bgm, enabled: true, track: { name: `${name}.mp3`, path: targetPath } },
  })}\n`;
  await writeFile(path.join(projectRoot, "preview-settings.json"), oldSettings);
  const database = openVidcomDatabase(appData);
  await migrateDatabase(database);
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
    projectId, workspaceRoot, "project", clock.now().toISOString(), clock.now().toISOString());
  dbRun(database, `INSERT INTO entity_state
    (project_id, entity, revision, content_hash, backing_path, last_actor, updated_at)
    VALUES (?, 'preview-settings', 1, ?, 'preview-settings.json', 'system', ?)`,
    projectId, hash(oldSettings), clock.now().toISOString());
  const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
  const ref = (await workspace.listProjects())[0]!;
  const resolved = await workspace.resolve(ref, targetPath, "write-asset");
  if (!resolved.ok) throw new Error("fixture target was rejected");
  const staged = await new AppDataAssetStager(appData).stage(resolved.value, targetPath, new Uint8Array([0x49, 0x44, 0x33]));
  const journal = new MutationJournal(database, clock);
  await journal.begin({
    projectId, kind: "entity", path: null, entity: "preview-settings",
    fromHash: hash(oldSettings), previousContent: oldSettings, toHash: hash(newSettings), actor: "user",
      stagedAsset: { temporaryPath: staged.temporaryPath, targetPath, contentHash: staged.contentHash },
  });
  return { root, appData, projectRoot, database, workspace, ref, staged, journal, oldSettings, newSettings, targetPath };
}

async function absent(filename: string): Promise<boolean> {
  try { await stat(filename); return false; } catch { return true; }
}

describe("composite BGM crash recovery", () => {
  it("removes a staged temp when the daemon stops before asset install", async () => {
    const item = await fixture("before-install");
    try {
      await reconcileStagedAssets(item.database, clock, item.appData);
      expect(await absent(item.staged.temporaryPath)).toBe(true);
      expect(await item.journal.listPending()).toEqual([]);
      expect(await readFile(path.join(item.projectRoot, "preview-settings.json"), "utf8")).toBe(item.oldSettings);
    } finally { await item.database.destroy(); }
  });

  it("removes an installed orphan when settings were not written", async () => {
    const item = await fixture("after-install");
    try {
      await item.staged.commit();
      const target = path.join(item.projectRoot, item.targetPath);
      await reconcileStagedAssets(item.database, clock, item.appData);
      expect(await absent(target)).toBe(true);
      expect(await item.journal.listPending()).toEqual([]);
      expect(await readFile(path.join(item.projectRoot, "preview-settings.json"), "utf8")).toBe(item.oldSettings);
    } finally { await item.database.destroy(); }
  });

  it("keeps the asset and completes the pending mutation when both files landed", async () => {
    const item = await fixture("after-settings");
    try {
      await item.staged.commit();
      await writeFile(path.join(item.projectRoot, "preview-settings.json"), item.newSettings);
      await reconcileStagedAssets(item.database, clock, item.appData);
      expect(await item.journal.listPending()).toHaveLength(1);
      await reconcilePendingMutations({
        workspace: item.workspace,
        journal: item.journal,
        resolveProjectRef: async (): Promise<ProjectRef> => item.ref,
      });
      expect(await item.journal.listPending()).toEqual([]);
      expect(await absent(path.join(item.projectRoot, item.targetPath))).toBe(false);
      expect(dbOne(item.database, "SELECT revision FROM entity_state WHERE project_id = ?", projectId))
        .toEqual({ revision: 2 });
    } finally { await item.database.destroy(); }
  });
});
