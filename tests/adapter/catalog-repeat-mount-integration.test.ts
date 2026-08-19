import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  ApprovalService,
  DEFAULT_PREVIEW_SETTINGS,
  WriteAuthority,
  applyMutationInverse,
  executeCatalogInstall,
  prepareCatalogInstall,
  serializePreviewSettings,
  type AbsolutePath,
  type CatalogInstallExecuteDependencies,
  type CatalogInstallIntent,
  type CatalogMaterializedFile,
  type VerifiedCatalogItem,
} from "@vidcom/core";
import {
  AppDataAssetStager,
  AppDataBackupStore,
  CompositionHf,
  LargePreviousContentStore,
  MutationJournal,
  SqliteApprovalGrantStore,
  WorkspaceFs,
  WorkspaceLease,
  catalogManifestDigest,
  createInstalledProvenanceReader,
  initializeDatabase,
} from "@vidcom/adapter";
import { MutationHistory } from "../../packages/server/src/service/mutation-history";

import { createFixedClock, createSequentialIdPort } from "../support/deterministic";
import { dbRun } from "../support/database";
import { removeTree } from "../support/platform";

const now = "2026-08-19T00:00:00.000Z";
const projectId = "project_catalog_repeat" as ProjectId;
const ENTRY_TARGET = "blocks/lower-third/index.html" as RelPath;
const hashContent = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;
const ENTRY_BYTES = "<section data-composition-id=\"lower-third\"><p>lower third</p></section>\n";

const indexSource = `<!doctype html><html><body>
<main data-hf-id="root" data-composition-id="root" data-width="1920" data-height="1080" data-duration="4">
  <div data-hf-id="scene-1-host" data-composition-id="scene-1" data-composition-src="compositions/scene-1.html" data-start="0" data-duration="4" data-track-index="0"></div>
</main></body></html>`;
const sceneSource = `<!doctype html><html><body><section data-hf-id="scene-1" data-composition-id="scene-1" data-width="1920" data-height="1080" data-start="0" data-duration="4"><h1 data-hf-id="title">Scene one</h1></section></body></html>`;

const clock = createFixedClock(now);
const SESSION_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SESSION_B = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

let root: string;
let appData: string;
let cacheRoot: string;
let projectRoot: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;
let workspace: WorkspaceFs;
let composition: CompositionHf;
let journal: MutationJournal;
let authority: WriteAuthority;
let history: MutationHistory;
let approvals: ApprovalService;
let grantSequence: number;

function item(): VerifiedCatalogItem {
  const base = {
    name: "lower-third",
    kind: "block",
    title: "Lower third",
    description: null,
    tags: ["social"],
    category: "Social",
    version: "1.2.0",
    integrity: {
      algo: "sha256" as const,
      files: { [ENTRY_TARGET]: createHash("sha256").update(ENTRY_BYTES).digest("hex") },
      manifest: "",
    },
    materialization: "verified" as const,
    source: { registry: "bundled" as const, url: null, revision: null, committedAt: null },
    dependencies: [],
    compatibility: { aspectRatios: null, minWidth: null, fps: null, minHyperframesVersion: null },
    durationSeconds: 4,
    entry: ENTRY_TARGET,
    preview: null,
  } as VerifiedCatalogItem;
  base.integrity.manifest = catalogManifestDigest(base);
  return base;
}

async function files(): Promise<CatalogMaterializedFile[]> {
  await mkdir(cacheRoot, { recursive: true });
  const target = path.join(cacheRoot, "index.html");
  await writeFile(target, ENTRY_BYTES, "utf8");
  return [{
    path: ENTRY_TARGET,
    contentHash: hashContent(ENTRY_BYTES),
    source: { sourcePath: target as AbsolutePath, contentHash: hashContent(ENTRY_BYTES) },
    encoding: "utf8",
  }];
}

const baseIntent: CatalogInstallIntent = {
  projectId,
  name: "lower-third",
  version: "1.2.0",
  mount: { kind: "new-scene", toIndex: 1 },
  expectedRevision: 0,
};

function originFor(sessionId: string) {
  return {
    kind: "ui" as const,
    sessionId,
    label: "Install lower-third",
    historyAction: "record" as const,
    historyOperation: null,
  };
}

async function dependencies(): Promise<CatalogInstallExecuteDependencies> {
  const materialized = await files();
  return {
    workspace,
    composition,
    journal,
    catalog: {
      materialize: async () => ({
        ok: true as const,
        value: { item: item(), files: materialized, release: async () => {} },
      }),
    },
    installedProvenance: createInstalledProvenanceReader({
      documents: async (target) => {
        const model = await composition.parseProject(target);
        return [target.entry as string, ...(model.scenes as unknown as { src?: string | null }[])
          .flatMap((scene) => (scene.src ? [scene.src] : []))];
      },
      read: async (target, file) => {
        const resolved = await workspace.resolve(target, file as RelPath, "read-source");
        if (!resolved.ok) return null;
        return (await workspace.readFile(resolved.value))?.content ?? null;
      },
    }),
    hashContent,
    manifestDigest: (candidate) => catalogManifestDigest(candidate),
    clock,
    approval: { planReserve: (grantId, binding) => approvals.planReserve(grantId, binding) },
    authority: { mutateSource: (request, actor) => authority.mutateSource(request, actor) },
  };
}

