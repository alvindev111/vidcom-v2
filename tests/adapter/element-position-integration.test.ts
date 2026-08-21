// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabase } from "@vidcom/adapter";
import { type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  applyMutationInverse,
  setElementPosition,
  type AbsolutePath,
  type ProjectRef,
} from "@vidcom/core";
import type { MutationHistory } from "@vidcom/server";
import { createApplication, createInfrastructure } from "../../packages/cli/src/composition-root";

import { dbRun } from "../support/database";

const roots: string[] = [];
const databases: Array<{ destroy(): Promise<void> }> = [];
const now = "2026-08-21T00:00:00.000Z";
const clock = { now: () => new Date(now) };
const projectId = "project_element_position" as ProjectId;
const studioSessionId = "01K1ELEMENTPOSITION000000001";
const browserSessionId = "browser-element-position";
const origin = {
  kind: "ui", sessionId: studioSessionId, label: "Move element",
  historyAction: "record", historyOperation: null,
} as const;

const entry = `<!doctype html><html><body>
<main data-composition-id="main" data-width="320" data-height="180" data-fps="30" data-duration="8">
  <section data-composition-id="inline" data-scene-role="story" data-start="0" data-duration="4" data-track-index="0">
    <div class="clip" data-hf-id="hero" data-start="0" data-duration="4" style="transform: scale(1.1)">Hero</div>
  </section>
  <section data-composition-id="mounted" data-composition-src="compositions/mounted.html" data-scene-role="story" data-start="4" data-duration="4" data-track-index="0"></section>
</main></body></html>\n`;
const mounted = `<!doctype html><html><body>
<section data-composition-id="mounted" data-width="320" data-height="180" data-duration="4">
  <div class="clip" data-hf-id="card" data-start="0" data-duration="4">Card</div>
  <div class="captions clip" data-hf-id="captions-mounted" data-start="0" data-duration="4"><p>Caption</p></div>
</section></body></html>\n`;

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function identity() {
  return `${JSON.stringify({
    schemaVersion: 1,
    id: projectId,
    platform: {
      presetId: "custom", orientation: "horizontal", aspectRatio: "16:9",
      width: 320, height: 180, fps: 30, targets: [], recommendedMaxDurationSeconds: null,
    },
    render: { defaultPresetId: "custom", outputDirectory: "renders" },
    narration: { defaultProviderId: null, defaultVoiceId: null },
    createdAt: now,
    updatedAt: now,
  }, null, 2)}\n`;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-element-position-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const appDataRoot = path.join(root, "app-data");
  const projectRoot = path.join(workspaceRoot, "project");
  await mkdir(path.join(projectRoot, "compositions"), { recursive: true });
  await Promise.all([
    writeFile(path.join(projectRoot, "vidcom.json"), identity()),
    writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n"),
    writeFile(path.join(projectRoot, "index.html"), entry),
    writeFile(path.join(projectRoot, "compositions/mounted.html"), mounted),
  ]);
  const initialized = await initializeDatabase(appDataRoot);
  await initialized.destroy();
  const infrastructure = createInfrastructure({
    appDataRoot,
    workspaceRoot: workspaceRoot as AbsolutePath,
    clock,
  });
  databases.push(infrastructure.database);
  dbRun(infrastructure.database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  projectId, workspaceRoot, "project", now, now);
  const lease = await infrastructure.lease.acquire(workspaceRoot as AbsolutePath, "test:element-position");
  if (!lease.ok) throw new Error("workspace lease denied");
  const application = createApplication(infrastructure, lease.leaseId);
  const history = infrastructure.mutationObserver as unknown as MutationHistory;
  history.attach(browserSessionId, studioSessionId, projectId);
  const ref: ProjectRef = {
    id: projectId, slug: "project", root: projectRoot as AbsolutePath, entry: "index.html" as RelPath,
  };
  return { projectRoot, infrastructure, application, history, ref };
}

async function hashOf(value: Awaited<ReturnType<typeof fixture>>, file: RelPath): Promise<ContentHash> {
  const resolved = await value.infrastructure.workspace.resolve(value.ref, file, "read-source");
  if (!resolved.ok) throw new Error("source resolve failed");
  const hash = await value.infrastructure.workspace.readHash(resolved.value);
  if (!hash) throw new Error("source hash missing");
  return hash;
}

