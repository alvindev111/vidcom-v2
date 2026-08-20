import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CreateSceneInputSchema,
  ListProjectsInputSchema,
  type ContentHash,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import {
  ApprovalService,
  createScene,
  DEFAULT_PREVIEW_SETTINGS,
  deleteScene,
  deleteScenes,
  prepareFileDeletion,
  prepareDeleteScenes,
  prepareSceneDeletion,
  ProjectIdentityService,
  reconcileCompositeMutation,
  restoreBackup,
  saveSourceFile,
  setSceneScript,
  setSceneTiming,
  serializePreviewSettings,
  ToolAuditService,
  WriteAuthority,
  type AbsolutePath,
  type PendingToolAudit,
  type ProjectRef,
  type WorkspacePort,
} from "@vidcom/core";
import {
  AppDataBackupStore,
  CompositionHf,
  initializeDatabase,
  LargePreviousContentStore,
  MutationJournal,
  SqliteApprovalGrantStore,
  SqliteToolAuditRepository,
  WorkspaceFs,
  WorkspaceLease,
} from "@vidcom/adapter";
import { ToolRegistry } from "@vidcom/mcp";
import { MutationHistory } from "../../packages/server/src/service/mutation-history";

import { createFixedClock, createSequentialIdPort } from "../support/deterministic";
import { dbAll, dbOne, dbRun } from "../support/database";

const TEST_ORIGIN = { kind: "system", sessionId: null, label: null, historyAction: "ignore", historyOperation: null } as const;
const now = "2026-08-02T00:00:00.000Z";
const projectId = "project_destructive_usecases" as ProjectId;
const hashContent = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

const indexSource = `<!doctype html><html><body>
<main data-hf-id="root" data-composition-id="root" data-width="1920" data-height="1080" data-duration="4">
  <div data-hf-id="scene-1-host" data-composition-id="scene-1" data-composition-src="compositions/scene-1.html" data-start="0" data-duration="4" data-track-index="1"></div>
</main></body></html>`;
const sceneSource = `<!doctype html><html><body><section data-hf-id="scene-1" data-composition-id="scene-1" data-width="1920" data-height="1080" data-start="0" data-duration="4"><h1 data-hf-id="title">Scene one</h1></section></body></html>`;

let root: string;
let appData: string;
let projectRoot: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;
let workspace: WorkspaceFs;
let composition: CompositionHf;
let journal: MutationJournal;
let backups: AppDataBackupStore;
let authority: WriteAuthority;
let lease: WorkspaceLease;
let leaseId: string;
let ref: ProjectRef;
const clock = createFixedClock(now);

function audit(tool: string, level: "write" | "destructive"): PendingToolAudit {
  return {
    schemaVersion: 1,
    invocationId: `invocation-${tool}`,
    tool,
    level,
    projectId,
    era: "modern",
    protocolVersion: "2026-07-28",
    detail: { sceneId: "scene-1" },
    credentialId: "credential-test",
    invokedAt: now,
    revisionBefore: 0,
  };
}

