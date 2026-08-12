import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  initializeDatabase,
  NodeHyperframesDiagnosticsLint,
  NodeModulesMotionLibraryFiles,
  NodeProcessRunner,
} from "@vidcom/adapter";
import {
  ErrorCode,
  countStrandedTweens,
  measureElementWindow,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import {
  DiagnosticsService,
  findMotionLibrary,
  installMotionLibrary,
  type AbsolutePath,
  type CompositionModel,
  type CompositionPort,
  type ProjectRef,
  ThumbnailResolver,
  setSceneTiming,
} from "@vidcom/core";
import { prepareRender, prepareSnapshot } from "@vidcom/worker";
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

const emptyComposition = `<!doctype html><html><body>
<main data-composition-id="root" data-width="320" data-height="180" data-fps="30" data-duration="0"></main>
</body></html>\n`;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-diagnostics-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const appDataRoot = path.join(root, "app-data");
  await mkdir(workspaceRoot, { recursive: true });
  const initialized = await initializeDatabase(appDataRoot);
  await initialized.destroy();
  const infrastructure = createInfrastructure({
    appDataRoot,
    workspaceRoot: workspaceRoot as AbsolutePath,
    clock,
  });
  databases.push(infrastructure.database);
  const lease = await infrastructure.lease.acquire(workspaceRoot as AbsolutePath, "test:diagnostics");
  if (!lease.ok) throw new Error("workspace lease denied");
  const application = createApplication(infrastructure, lease.leaseId);
  return { root, workspaceRoot, infrastructure, application };
}

async function addProject(
  value: Awaited<ReturnType<typeof fixture>>,
  slug: string,
  id: ProjectId,
  index: string | null,
) {
  const projectRoot = path.join(value.workspaceRoot, slug);
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "vidcom.json"), identity(id));
  await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
  if (index !== null) await writeFile(path.join(projectRoot, "index.html"), index);
  dbRun(value.infrastructure.database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  id, value.workspaceRoot, slug, now, now);
  const ref: ProjectRef = {
    id, slug, root: projectRoot as AbsolutePath, entry: "index.html" as RelPath,
  };
  await value.application.state.ensure(ref);
  return { projectRoot, ref };
}

function diagnosticsWithMissingCheck(value: Awaited<ReturnType<typeof fixture>>) {
  return new DiagnosticsService({
    scan: value.application.scanWorkspace,
    workspace: value.infrastructure.workspace,
    composition: value.infrastructure.composition,
    identity: value.application.identity,
    journal: value.infrastructure.journal,
    authority: value.application.authority,
    lint: new NodeHyperframesDiagnosticsLint(
      new NodeProcessRunner(2_000),
      {
        cliPath: path.join(value.root, "missing-hyperframes-cli.mjs") as AbsolutePath,
        timeoutMs: 2_000,
      },
    ),
    fonts: value.application.fonts,
  });
}