async function historyStep(value: Awaited<ReturnType<typeof fixture>>, direction: "undo" | "redo") {
  const begun = value.history.begin(studioSessionId, projectId, direction);
  if (!begun.ok) return begun;
  try {
    return await applyMutationInverse(
      value.application.writeDependencies as unknown as Parameters<typeof applyMutationInverse>[0],
      { projectId, receipt: begun.value.receipt, direction },
      "user",
      {
        kind: "ui",
        sessionId: studioSessionId,
        label: direction === "undo" ? "Undo" : "Redo",
        historyAction: direction,
        historyOperation: { id: begun.value.operationId, targetReceiptId: begun.value.receipt.id },
      },
    );
  } finally {
    value.history.cancel(begun.value.operationId);
  }
}

describe("element position on real SQLite and filesystem", () => {
  it("round-trips inline, mounted, and caption targets with one undoable receipt", async () => {
    const value = await fixture();
    const noChange = await setElementPosition(value.application.writeDependencies, {
      projectId, sceneId: "inline", elementId: "hero", offsetX: 0, offsetY: 0,
      expectedContentHash: await hashOf(value, "index.html" as RelPath),
    }, "user", { origin, toolAudit: null });
    expect(noChange).toMatchObject({ ok: true, value: { changed: false, revision: 0, changeSeq: null } });
    expect(await value.infrastructure.journal.latestRevision(projectId)).toBeNull();

    const moved = await setElementPosition(value.application.writeDependencies, {
      projectId, sceneId: "inline", elementId: "hero", offsetX: 32, offsetY: -12,
      expectedContentHash: await hashOf(value, "index.html" as RelPath),
    }, "user", { origin, toolAudit: null });
    expect(moved).toMatchObject({ ok: true, value: { changed: true, revision: 1 } });
    const movedBytes = await readFile(path.join(value.projectRoot, "index.html"), "utf8");
    expect(movedBytes).toContain("data-vidcom-layout-offset");
    expect(movedBytes).toContain("--vidcom-layout-x: 32px");
    expect(movedBytes).toContain("transform: scale(1.1)");
    expect(value.history.state(studioSessionId, projectId).canUndo).toBe(true);

    expect((await historyStep(value, "undo")).ok).toBe(true);
    expect(await readFile(path.join(value.projectRoot, "index.html"), "utf8")).toBe(entry);
    expect((await historyStep(value, "redo")).ok).toBe(true);
    expect(await readFile(path.join(value.projectRoot, "index.html"), "utf8")).toBe(movedBytes);

    for (const elementId of ["card", "captions-mounted"]) {
      const result = await setElementPosition(value.application.writeDependencies, {
        projectId, sceneId: "mounted", elementId, offsetX: 8, offsetY: 6,
        expectedContentHash: await hashOf(value, "compositions/mounted.html" as RelPath),
      }, "user", { origin, toolAudit: null });
      expect(result).toMatchObject({ ok: true, value: { changed: true, file: { path: "compositions/mounted.html" } } });
    }
    const mountedBytes = await readFile(path.join(value.projectRoot, "compositions/mounted.html"), "utf8");
    expect(mountedBytes.match(/data-vidcom-layout-offset/g)).toHaveLength(2);
  });

  it("keeps bytes and revision unchanged on stale hash and restores after injected publish failure", async () => {
    const value = await fixture();
    const original = await readFile(path.join(value.projectRoot, "index.html"), "utf8");
    const stale = await setElementPosition(value.application.writeDependencies, {
      projectId, sceneId: "inline", elementId: "hero", offsetX: 1, offsetY: 1,
      expectedContentHash: `sha256:${"0".repeat(64)}`,
    }, "user", { origin, toolAudit: null });
    expect(stale).toMatchObject({ ok: false, error: { code: "write_conflict" } });
    expect(await readFile(path.join(value.projectRoot, "index.html"), "utf8")).toBe(original);
    expect(await value.infrastructure.journal.latestRevision(projectId)).toBeNull();

    const workspace = value.infrastructure.workspace as typeof value.infrastructure.workspace & {
      publishCaptured: (...args: unknown[]) => Promise<void>;
    };
    const publish = workspace.publishCaptured.bind(workspace);
    workspace.publishCaptured = async () => { throw new Error("injected publish failure"); };
    const failed = await setElementPosition(value.application.writeDependencies, {
      projectId, sceneId: "inline", elementId: "hero", offsetX: 2, offsetY: 2,
      expectedContentHash: await hashOf(value, "index.html" as RelPath),
    }, "user", { origin, toolAudit: null });
    workspace.publishCaptured = publish;
    expect(failed.ok).toBe(false);
    expect(await readFile(path.join(value.projectRoot, "index.html"), "utf8")).toBe(original);
    expect(await value.infrastructure.journal.latestRevision(projectId)).toBeNull();
  });
});
