// @vitest-environment node

import { access, constants, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hashContent, startVidcomFoundation } from "@vidcom/cli";
import { type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import { applyMutationInverse, ingestAsset, mountAsset, type AbsolutePath } from "@vidcom/core";
import type { MutationHistory } from "@vidcom/server";

import { createSequentialIdPort } from "../support/deterministic";
import { writeSampleProject } from "../support/sample-project";

const roots: string[] = [];
const projectId = "project_pending_undo" as ProjectId;
const studioSessionId = "01K30Y8Z7K0000000000000021";
const browserSessionId = "browser-undo";
const origin = {
  kind: "ui", sessionId: studioSessionId, label: "Mount asset",
  historyAction: "record", historyOperation: null,
} as const;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function mediaBinaries(): Promise<{ ffmpegPath: AbsolutePath; ffprobePath: AbsolutePath }> {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const find = async (name: string) => {
    const declared = process.env[`HYPERFRAMES_${name.toUpperCase()}_PATH`]?.trim();
    if (declared) return declared;
    for (const directory of directories) {
      const candidate = path.join(directory, `${name}${suffix}`);
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
    }
    throw new Error(`${name} is required for the pending-mount undo suite`);
  };
  return {
    ffmpegPath: await find("ffmpeg") as AbsolutePath,
    ffprobePath: await find("ffprobe") as AbsolutePath,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(label: string) {
  const root = await mkdtemp(path.join(tmpdir(), `vidcom-undo-${label}-`));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  const project = await writeSampleProject(workspaceRoot, { slug: label, id: projectId });
  const foundation = await startVidcomFoundation({
    appDataRoot: path.join(root, "app-data"),
    workspaceRoot: workspaceRoot as AbsolutePath,
    holderId: `test:${label}`,
    clock: { now: () => new Date("2026-08-18T12:00:00.000Z") },
    ids: createSequentialIdPort(),
    renderBinaryPaths: await mediaBinaries(),
  }, {
    async recoverJobs() {}, async startScheduler() {}, async startWatcher() {}, async openListener() { return null; },
  });
  const { infrastructure, application } = foundation;
  const history = infrastructure.mutationObserver as unknown as MutationHistory;
  history.attach(browserSessionId, studioSessionId, projectId);
  return {
    root, project, foundation, infrastructure, application, history,
    ingest: {
      ...application.writeDependencies,
      staging: infrastructure.assetStaging,
      sanitizer: infrastructure.assetSanitizer,
      pendingMount: infrastructure.pendingMount,
      probe: infrastructure.assetProbe,
      hashContent,
    } as unknown as Parameters<typeof ingestAsset>[0],
    mount: {
      workspace: infrastructure.workspace,
      composition: infrastructure.composition,
      probe: infrastructure.assetProbe,
      pendingMount: infrastructure.pendingMount,
      authority: application.authority,
      clock: infrastructure.clock,
    } as unknown as Parameters<typeof mountAsset>[0],
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Runs one history step exactly the way the undo/redo route does. */
async function history(value: Fixture, direction: "undo" | "redo") {
  const begun = value.history.begin(studioSessionId, projectId, direction);
  if (!begun.ok) return begun;
  try {
    return await applyMutationInverse(
      value.application.writeDependencies as unknown as Parameters<typeof applyMutationInverse>[0],
      { projectId, receipt: begun.value.receipt, direction },
      "user",
      {
        kind: "ui" as const,
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

async function entryHash(value: Fixture): Promise<ContentHash> {
  const ref = await value.infrastructure.workspace.readProjectRef(projectId);
  if (!ref) throw new Error("project was not registered");
  const resolved = await value.infrastructure.workspace.resolve(ref, ref.entry, "read-source");
  if (!resolved.ok) throw new Error("entry could not be resolved");
  const hash = await value.infrastructure.workspace.readHash(resolved.value);
  if (!hash) throw new Error("entry has no hash");
  return hash;
}

function upload(value: Fixture, operationId: string) {
  return ingestAsset(value.ingest, {
    projectId,
    kind: "image",
    filename: "drop.png",
    expectedRevision: 0,
    stream: (async function* () { yield new Uint8Array(PNG); })(),
    pendingMount: { operationId, atSeconds: 1, trackIndex: 0 },
  } as Parameters<typeof ingestAsset>[1], "user", origin);
}

async function exists(target: string): Promise<boolean> {
  try { await stat(target); return true; } catch { return false; }
}

describe("undoing a mount", () => {
  it("removes the wrapper and its sidecar, keeps the asset, and reopens the operation", async () => {
    const value = await fixture("pending");
    const operationId = "01K1AAAAAAAAAAAAAAAAAAAAAA";
    const uploaded = await upload(value, operationId);
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    const mounted = await mountAsset(value.mount, {
      projectId, operationId, expectedContentHash: await entryHash(value), onOverflow: "extend-root",
    }, "user", origin);
    expect(mounted.ok).toBe(true);
    if (!mounted.ok) return;
    const wrapper = path.join(value.project.root, "compositions", `${mounted.value.sceneId}.html`);
    const sidecar = path.join(value.project.root, "narration", `${mounted.value.sceneId}.json`);
    const asset = path.join(value.project.root, uploaded.value.path);

    const undone = await history(value, "undo");
    expect(undone.ok).toBe(true);
    expect(await exists(wrapper)).toBe(false);
    expect(await exists(sidecar)).toBe(false);
    // The whole point: undo takes back the mount, not the upload.
    expect(await exists(asset)).toBe(true);
    await expect(value.infrastructure.pendingMount.listPending(projectId)).resolves.toMatchObject([
      { operationId, state: "uploaded_unmounted" },
    ]);

    const redone = await history(value, "redo");
    expect(redone.ok).toBe(true);
    expect(await exists(wrapper)).toBe(true);
    await expect(value.infrastructure.pendingMount.lookup(projectId, operationId)).resolves.toMatchObject({
      state: "active",
      record: { state: "mounted", mountedSceneId: mounted.value.sceneId },
    });
  });

  it("blocks redo when the asset changed while the mount was undone", async () => {
    const value = await fixture("changed");
    const operationId = "01K1BBBBBBBBBBBBBBBBBBBBBB";
    const uploaded = await upload(value, operationId);
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    expect((await mountAsset(value.mount, {
      projectId, operationId, expectedContentHash: await entryHash(value), onOverflow: "extend-root",
    }, "user", origin)).ok).toBe(true);
    expect((await history(value, "undo")).ok).toBe(true);

    // Someone edits the asset outside the app while the mount is undone.
    await writeFile(path.join(value.project.root, uploaded.value.path), Buffer.concat([PNG, Buffer.from("edited")]));
    value.infrastructure.mutationObserver.observeExternalChange(projectId, [uploaded.value.path as RelPath]);

    expect(value.history.state(studioSessionId, projectId).canRedo).toBe(false);
    const redone = await history(value, "redo");
    expect(redone.ok).toBe(false);
    // The file is still there; only replaying the mount over changed bytes is refused.
    expect(await exists(path.join(value.project.root, uploaded.value.path))).toBe(true);
  });

  it("opens no pending row for an asset that was already in the project", async () => {
    const value = await fixture("existing");
    const uploaded = await ingestAsset(value.ingest, {
      projectId,
      kind: "image",
      filename: "library.png",
      expectedRevision: 0,
      stream: (async function* () { yield new Uint8Array(PNG); })(),
    } as Parameters<typeof ingestAsset>[1], "user", origin);
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    await expect(value.infrastructure.pendingMount.listPending(projectId)).resolves.toEqual([]);

    const mounted = await mountAsset(value.mount, {
      projectId,
      assetPath: uploaded.value.path,
      assetContentHash: uploaded.value.assetContentHash,
      atSeconds: 0,
      trackIndex: 0,
      expectedContentHash: await entryHash(value),
      onOverflow: "extend-root",
    }, "user", origin);
    expect(mounted.ok).toBe(true);
    if (!mounted.ok) return;
    // A drag from Media is one mutation with no operation behind it.
    await expect(value.infrastructure.pendingMount.listPending(projectId)).resolves.toEqual([]);

    expect((await history(value, "undo")).ok).toBe(true);
    expect(await exists(path.join(value.project.root, "compositions", `${mounted.value.sceneId}.html`))).toBe(false);
    expect(await exists(path.join(value.project.root, uploaded.value.path))).toBe(true);
  });
});
