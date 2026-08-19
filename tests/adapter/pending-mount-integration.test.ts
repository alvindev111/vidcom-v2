// @vitest-environment node

import { access, constants, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sweepPendingMounts } from "@vidcom/adapter";
import { hashContent, startVidcomFoundation } from "@vidcom/cli";
import {
  ErrorCode,
  MountAssetRequestSchema,
  type ContentHash,
  type ProjectId,
} from "@vidcom/contracts";
import { ingestAsset, mountAsset, type AbsolutePath } from "@vidcom/core";

import { createSequentialIdPort } from "../support/deterministic";
import { dbAll } from "../support/database";
import { writeSampleProject } from "../support/sample-project";

const roots: string[] = [];
const projectId = "project_pending_integration" as ProjectId;
const otherProjectId = "project_pending_other" as ProjectId;
const origin = {
  kind: "ui", sessionId: "01K30Y8Z7K0000000000000009", label: "Mount asset",
  historyAction: "record", historyOperation: null,
} as const;

/** A 1×1 PNG: real bytes, so the sanitizer and the probe see a real file. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * The real ffprobe on this machine.
 *
 * The mount duration is probed, so a fake here would only prove the test's own
 * stub. CI installs FFmpeg for exactly this reason, and a machine without it
 * fails loudly rather than quietly measuring nothing.
 */
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
    throw new Error(`${name} is required for the pending-mount integration suite`);
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
  const root = await mkdtemp(path.join(tmpdir(), `vidcom-pending-${label}-`));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  const project = await writeSampleProject(workspaceRoot, { slug: label, id: projectId });
  await writeSampleProject(workspaceRoot, { slug: `${label}-other`, id: otherProjectId });
  const foundation = await startVidcomFoundation({
    appDataRoot: path.join(root, "app-data"),
    workspaceRoot: workspaceRoot as AbsolutePath,
    holderId: `test:${label}`,
    renderBinaryPaths: await mediaBinaries(),
    clock: { now: () => new Date("2026-08-18T12:00:00.000Z") },
    ids: createSequentialIdPort(),
  }, {
    async recoverJobs() {}, async startScheduler() {}, async startWatcher() {}, async openListener() { return null; },
  });
  const { infrastructure, application } = foundation;
  if (!application) throw new Error("application was not created");
  const ingestDependencies = {
    ...application.writeDependencies,
    staging: infrastructure.assetStaging,
    sanitizer: infrastructure.assetSanitizer,
    pendingMount: infrastructure.pendingMount,
    probe: infrastructure.assetProbe,
    hashContent,
  } as unknown as Parameters<typeof ingestAsset>[0];
  const mountDependencies = {
    workspace: infrastructure.workspace,
    composition: infrastructure.composition,
    probe: infrastructure.assetProbe,
    pendingMount: infrastructure.pendingMount,
    authority: application.authority,
    clock: infrastructure.clock,
  } as unknown as Parameters<typeof mountAsset>[0];
  return { root, project, foundation, infrastructure, application, ingestDependencies, mountDependencies };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function upload(value: Fixture, options: {
  operationId?: string;
  bytes?: Buffer;
  filename?: string;
  atSeconds?: number;
  trackIndex?: number;
  owner?: ProjectId;
}) {
  const bytes = options.bytes ?? PNG;
  const revision = await value.infrastructure.journal.latestRevision(options.owner ?? projectId) ?? 0;
  return await ingestAsset(value.ingestDependencies, {
    projectId: options.owner ?? projectId,
    kind: "image",
    filename: options.filename ?? "drop.png",
    expectedRevision: revision,
    stream: (async function* () { yield new Uint8Array(bytes); })(),
    ...(options.operationId === undefined ? {} : {
      pendingMount: {
        operationId: options.operationId,
        atSeconds: options.atSeconds ?? 1,
        trackIndex: options.trackIndex ?? 0,
      },
    }),
  } as Parameters<typeof ingestAsset>[1], "user", origin);
}

async function entryHash(value: Fixture, owner: ProjectId = projectId): Promise<ContentHash> {
  const ref = await value.infrastructure.workspace.readProjectRef(owner);
  if (!ref) throw new Error("project was not registered");
  const resolved = await value.infrastructure.workspace.resolve(ref, ref.entry, "read-source");
  if (!resolved.ok) throw new Error("entry could not be resolved");
  const hash = await value.infrastructure.workspace.readHash(resolved.value);
  if (!hash) throw new Error("entry has no hash");
  return hash;
}