async function missing(target: string): Promise<boolean> {
  try { await access(target); return false; }
  catch { return true; }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-project-destructive-"));
  appData = path.join(root, "app-data");
  const workspaceRoot = path.join(root, "workspace");
  projectRoot = path.join(workspaceRoot, "project");
  await mkdir(path.join(projectRoot, "compositions"), { recursive: true });
  await mkdir(path.join(projectRoot, "narration"), { recursive: true });
  await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
  await writeFile(path.join(projectRoot, "vidcom.json"), JSON.stringify({ id: projectId }));
  await writeFile(path.join(projectRoot, "index.html"), indexSource);
  await writeFile(path.join(projectRoot, "compositions/scene-1.html"), sceneSource);
  const preview = serializePreviewSettings({
    ...DEFAULT_PREVIEW_SETTINGS,
    scenes: { "scene-1": { transitionSound: "minimal", revealSound: "ping", hidden: false } },
  });
  await writeFile(path.join(projectRoot, "preview-settings.json"), preview);
  await writeFile(path.join(projectRoot, "narration/scene-1.json"), `${JSON.stringify({
    sceneId: "scene-1", text: "Scene one", voice: "af_heart", status: "generated",
    audioPath: "narration/scene-1.wav", command: "tts", revision: 1, updatedAt: now, staleSince: null,
  }, null, 2)}\n`);
  await writeFile(path.join(projectRoot, "narration/scene-1.wav"), new Uint8Array([82, 73, 70, 70]));
  await writeFile(path.join(projectRoot, "notes.txt"), "notes old");

  database = await initializeDatabase(appData);
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, 'project', ?, ?)`,
  projectId, workspaceRoot, now, now);
  dbRun(database, `INSERT INTO entity_state
    (project_id, entity, revision, content_hash, backing_path, last_actor, updated_at)
    VALUES (?, 'preview-settings', 0, ?, 'preview-settings.json', 'system', ?)`,
  projectId, hashContent(preview), now);
  ref = { id: projectId, slug: "project", root: projectRoot as AbsolutePath, entry: "index.html" as RelPath };
  workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
  composition = new CompositionHf();
  journal = new MutationJournal(database, clock);
  backups = new AppDataBackupStore(appData, database, clock, { newId: () => "backup_scene_delete" });
  lease = new WorkspaceLease(database, clock, createSequentialIdPort());
  const acquired = await lease.acquire(workspaceRoot as AbsolutePath, "test:project-destructive");
  if (!acquired.ok) throw new Error("test lease was denied");
  leaseId = acquired.leaseId;
  authority = new WriteAuthority({
    workspace,
    journal,
    compositeJournal: journal,
    lease,
    leaseId,
    hashContent,
    validateFileContent(path, content) {
      return typeof content === "string"
        ? composition.validateSource?.(path, content) ?? Promise.resolve({ ok: true as const, value: undefined })
        : Promise.resolve({ ok: true as const, value: undefined });
    },
    invalidate() {},
    notifyEvents() {},
    backups,
  });
});

// Injection targets are written with forward slashes, but a resolved path uses
// the platform separator, so the suffix has to be matched separator-agnostically
// or the failure silently never fires on Windows.
function targetMatches(target: string, suffix: string | undefined): boolean {
  return suffix !== undefined && target.split(path.sep).join("/").endsWith(suffix);
}

function authorityWithFailure(options: { writePath?: string; deletePath?: string }): WriteAuthority {
  const proxy: WorkspacePort = {
    resolve: workspace.resolve.bind(workspace),
    resolveMutation: workspace.resolveMutation.bind(workspace),
    revalidateMutationPath: workspace.revalidateMutationPath.bind(workspace),
    refreshMutationPath: workspace.refreshMutationPath.bind(workspace),
    resolveWorkspace: workspace.resolveWorkspace.bind(workspace),
    listProjects: workspace.listProjects.bind(workspace),
    readProjectRef: workspace.readProjectRef.bind(workspace),
    readFile: workspace.readFile.bind(workspace),
    readBytes: workspace.readBytes.bind(workspace),
    readHash: workspace.readHash.bind(workspace),
    async writeAtomic(target, content) {
      if (targetMatches(target, options.writePath)) throw new Error("injected write failure");
      await workspace.writeAtomic(target, content);
    },
    exists: workspace.exists.bind(workspace),
    async deleteAtomic(target) {
      if (targetMatches(target, options.deletePath)) throw new Error("injected delete failure");
      await workspace.deleteAtomic(target);
    },
    captureForMutation: workspace.captureForMutation.bind(workspace),
    async publishCaptured(capture, content) {
      if (content === null && targetMatches(capture.target, options.deletePath)) {
        throw new Error("injected delete failure");
      }
      if (content !== null && targetMatches(capture.target, options.writePath)) {
        throw new Error("injected write failure");
      }
      return workspace.publishCaptured(capture, content);
    },
    restoreCaptured: workspace.restoreCaptured.bind(workspace),
    discardCapture: workspace.discardCapture.bind(workspace),
    readTree: workspace.readTree.bind(workspace),
    stat: workspace.stat.bind(workspace),
    readDirectory: workspace.readDirectory.bind(workspace),
  };
  return new WriteAuthority({
    workspace: proxy,
    journal,
    compositeJournal: journal,
    lease,
    leaseId,
    hashContent,
    invalidate() {},
    notifyEvents() {},
    backups,
  });
}

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

describe("Phase J use cases with real SQLite and filesystem", () => {
  it("denies deletion of a canonical asset referenced relatively by a nested scene", async () => {
    await mkdir(path.join(projectRoot, "assets"));
    await writeFile(path.join(projectRoot, "assets/logo.svg"), "<svg></svg>");
    await writeFile(path.join(projectRoot, "compositions/scene-1.html"), `
      <section data-composition-id="scene-1">
        <img src="../assets/logo.svg" />
      </section>
    `);
    const resolved = await workspace.resolve(ref, "assets/logo.svg" as RelPath, "write-source");
    if (!resolved.ok) throw new Error("asset path did not resolve");
    const expectedContentHash = await workspace.readHash(resolved.value);
    if (!expectedContentHash) throw new Error("asset hash was missing");
    await expect(prepareFileDeletion({ workspace, composition, journal, hashContent }, {
      projectId,
      path: "assets/logo.svg" as RelPath,
      expectedContentHash,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "referenced_by_composition" },
    });
  });

  it("commits create_scene atomically and forwards composite plus one-step tool audits", async () => {
    const created = await createScene({ workspace, composition, journal, authority, clock }, {
      projectId,
      title: "Scene two",
      expectedContentHash: hashContent(indexSource),
    }, "agent", { origin: TEST_ORIGIN, toolAudit: audit("create_scene", "write") });
    expect(created).toMatchObject({ ok: true, value: { scene: { id: "scene-2" }, envelope: { projectRevision: 1 } } });
    expect(await missing(path.join(projectRoot, "compositions/scene-2.html"))).toBe(false);
    expect(await missing(path.join(projectRoot, "narration/scene-2.json"))).toBe(false);
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision WHERE id = 1")).toEqual({ count: 1 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision_step WHERE revision_id = 1")).toEqual({ count: 3 });
    expect(dbOne(database, `SELECT revision_id AS revisionId FROM audit_entry
      WHERE action = 'tool:create_scene'`)).toEqual({ revisionId: 1 });

    const saved = await saveSourceFile({ workspace, composition, journal, authority, clock }, {
      projectId,
      path: "notes.txt" as RelPath,
      content: "notes new",
      expectedContentHash: hashContent("notes old"),
    }, "agent", { origin: TEST_ORIGIN, toolAudit: audit("save_file", "write") });
    expect(saved).toMatchObject({ ok: true, value: { envelope: { projectRevision: 2 } } });
    expect(dbOne(database, `SELECT revision_id AS revisionId FROM audit_entry
      WHERE action = 'tool:save_file'`)).toEqual({ revisionId: 2 });
    expect(dbOne(database, "SELECT kind FROM revision WHERE id = 2")).toEqual({ kind: "file" });
  });

  it("ripples only the affected track and commits every moved scene in one revision", async () => {
    const multiTrack = `<!doctype html><html><body>
