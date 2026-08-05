import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabase } from "@vidcom/adapter";
import { type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import { createScene, patchNarrationCue, setSceneScript, setSceneTiming, type AbsolutePath, type ProjectRef } from "@vidcom/core";
import { createApplication, createInfrastructure, hashContent } from "../../packages/cli/src/composition-root";

import { dbRun } from "../support/database";

const roots: string[] = [];
const databases: Array<{ destroy(): Promise<void> }> = [];
const now = "2026-08-04T12:00:00.000Z";
const clock = { now: () => new Date(now) };

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function identity(id: ProjectId) {
  return `${JSON.stringify({
    schemaVersion: 1,
    id,
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

async function fixture(slug: string, index: string | null) {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-scene-ripple-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const appDataRoot = path.join(root, "app-data");
  const projectRoot = path.join(workspaceRoot, slug);
  await mkdir(projectRoot, { recursive: true });
  const id = `project_${slug.replaceAll("-", "_")}` as ProjectId;
  await Promise.all([
    writeFile(path.join(projectRoot, "vidcom.json"), identity(id)),
    writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n"),
    ...(index === null ? [] : [writeFile(path.join(projectRoot, "index.html"), index)]),
  ]);
  const initialized = await initializeDatabase(appDataRoot);
  await initialized.destroy();
  const infrastructure = createInfrastructure({
    appDataRoot, workspaceRoot: workspaceRoot as AbsolutePath, clock,
  });
  databases.push(infrastructure.database);
  dbRun(infrastructure.database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  id, workspaceRoot, slug, now, now);
  const lease = await infrastructure.lease.acquire(workspaceRoot as AbsolutePath, "test:scene-ripple");
  if (!lease.ok) throw new Error("workspace lease denied");
  const application = createApplication(infrastructure, lease.leaseId);
  const ref: ProjectRef = { id, slug, root: projectRoot as AbsolutePath, entry: "index.html" as RelPath };
  return { id, projectRoot, infrastructure, application, ref };
}

const multiTrack = `<!doctype html><html><body>
<main data-composition-id="main" data-width="320" data-height="180" data-fps="30" data-duration="4">
  <section data-composition-id="a" data-start="0" data-duration="2" data-track-index="0"></section>
  <section data-composition-id="b" data-start="2" data-duration="2" data-track-index="0"></section>
  <section data-composition-id="overlay" data-start="0" data-duration="4" data-track-index="1"></section>
</main></body></html>\n`;

describe("Phase N scene ripple and narration on real SQLite/filesystem", () => {
  it("inserts in one track, shifts only following peers, and leaves the other track fixed", async () => {
    const value = await fixture("insert-track", multiTrack);
    const source = await value.infrastructure.workspace.resolve(value.ref, value.ref.entry, "read-source");
    if (!source.ok) throw new Error("entry resolve failed");
    const hash = await value.infrastructure.workspace.readHash(source.value) as ContentHash;
    const result = await createScene(value.application.writeDependencies, {
      projectId: value.id,
      title: "Inserted",
      duration: 1,
      index: 1,
      trackIndex: 0,
      expectedContentHash: hash,
    }, "agent");
    expect(result).toMatchObject({
      ok: true,
      value: {
        scene: { start: 2, trackIndex: 0 },
        moved: [{ sceneId: "b", fromStart: 2, toStart: 3 }],
        envelope: { projectRevision: 1 },
      },
    });
    const model = await value.infrastructure.composition.parseProject(value.ref);
    const byId = Object.fromEntries(model.scenes.map((scene) => [scene.id, scene]));
    expect(byId.b?.start).toBe(3);
    expect(byId.overlay?.start).toBe(0);
    expect(model.project.duration).toBe(5);
  });

  it("ripples only the changed track and commits the root update in one revision", async () => {
    const value = await fixture("multi-track", multiTrack);
    const source = await value.infrastructure.workspace.resolve(value.ref, value.ref.entry, "read-source");
    if (!source.ok) throw new Error("entry resolve failed");
    const hash = await value.infrastructure.workspace.readHash(source.value) as ContentHash;
    const result = await setSceneTiming(value.application.writeDependencies, {
      projectId: value.id,
      sceneId: "a",
      timing: { duration: 3 },
      expectedContentHash: hash,
      ripple: true,
      extendRoot: true,
    }, "user");
    expect(result).toMatchObject({
      ok: true,
      value: {
        affectedTrackIndex: 0,
        moved: [{ sceneId: "b", fromStart: 2, toStart: 3 }],
        envelope: { projectRevision: 1 },
      },
    });
    const model = await value.infrastructure.composition.parseProject(value.ref);
    expect(model.scenes.map(({ id, start, trackIndex }) => ({ id, start, trackIndex }))
      .sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: "a", start: 0, trackIndex: 0 },
      { id: "b", start: 3, trackIndex: 0 },
      { id: "overlay", start: 0, trackIndex: 1 },
    ]);
    expect(model.project.duration).toBe(5);
    expect(await value.infrastructure.journal.latestRevision(value.id)).toBe(1);
  });

  it("creates the first scene and root document from identity in one revision", async () => {
    const value = await fixture("empty-project", null);
    const result = await createScene(value.application.writeDependencies, {
      projectId: value.id,
      title: "First",
      index: 0,
      expectedContentHash: null,
    }, "agent");
    expect(result).toMatchObject({
      ok: true,
      value: {
        scene: { id: "scene-1", start: 0, trackIndex: 0 },
        project: { sceneCount: 1 },
        envelope: { projectRevision: 1 },
      },
    });
    expect(await value.infrastructure.journal.latestRevision(value.id)).toBe(1);
    const model = await value.infrastructure.composition.parseProject(value.ref);
    expect(model.scenes).toHaveLength(1);
    expect(await readFile(path.join(value.projectRoot, "compositions/scene-1.html"), "utf8")).toContain("First");
  });

  it("returns machine-readable root and runtime overflow discriminators before writing", async () => {
    const value = await fixture("duration-limits", multiTrack);
    const source = await value.infrastructure.workspace.resolve(value.ref, value.ref.entry, "read-source");
    if (!source.ok) throw new Error("entry resolve failed");
    const hash = await value.infrastructure.workspace.readHash(source.value) as ContentHash;
    await expect(setSceneTiming(value.application.writeDependencies, {
      projectId: value.id, sceneId: "a", timing: { duration: 5 }, expectedContentHash: hash,
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: {
        code: "duration_overflow",
        details: { limitKind: "root", actualSeconds: 5, maxSeconds: 4, extendRootAllowed: true },
      },
    });
    await expect(setSceneTiming(value.application.writeDependencies, {
      projectId: value.id, sceneId: "a", timing: { duration: 3_601 },
      expectedContentHash: hash, extendRoot: true,
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: {
        code: "duration_overflow",
        details: {
          limitKind: "runtime", actualSeconds: 3_601,
          maxSeconds: 3_600, extendRootAllowed: false,
        },
      },
    });
    expect(await value.infrastructure.journal.latestRevision(value.id)).toBeNull();
  });

  it("marks only the script line's matching cue stale", async () => {
    const root = `<!doctype html><html><body>
<main data-composition-id="main" data-width="320" data-height="180" data-duration="4">
  <section data-composition-id="scene" data-composition-src="compositions/scene.html" data-start="0" data-duration="4"></section>
</main></body></html>\n`;
    const value = await fixture("cue-stale", root);
    const sceneFile = path.join(value.projectRoot, "compositions/scene.html");
    await mkdir(path.dirname(sceneFile), { recursive: true });
    await mkdir(path.join(value.projectRoot, "narration"), { recursive: true });
    await writeFile(sceneFile, `<!doctype html><html><body>
<div data-composition-id="scene" data-duration="4"><p data-hf-id="line-1">One</p><p data-hf-id="line-2">Two</p></div>
</body></html>\n`);
    await writeFile(path.join(value.projectRoot, "narration/scene.json"), `${JSON.stringify({
      schemaVersion: 2,
      sceneId: "scene",
      revision: 1,
      updatedAt: now,
      cues: [
        { cueId: "line-1", text: "One", voice: "a", offsetSeconds: 0, durationSeconds: 1,
          staleSince: null, status: "mock", audioPath: "narration/scene/line-1.wav" },
        { cueId: "line-2", text: "Two", voice: "b", offsetSeconds: 1.5, durationSeconds: 1,
          staleSince: null, status: "mock", audioPath: "narration/scene/line-2.wav" },
      ],
    }, null, 2)}\n`);
    const source = await value.infrastructure.workspace.resolve(value.ref, "compositions/scene.html", "read-source");
    if (!source.ok) throw new Error("scene resolve failed");
    const hash = await value.infrastructure.workspace.readHash(source.value) as ContentHash;
    const result = await setSceneScript(value.application.writeDependencies, {
      projectId: value.id,
      sceneId: "scene",
      file: "compositions/scene.html" as RelPath,
      elementId: "line-1",
      text: "One updated",
      expectedContentHash: hash,
    }, "user");
    expect(result.ok).toBe(true);
    const sidecar = JSON.parse(await readFile(path.join(value.projectRoot, "narration/scene.json"), "utf8"));
    expect(sidecar.cues.map((cue: { cueId: string; staleSince: string | null }) => ({
      cueId: cue.cueId, staleSince: cue.staleSince,
    }))).toEqual([
      { cueId: "line-1", staleSince: now },
      { cueId: "line-2", staleSince: null },
    ]);
  });

  it("patches one generated cue without resetting sibling or audio metadata", async () => {
    const value = await fixture("cue-patch", multiTrack);
    await mkdir(path.join(value.projectRoot, "narration"), { recursive: true });
    const sidecarPath = path.join(value.projectRoot, "narration/a.json");
    const original = {
      schemaVersion: 2,
      sceneId: "a",
      revision: 3,
      updatedAt: "2026-08-03T00:00:00.000Z",
      cues: [
        { cueId: "line-1", text: "One", voice: "a", offsetSeconds: 0, durationSeconds: 1.25,
          staleSince: null, status: "generated", audioPath: "narration/a/line-1.wav", command: "tts one",
          provider: "vieneu", engine: { model: "v3", device: "cpu" },
          words: [{ text: "One", startSeconds: 0, endSeconds: 1.25 }], wordTimingSource: "engine" },
        { cueId: "line-2", text: "Two", voice: "b", offsetSeconds: 1.5, durationSeconds: 1,
          staleSince: null, status: "generated", audioPath: "narration/a/line-2.wav", command: "tts two",
          words: [{ text: "Two", startSeconds: 0, endSeconds: 1 }], wordTimingSource: "estimated" },
      ],
    };
    const content = `${JSON.stringify(original, null, 2)}\n`;
    await writeFile(sidecarPath, content);

    const result = await patchNarrationCue(value.application.writeDependencies, {
      projectId: value.id,
      sceneId: "a",
      cueId: "line-1",
      patch: { text: "One updated" },
      expectedContentHash: hashContent(content),
    }, "user");
    expect(result.ok).toBe(true);
    const updatedContent = await readFile(sidecarPath, "utf8");
    const updated = JSON.parse(updatedContent);
    expect(updated.cues[0]).toEqual({ ...original.cues[0], text: "One updated", staleSince: now });
    expect(updated.cues[1]).toEqual(original.cues[1]);

    const offsetOnly = await patchNarrationCue(value.application.writeDependencies, {
      projectId: value.id,
      sceneId: "a",
      cueId: "line-2",
      patch: { offsetSeconds: 2 },
      expectedContentHash: hashContent(updatedContent),
    }, "user");
    expect(offsetOnly.ok).toBe(true);
    const offsetUpdated = JSON.parse(await readFile(sidecarPath, "utf8"));
    expect(offsetUpdated.cues[0]).toEqual(updated.cues[0]);
    expect(offsetUpdated.cues[1]).toEqual({ ...original.cues[1], offsetSeconds: 2 });

    const legacy = {
      sceneId: "a", text: "Legacy", voice: "legacy-voice", status: "generated",
      audioPath: "narration/a.wav", command: "vidcom tts --scene a", revision: 7,
      updatedAt: "2026-08-03T00:00:00.000Z", staleSince: null, provider: "vieneu",
      durationSeconds: 1.5, words: [{ text: "Legacy", startSeconds: 0, endSeconds: 1.5 }],
      wordTimingSource: "engine", engine: { model: "v3", device: "cpu" },
    };
    const legacyContent = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(sidecarPath, legacyContent);
    const legacyPatched = await patchNarrationCue(value.application.writeDependencies, {
      projectId: value.id, sceneId: "a", cueId: "a", patch: { offsetSeconds: 0.25 },
      expectedContentHash: hashContent(legacyContent),
    }, "user");
    expect(legacyPatched.ok).toBe(true);
    const normalizedLegacy = JSON.parse(await readFile(sidecarPath, "utf8"));
    expect(normalizedLegacy).toMatchObject({
      status: "generated", audioPath: legacy.audioPath, command: legacy.command,
      provider: legacy.provider, engine: legacy.engine, words: legacy.words, wordTimingSource: "engine",
      cues: [{
        status: "generated", audioPath: legacy.audioPath, command: legacy.command,
        provider: legacy.provider, engine: legacy.engine, words: legacy.words, offsetSeconds: 0.25,
      }],
    });
  });
});
