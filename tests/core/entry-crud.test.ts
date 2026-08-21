import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  canonicalizeJson,
  createEntry,
  executeDeleteEntry,
  getEntryExpectation,
  prepareDeleteEntry,
  renameEntry,
  type AbsolutePath,
  type CompositeRequest,
  type DirectoryEntry,
  type ProjectRef,
  type ResolvedPath,
  type StagedSourceHandle,
} from "@vidcom/core";

const projectId = "project_entry_crud" as ProjectId;
const ref: ProjectRef = {
  id: projectId,
  slug: "entry-crud",
  root: "/workspace/entry-crud" as AbsolutePath,
  entry: "index.html" as RelPath,
};
const actor = "user" as const;
const origin = {
  kind: "ui", sessionId: "session", label: "File operation", historyAction: "record", historyOperation: null,
} as const;

function digest(value: string | Uint8Array): ContentHash {
  return `sha256:${createHash("sha256").update(value).digest("hex")}` as ContentHash;
}

function setup(options: {
  revision?: number;
  special?: Record<string, "symlink" | "other">;
  entryResourceLimits?: {
    maxDepth: number;
    maxNodes: number;
    maxEntriesPerDirectory: number;
    maxSerializedBytes: number;
    maxDurationMs: number;
  };
} = {}) {
  const files = new Map<string, ContentHash>([
    ["assets/source/a.txt", digest("a")],
    ["assets/source/nested/b.txt", digest("b")],
  ]);
  const directories = new Map<string, DirectoryEntry[]>([
    ["assets", [{ name: "source", kind: "directory" }]],
    ["assets/source", [{ name: "a.txt", kind: "file" }, { name: "nested", kind: "directory" }]],
    ["assets/source/nested", [{ name: "b.txt", kind: "file" }]],
  ]);
  const mutations: CompositeRequest[] = [];
  const opened: StagedSourceHandle[] = [];
  const dependencies = {
    workspace: {
      async readProjectRef(id: ProjectId) { return id === projectId ? ref : null; },
      async resolve(_ref: ProjectRef, value: string) { return { ok: true as const, value: value as ResolvedPath }; },
      async stat(value: ResolvedPath) {
        const special = options.special?.[value];
        if (special) return { size: 0, modifiedAt: new Date(0), kind: special };
        if (files.has(value)) return { size: 1, modifiedAt: new Date(0), kind: "file" as const };
        if (directories.has(value)) return { size: 0, modifiedAt: new Date(0), kind: "directory" as const };
        return null;
      },
      async readDirectory(value: ResolvedPath) { return directories.get(value) ?? null; },
      async readHash(value: ResolvedPath) { return files.get(value) ?? null; },
      async openStagedSource(_ref: ProjectRef, value: RelPath, expectedHash: ContentHash) {
        const handle: StagedSourceHandle = {
          source: { sourcePath: `/tmp/${value.replaceAll("/", "-")}` as AbsolutePath, contentHash: expectedHash },
          discarded: false,
          async discard() { this.discarded = true; },
        } as StagedSourceHandle & { discarded: boolean };
        opened.push(handle);
        return handle;
      },
    },
    journal: { async latestRevision() { return options.revision ?? 7; } },
    authority: {
      async mutateSource(request: CompositeRequest) {
        mutations.push(request);
        return { ok: true as const, value: {
          projectRevision: 8,
          entityRevision: null,
          fileHashes: {},
          diagnostics: [],
          changeSeq: 8,
          ...(request.backup ? { backupId: "backup_entry" } : {}),
        } };
      },
    },
    hashContent: digest,
    ...(options.entryResourceLimits ? { entryResourceLimits: options.entryResourceLimits } : {}),
  };
  return { dependencies, files, directories, mutations, opened };
}

function folderDigest(): ContentHash {
  return digest(canonicalizeJson([
    { relativePath: "a.txt", kind: "file", contentHash: digest("a") },
    { relativePath: "nested", kind: "folder", contentHash: null },
    { relativePath: "nested/b.txt", kind: "file", contentHash: digest("b") },
  ]));
}