<main data-hf-id="root" data-composition-id="root" data-width="1920" data-height="1080" data-duration="8">
  <div data-hf-id="scene-1-host" data-composition-id="scene-1" data-composition-src="compositions/scene-1.html" data-start="0" data-duration="4" data-track-index="1"></div>
  <div data-hf-id="scene-2-host" data-composition-id="scene-2" data-composition-src="compositions/scene-2.html" data-start="4" data-duration="4" data-track-index="1"></div>
  <div data-hf-id="scene-3-host" data-composition-id="scene-3" data-composition-src="compositions/scene-3.html" data-start="1" data-duration="2" data-track-index="2"></div>
</main></body></html>`;
    await writeFile(path.join(projectRoot, "index.html"), multiTrack);
    await writeFile(path.join(projectRoot, "compositions/scene-2.html"), sceneSource.replaceAll("scene-1", "scene-2"));
    await writeFile(path.join(projectRoot, "compositions/scene-3.html"), sceneSource.replaceAll("scene-1", "scene-3"));

    const result = await setSceneTiming({ workspace, composition, journal, authority, clock }, {
      projectId,
      sceneId: "scene-1",
      timing: { duration: 6 },
      ripple: true,
      extendRoot: true,
      expectedContentHash: hashContent(multiTrack),
    }, "user");

    expect(result).toMatchObject({
      ok: true,
      value: { envelope: { projectRevision: 1 }, moved: [{ sceneId: "scene-2", fromStart: 4, toStart: 6 }] },
    });
    const model = await composition.parseProject(ref);
    expect(model.scenes.map(({ id, start, trackIndex }) => ({ id, start, trackIndex }))
      .sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: "scene-1", start: 0, trackIndex: 1 },
      { id: "scene-2", start: 6, trackIndex: 1 },
      { id: "scene-3", start: 1, trackIndex: 2 },
    ]);
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 1 });
  });

  it.each([
    ["horizontal-youtube", 1920, 1080, "horizontal", "16:9", ["youtube"], null],
    ["vertical-shorts", 1080, 1920, "vertical", "9:16", ["tiktok", "instagram-reels", "youtube-shorts"], 180],
  ] as const)("authors and mounts an empty %s project with platform dimensions", async (
    presetId,
    width,
    height,
    orientation,
    aspectRatio,
    targets,
    recommendedMaxDurationSeconds,
  ) => {
    await Promise.all([
      rm(path.join(projectRoot, "index.html"), { force: true }),
      rm(path.join(projectRoot, "compositions/scene-1.html"), { force: true }),
      rm(path.join(projectRoot, "narration/scene-1.json"), { force: true }),
      rm(path.join(projectRoot, "narration/scene-1.wav"), { force: true }),
    ]);
    await writeFile(path.join(projectRoot, "vidcom.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: projectId,
      platform: {
        presetId, orientation, aspectRatio, width, height, fps: 30, targets, recommendedMaxDurationSeconds,
      },
      render: { defaultPresetId: presetId, outputDirectory: "renders" },
      narration: { defaultProviderId: null, defaultVoiceId: null },
      createdAt: now,
      updatedAt: now,
    }, null, 2)}\n`);
    const identity = new ProjectIdentityService({ workspace, authority, composition, clock });

    const result = await createScene({ workspace, composition, journal, authority, clock, identity }, {
      projectId,
      title: "First scene",
      index: 0,
      expectedContentHash: null,
    }, "user");

    expect(result).toMatchObject({ ok: true, value: { envelope: { projectRevision: 1 }, scene: { id: "scene-1" } } });
    const entry = await readFile(path.join(projectRoot, "index.html"), "utf8");
    const scene = await readFile(path.join(projectRoot, "compositions/scene-1.html"), "utf8");
    const parsed = await composition.parseProject(ref);
    expect(parsed.project).toMatchObject({ width, height, duration: 4, sceneCount: 1 });
    expect(parsed.scenes).toMatchObject([{
      id: "scene-1", src: "compositions/scene-1.html", start: 0, duration: 4, trackIndex: 0,
    }]);

    const { document: entryDocument } = parseHTML(entry);
    const host = entryDocument.querySelector('[data-composition-src="compositions/scene-1.html"]');
    expect(host?.getAttribute("data-width")).toBe(String(width));
    expect(host?.getAttribute("data-height")).toBe(String(height));
    expect(entryDocument.querySelector("main")?.getAttribute("data-fps")).toBe("30");

    const { document: sceneDocument } = parseHTML(scene);
    const template = sceneDocument.querySelector("template") as HTMLTemplateElement | null;
    expect(template).not.toBeNull();
    const mounted = entryDocument.createElement("div");
    mounted.append(template!.content.cloneNode(true));
    expect(mounted.querySelector("style")?.textContent).toContain(`width:${width}px;height:${height}px`);
    expect(mounted.querySelector('[data-composition-id="scene-1"]')).toMatchObject({
      dataset: expect.objectContaining({ width: String(width), height: String(height) }),
    });
    expect(mounted.querySelector("h2")?.textContent).toBe("First scene");
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 1 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision_step WHERE revision_id = 1")).toEqual({ count: 3 });
  });

  it("marks only the narration cue bound to the edited script element stale", async () => {
    const twoLines = sceneSource.replace("</section>", '<p data-hf-id="subtitle">Second line</p></section>');
    await writeFile(path.join(projectRoot, "compositions/scene-1.html"), twoLines);
    await writeFile(path.join(projectRoot, "narration/scene-1.json"), `${JSON.stringify({
      schemaVersion: 2,
      sceneId: "scene-1",
      revision: 4,
      updatedAt: now,
      cues: [
        { cueId: "title", text: "Scene one", voice: "af_heart", offsetSeconds: 0, durationSeconds: 1, staleSince: null, status: "mock", audioPath: "narration/scene-1/title.wav" },
        { cueId: "subtitle", text: "Second line", voice: "af_heart", offsetSeconds: 1.5, durationSeconds: 1, staleSince: null, status: "mock", audioPath: "narration/scene-1/subtitle.wav" },
      ],
    }, null, 2)}\n`);

    const result = await setSceneScript({ workspace, composition, journal, authority, clock }, {
      projectId,
      sceneId: "scene-1",
      file: "compositions/scene-1.html" as RelPath,
      elementId: "title",
      text: "Updated title",
      expectedContentHash: hashContent(twoLines),
    }, "user");

    expect(result).toMatchObject({ ok: true, value: { narrationStale: true, envelope: { projectRevision: 1 } } });
    const sidecar = JSON.parse(await readFile(path.join(projectRoot, "narration/scene-1.json"), "utf8"));
    expect(sidecar.cues.map((cue: { cueId: string; staleSince: string | null }) => [cue.cueId, cue.staleSince])).toEqual([
      ["title", now],
      ["subtitle", null],
    ]);
  });

  it("rejects zero, negative and overflowing create_scene timing before filesystem or SQLite mutation", async () => {
    for (const duration of [0, -1]) {
      await expect(createScene({ workspace, composition, journal, authority, clock }, {
        projectId,
        title: "Invalid timing",
        duration,
        expectedContentHash: hashContent(indexSource),
      }, "agent")).resolves.toMatchObject({ ok: false, error: { code: "timing_invalid" } });
    }
    const huge = Number.MAX_VALUE / 2;
    const overflowSource = `
      <main data-composition-id="root" data-duration="${Number.MAX_VALUE}">
        <div data-composition-id="scene-1" data-start="${huge}" data-duration="${huge}" data-track-index="1"></div>
      </main>
    `;
    await writeFile(path.join(projectRoot, "index.html"), overflowSource);
    await expect(createScene({ workspace, composition, journal, authority, clock }, {
      projectId,
      title: "Overflow timing",
      duration: Number.MAX_VALUE,
      expectedContentHash: hashContent(overflowSource),
    }, "agent")).resolves.toMatchObject({ ok: false, error: { code: "duration_overflow" } });

    expect(await missing(path.join(projectRoot, "compositions/scene-2.html"))).toBe(true);
    expect(await missing(path.join(projectRoot, "narration/scene-2.json"))).toBe(true);
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM mutation_journal")).toEqual({ count: 0 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });
  });

  it("reports committed_response_error without disguising a committed malformed write response", async () => {
    const toolAudit = new ToolAuditService(
      new SqliteToolAuditRepository(database),
      clock,
      { warn() {}, error() {} },
      { increment() {}, observeMilliseconds() {} },
      journal,
    );
    const registry = new ToolRegistry({
      audit: toolAudit,
      approvals: { request: async () => "unused" },
    }, {
      newInvocationId: () => "invocation-malformed-create",
      now: () => new Date(now),
    });
    registry.register({
      name: "malformed_create_scene",
      title: "Malformed create scene",
      level: "write",
      description: "Test-only committed response finalization seam.",
      input: CreateSceneInputSchema,
      output: ListProjectsInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      availableInLegacy: true,
      projectIdOf: (input) => input.projectId as ProjectId,
      handler: async (context, input) => {
        const created = await createScene({ workspace, composition, journal, authority, clock }, {
          projectId: input.projectId as ProjectId,
          title: input.title,
          expectedContentHash: input.expectedContentHash as ContentHash,
        }, "agent", context.writeInvocation);
        return created.ok
          ? { ok: true as const, value: created.value as unknown as { limit: number; cursor?: string } }
          : created;
      },
    });

    await expect(registry.invoke("malformed_create_scene", {
      projectId,
      title: "Committed malformed response",
      expectedContentHash: hashContent(indexSource),
    }, {
      era: "modern",
      protocolVersion: "2026-07-28",
      credentialId: "credential-test",
      requestInput: async (): Promise<never> => { throw new Error("unused"); },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "committed_response_error",
        details: { committed: true, projectRevision: 1, invocationId: "invocation-malformed-create" },
      },
    });
    expect(await missing(path.join(projectRoot, "compositions/scene-2.html"))).toBe(false);
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = 1")).toEqual({ status: "committed" });
    expect(dbOne(database, `SELECT outcome, revision_id AS revisionId FROM audit_entry
      WHERE action = 'tool:malformed_create_scene'`)).toEqual({ outcome: "ok", revisionId: 1 });
  });

  it("rolls create_scene back after a mid-step filesystem failure without revision or audit", async () => {
    const failing = authorityWithFailure({ writePath: "index.html" });
    const created = await createScene({ workspace, composition, journal, authority: failing, clock }, {
      projectId,
      title: "Must roll back",
      expectedContentHash: hashContent(indexSource),
    }, "agent", { origin: TEST_ORIGIN, toolAudit: audit("create_scene", "write") });
    expect(created).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    expect(await missing(path.join(projectRoot, "compositions/scene-2.html"))).toBe(true);
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe(indexSource);
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = 1")).toEqual({ status: "aborted" });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry")).toEqual({ count: 0 });
  });

  it("keeps create_scene recovery-gated at T2 failure then reconciles exactly one tool audit", async () => {
    dbRun(database, `CREATE TRIGGER fail_create_t2 BEFORE INSERT ON revision
      BEGIN SELECT RAISE(ABORT, 'injected T2 failure'); END`);
    const created = await createScene({ workspace, composition, journal, authority, clock }, {
      projectId,
      title: "Landed before T2",
      expectedContentHash: hashContent(indexSource),
    }, "agent", { origin: TEST_ORIGIN, toolAudit: audit("create_scene", "write") });
    expect(created).toMatchObject({ ok: false, error: { code: "recovery_required" } });
    expect(await missing(path.join(projectRoot, "compositions/scene-2.html"))).toBe(false);
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = 1")).toEqual({ status: "pending" });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry")).toEqual({ count: 0 });

    dbRun(database, "DROP TRIGGER fail_create_t2");
    await expect(reconcileCompositeMutation({
      workspace,
      journal,
      async resolveProjectRef() { return ref; },
    }, 1 as never)).resolves.toMatchObject({ ok: true, value: { terminal: "committed" } });
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = 1")).toEqual({ status: "committed" });
    expect(dbOne(database, `SELECT COUNT(*) AS count FROM audit_entry
      WHERE action = 'tool:create_scene'`)).toEqual({ count: 1 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 1 });
  });

  it("rolls delete_scene back after a mid-delete failure and releases the grant without audit", async () => {
    const prepared = await prepareSceneDeletion({ workspace, composition, journal, hashContent }, {
      projectId,
      sceneId: "scene-1",
      expectedRevision: 0,
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const approvals = new ApprovalService({
      grants: new SqliteApprovalGrantStore(database),
      clock,
      ids: { newId: () => "grant_scene_failure" },
    });
    await approvals.request(prepared.value.binding, "Delete scene-1");
    await approvals.issue("grant_scene_failure", "cli");
    const failing = authorityWithFailure({ deletePath: "narration/scene-1.wav" });
    const deleted = await deleteScene({
      workspace,
      composition,
      journal,
      authority: failing,
      clock,
      hashContent,
    }, {
      projectId,
      sceneId: "scene-1",
      expectedRevision: 0,
      grantId: "grant_scene_failure",
    }, "agent", { origin: TEST_ORIGIN, toolAudit: audit("delete_scene", "destructive") });

    expect(deleted).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe(indexSource);
    expect(await readFile(path.join(projectRoot, "compositions/scene-1.html"), "utf8")).toBe(sceneSource);
    expect(await missing(path.join(projectRoot, "narration/scene-1.json"))).toBe(false);
    expect(await missing(path.join(projectRoot, "narration/scene-1.wav"))).toBe(false);
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = 1")).toEqual({ status: "aborted" });
    expect(dbOne(database, "SELECT status FROM approval_grant WHERE id = 'grant_scene_failure'"))
      .toEqual({ status: "issued" });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry")).toEqual({ count: 0 });
  });

  it("deletes all scene targets with one revision/backup and rejects restore after a later edit", async () => {
    const prepared = await prepareSceneDeletion({ workspace, composition, journal, hashContent }, {
      projectId,
      sceneId: "scene-1",
      expectedRevision: 0,
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const approvals = new ApprovalService({
      grants: new SqliteApprovalGrantStore(database),
      clock,
      ids: { newId: () => "grant_scene_delete" },
    });
    await approvals.request(prepared.value.binding, "Delete scene-1");
    await expect(approvals.issue("grant_scene_delete", "cli")).resolves.toMatchObject({ ok: true });

    const deleted = await deleteScene({ workspace, composition, journal, authority, clock, hashContent }, {
      projectId,
      sceneId: "scene-1",
      expectedRevision: 0,
      grantId: "grant_scene_delete",
    }, "agent", { origin: TEST_ORIGIN, toolAudit: audit("delete_scene", "destructive") });
    expect(deleted).toMatchObject({
      ok: true,
      value: {
        project: { duration: 0, sceneCount: 0, revision: 1 },
        envelope: { projectRevision: 1, diagnostics: [{ code: "composition_empty" }] },
        deletedFile: "compositions/scene-1.html",
        backupId: "backup_scene_delete",
      },
    });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).not.toContain("scene-1-host");
    expect(await missing(path.join(projectRoot, "compositions/scene-1.html"))).toBe(true);
    expect(await missing(path.join(projectRoot, "narration/scene-1.json"))).toBe(true);
    expect(await missing(path.join(projectRoot, "narration/scene-1.wav"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(projectRoot, "preview-settings.json"), "utf8")).scenes)
      .not.toHaveProperty("scene-1");
    expect(await backups.verify("backup_scene_delete")).toBe(true);
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision WHERE id = 1")).toEqual({ count: 1 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision_step WHERE revision_id = 1")).toEqual({ count: 5 });
    expect(dbOne(database, "SELECT status FROM approval_grant WHERE id = 'grant_scene_delete'"))
      .toEqual({ status: "consumed" });
    expect(dbOne(database, `SELECT revision_id AS revisionId FROM audit_entry
      WHERE action = 'tool:delete_scene'`)).toEqual({ revisionId: 1 });

    const afterDelete = await readFile(path.join(projectRoot, "index.html"), "utf8");
    const later = await authority.mutateSource({
      ref,
      steps: [{
        kind: "write",
        path: "index.html" as RelPath,
        content: `${afterDelete}\n<!-- later edit -->`,
        expectedContentHash: hashContent(afterDelete),
      }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "user");
    expect(later).toMatchObject({ ok: true, value: { projectRevision: 2 } });
    await expect(restoreBackup({ backups, journal, workspace, writes: authority }, {
      projectId,
      backupId: "backup_scene_delete",
    }, "cli-external")).resolves.toMatchObject({ ok: false, error: { code: "write_conflict" } });
    expect(dbAll(database, "PRAGMA foreign_key_check")).toEqual([]);
  });

  it("deletes multiple scenes through one revision, backup and undo item", async () => {
    const undoContent = new LargePreviousContentStore(appData);
    const history = new MutationHistory(undoContent);
    history.attach("browser-group", "studio-group", projectId);
    const twoScenes = `<!doctype html><html><body>
<main data-hf-id="root" data-composition-id="root" data-width="1920" data-height="1080" data-duration="8">
  <div data-hf-id="scene-1-host" data-composition-id="scene-1" data-composition-src="compositions/scene-1.html" data-start="0" data-duration="4" data-track-index="1"></div>
  <div data-hf-id="scene-2-host" data-composition-id="scene-2" data-composition-src="compositions/scene-2.html" data-start="4" data-duration="4" data-track-index="1"></div>
</main></body></html>`;
    await writeFile(path.join(projectRoot, "index.html"), twoScenes);
    await writeFile(path.join(projectRoot, "compositions/scene-2.html"), sceneSource.replaceAll("scene-1", "scene-2"));
    await writeFile(path.join(projectRoot, "narration/scene-2.json"), `${JSON.stringify({
      sceneId: "scene-2", text: "Scene two", voice: "af_heart", status: "generated",
      audioPath: "narration/scene-2.wav", command: "tts", revision: 1, updatedAt: now, staleSince: null,
    }, null, 2)}\n`);
    await writeFile(path.join(projectRoot, "narration/scene-2.wav"), new Uint8Array([82, 73, 70, 70, 2]));
    const settings = serializePreviewSettings({
      ...DEFAULT_PREVIEW_SETTINGS,
      scenes: {
        "scene-1": { transitionSound: "minimal", revealSound: "ping", hidden: false },
        "scene-2": { transitionSound: "gong", revealSound: "pop", hidden: false },
      },
    });
    await writeFile(path.join(projectRoot, "preview-settings.json"), settings);
    dbRun(database, `UPDATE entity_state SET content_hash = ?
      WHERE project_id = ? AND entity = 'preview-settings'`, hashContent(settings), projectId);

    const prepared = await prepareDeleteScenes({ workspace, composition, journal, hashContent }, {
      projectId,
      sceneIds: ["scene-2", "scene-1"],
      expectedRevision: 0,
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const approvals = new ApprovalService({
      grants: new SqliteApprovalGrantStore(database),
      clock,
      ids: { newId: () => "grant_scenes_delete" },
    });
    await approvals.request(prepared.value.binding, "Delete scene group");
    await expect(approvals.issue("grant_scenes_delete", "cli")).resolves.toMatchObject({ ok: true });

    const observedAuthority = new WriteAuthority({
      workspace,
      journal,
      compositeJournal: journal,
      lease,
      leaseId,
      hashContent,
      invalidate() {},
      notifyEvents() {},
      backups,
      clock,
      observer: history,
      undoContent,
    });
    const deleted = await deleteScenes({
      workspace,
      composition,
      journal,
      authority: observedAuthority,
      clock,
      hashContent,
    }, {
      projectId,
      sceneIds: ["scene-2", "scene-1"],
      expectedRevision: 0,
      grantId: "grant_scenes_delete",
    }, "user", {
      origin: { kind: "ui", sessionId: "studio-group", label: "Delete 2 scenes", historyAction: "record", historyOperation: null },
      toolAudit: null,
    });

    expect(deleted).toMatchObject({
      ok: true,
      value: { project: { duration: 0, sceneCount: 0, revision: 1 }, backupId: "backup_scene_delete" },
    });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 1 });
    expect(history.state("studio-group", projectId)).toMatchObject({
      depth: 1,
      canUndo: true,
      nextUndoLabel: "Delete 2 scenes",
    });
    expect(history.begin("studio-group", projectId, "undo")).toMatchObject({
      ok: true,
      value: {
        receipt: {
          id: "journal:1",
          projectRevision: 1,
          origin: { sessionId: "studio-group", label: "Delete 2 scenes" },
        },
      },
    });
    expect(await missing(path.join(projectRoot, "compositions/scene-1.html"))).toBe(true);
    expect(await missing(path.join(projectRoot, "compositions/scene-2.html"))).toBe(true);
    expect(await backups.verify("backup_scene_delete")).toBe(true);
  });
});