/** One full install for a session, with a real requested-then-issued grant. */
async function install(
  sessionId: string,
  override: Partial<CatalogInstallIntent> = {},
) {
  const deps = await dependencies();
  const intent = { ...baseIntent, ...override };
  const prepared = await prepareCatalogInstall(deps, intent);
  if (!prepared.ok) return { prepared, executed: null } as const;
  if (prepared.value.status !== "ready") return { prepared, executed: null } as const;
  const grantId = await approvals.request(prepared.value.binding, "Install lower-third");
  await approvals.issue(grantId, "ui");
  const executed = await executeCatalogInstall(
    deps,
    { intent, grantId },
    "user",
    { origin: originFor(sessionId), toolAudit: null },
  );
  return { prepared, executed } as const;
}

function inverseDependencies() {
  return {
    workspace,
    composition,
    journal,
    authority,
    clock,
    undoContent: new LargePreviousContentStore(appData),
  } as unknown as Parameters<typeof applyMutationInverse>[0];
}

async function undoTop(sessionId: string) {
  const claimed = history.begin(sessionId, projectId, "undo");
  if (!claimed.ok) return { claimed, undone: null } as const;
  const undone = await applyMutationInverse(
    inverseDependencies(),
    { projectId, receipt: claimed.value.receipt, direction: "undo" },
    "user",
    {
      ...originFor(sessionId),
      historyAction: "undo",
      historyOperation: { id: claimed.value.operationId, targetReceiptId: claimed.value.receipt.id },
    },
  );
  return { claimed, undone } as const;
}

async function absent(target: string): Promise<boolean> {
  try { await access(target); return false; }
  catch { return true; }
}