describe("entry CRUD", () => {
  it("returns server-owned file hashes and canonical folder digests for UI preconditions", async () => {
    const value = setup();
    expect(await getEntryExpectation(value.dependencies, {
      projectId, path: "assets/source/a.txt" as RelPath,
    })).toEqual({ ok: true, value: {
      path: "assets/source/a.txt", kind: "file", expectedContentHash: digest("a"),
    } });
    expect(await getEntryExpectation(value.dependencies, {
      projectId, path: "assets/source" as RelPath,
    })).toEqual({ ok: true, value: {
      path: "assets/source", kind: "folder", expectedTreeDigest: folderDigest(),
    } });
  });

  it("creates an empty file or an absent directory through one history-ignored composite", async () => {
    for (const kind of ["file", "folder"] as const) {
      const value = setup();
      const result = await createEntry(value.dependencies, {
        projectId, path: `assets/new-${kind}` as RelPath, kind, expectedRevision: 7,
      }, actor, { origin, toolAudit: null });
      expect(result.ok).toBe(true);
      expect(value.mutations).toHaveLength(1);
      expect(value.mutations[0]).toMatchObject({
        origin: { kind: "ui", sessionId: "session", historyAction: "ignore", historyOperation: null },
        backup: false,
        steps: kind === "file"
          ? [{ kind: "write", path: "assets/new-file", content: "", expectedContentHash: null }]
          : [{ kind: "mkdir", path: "assets/new-folder", expectExisting: "absent" }],
      });
    }
  });

  it("renames a file with staged publish before source deletion and cleans the capability", async () => {
    const value = setup();
    value.files.set("assets/source.txt", digest("source"));
    const result = await renameEntry(value.dependencies, {
      projectId,
      from: "assets/source.txt" as RelPath,
      to: "assets/renamed.txt" as RelPath,
      expectedRevision: 7,
      expected: { kind: "file", contentHash: digest("source") },
    }, actor, { origin, toolAudit: null });

    expect(result).toMatchObject({ ok: true, value: { from: "assets/source.txt", to: "assets/renamed.txt", backupId: "backup_entry" } });
    expect(value.mutations[0]).toMatchObject({
      backup: true,
      steps: [
        { kind: "write-staged", path: "assets/renamed.txt", expectedContentHash: null, undoable: false },
        { kind: "delete", path: "assets/source.txt", expectedContentHash: digest("source") },
      ],
    });
    expect((value.opened[0] as StagedSourceHandle & { discarded: boolean }).discarded).toBe(true);
  });

  it("renames a folder from shallow target mkdirs through all writes to deep source removal", async () => {
    const value = setup();
    const result = await renameEntry(value.dependencies, {
      projectId,
      from: "assets/source" as RelPath,
      to: "assets/target" as RelPath,
      expectedRevision: 7,
      expected: { kind: "folder", treeDigest: folderDigest() },
    }, actor, { origin, toolAudit: null });

    expect(result.ok).toBe(true);
    expect(value.mutations[0]?.steps).toMatchObject([
      { kind: "mkdir", path: "assets/target", expectExisting: "absent" },
      { kind: "mkdir", path: "assets/target/nested", expectExisting: "absent" },
      { kind: "write-staged", path: "assets/target/a.txt", undoable: false },
      { kind: "write-staged", path: "assets/target/nested/b.txt", undoable: false },
      { kind: "delete", path: "assets/source/a.txt", expectedContentHash: digest("a") },
      { kind: "delete", path: "assets/source/nested/b.txt", expectedContentHash: digest("b") },
      { kind: "rmdir", path: "assets/source/nested", expectEmpty: true },
      { kind: "rmdir", path: "assets/source", expectEmpty: true },
    ]);
    expect(value.opened).toHaveLength(2);
    expect(value.opened.every((item) => (item as StagedSourceHandle & { discarded: boolean }).discarded)).toBe(true);
  });

  it("rejects stale tree digests, descendant moves and special entries before mutation", async () => {
    const stale = setup();
    const staleResult = await renameEntry(stale.dependencies, {
      projectId, from: "assets/source" as RelPath, to: "assets/target" as RelPath, expectedRevision: 7,
      expected: { kind: "folder", treeDigest: digest("stale") },
    }, actor, { origin, toolAudit: null });
    expect(staleResult).toEqual({ ok: false, error: expect.objectContaining({ code: ErrorCode.WriteConflict }) });
    expect(stale.mutations).toHaveLength(0);
    expect(stale.opened).toHaveLength(0);

    const descendant = setup();
    const descendantResult = await renameEntry(descendant.dependencies, {
      projectId, from: "assets/source" as RelPath, to: "assets/source/nested/new" as RelPath, expectedRevision: 7,
      expected: { kind: "folder", treeDigest: folderDigest() },
    }, actor, { origin, toolAudit: null });
    expect(descendantResult).toEqual({ ok: false, error: expect.objectContaining({ code: ErrorCode.PathInvalid }) });

    const special = setup({ special: { "assets/source/nested/b.txt": "symlink" } });
    const specialResult = await renameEntry(special.dependencies, {
      projectId, from: "assets/source" as RelPath, to: "assets/target" as RelPath, expectedRevision: 7,
      expected: { kind: "folder", treeDigest: folderDigest() },
    }, actor, { origin, toolAudit: null });
    expect(specialResult).toEqual({ ok: false, error: expect.objectContaining({ code: ErrorCode.AssetNotAllowed }) });
    expect(special.mutations).toHaveLength(0);
  });

  it("re-plans destructive deletion and binds the current revision and file hashes to the grant", async () => {
    const prepared = setup();
    const plan = await prepareDeleteEntry(prepared.dependencies, {
      projectId, path: "assets/source" as RelPath, recursive: true, expectedRevision: 7,
    });
    expect(plan).toMatchObject({ ok: true, value: { binding: {
      tool: "delete_entry",
      projectId,
      expectedRevision: 7,
      targetHashes: {
        "assets/source/a.txt": digest("a"),
        "assets/source/nested/b.txt": digest("b"),
      },
    } } });

    const executed = setup();
    const result = await executeDeleteEntry(executed.dependencies, {
      projectId, path: "assets/source" as RelPath, recursive: true, expectedRevision: 7, grantId: "grant_entry",
    }, actor, { origin, toolAudit: null });
    expect(result).toMatchObject({ ok: true, value: { deleted: "assets/source", backupId: "backup_entry" } });
    expect(executed.mutations[0]).toMatchObject({
      backup: true,
      grant: { id: "grant_entry", binding: { tool: "delete_entry", expectedRevision: 7 } },
      steps: [
        { kind: "delete", path: "assets/source/a.txt" },
        { kind: "delete", path: "assets/source/nested/b.txt" },
        { kind: "rmdir", path: "assets/source/nested" },
        { kind: "rmdir", path: "assets/source" },
      ],
    });
  });

  it.each([
    ["node_count", { maxDepth: 64, maxNodes: 2, maxEntriesPerDirectory: 2_000, maxSerializedBytes: 8 * 1024 * 1024, maxDurationMs: 5_000 }],
    ["directory_entries", { maxDepth: 64, maxNodes: 10_000, maxEntriesPerDirectory: 1, maxSerializedBytes: 8 * 1024 * 1024, maxDurationMs: 5_000 }],
    ["depth", { maxDepth: 1, maxNodes: 10_000, maxEntriesPerDirectory: 2_000, maxSerializedBytes: 8 * 1024 * 1024, maxDurationMs: 5_000 }],
    ["serialized_bytes", { maxDepth: 64, maxNodes: 10_000, maxEntriesPerDirectory: 2_000, maxSerializedBytes: 1, maxDurationMs: 5_000 }],
  ] as const)("rejects recursive plans that cross the %s budget", async (reason, entryResourceLimits) => {
    const value = setup({ entryResourceLimits });
    const result = await prepareDeleteEntry(value.dependencies, {
      projectId, path: "assets/source" as RelPath, recursive: true, expectedRevision: 7,
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({
      code: "resource_limit_exceeded",
      details: expect.objectContaining({ reason }),
    }) });
    expect(value.mutations).toHaveLength(0);
    expect(value.opened).toHaveLength(0);
  });
});