function rows(value: Fixture) {
  return dbAll<{ operationId: string; state: string; sceneId: string | null; owner: string }>(
    value.infrastructure.database,
    `SELECT operation_id AS operationId, state, mounted_scene_id AS sceneId, project_id AS owner
     FROM pending_mount ORDER BY operation_id`,
  );
}

async function exists(target: string): Promise<boolean> {
  try { await stat(target); return true; } catch { return false; }
}

describe("pending mount, end to end", () => {
  it("carries one drop from upload to a mounted scene and closes its row", async () => {
    const value = await fixture("mounted");
    const operationId = "01K1AAAAAAAAAAAAAAAAAAAAAA";
    const uploaded = await upload(value, { operationId });
    expect(uploaded.ok).toBe(true);
    expect(rows(value)).toEqual([
      { operationId, state: "uploaded_unmounted", sceneId: null, owner: projectId },
    ]);

    const mounted = await mountAsset(value.mountDependencies, {
      projectId,
      operationId,
      expectedContentHash: await entryHash(value),
      onOverflow: "extend-root",
    }, "user", origin);
    expect(mounted.ok).toBe(true);
    if (!mounted.ok) return;
    expect(rows(value)).toEqual([
      { operationId, state: "mounted", sceneId: mounted.value.sceneId, owner: projectId },
    ]);
    // The wrapper scene and its sidecar are on disk, and the root entry points at it.
    expect(await exists(path.join(value.project.root, "compositions", `${mounted.value.sceneId}.html`))).toBe(true);
    expect(await readFile(path.join(value.project.root, "index.html"), "utf8"))
      .toContain(`data-composition-id="${mounted.value.sceneId}"`);

    // A replay of the same operation returns the same scene and writes nothing.
    const before = await value.infrastructure.journal.latestRevision(projectId);
    const replayed = await mountAsset(value.mountDependencies, {
      projectId,
      operationId,
      expectedContentHash: await entryHash(value),
      onOverflow: "extend-root",
    }, "user", origin);
    expect(replayed.ok).toBe(true);
    if (replayed.ok) expect(replayed.value).toMatchObject({ sceneId: mounted.value.sceneId, replayed: true });
    expect(await value.infrastructure.journal.latestRevision(projectId)).toBe(before);
  });

  it("refuses an operation from another project and writes nothing there", async () => {
    const value = await fixture("cross");
    const operationId = "01K1BBBBBBBBBBBBBBBBBBBBBB";
    expect((await upload(value, { operationId })).ok).toBe(true);
    const before = await value.infrastructure.journal.latestRevision(otherProjectId);
    const mounted = await mountAsset(value.mountDependencies, {
      projectId: otherProjectId,
      operationId,
      expectedContentHash: await entryHash(value, otherProjectId),
      onOverflow: "extend-root",
    }, "user", origin);
    expect(mounted.ok).toBe(false);
    if (!mounted.ok) expect(mounted.error.code).toBe(ErrorCode.NotFound);
    expect(await value.infrastructure.journal.latestRevision(otherProjectId)).toBe(before);
    expect(rows(value)).toEqual([
      { operationId, state: "uploaded_unmounted", sceneId: null, owner: projectId },
    ]);
  });

  it("replays an identical upload and refuses a different one under the same operation", async () => {
    const value = await fixture("replay");
    const operationId = "01K1CCCCCCCCCCCCCCCCCCCCCC";
    expect((await upload(value, { operationId })).ok).toBe(true);
    const revision = await value.infrastructure.journal.latestRevision(projectId);

    const again = await upload(value, { operationId });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.replayed).toBe(true);
    expect(await value.infrastructure.journal.latestRevision(projectId)).toBe(revision);

    const different = await upload(value, { operationId, bytes: Buffer.concat([PNG, Buffer.from("x")]) });
    expect(different.ok).toBe(false);
    if (!different.ok) expect(different.error.code).toBe(ErrorCode.WriteConflict);
    expect(await value.infrastructure.journal.latestRevision(projectId)).toBe(revision);
  });

  it("refuses a retry after retention removed the row, without mounting a second time", async () => {
    const value = await fixture("expired");
    const operationId = "01K1DDDDDDDDDDDDDDDDDDDDDD";
    expect((await upload(value, { operationId })).ok).toBe(true);
    const mounted = await mountAsset(value.mountDependencies, {
      projectId, operationId, expectedContentHash: await entryHash(value), onOverflow: "extend-root",
    }, "user", origin);
    expect(mounted.ok).toBe(true);

    // Two days later the tombstone is swept; the journal still proves it existed.
    await sweepPendingMounts(value.infrastructure.database, new Date("2026-08-20T12:00:00.000Z"));
    expect(rows(value)).toEqual([]);
    await expect(value.infrastructure.pendingMount.lookup(projectId, operationId))
      .resolves.toEqual({ state: "expired" });

    const revision = await value.infrastructure.journal.latestRevision(projectId);
    const late = await mountAsset(value.mountDependencies, {
      projectId, operationId, expectedContentHash: await entryHash(value), onOverflow: "extend-root",
    }, "user", origin);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe(ErrorCode.NotFound);
    expect(await value.infrastructure.journal.latestRevision(projectId)).toBe(revision);
    // Exactly one wrapper scene exists: the retry created nothing.
    if (mounted.ok) {
      expect(await exists(path.join(value.project.root, "compositions", `${mounted.value.sceneId}.html`))).toBe(true);
      expect(await exists(path.join(value.project.root, "compositions", "scene-3.html"))).toBe(false);
    }
  });

  it("leaves no row and no mount when the upload itself fails", async () => {
    const value = await fixture("failed-upload");
    const operationId = "01K1EEEEEEEEEEEEEEEEEEEEEE";
    const refused = await upload(value, { operationId, bytes: Buffer.from("not an image at all") });
    expect(refused.ok).toBe(false);
    expect(rows(value)).toEqual([]);

    const revision = await value.infrastructure.journal.latestRevision(projectId);
    const mounted = await mountAsset(value.mountDependencies, {
      projectId, operationId, expectedContentHash: await entryHash(value), onOverflow: "extend-root",
    }, "user", origin);
    expect(mounted.ok).toBe(false);
    if (!mounted.ok) expect(mounted.error.code).toBe(ErrorCode.NotFound);
    expect(await value.infrastructure.journal.latestRevision(projectId)).toBe(revision);
  });

  it("lets abandon win over a later mount, and keeps the asset in Media", async () => {
    const value = await fixture("abandoned");
    const operationId = "01K1FFFFFFFFFFFFFFFFFFFFFF";
    const uploaded = await upload(value, { operationId });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    await value.infrastructure.pendingMount.abandon(projectId, operationId, "user cancelled the upload");

    const revision = await value.infrastructure.journal.latestRevision(projectId);
    const mounted = await mountAsset(value.mountDependencies, {
      projectId, operationId, expectedContentHash: await entryHash(value), onOverflow: "extend-root",
    }, "user", origin);
    expect(mounted.ok).toBe(false);
    expect(await value.infrastructure.journal.latestRevision(projectId)).toBe(revision);
    expect(rows(value)).toEqual([
      { operationId, state: "abandoned", sceneId: null, owner: projectId },
    ]);
    // The point of abandoning a mount: the file is still there.
    expect(await exists(path.join(value.project.root, uploaded.value.path))).toBe(true);
  });

  it("places a retry where the record says, and refuses a payload that tries to move it", async () => {
    const value = await fixture("placement");
    const operationId = "01K1GGGGGGGGGGGGGGGGGGGGGG";
    expect((await upload(value, { operationId, atSeconds: 2, trackIndex: 1 })).ok).toBe(true);

    // The retry contract carries the operation and the precondition, nothing else.
    expect(MountAssetRequestSchema.safeParse({
      operationId,
      assetPath: "assets/elsewhere.png",
      atSeconds: 9,
      trackIndex: 3,
      expectedContentHash: await entryHash(value),
      onOverflow: "extend-root",
    }).success).toBe(false);

    const mounted = await mountAsset(value.mountDependencies, {
      projectId, operationId, expectedContentHash: await entryHash(value), onOverflow: "extend-root",
    }, "user", origin);
    expect(mounted.ok).toBe(true);
    if (!mounted.ok) return;
    const entry = await readFile(path.join(value.project.root, "index.html"), "utf8");
    const layer = new RegExp(`data-composition-id="${mounted.value.sceneId}"[^>]*`, "u").exec(entry)?.[0] ?? "";
    // The track comes from the row the upload opened; this request carried none.
    // The start is the timeline's to decide from that placement, not the client's.
    expect(layer).toContain(`data-track-index="1"`);
  });
});
