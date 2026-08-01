import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import { ErrorCode } from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  serializePreviewSettings,
  WriteAuthority,
  type AbsolutePath,
  type EntityState,
  type JournalId,
  type MutationIntent,
  type MutationResult,
  type PendingMutation,
  type ProjectRef,
  type ResolvedPath,
} from "@vidcom/core";

const digest = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

const projectId = "project_0001" as ProjectId;
const project: ProjectRef = {
  id: projectId,
  slug: "project",
  root: "/workspace/project" as AbsolutePath,
  entry: "index.html" as RelPath,
};

class FakeWorkspace {
  readonly files = new Map<string, string>();
  writeDelayMs = 0;
  writeError: Error | null = null;
  writes = 0;

  async resolve(_ref: ProjectRef, path: string) {
    return { ok: true as const, value: path as ResolvedPath };
  }
  async listProjects() { return [project]; }
  async readProjectRef(id: ProjectId) { return id === projectId ? project : null; }
  async readFile(path: ResolvedPath) {
    const content = this.files.get(path);
    return content === undefined ? null : { content, contentHash: digest(content) };
  }
  async readBytes() { return null; }
  async readHash(path: ResolvedPath) {
    const content = this.files.get(path);
    return content === undefined ? null : digest(content);
  }
  async writeAtomic(path: ResolvedPath, content: string | Uint8Array) {
    this.writes += 1;
    if (this.writeDelayMs) await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
    if (this.writeError) throw this.writeError;
    this.files.set(path, typeof content === "string" ? content : new TextDecoder().decode(content));
  }
  async readTree() { return []; }
  async stat(path: ResolvedPath) {
    const content = this.files.get(path);
    return content === undefined ? null : { size: content.length, modifiedAt: new Date(0), kind: "file" as const };
  }
}

class FakeJournal {
  pending: PendingMutation[] = [];
  aborted: Array<{ id: JournalId; reason: ErrorCode }> = [];
  commitError: Error | null = null;
  revision = 0;
  entityState: EntityState | null = null;

  async begin(intent: MutationIntent): Promise<JournalId> {
    const id = (this.pending.length + 1) as JournalId;
    this.pending.push({ id, ...intent });
    return id;
  }
  async commit(id: JournalId, result: MutationResult): Promise<number> {
    if (this.commitError) throw this.commitError;
    this.pending = this.pending.filter((entry) => entry.id !== id);
    if (result.kind === "entity") {
      this.entityState = {
        revision: (this.entityState?.revision ?? 0) + 1,
        contentHash: result.toHash,
        backingPath: "preview-settings.json" as RelPath,
      };
      return this.entityState.revision;
    }
    this.revision += 1;
    return this.revision;
  }
  async abort(id: JournalId, reason: ErrorCode) {
    this.pending = this.pending.filter((entry) => entry.id !== id);
    this.aborted.push({ id, reason });
  }
  async recover(id: JournalId, result: MutationResult) { return this.commit(id, result); }
  async orphan(id: JournalId) { this.pending = this.pending.filter((entry) => entry.id !== id); }
  async listPending() { return this.pending; }
  async latestRevision() { return this.revision || null; }
  async readEntityState() { return this.entityState; }
  async findProjectRegistration() { return null; }
  async registerProject() {}
  async beginBootstrap(_registration: unknown, _seed: unknown, intent: MutationIntent) {
    return this.begin(intent);
  }
}

function setup() {
  const workspace = new FakeWorkspace();
  const journal = new FakeJournal();
  const lease = { held: true };
  const authority = new WriteAuthority({
    workspace,
    journal,
    lease: {
      async acquire() { return { ok: true as const, leaseId: "lease" }; },
      async renew() { return lease.held; },
      async release() {},
      async assertHeld() { return lease.held; },
    },
    leaseId: "lease",
    hashContent: digest,
    invalidate() {},
    notifyEvents() {},
  });
  return { authority, workspace, journal, lease };
}