beforeEach(async () => {
  grantSequence = 0;
  root = await mkdtemp(path.join(tmpdir(), "vidcom-catalog-repeat-"));
  appData = path.join(root, "app-data");
  cacheRoot = path.join(root, "catalog-cache");
  const workspaceRoot = path.join(root, "workspace");
  projectRoot = path.join(workspaceRoot, "project");
  await mkdir(path.join(projectRoot, "compositions"), { recursive: true });
  await writeFile(path.join(projectRoot, "vidcom.json"), JSON.stringify({ id: projectId }));
  await writeFile(path.join(projectRoot, "index.html"), indexSource);
  await writeFile(path.join(projectRoot, "compositions/scene-1.html"), sceneSource);
  const preview = serializePreviewSettings(DEFAULT_PREVIEW_SETTINGS);
  await writeFile(path.join(projectRoot, "preview-settings.json"), preview);

  database = await initializeDatabase(appData);
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, 'project', ?, ?)`,
  projectId, workspaceRoot, now, now);
  dbRun(database, `INSERT INTO entity_state
    (project_id, entity, revision, content_hash, backing_path, last_actor, updated_at)
    VALUES (?, 'preview-settings', 0, ?, 'preview-settings.json', 'system', ?)`,
  projectId, hashContent(preview), now);

  workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
  composition = new CompositionHf();
  journal = new MutationJournal(database, clock, new LargePreviousContentStore(appData));
  const lease = new WorkspaceLease(database, clock, createSequentialIdPort());
  const acquired = await lease.acquire(workspaceRoot as AbsolutePath, "test:catalog-repeat");
  if (!acquired.ok) throw new Error("test lease was denied");
  approvals = new ApprovalService({
    grants: new SqliteApprovalGrantStore(database),
    clock,
    ids: { newId: () => `grant_repeat_${++grantSequence}` },
  });
  history = new MutationHistory(new LargePreviousContentStore(appData));
  history.attach("browser-a", SESSION_A, projectId);
  history.attach("browser-b", SESSION_B, projectId);
  authority = new WriteAuthority({
    workspace,
    journal,
    compositeJournal: journal,
    lease,
    leaseId: acquired.leaseId,
    hashContent,
    invalidate() {},
    notifyEvents() {},
    undoContent: new LargePreviousContentStore(appData),
    stagedAssets: new AppDataAssetStager(appData),
    // Undoing an install deletes what it created, and a delete needs a verified
    // backup, so the same store production uses is wired here.
    backups: new AppDataBackupStore(appData, database, clock, { newId: () => `backup_repeat_${++grantSequence}` }),
    clock,
    observer: history,
  });
});

afterEach(async () => {
  history?.dispose();
  await database?.destroy();
  await removeTree(root);
});

describe("repeat mounts, LIFO undo and a shared package across sessions", () => {
  it("mounts the same package twice as separate instances and asks before reusing", async () => {
    const first = await install(SESSION_A);
    expect(first.executed?.ok).toBe(true);
    if (!first.executed?.ok) return;

    // Second insert of the identical package: the files are already there, so
    // the author is asked rather than silently overwritten.
    const asked = await prepareCatalogInstall(await dependencies(), {
      ...baseIntent,
      mount: { kind: "new-scene", toIndex: 2 },
      expectedRevision: 1,
    });
    expect(asked.ok).toBe(true);
    if (!asked.ok || asked.value.status !== "choice_required") throw new Error("expected a question");
    expect(asked.value.decision.comparison).toBe("identical");
    expect(asked.value.decision.choices).toEqual(["reuse", "skip"]);

    const reused = await install(SESSION_A, {
      mount: { kind: "new-scene", toIndex: 2 },
      expectedRevision: 1,
      existingPolicy: "reuse",
    });
    expect(reused.executed?.ok).toBe(true);
    if (!reused.executed?.ok) return;
    expect(reused.executed.value.packageStatus).toBe("reused");
    // Two distinct scene instances, one shared package file.
    expect(reused.executed.value.sceneId).not.toBe(first.executed.value.sceneId);
    expect(await readFile(path.join(projectRoot, ENTRY_TARGET), "utf8")).toBe(ENTRY_BYTES);
    expect(history.state(SESSION_A, projectId)).toMatchObject({ depth: 2 });
  });

  it("skips without mounting and without a revision", async () => {
    const first = await install(SESSION_A);
    expect(first.executed?.ok).toBe(true);
    const revisionAfterFirst = await journal.latestSourceRevision(projectId);

    const skipped = await prepareCatalogInstall(await dependencies(), {
      ...baseIntent,
      mount: { kind: "new-scene", toIndex: 2 },
      expectedRevision: 1,
      existingPolicy: "skip",
    });
    expect(skipped).toEqual({ ok: true, value: { status: "skipped" } });
    expect(await journal.latestSourceRevision(projectId)).toBe(revisionAfterFirst);
    expect(history.state(SESSION_A, projectId)).toMatchObject({ depth: 1 });
  });

  it("undoes the second mount only, then the first undo removes the package file", async () => {
    const first = await install(SESSION_A);
    expect(first.executed?.ok).toBe(true);
    if (!first.executed?.ok) return;
    const second = await install(SESSION_A, {
      mount: { kind: "new-scene", toIndex: 2 },
      expectedRevision: 1,
      existingPolicy: "reuse",
    });
    expect(second.executed?.ok).toBe(true);
    if (!second.executed?.ok) return;

    // LIFO: the newest mount comes off first and the shared file stays, because
    // the mutation that created it is still in the stack.
    const undoSecond = await undoTop(SESSION_A);
    if (!undoSecond.claimed.ok) console.error("CLAIM2", JSON.stringify(undoSecond.claimed.error));
    if (undoSecond.undone && !undoSecond.undone.ok) console.error("UNDO2", JSON.stringify(undoSecond.undone.error));
    expect(undoSecond.undone?.ok).toBe(true);
    expect(await absent(path.join(projectRoot, "compositions", `${second.executed.value.sceneId}.html`)))
      .toBe(true);
    expect(await readFile(path.join(projectRoot, ENTRY_TARGET), "utf8")).toBe(ENTRY_BYTES);
    expect(await absent(path.join(projectRoot, "compositions", `${first.executed.value.sceneId}.html`)))
      .toBe(false);

    const undoFirst = await undoTop(SESSION_A);
    expect(undoFirst.undone?.ok).toBe(true);
    // Only now is the package file removed, by the mutation that created it.
    expect(await absent(path.join(projectRoot, ENTRY_TARGET))).toBe(true);
    expect(await absent(path.join(projectRoot, "compositions", `${first.executed.value.sceneId}.html`)))
      .toBe(true);
  });

  it("replaces an unmanaged collision and restores the author's bytes on undo", async () => {
    // A file at the package target that the app never installed.
    await mkdir(path.join(projectRoot, "blocks", "lower-third"), { recursive: true });
    await writeFile(path.join(projectRoot, ENTRY_TARGET), "<section>mine</section>\n", "utf8");

    const asked = await prepareCatalogInstall(await dependencies(), baseIntent);
    expect(asked.ok).toBe(true);
    if (!asked.ok || asked.value.status !== "choice_required") throw new Error("expected a question");
    expect(asked.value.decision.comparison).toBe("unmanaged");
    expect(asked.value.decision.choices).toEqual(["replace", "skip"]);
    expect(asked.value.decision.existing.version).toBeNull();

    const replaced = await install(SESSION_A, { existingPolicy: "replace" });
    if (replaced.executed && !replaced.executed.ok) console.error("REPLACE", JSON.stringify(replaced.executed.error));
    if (!replaced.executed) console.error("REPLACE PREPARE", JSON.stringify(replaced.prepared));
    expect(replaced.executed?.ok).toBe(true);
    if (!replaced.executed?.ok) return;
    expect(replaced.executed.value.packageStatus).toBe("replaced");
    expect(await readFile(path.join(projectRoot, ENTRY_TARGET), "utf8")).toBe(ENTRY_BYTES);

    const undone = await undoTop(SESSION_A);
    expect(undone.undone?.ok).toBe(true);
    // The author's original bytes come back, not an empty file and not the package.
    expect(await readFile(path.join(projectRoot, ENTRY_TARGET), "utf8")).toBe("<section>mine</section>\n");
  });

  it("blocks one session's undo while another session's mount depends on the shared file", async () => {
    const owner = await install(SESSION_A);
    expect(owner.executed?.ok).toBe(true);
    if (!owner.executed?.ok) return;
    const consumer = await install(SESSION_B, {
      mount: { kind: "new-scene", toIndex: 2 },
      expectedRevision: 1,
      existingPolicy: "reuse",
    });
    expect(consumer.executed?.ok).toBe(true);
    if (!consumer.executed?.ok) return;

    // Session A owns the file mutation; session B only read-guards it, so A's
    // undo would delete a file B's live mount still points at.
    const blocked = history.begin(SESSION_A, projectId, "undo");
    if (blocked.ok) console.error("NOT BLOCKED", JSON.stringify(blocked.value.receipt.id));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe(ErrorCode.WriteConflict);
    expect(await readFile(path.join(projectRoot, ENTRY_TARGET), "utf8")).toBe(ENTRY_BYTES);

    // B can still undo its own mount. Its receipt owns only the authored
    // documents it wrote; the shared package file is a read guard, so undoing B
    // never deletes A's file and no invalidation is faked for that path.
    const consumerUndo = await undoTop(SESSION_B);
    if (!consumerUndo.claimed.ok) console.error("B CLAIM", JSON.stringify(consumerUndo.claimed.error));
    expect(consumerUndo.claimed.ok).toBe(true);
    if (!consumerUndo.claimed.ok) return;
    expect(consumerUndo.claimed.value.receipt.paths).not.toContain(ENTRY_TARGET);
    expect(consumerUndo.claimed.value.receipt.readGuards.map((guard) => guard.path))
      .toContain(ENTRY_TARGET);
    expect(consumerUndo.undone?.ok).toBe(true);
    expect(await readFile(path.join(projectRoot, ENTRY_TARGET), "utf8")).toBe(ENTRY_BYTES);

    // A's barrier is sticky by design: it was raised when B's dependent receipt
    // arrived and is not recomputed when B undoes. The documented escape is the
    // P3 reload/keep-current flow, not an automatic unblock, so A stays blocked
    // and the shared file stays on disk.
    const stillBlocked = history.begin(SESSION_A, projectId, "undo");
    expect(stillBlocked.ok).toBe(false);
    expect(await readFile(path.join(projectRoot, ENTRY_TARGET), "utf8")).toBe(ENTRY_BYTES);
  });
  it("fails with zero writes when a reused file changes after the plan", async () => {
    const first = await install(SESSION_A);
    expect(first.executed?.ok).toBe(true);

    const deps = await dependencies();
    const prepared = await prepareCatalogInstall(deps, {
      ...baseIntent,
      mount: { kind: "new-scene", toIndex: 2 },
      expectedRevision: 1,
      existingPolicy: "reuse",
    });
    if (!prepared.ok || prepared.value.status !== "ready") throw new Error("expected a ready plan");
    const grantId = await approvals.request(prepared.value.binding, "Install lower-third");
    await approvals.issue(grantId, "ui");

    // The reused file changes between the approved plan and the mutation.
    await writeFile(path.join(projectRoot, ENTRY_TARGET), "<section>edited</section>\n", "utf8");
    const executed = await executeCatalogInstall(
      deps,
      {
        intent: {
          ...baseIntent,
          mount: { kind: "new-scene", toIndex: 2 },
          expectedRevision: 1,
          existingPolicy: "reuse",
        },
        grantId,
      },
      "user",
      { origin: originFor(SESSION_A), toolAudit: null },
    );
    expect(executed.ok).toBe(false);
    // The edited bytes are untouched and no new scene appeared.
    expect(await readFile(path.join(projectRoot, ENTRY_TARGET), "utf8")).toBe("<section>edited</section>\n");
    expect(history.state(SESSION_A, projectId)).toMatchObject({ depth: 1 });
  });
});