describe("Phase M diagnostics and thumbnails on real SQLite/filesystem", () => {
  it("uses the same Core arithmetic for stranded tweens and element overruns", () => {
    const elements = [{
      id: "title", start: 1, duration: 4,
      effects: [{ id: "late", start: 3, duration: 1 }],
    }];
    expect(countStrandedTweens(elements, 3)).toBe(1);
    expect(measureElementWindow(elements[0]!, 3)).toMatchObject({ start: 1, span: 4, inWindow: 2, overrun: 2 });
  });

  it("emits every internal diagnostic family and merges lint findings", async () => {
    const value = await fixture();
    const id = "project_all_diagnostics" as ProjectId;
    await addProject(value, "all-diagnostics", id, emptyComposition);
    const model = {
      project: {
        id,
        slug: "all-diagnostics",
        title: "All diagnostics",
        width: 1920,
        height: 1080,
        duration: 8,
        updatedAt: now,
        sceneCount: 2,
        revision: 0,
      },
      frameRate: 60,
      scenes: [{
        id: "timed",
        src: "compositions/timed.html",
        start: 0,
        duration: 4,
        trackIndex: 0,
        block: null,
        isTransition: false,
        media: [],
        script: [],
        narration: {
          sceneId: "timed",
          text: "long narration",
          voice: "voice",
          status: "generated",
          audioPath: "narration/timed.wav",
          command: "tts",
          revision: 1,
          updatedAt: now,
          staleSince: null,
          durationSeconds: 6,
        },
        elements: [{
          id: "hero",
          label: "hero",
          kind: "image",
          start: 1,
          duration: 5,
          src: "assets/missing.png",
          effects: [{ id: "late", method: "to", start: 4, duration: 1, ease: null, propertyGroup: null }],
        }],
        unresolvedEffects: 2,
      }, {
        id: "empty",
        src: null,
        start: 4,
        duration: 4,
        trackIndex: 0,
        block: null,
        isTransition: false,
        media: [],
        script: [],
        narration: null,
        elements: [],
        unresolvedEffects: 0,
      }],
      rootTrack: null,
      diagnostics: [],
      sources: [{ path: "index.html" as RelPath, contentHash: hashContent("index"), byteSize: 5 }],
      references: [{ owner: "index.html" as RelPath, path: "assets/missing.png" as RelPath }],
    } satisfies CompositionModel;
    const composition = new Proxy(value.infrastructure.composition, {
      get(target, property) {
        if (property === "parseProject") return async () => model;
        const member = Reflect.get(target, property, target) as unknown;
        return typeof member === "function" ? member.bind(target) : member;
      },
    }) as CompositionPort;
    const service = new DiagnosticsService({
      scan: async () => [{
        kind: "project",
        projectId: id,
        slug: "all-diagnostics",
        state: "authored",
        platform: null,
        sceneCount: 2,
      }],
      workspace: value.infrastructure.workspace,
      composition,
      identity: value.application.identity,
      journal: value.infrastructure.journal,
      authority: value.application.authority,
      lint: {
        async check() {
          return { available: true, diagnostics: [{ severity: "warning", code: "lint:sample", message: "sample" }] };
        },
      },
      fonts: value.application.fonts,
    });
    const report = await service.forProject(id);
    expect(report.ok).toBe(true);
    if (report.ok) expect(new Set(report.value.diagnostics.map(({ code }) => code))).toEqual(new Set([
      "element-overrun",
      "stranded-tween",
      "unresolved-selector",
      "narration-overflow",
      "empty-scene",
      "platform-mismatch",
      "missing-asset",
      "story-motion-unverified",
      "lint:sample",
    ]));
  });

  it("reports authored zero-scene and an explicit unavailable lint source, then persists the revisioned report", async () => {
    const value = await fixture();
    const id = "project_zero_scenes" as ProjectId;
    const { projectRoot } = await addProject(value, "zero-scenes", id, emptyComposition);
    const result = await diagnosticsWithMissingCheck(value).forProject(id);
    expect(result).toMatchObject({ ok: true, value: { computedAtSourceRevision: 0, lintSourceAvailable: false } });
    if (!result.ok) return;
    expect(result.value.diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "no-scenes", "lint-source-unavailable",
    ]));
    const stored = JSON.parse(await readFile(path.join(projectRoot, ".vidcom/context/diagnostics.json"), "utf8"));
    expect(stored).toEqual(result.value);
  });

  it("keeps invalid composition diagnosable while render, snapshot, and composition mutation reject project_invalid", async () => {
    const value = await fixture();
    const id = "project_invalid_composition" as ProjectId;
    const { ref } = await addProject(value, "invalid-composition", id, "<html><body>broken</body></html>\n");
    const diagnostic = await diagnosticsWithMissingCheck(value).forProject(id);
    expect(diagnostic.ok && diagnostic.value.diagnostics.map(({ code }) => code)).toContain("composition_parse_error");
    const jobDeps = {
      workspace: value.infrastructure.workspace,
      composition: value.infrastructure.composition,
      journal: value.infrastructure.journal,
      fonts: value.application.fonts,
    };
    await expect(prepareRender(jobDeps, id)).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.ProjectInvalid } });
    await expect(prepareSnapshot(jobDeps, id)).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.ProjectInvalid } });
    const current = await value.infrastructure.workspace.resolve(ref, ref.entry, "read-source");
    if (!current.ok) throw new Error("entry resolve failed");
    const sourceHash = (await value.infrastructure.workspace.readHash(current.value))!;
    await expect(setSceneTiming({
      workspace: value.infrastructure.workspace,
      composition: value.infrastructure.composition,
      journal: value.infrastructure.journal,
      authority: value.application.authority,
      clock,
    }, {
      projectId: id, sceneId: "scene", timing: { duration: 1 }, expectedContentHash: sourceHash,
    }, "user")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.ProjectInvalid } });
  });

  it("returns identity recovery diagnostics without creating .vidcom", async () => {
    const value = await fixture();
    const projectRoot = path.join(value.workspaceRoot, "broken-identity");
    await mkdir(projectRoot);
    await writeFile(path.join(projectRoot, "vidcom.json"), "{broken\n");
    const entries = await value.application.scanWorkspace();
    const entry = entries.find((item) => item.kind === "project" && item.state === "invalid"
      && item.invalidKind === "identity");
    if (!entry || entry.state !== "invalid" || entry.invalidKind !== "identity") throw new Error("entry missing");
    const result = await diagnosticsWithMissingCheck(value).forEntry(entry.entryId);
    expect(result).toMatchObject({ ok: true, value: { computedAtSourceRevision: null, lintSourceAvailable: false } });
    if (result.ok) expect(result.value.diagnostics[0]?.code).toBe("identity_parse_error");
    await expect(stat(path.join(projectRoot, ".vidcom"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses projectId placeholders except identity-invalid slug seeds and resolves a real hashed snapshot", async () => {
    const value = await fixture();
    const id = "project_thumbnail" as ProjectId;
    const { projectRoot } = await addProject(value, "thumbnail", id, emptyComposition);
    const entries = await value.application.scanWorkspace();
    const entry = entries.find((item) => item.kind === "project" && item.projectId === id)!;
    const resolver = new ThumbnailResolver(value.infrastructure.workspace);
    expect(await resolver.resolve(entry, null, 0)).toMatchObject({ kind: "placeholder", seed: id, seedKind: "projectId" });
    const imagePath = "snapshots/scene-a.png" as RelPath;
    await mkdir(path.join(projectRoot, "snapshots"));
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    await writeFile(path.join(projectRoot, imagePath), bytes);
    expect(await resolver.resolve(entry, {
      complete: true, computedAtSourceRevision: 2, partialAtSourceRevision: null,
      missingSceneIds: [], sceneCount: 1, sceneIds: ["scene-a"],
      snapshotPaths: { "scene-a": imagePath }, contactSheet: null,
    }, 3)).toEqual({ kind: "image", path: imagePath, stale: true, etag: hashContent(bytes) });
    const identityInvalid = {
      kind: "project", projectId: null, entryId: "entry_ephemeral" as never, slug: "broken",
      state: "invalid", invalidKind: "identity", invalidReason: { code: "identity_parse_error" },
    } as const;
    expect(await resolver.resolve(identityInvalid, null, null)).toMatchObject({ seed: "broken", seedKind: "slug", invalid: true });
  });

  it("flags a CDN motion library and clears once the vendored copy is referenced", async () => {
    const value = await fixture();
    const id = "project_motion_cdn" as ProjectId;
    const gsap = findMotionLibrary("gsap")!;
    const cdnEntry = `<!doctype html><html><head>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
</head><body>
<main data-composition-id="root" data-width="320" data-height="180" data-fps="30" data-duration="0"></main>
</body></html>\n`;
    const { projectRoot } = await addProject(value, "motion-cdn", id, cdnEntry);
    const model = {
      project: {
        id, slug: "motion-cdn", title: "Motion CDN", width: 320, height: 180,
        duration: 0, updatedAt: now, sceneCount: 0, revision: 0,
      },
      frameRate: 30,
      scenes: [],
      rootTrack: null,
      diagnostics: [],
      sources: [{ path: "index.html" as RelPath, contentHash: hashContent(cdnEntry), byteSize: cdnEntry.length }],
      references: [],
    } as unknown as CompositionModel;
    const composition = new Proxy(value.infrastructure.composition, {
      get(target, property, receiver) {
        if (property === "parseProject") return async () => model;
        const member = Reflect.get(target, property, receiver) as unknown;
        return typeof member === "function" ? member.bind(target) : member;
      },
    }) as CompositionPort;
    const service = new DiagnosticsService({
      scan: async () => [{
        kind: "project", projectId: id, slug: "motion-cdn",
        state: "authored", platform: null, sceneCount: 0,
      }],
      workspace: value.infrastructure.workspace,
      composition,
      identity: value.application.identity,
      journal: value.infrastructure.journal,
      authority: value.application.authority,
      lint: { async check() { return { available: true, diagnostics: [] }; } },
      fonts: value.application.fonts,
    });

    const before = await service.forProject(id);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const flagged = before.value.diagnostics.find(({ code }) => code === "remote-motion-library");
    expect(flagged).toMatchObject({ severity: "warning", file: "index.html" });
    expect(flagged!.message).toContain(gsap.entry);

    const installed = await installMotionLibrary({
      workspace: value.infrastructure.workspace,
      motionLibraries: new NodeModulesMotionLibraryFiles(),
      authority: value.application.authority,
    }, { projectId: id, libraryId: "gsap" }, "agent");
    expect(installed.ok, JSON.stringify(installed.ok ? null : installed.error)).toBe(true);
    if (!installed.ok) return;
    expect(installed.value.status).toBe("installed");
    // The real package bytes must land on disk: this is what makes the render
    // reproducible and what keeps working with no network.
    const vendored = await readFile(path.join(projectRoot, gsap.entry), "utf8");
    expect(vendored).toContain(gsap.globalName!);
    expect(vendored.length).toBeGreaterThan(1_000);

    await writeFile(
      path.join(projectRoot, "index.html"),
      cdnEntry.replace(/<script src="https:[^"]+"><\/script>/u, installed.value.library.scriptTag),
    );
    const after = await service.forProject(id);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.value.diagnostics.some(({ code }) => code === "remote-motion-library")).toBe(false);
  });

  it("maps every HyperFrames finding group to lint:<rule> through a real child process", async () => {
    const value = await fixture();
    const cli = path.join(value.root, "fake-check.mjs");
    await writeFile(cli, `process.stdout.write(JSON.stringify({
      lint:{findings:[{code:"static",severity:"warning",message:"static",sourceFile:process.cwd()+"/index.html"}]},
      runtime:{findings:[{code:"runtime",severity:"error",message:"runtime"}]},
      layout:{findings:[{code:"layout",severity:"info",message:"layout"}]},
      motion:{findings:[{code:"motion",severity:"warning",message:"motion"}]},
      contrast:{findings:[{code:"contrast",severity:"error",message:"contrast"}]}
    }));\n`);
    const root = value.workspaceRoot as AbsolutePath;
    const lint = new NodeHyperframesDiagnosticsLint(new NodeProcessRunner(5_000), {
      cliPath: cli as AbsolutePath,
      timeoutMs: 5_000,
    });
    const result = await lint.check({
      id: "project_lint" as ProjectId, slug: "lint", root, entry: "index.html" as RelPath,
    });
    expect(result.available).toBe(true);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "lint:static", "lint:runtime", "lint:layout", "lint:motion", "lint:contrast",
    ]);
  });
});
