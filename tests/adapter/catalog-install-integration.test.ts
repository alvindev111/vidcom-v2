import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  ApprovalService,
  DEFAULT_PREVIEW_SETTINGS,
  WriteAuthority,
  applyMutationInverse,
  catalogProvenanceOf,
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
  SqliteApprovalGrantStore,
  LargePreviousContentStore,
  MutationJournal,
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
const projectId = "project_catalog_install" as ProjectId;
const ENTRY_TARGET = "blocks/lower-third/index.html" as RelPath;
const STYLE_TARGET = "blocks/lower-third/style.css" as RelPath;
const hashContent = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;
const digestOf = (content: string) => createHash("sha256").update(content).digest("hex");

const ENTRY_BYTES = "<section data-composition-id=\"lower-third\"><p>lower third</p></section>\n";
const STYLE_BYTES = ".lower-third { color: red }\n";

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
let releases: number;
let leaseHandle: WorkspaceLease;
let leaseId: string;
let approvals: ApprovalService;
let grantSequence: number;

function verifiedItem(overrides: Partial<VerifiedCatalogItem> = {}): VerifiedCatalogItem {
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
      files: { [ENTRY_TARGET]: digestOf(ENTRY_BYTES), [STYLE_TARGET]: digestOf(STYLE_BYTES) },
      manifest: "",
    },
    materialization: "verified" as const,
    source: { registry: "bundled" as const, url: null, revision: null, committedAt: null },
    dependencies: [],
    compatibility: { aspectRatios: null, minWidth: null, fps: null, minHyperframesVersion: null },
    durationSeconds: 4,
    entry: ENTRY_TARGET,
    preview: null,
    ...overrides,
  } as VerifiedCatalogItem;
  base.integrity.manifest = catalogManifestDigest(base);
  return base;
}

