// @vitest-environment node

import { access, constants, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hashContent, startVidcomFoundation } from "@vidcom/cli";
import { ErrorCode, type ContentHash, type ProjectId } from "@vidcom/contracts";
import { ingestAsset, mountAsset, type AbsolutePath } from "@vidcom/core";

import { createSequentialIdPort } from "../support/deterministic";
import { writeSampleProject } from "../support/sample-project";

const roots: string[] = [];
const projectId = "project_pending_recovery" as ProjectId;
const origin = {
  kind: "ui", sessionId: "01K30Y8Z7K0000000000000011", label: "Mount asset",
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
    throw new Error(`${name} is required for the pending-mount recovery suite`);
  };
  return {
    ffmpegPath: await find("ffmpeg") as AbsolutePath,
    ffprobePath: await find("ffprobe") as AbsolutePath,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** One workspace and one app-data directory that survive a foundation restart. */
async function workspace(label: string) {
  const root = await mkdtemp(path.join(tmpdir(), `vidcom-recovery-${label}-`));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  const project = await writeSampleProject(workspaceRoot, { slug: label, id: projectId });
  return { root, workspaceRoot, project, appDataRoot: path.join(root, "app-data") };
}

async function boot(place: Awaited<ReturnType<typeof workspace>>, label: string, at = "2026-08-18T12:00:00.000Z") {
  const foundation = await startVidcomFoundation({
    appDataRoot: place.appDataRoot,
    workspaceRoot: place.workspaceRoot as AbsolutePath,
    holderId: `test:${label}`,
    clock: { now: () => new Date(at) },
    ids: createSequentialIdPort(),
    renderBinaryPaths: await mediaBinaries(),
  }, {
    async recoverJobs() {}, async startScheduler() {}, async startWatcher() {}, async openListener() { return null; },
  });
  const { infrastructure, application } = foundation;
  return {
    foundation,
    infrastructure,
    application,
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

type Runtime = Awaited<ReturnType<typeof boot>>;

/**
 * Kills the process at the publish/settle boundary.
 *
 * The files are already on disk when `commitComposite` runs, so throwing there
 * reproduces exactly the crash the pending-mount design exists for: a published
 * write whose intent was never settled.
 */
function killAtCommit(runtime: Runtime): void {
  const journal = runtime.infrastructure.journal as unknown as { commitComposite: unknown };
  journal.commitComposite = () => Promise.reject(new Error("process died before settling"));
}

async function entryHash(runtime: Runtime): Promise<ContentHash> {
  const ref = await runtime.infrastructure.workspace.readProjectRef(projectId);
  if (!ref) throw new Error("project was not registered");
  const resolved = await runtime.infrastructure.workspace.resolve(ref, ref.entry, "read-source");
  if (!resolved.ok) throw new Error("entry could not be resolved");
  const hash = await runtime.infrastructure.workspace.readHash(resolved.value);
  if (!hash) throw new Error("entry has no hash");
  return hash;
}

function upload(runtime: Runtime, operationId: string) {
  return ingestAsset(runtime.ingest, {
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

describe("pending mount recovery", () => {
  it("shows an upload that never settled as pending, and says it was interrupted", async () => {
    const place = await workspace("upload");
    const first = await boot(place, "upload-1");
    killAtCommit(first);
    const interrupted = await upload(first, "01K1AAAAAAAAAAAAAAAAAAAAAA");
    expect(interrupted.ok).toBe(false);
    if (!interrupted.ok) expect(interrupted.error.code).toBe(ErrorCode.RecoveryRequired);
    await first.foundation.stop();

    // Restart: the production startup sequence is what has to repair this.
    const second = await boot(place, "upload-2");
    const pending = await second.infrastructure.pendingMount.listPending(projectId);
    expect(pending).toMatchObject([{
      operationId: "01K1AAAAAAAAAAAAAAAAAAAAAA",
      state: "uploaded_unmounted",
      // Without a reason, Media would show an unexplained file (R11.3b).
      lastFailure: { code: "interrupted" },
    }]);
    expect(await exists(path.join(place.project.root, pending[0]!.assetPath))).toBe(true);

    // The operation is still mountable: the crash cost the mount, not the upload.
    const mounted = await mountAsset(second.mount, {
      projectId,
      operationId: "01K1AAAAAAAAAAAAAAAAAAAAAA",
      expectedContentHash: await entryHash(second),
      onOverflow: "extend-root",
    }, "user", origin);
    expect(mounted.ok).toBe(true);
    await expect(second.infrastructure.pendingMount.listPending(projectId)).resolves.toEqual([]);
    await second.foundation.stop();
  });

  it("settles a mount whose commit never landed, and answers the retry with it", async () => {
    const place = await workspace("mount");
    const first = await boot(place, "mount-1");
    const operationId = "01K1BBBBBBBBBBBBBBBBBBBBBB";
    expect((await upload(first, operationId)).ok).toBe(true);
    const expectedContentHash = await entryHash(first);
    killAtCommit(first);
    const interrupted = await mountAsset(first.mount, {
      projectId, operationId, expectedContentHash, onOverflow: "extend-root",
    }, "user", origin);
    expect(interrupted.ok).toBe(false);
    if (!interrupted.ok) expect(interrupted.error.code).toBe(ErrorCode.RecoveryRequired);
    await first.foundation.stop();

    const second = await boot(place, "mount-2");
    const found = await second.infrastructure.pendingMount.lookup(projectId, operationId);
    expect(found.state).toBe("active");
    if (found.state !== "active") return;
    // Reconciliation concluded the composite was committed, so it applied the
    // close it had recorded at T1: the row is mounted and points at a scene that
    // is really there.
    expect(found.record.state).toBe("mounted");
    expect(await exists(path.join(place.project.root, "compositions", `${found.record.mountedSceneId}.html`)))
      .toBe(true);

    // The retry the browser sends after a lost response gets that same scene back.
    const replayed = await mountAsset(second.mount, {
      projectId, operationId, expectedContentHash: await entryHash(second), onOverflow: "extend-root",
    }, "user", origin);
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.value).toMatchObject({ sceneId: found.record.mountedSceneId, replayed: true });
    }
    // One wrapper only: the sample scene plus the mounted one.
    const entry = await readFile(path.join(place.project.root, "index.html"), "utf8");
    expect(entry.match(/data-composition-src="compositions\//gu)?.length).toBe(2);
    await expect(second.infrastructure.pendingMount.listPending(projectId)).resolves.toEqual([]);
    await second.foundation.stop();
  });
});
