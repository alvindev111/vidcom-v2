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
import { dbOne, dbRun } from "../support/database";
import { removeTree } from "../support/platform";

const now = "2026-08-19T00:00:00.000Z";
const projectId = "project_catalog_approval" as ProjectId;
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
/** Live pin counter: `materialize` increments, `release` decrements. */
let pins: number;
let leaseHandle: WorkspaceLease;
let leaseId: string;

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

const intent: CatalogInstallIntent = {
  projectId,
  name: "lower-third",
  version: "1.2.0",
  mount: { kind: "new-scene", toIndex: 1 },
  expectedRevision: 0,
};

const origin = {
  kind: "ui" as const,
  sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  label: "Install lower-third",
  historyAction: "record" as const,
  historyOperation: null,
};

async function dependencies(): Promise<CatalogInstallExecuteDependencies> {
  const materialized = await files();
  return {
    workspace,
    composition,
    journal,
    catalog: {
      materialize: async () => {
        pins += 1;
        return {
          ok: true as const,
          value: {
            item: item(),
            files: materialized,
            release: async () => { pins -= 1; },
          },
        };
      },
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

async function issuedGrant(deps: CatalogInstallExecuteDependencies): Promise<string> {
  const prepared = await prepareCatalogInstall(deps, intent);
  if (!prepared.ok || prepared.value.status !== "ready") throw new Error("expected a ready preparation");
  const grantId = await approvals.request(prepared.value.binding, "Install lower-third");
  await approvals.issue(grantId, "ui");
  return grantId;
}

async function absent(target: string): Promise<boolean> {
  try { await access(target); return false; }
  catch { return true; }
}

beforeEach(async () => {
  pins = 0;
  grantSequence = 0;
  root = await mkdtemp(path.join(tmpdir(), "vidcom-catalog-approval-"));
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
  leaseHandle = new WorkspaceLease(database, clock, createSequentialIdPort());
  const acquired = await leaseHandle.acquire(workspaceRoot as AbsolutePath, "test:catalog-approval");
  if (!acquired.ok) throw new Error("test lease was denied");
  leaseId = acquired.leaseId;
  approvals = new ApprovalService({
    grants: new SqliteApprovalGrantStore(database),
    clock,
    ids: { newId: () => `grant_approval_${++grantSequence}` },
  });
  history = new MutationHistory(new LargePreviousContentStore(appData));
  history.attach("browser-approval", origin.sessionId, projectId);
  authority = new WriteAuthority({
    workspace,
    journal,
    compositeJournal: journal,
    lease: leaseHandle,
    leaseId,
    hashContent,
    invalidate() {},
    notifyEvents() {},
    undoContent: new LargePreviousContentStore(appData),
    stagedAssets: new AppDataAssetStager(appData),
    clock,
    observer: history,
  });
});

afterEach(async () => {
  history?.dispose();
  await database?.destroy();
  await removeTree(root);
});

describe("catalog approval lifecycle and pin cleanup", () => {
  it("leaves no pin and no write when the author abandons the dialog", async () => {
    const deps = await dependencies();
    const prepared = await prepareCatalogInstall(deps, intent);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || prepared.value.status !== "ready") throw new Error("expected a ready plan");
    // The grant is requested but never issued: the dialog was closed.
    const grantId = await approvals.request(prepared.value.binding, "Install lower-third");
    expect(pins).toBe(0);
    expect(await absent(path.join(projectRoot, ENTRY_TARGET))).toBe(true);
    expect(dbOne<{ status: string }>(database,
      "SELECT status FROM approval_grant WHERE id = ?", grantId)?.status).toBe("requested");
    expect(await journal.latestSourceRevision(projectId)).toBeNull();
  });

  it("refuses a requested-but-unissued grant and a revoked grant without writing", async () => {
    const deps = await dependencies();
    const prepared = await prepareCatalogInstall(deps, intent);
    if (!prepared.ok || prepared.value.status !== "ready") throw new Error("expected a ready plan");
    const requested = await approvals.request(prepared.value.binding, "Install lower-third");
    const unissued = await executeCatalogInstall(
      deps,
      { intent, grantId: requested },
      "user",
      { origin, toolAudit: null },
    );
    expect(unissued.ok).toBe(false);
    if (!unissued.ok) expect(unissued.error.code).toBe(ErrorCode.ApprovalInvalid);

    await approvals.issue(requested, "ui");
    expect((await approvals.revoke(requested)).ok).toBe(true);
    const revoked = await executeCatalogInstall(
      deps,
      { intent, grantId: requested },
      "user",
      { origin, toolAudit: null },
    );
    expect(revoked.ok).toBe(false);
    // Neither attempt wrote anything, and both released their pin.
    expect(await absent(path.join(projectRoot, ENTRY_TARGET))).toBe(true);
    expect(await journal.latestSourceRevision(projectId)).toBeNull();
    expect(pins).toBe(0);
  });

  it("refuses an expired grant at the reserve boundary", async () => {
    // A clock that only moves for the approval service: the grant is issued at
    // its own time and reserved a minute later, which is how expiry happens.
    let issuedAt = Date.parse(now);
    const shortLived = new ApprovalService({
      grants: new SqliteApprovalGrantStore(database),
      clock: { now: () => new Date(issuedAt) },
      ids: { newId: () => "grant_expired" },
      config: { requestTtlMs: 1_000, grantTtlMs: 1_000 },
    });
    const deps = await dependencies();
    const prepared = await prepareCatalogInstall(deps, intent);
    if (!prepared.ok || prepared.value.status !== "ready") throw new Error("expected a ready plan");
    const grantId = await shortLived.request(prepared.value.binding, "Install lower-third");
    await shortLived.issue(grantId, "ui");
    issuedAt += 60_000;
    const expired = await executeCatalogInstall(
      { ...deps, approval: { planReserve: (id, binding) => shortLived.planReserve(id, binding) } },
      { intent, grantId },
      "user",
      { origin, toolAudit: null },
    );
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error.code).toBe(ErrorCode.ApprovalExpired);
    expect(await absent(path.join(projectRoot, ENTRY_TARGET))).toBe(true);
    expect(pins).toBe(0);
  });

  it("survives a daemon restart between prepare and execute", async () => {
    const grantId = await issuedGrant(await dependencies());
    // A restart drops every in-memory object; the grant row and the project are
    // the only state that carries over.
    history.dispose();
    const restartedHistory = new MutationHistory(new LargePreviousContentStore(appData));
    restartedHistory.attach("browser-restarted", origin.sessionId, projectId);
    history = restartedHistory;
    // The old process exits, so its lease is released before the new one starts.
    await leaseHandle.release(leaseId);
    const lease = new WorkspaceLease(database, clock, createSequentialIdPort());
    const reacquired = await lease.acquire(
      path.join(root, "workspace") as AbsolutePath,
      "test:catalog-approval-restarted",
    );
    expect(reacquired.ok).toBe(true);
    if (!reacquired.ok) return;
    authority = new WriteAuthority({
      workspace: new WorkspaceFs(path.join(root, "workspace") as AbsolutePath),
      journal: new MutationJournal(database, clock, new LargePreviousContentStore(appData)),
      compositeJournal: new MutationJournal(database, clock, new LargePreviousContentStore(appData)),
      lease,
      leaseId: reacquired.leaseId,
      hashContent,
      invalidate() {},
      notifyEvents() {},
      undoContent: new LargePreviousContentStore(appData),
      stagedAssets: new AppDataAssetStager(appData),
      clock,
      observer: restartedHistory,
    });
    const executed = await executeCatalogInstall(
      await dependencies(),
      { intent, grantId },
      "user",
      { origin, toolAudit: null },
    );
    expect(executed.ok).toBe(true);
    expect(await readFile(path.join(projectRoot, ENTRY_TARGET), "utf8")).toBe(ENTRY_BYTES);
    expect(pins).toBe(0);
  });

  it("rejects an execute that changes the mount or the item under the same grant", async () => {
    const deps = await dependencies();
    const grantId = await issuedGrant(deps);
    const movedMount = await executeCatalogInstall(
      deps,
      { intent: { ...intent, mount: { kind: "new-scene", toIndex: 0 } }, grantId },
      "user",
      { origin, toolAudit: null },
    );
    expect(movedMount.ok).toBe(false);
    if (!movedMount.ok) expect(movedMount.error.code).toBe(ErrorCode.ApprovalInvalid);

    const renamed = await executeCatalogInstall(
      deps,
      { intent: { ...intent, name: "other-block" }, grantId },
      "user",
      { origin, toolAudit: null },
    );
    expect(renamed.ok).toBe(false);
    expect(await absent(path.join(projectRoot, ENTRY_TARGET))).toBe(true);
    expect(await journal.latestSourceRevision(projectId)).toBeNull();
    expect(pins).toBe(0);

    // The untouched grant still works for the intent it approved.
    const honoured = await executeCatalogInstall(deps, { intent, grantId }, "user", { origin, toolAudit: null });
    expect(honoured.ok).toBe(true);
    expect(pins).toBe(0);
  });

  it("rejects a stale revision after the project moves under a prepared grant", async () => {
    const deps = await dependencies();
    const grantId = await issuedGrant(deps);
    // Something else writes first, so the approved revision is no longer current.
    const bumped = await authority.mutateSource({
      ref: (await workspace.readProjectRef(projectId))!,
      steps: [{ kind: "write", path: "notes.txt" as RelPath, content: "note\n", expectedContentHash: null }],
      origin: { kind: "system", sessionId: null, label: null, historyAction: "ignore", historyOperation: null },
      toolAudit: null,
      backup: false,
    }, "system");
    expect(bumped.ok).toBe(true);

    const stale = await executeCatalogInstall(deps, { intent, grantId }, "user", { origin, toolAudit: null });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe(ErrorCode.WriteConflict);
    expect(await absent(path.join(projectRoot, ENTRY_TARGET))).toBe(true);
    expect(pins).toBe(0);
  });
});