async function materializedFiles(): Promise<CatalogMaterializedFile[]> {
  await mkdir(cacheRoot, { recursive: true });
  const entryPath = path.join(cacheRoot, "index.html");
  const stylePath = path.join(cacheRoot, "style.css");
  await writeFile(entryPath, ENTRY_BYTES, "utf8");
  await writeFile(stylePath, STYLE_BYTES, "utf8");
  return [
    {
      path: ENTRY_TARGET,
      contentHash: hashContent(ENTRY_BYTES),
      source: { sourcePath: entryPath as AbsolutePath, contentHash: hashContent(ENTRY_BYTES) },
      encoding: "utf8",
    },
    {
      path: STYLE_TARGET,
      contentHash: hashContent(STYLE_BYTES),
      source: { sourcePath: stylePath as AbsolutePath, contentHash: hashContent(STYLE_BYTES) },
      encoding: "utf8",
    },
  ];
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

async function dependencies(options: {
  item?: VerifiedCatalogItem;
  files?: CatalogMaterializedFile[];
  authorityOverride?: WriteAuthority;
} = {}): Promise<CatalogInstallExecuteDependencies> {
  const item = options.item ?? verifiedItem();
  const files = options.files ?? await materializedFiles();
  const used = options.authorityOverride ?? authority;
  return {
    workspace,
    composition,
    journal,
    catalog: {
      materialize: async () => ({
        ok: true as const,
        value: { item, files, release: async () => { releases += 1; } },
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
    authority: { mutateSource: (request, actor) => used.mutateSource(request, actor) },
  };
}

/**
 * Prepares, has the grant issued the way an authenticated click does, then
 * executes. The grant is a real SQLite row, so `WriteAuthority` reserves it
 * against the same binding rather than trusting the caller.
 */
async function installOnce(
  deps: CatalogInstallExecuteDependencies,
  override: Partial<CatalogInstallIntent> = {},
) {
  const target = { ...intent, ...override };
  const prepared = await prepareCatalogInstall(deps, target);
  if (!prepared.ok) return { prepared, executed: null } as const;
  if (prepared.value.status !== "ready") return { prepared, executed: null } as const;
  const grantId = await approvals.request(prepared.value.binding, `Install ${target.name}`);
  await approvals.issue(grantId, "ui");
  const executed = await executeCatalogInstall(
    deps,
    { intent: target, grantId },
    "user",
    { origin, toolAudit: null },
  );
  return { prepared, executed } as const;
}

/** Dependencies `applyMutationInverse` needs; the same objects the install used. */
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

async function absent(target: string): Promise<boolean> {
  try { await access(target); return false; }
  catch { return true; }
}

beforeEach(async () => {
  releases = 0;
  root = await mkdtemp(path.join(tmpdir(), "vidcom-catalog-install-"));
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
  const acquired = await leaseHandle.acquire(workspaceRoot as AbsolutePath, "test:catalog-install");
  if (!acquired.ok) throw new Error("test lease was denied");
  leaseId = acquired.leaseId;
  grantSequence = 0;
  approvals = new ApprovalService({
    grants: new SqliteApprovalGrantStore(database),
    clock,
    ids: { newId: () => `grant_catalog_${++grantSequence}` },
  });
  history = new MutationHistory(new LargePreviousContentStore(appData));
  history.attach("browser-catalog", origin.sessionId, projectId);
  authority = new WriteAuthority({
    workspace,
    journal,
    compositeJournal: journal,
    lease: leaseHandle,
    leaseId,
    hashContent,
    validateFileContent(target, content) {
      return typeof content === "string"
        ? composition.validateSource?.(target, content) ?? Promise.resolve({ ok: true as const, value: undefined })
        : Promise.resolve({ ok: true as const, value: undefined });
    },
    invalidate() {},
    notifyEvents() {},
    backups: new AppDataBackupStore(appData, database, clock, { newId: () => "backup_catalog" }),
    undoContent: new LargePreviousContentStore(appData),
    // Package files land through the same app-data stager production uses, so a
    // `write-staged` step publishes by hash-verified link rather than by bytes.
    stagedAssets: new AppDataAssetStager(appData),
    // Both are required for a receipt to exist at all: without a clock the
    // authority releases its retained content and emits nothing.
    clock,
    observer: history,
  });
});

afterEach(async () => {
  history?.dispose();
  await database?.destroy();
  await removeTree(root);
});

describe("catalog install over real SQLite and a real filesystem", () => {
  it("writes the package, the mount and the provenance as one mutation and one undo entry", async () => {
    const { executed } = await installOnce(await dependencies());
    expect(executed?.ok).toBe(true);
    if (!executed?.ok) return;

    // One revision for the whole install, and exactly one undoable entry.
    expect(executed.value.envelope.projectRevision).toBe(1);
    expect(await journal.latestSourceRevision(projectId)).toBe(1);
    expect(history.state(origin.sessionId, projectId)).toMatchObject({ depth: 1, canUndo: true });

    expect(await readFile(path.join(projectRoot, ENTRY_TARGET), "utf8")).toBe(ENTRY_BYTES);
    expect(await readFile(path.join(projectRoot, STYLE_TARGET), "utf8")).toBe(STYLE_BYTES);
    const entry = await readFile(path.join(projectRoot, "index.html"), "utf8");
    expect(entry).toContain(executed.value.sceneId ?? "scene-2");
    const wrapper = await readFile(
      path.join(projectRoot, "compositions", `${executed.value.sceneId}.html`),
      "utf8",
    );
    expect(wrapper).toContain(`data-composition-src="${ENTRY_TARGET}"`);
    expect(wrapper).toContain("data-catalog-provenance=");
    expect(executed.value.provenance).toEqual(catalogProvenanceOf(verifiedItem()));
    expect(releases).toBeGreaterThan(0);
  });

  it("writes nothing when a materialized digest drifts from the manifest", async () => {
    const files = await materializedFiles();
    await writeFile(path.join(cacheRoot, "style.css"), "/* tampered */\n", "utf8");
    const drifted = [
      files[0]!,
      { ...files[1]!, contentHash: hashContent("/* tampered */\n"), source: { ...files[1]!.source, contentHash: hashContent("/* tampered */\n") } },
    ];
    const prepared = await prepareCatalogInstall(await dependencies({ files: drifted }), intent);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error.code).toBe(ErrorCode.IntegrityMismatch);

    const { executed } = await installOnce(await dependencies({ files: drifted }));
    expect(executed).toBeNull();
    expect(await absent(path.join(projectRoot, ENTRY_TARGET))).toBe(true);
    expect(await journal.latestSourceRevision(projectId)).toBeNull();
  });

  it("refuses the same version with different bytes rather than offering a replace", async () => {
    const first = await installOnce(await dependencies());
    expect(first.executed?.ok).toBe(true);

    // Same version, different contents: a package that is not what it claims.
    const drifted = verifiedItem({
      integrity: {
        algo: "sha256",
        files: { [ENTRY_TARGET]: digestOf("<section>changed</section>\n"), [STYLE_TARGET]: digestOf(STYLE_BYTES) },
        manifest: "",
      },
    });
    drifted.integrity.manifest = catalogManifestDigest(drifted);
    const changed = await materializedFiles();
    await writeFile(path.join(cacheRoot, "index.html"), "<section>changed</section>\n", "utf8");
    const prepared = await prepareCatalogInstall(await dependencies({
      item: drifted,
      files: [
        {
          ...changed[0]!,
          contentHash: hashContent("<section>changed</section>\n"),
          source: { ...changed[0]!.source, contentHash: hashContent("<section>changed</section>\n") },
        },
        changed[1]!,
      ],
    }), { ...intent, expectedRevision: 1 });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error.code).toBe(ErrorCode.IntegrityMismatch);
  });

  it("undoes the mount and every file the install created", async () => {
    const { executed } = await installOnce(await dependencies());
    expect(executed?.ok).toBe(true);
    if (!executed?.ok) return;
    await writeFile(path.join(projectRoot, "untouched.txt"), "keep me\n", "utf8");

    const claimed = history.begin(origin.sessionId, projectId, "undo");
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const undone = await applyMutationInverse(
      inverseDependencies(),
      { projectId, receipt: claimed.value.receipt, direction: "undo" },
      "user",
      {
        ...origin,
        historyAction: "undo",
        historyOperation: { id: claimed.value.operationId, targetReceiptId: claimed.value.receipt.id },
      },
    );
    expect(undone.ok).toBe(true);

    // The package files and the wrapper are gone; the untouched file stays.
    expect(await absent(path.join(projectRoot, ENTRY_TARGET))).toBe(true);
    expect(await absent(path.join(projectRoot, STYLE_TARGET))).toBe(true);
    expect(await absent(path.join(projectRoot, "compositions", `${executed.value.sceneId}.html`))).toBe(true);
    expect(await readFile(path.join(projectRoot, "untouched.txt"), "utf8")).toBe("keep me\n");
    const entry = await readFile(path.join(projectRoot, "index.html"), "utf8");
    expect(entry).not.toContain(String(executed.value.sceneId));
  });

  it("rolls the whole package back when one write fails", async () => {
    // Proxy the real workspace so only the authored mount write fails; every
    // other filesystem operation stays real.
    const failingWorkspace = new Proxy(workspace, {
      get(target, property, receiver) {
        if (property === "publishCaptured") {
          return async (...args: Parameters<WorkspaceFs["publishCaptured"]>) => {
            const written = String(args[0].target).split(path.sep).join("/");
            // Only the authored root entry fails to land; the package files
            // publish first, so the rollback has something to undo.
            if (written.endsWith("/index.html") && !written.includes("/blocks/")) return false;
            return target.publishCaptured(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failing = new WriteAuthority({
      workspace: failingWorkspace,
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
    });    const { executed } = await installOnce(await dependencies({ authorityOverride: failing }));
    expect(executed?.ok).toBe(false);
    // Nothing partial survives: no package file, no wrapper, no revision.
    expect(await absent(path.join(projectRoot, ENTRY_TARGET))).toBe(true);
    expect(await absent(path.join(projectRoot, STYLE_TARGET))).toBe(true);
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe(indexSource);
    expect(releases).toBeGreaterThan(0);
  });

  it("redoes an install after the catalog cache that produced it is gone", async () => {
    const { executed } = await installOnce(await dependencies());
    expect(executed?.ok).toBe(true);
    if (!executed?.ok) return;
    const undoClaim = history.begin(origin.sessionId, projectId, "undo");
    expect(undoClaim.ok).toBe(true);
    if (!undoClaim.ok) return;
    const undone = await applyMutationInverse(
      inverseDependencies(),
      { projectId, receipt: undoClaim.value.receipt, direction: "undo" },
      "user",
      {
        ...origin,
        historyAction: "undo",
        historyOperation: { id: undoClaim.value.operationId, targetReceiptId: undoClaim.value.receipt.id },
      },
    );
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;


    // Simulate the global LRU reclaiming the package the install came from.
    await rm(cacheRoot, { recursive: true, force: true });

    const redoClaim = history.begin(origin.sessionId, projectId, "redo");
    expect(redoClaim.ok).toBe(true);
    if (!redoClaim.ok) return;
    const redone = await applyMutationInverse(
      inverseDependencies(),
      { projectId, receipt: redoClaim.value.receipt, direction: "redo" },
      "user",
      {
        ...origin,
        historyAction: "redo",
        historyOperation: { id: redoClaim.value.operationId, targetReceiptId: redoClaim.value.receipt.id },
      },
    );
    expect(redone.ok).toBe(true);
    // History kept its own content refs, so redo does not need the catalog cache.
    expect(await readFile(path.join(projectRoot, ENTRY_TARGET), "utf8")).toBe(ENTRY_BYTES);
    expect(await readFile(path.join(projectRoot, STYLE_TARGET), "utf8")).toBe(STYLE_BYTES);
  });
});