describe("WriteAuthority file mutations", () => {
  it("refuses mutation after lease loss while leaving reads untouched", async () => {
    const { authority, lease, workspace } = setup();
    workspace.files.set("index.html", "old");
    lease.held = false;
    await expect(
      authority.mutate({
        kind: "file",
        ref: project,
        path: "index.html" as RelPath,
        content: "new",
        expectedContentHash: digest("old"),
      }, "user"),
    ).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.WorkspaceLeaseLost } });
    expect((await workspace.readFile("index.html" as ResolvedPath))?.content).toBe("old");
    expect(workspace.writes).toBe(0);
  });

  it("rejects missing, legacy and malformed preconditions with distinct codes", async () => {
    const { authority, workspace } = setup();
    workspace.files.set("index.html", "old");
    for (const [expectedContentHash, code] of [
      [null, ErrorCode.PreconditionRequired],
      ["l1-2z", ErrorCode.VersionFormatLegacy],
      ["anything", ErrorCode.SchemaInvalid],
    ] as const) {
      await expect(authority.mutate({
        kind: "file",
        ref: project,
        path: "index.html" as RelPath,
        content: "new",
        expectedContentHash,
      }, "user")).resolves.toMatchObject({ ok: false, error: { code } });
    }
  });

  it("serializes concurrent writes so exactly one expected hash wins", async () => {
    const { authority, workspace } = setup();
    workspace.files.set("index.html", "old");
    workspace.writeDelayMs = 10;
    const request = (content: string) => authority.mutate({
      kind: "file" as const,
      ref: project,
      path: "index.html" as RelPath,
      content,
      expectedContentHash: digest("old"),
    }, "user");
    const results = await Promise.all([request("first"), request("second")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const failed = results.find((result) => !result.ok);
    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: ErrorCode.WriteConflict,
        details: { current: { content: "first", contentHash: digest("first"), revision: 1 } },
      },
    });
  });

  it("creates a missing file with null and makes identical content a no-op", async () => {
    const { authority, workspace } = setup();
    const request = {
      kind: "file" as const,
      ref: project,
      path: "compositions/new.html" as RelPath,
      content: "new",
      expectedContentHash: null,
    };
    await expect(authority.mutate(request, "user")).resolves.toMatchObject({ ok: true, value: { revision: 1 } });
    await expect(authority.mutate({ ...request, expectedContentHash: digest("new") }, "user")).resolves.toMatchObject({
      ok: true,
      value: { revision: 1 },
    });
    expect(workspace.writes).toBe(1);
  });

  it("normalizes a conflict revision to zero when no revision exists", async () => {
    const { authority, workspace } = setup();
    workspace.files.set("index.html", "current");

    await expect(authority.mutate({
      kind: "file",
      ref: project,
      path: "index.html" as RelPath,
      content: "next",
      expectedContentHash: digest("stale"),
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { details: { current: { revision: 0 } } },
    });
  });

  it("aborts the journal immediately when the atomic file write fails", async () => {
    const { authority, workspace, journal } = setup();
    workspace.writeError = new Error("disk unavailable");

    await expect(authority.mutate({
      kind: "file",
      ref: project,
      path: "compositions/new.html" as RelPath,
      content: "new",
      expectedContentHash: null,
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.StorageUnavailable },
    });
    expect(journal.pending).toEqual([]);
    expect(journal.aborted).toEqual([{ id: 1, reason: ErrorCode.StorageUnavailable }]);
  });

  it("keeps the journal pending for recovery when commit fails after the file write", async () => {
    const { authority, journal, workspace } = setup();
    journal.commitError = new Error("database unavailable");

    await expect(authority.mutate({
      kind: "file",
      ref: project,
      path: "compositions/new.html" as RelPath,
      content: "new",
      expectedContentHash: null,
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.StorageUnavailable },
    });
    expect(workspace.files.get("compositions/new.html")).toBe("new");
    expect(journal.pending).toHaveLength(1);
    expect(journal.aborted).toEqual([]);
  });
});

describe("WriteAuthority entity mutations", () => {
  it("reports missing entity state as an internal invariant failure", async () => {
    const { authority } = setup();

    await expect(authority.mutate({
      kind: "entity",
      ref: project,
      entity: "preview-settings",
      patch: { bgm: { volume: 0.7 } },
      expectedRevision: 0,
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.Internal },
    });
  });

  it("supports revision zero with no backing file and returns the updated entity", async () => {
    const { authority, journal } = setup();
    journal.entityState = {
      revision: 0,
      contentHash: digest(serializePreviewSettings(DEFAULT_PREVIEW_SETTINGS)),
      backingPath: "preview-settings.json" as RelPath,
    };
    await expect(authority.mutate({
      kind: "entity",
      ref: project,
      entity: "preview-settings",
      patch: { bgm: { volume: 0.7 } },
      expectedRevision: 0,
    }, "user")).resolves.toMatchObject({
      ok: true,
      value: { revision: 1, previewSettings: { bgm: { volume: 0.7 } } },
    });
  });

  it("conflicts on stale revision or backing-file hash and includes current merge data", async () => {
    const { authority, journal, workspace } = setup();
    const content = serializePreviewSettings(DEFAULT_PREVIEW_SETTINGS);
    workspace.files.set("preview-settings.json", content);
    journal.entityState = {
      revision: 2,
      contentHash: digest("stale"),
      backingPath: "preview-settings.json" as RelPath,
    };
    await expect(authority.mutate({
      kind: "entity",
      ref: project,
      entity: "preview-settings",
      patch: { bgm: { volume: 0.7 } },
      expectedRevision: 2,
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: {
        code: ErrorCode.WriteConflict,
        details: { current: { revision: 2, contentHash: digest(content), previewSettings: DEFAULT_PREVIEW_SETTINGS } },
      },
    });
  });

  it("aborts the journal immediately when the entity backing write fails", async () => {
    const { authority, journal, workspace } = setup();
    journal.entityState = {
      revision: 0,
      contentHash: digest(serializePreviewSettings(DEFAULT_PREVIEW_SETTINGS)),
      backingPath: "preview-settings.json" as RelPath,
    };
    workspace.writeError = new Error("disk unavailable");

    await expect(authority.mutate({
      kind: "entity",
      ref: project,
      entity: "preview-settings",
      patch: { bgm: { volume: 0.7 } },
      expectedRevision: 0,
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.StorageUnavailable },
    });
    expect(journal.pending).toEqual([]);
    expect(journal.aborted).toEqual([{ id: 1, reason: ErrorCode.StorageUnavailable }]);
  });
});
