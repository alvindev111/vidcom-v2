import { describe, expect, it } from "vitest";

import {
  ErrorCode,
  type ContentHash,
  type PreviewSettingsDto,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  restoreBackup,
  serializePreviewSettings,
  type BackupManifest,
  type BackupPayload,
  type CompositeRequest,
  type EntityState,
  type ProjectRef,
  type StepIntent,
  type WriteEnvelope,
} from "@vidcom/core";

const projectId = "project_restore" as ProjectId;
const hash = (digit: string): ContentHash => `sha256:${digit.repeat(64)}` as ContentHash;
const ref = {
  id: projectId,
  slug: "restore",
  root: "/workspace/restore",
  entry: "index.html" as RelPath,
} as ProjectRef;

function setup(options: {
  manifest?: Partial<BackupManifest>;
  steps?: StepIntent[];
  payloads?: BackupPayload[];
  entityState?: EntityState | null;
  currentEntity?: string | null;
} = {}) {
  const manifest: BackupManifest = {
    id: "backup_1",
    projectId,
    revisionId: 8,
    createdAt: "2026-08-02T00:00:00.000Z",
    reason: "tool:delete_scene",
    entries: [],
    manifestHash: hash("f"),
    payloadPrunedAt: null,
    ...options.manifest,
  };
  const calls: Array<{ request: CompositeRequest; actor: string }> = [];
  const dependencies = {
    backups: {
      async create() { return manifest; },
      async read() { return manifest; },
      async readPayloads() { return options.payloads ?? []; },
      async verify() { return true; },
      async list() { return [manifest]; },
      async prunePayloads() { return 0; },
      async cleanupOrphanPayloads() { return 0; },
    },
    journal: {
      async readBackupRevisionSteps() { return options.steps ?? []; },
      async readEntityState() { return options.entityState ?? null; },
    },
    workspace: {
      async readProjectRef() { return ref; },
      async resolve() { return { ok: true as const, value: "/workspace/restore/preview-settings.json" as never }; },
      async readFile() {
        const content = options.currentEntity ?? null;
        return content === null ? null : { content, contentHash: options.entityState?.contentHash ?? hash("9") };
      },
    },
    writes: {
      async mutateSource(request: CompositeRequest, actor: string) {
        calls.push({ request, actor });
        return {
          ok: true as const,
          value: {
            projectRevision: 9,
            entityRevision: null,
            fileHashes: {},
            diagnostics: [],
          } satisfies WriteEnvelope,
        };
      },
    },
  };
  return { dependencies, calls, manifest };
}

describe("restoreBackup", () => {
  it("uses destructive to_hash values as preconditions and creates a CLI-audited composite", async () => {
    const oldIndex = new TextEncoder().encode("old index");
    const oldScene = new TextEncoder().encode("old scene");
    const { dependencies, calls } = setup({
      steps: [
        { ordinal: 0, kind: "delete", path: "index.html" as RelPath, entity: null, fromHash: hash("1"), toHash: null, previousContent: oldIndex },
        { ordinal: 1, kind: "write", path: "narration/new.wav" as RelPath, entity: null, fromHash: null, toHash: hash("2"), previousContent: null },
        { ordinal: 2, kind: "write", path: "src/scene.html" as RelPath, entity: null, fromHash: hash("3"), toHash: hash("4"), previousContent: oldScene },
      ],
      payloads: [
        { path: "index.html" as RelPath, bytes: oldIndex, contentHash: hash("1") },
        { path: "src/scene.html" as RelPath, bytes: oldScene, contentHash: hash("3") },
      ],
    });

    await expect(restoreBackup(dependencies, { projectId, backupId: "backup_1" }, "cli-external"))
      .resolves.toMatchObject({ ok: true, value: { projectRevision: 9 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      actor: "cli-external",
      request: {
        backup: false,
        toolAudit: null,
        commandAudit: { action: "cli:restore", detail: { backupId: "backup_1" } },
        steps: [
          { kind: "write", path: "index.html", expectedContentHash: null },
          { kind: "delete", path: "narration/new.wav", expectedContentHash: hash("2") },
          { kind: "write", path: "src/scene.html", expectedContentHash: hash("4") },
        ],
      },
    });
  });

  it("reconstructs the full entity patch and removes scenes absent from the backup", async () => {
    const previousSettings: PreviewSettingsDto = {
      ...DEFAULT_PREVIEW_SETTINGS,
      scenes: { restored: { transitionSound: "minimal", revealSound: "ping", hidden: false } },
    };
    const currentSettings = { ...previousSettings, scenes: { transient: previousSettings.scenes.restored } };
    const previous = new TextEncoder().encode(serializePreviewSettings(previousSettings));
    const entityState: EntityState = {
      revision: 4,
      contentHash: hash("9"),
      backingPath: "preview-settings.json" as RelPath,
    };
    const { dependencies, calls } = setup({
      entityState,
      currentEntity: serializePreviewSettings(currentSettings),
      steps: [{ ordinal: 0, kind: "entity", path: null, entity: "preview-settings", fromHash: hash("8"), toHash: hash("9"), previousContent: previous }],
      payloads: [{ path: entityState.backingPath, bytes: previous, contentHash: hash("8") }],
    });

    await restoreBackup(dependencies, { projectId, backupId: "backup_1" }, "cli-external");
    expect(calls[0]?.request.steps[0]).toMatchObject({
      kind: "entity",
      expectedRevision: 4,
      patch: { scenes: previousSettings.scenes, scenesRemove: ["transient"] },
    });
  });

  it("returns backup_expired before reading payload bytes", async () => {
    const { dependencies, calls } = setup({ manifest: { payloadPrunedAt: "2026-08-02T00:00:00.000Z" } });
    await expect(restoreBackup(dependencies, { projectId, backupId: "backup_1" }, "cli-external"))
      .resolves.toMatchObject({ ok: false, error: { code: ErrorCode.BackupExpired } });
    expect(calls).toHaveLength(0);
  });

  it("rejects an entity changed after the destructive revision", async () => {
    const { dependencies, calls } = setup({
      entityState: { revision: 5, contentHash: hash("a"), backingPath: "preview-settings.json" as RelPath },
      steps: [{ ordinal: 0, kind: "entity", path: null, entity: "preview-settings", fromHash: hash("8"), toHash: hash("9"), previousContent: "{}" }],
    });
    await expect(restoreBackup(dependencies, { projectId, backupId: "backup_1" }, "cli-external"))
      .resolves.toMatchObject({ ok: false, error: { code: ErrorCode.WriteConflict } });
    expect(calls).toHaveLength(0);
  });
});
