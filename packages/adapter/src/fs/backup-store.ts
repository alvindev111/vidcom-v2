import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { sql } from "drizzle-orm";

import type { Dirent } from "node:fs";

import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import {
  canonicalizeJson,
  type BackupManifest,
  type BackupManifestEntry,
  type BackupPayload,
  type BackupPort,
  type BackupSource,
  type ClockPort,
  type IdPort,
} from "@vidcom/core";

import { syncDirectory } from "./durability";

import type { VidcomDatabase } from "../db/client";

interface StoredBackup {
  id: string;
  projectId: string;
  revisionId: number | null;
  reason: string;
  entries: string;
  manifestHash: string;
  createdAt: string;
  payloadPrunedAt: string | null;
}

function digest(bytes: string | Uint8Array): ContentHash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
}

function safeRelativePath(value: RelPath): string {
  if (path.posix.isAbsolute(value) || value.includes("\\")
    || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError("backup source path is not canonical project-relative");
  }
  return value;
}

function manifestDigest(manifest: Omit<BackupManifest, "manifestHash" | "revisionId" | "payloadPrunedAt">): ContentHash {
  return digest(canonicalizeJson(manifest));
}

function storedManifest(row: StoredBackup): BackupManifest {
  return {
    id: row.id,
    projectId: row.projectId as ProjectId,
    revisionId: row.revisionId,
    reason: row.reason,
    entries: JSON.parse(row.entries) as BackupManifestEntry[],
    manifestHash: row.manifestHash,
    createdAt: row.createdAt,
    payloadPrunedAt: row.payloadPrunedAt,
  };
}

async function writeSynced(filename: string, bytes: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface BackupStoreOperations {
  beforeVerify(directory: string): Promise<void>;
  syncDirectory(directory: string): Promise<void>;
  rename(source: string, target: string): Promise<void>;
  beforePruneCommit?(directory: string): Promise<void>;
  beforePruneDelete?(directory: string): Promise<void>;
}

const defaultOperations: BackupStoreOperations = {
  async beforeVerify() {},
  syncDirectory,
  rename,
};

/** App-data backup store with canonical public metadata and atomic payload publication. */
export class AppDataBackupStore implements BackupPort {
  private readonly backupsRoot: string;

  constructor(
    appDataRoot: string,
    private readonly database: VidcomDatabase,
    private readonly clock: ClockPort,
    private readonly ids: IdPort,
    private readonly operations: BackupStoreOperations = defaultOperations,
  ) {
    this.backupsRoot = path.join(appDataRoot, "backups");
  }

  private projectDirectory(projectId: ProjectId): string {
    return path.join(this.backupsRoot, encodeURIComponent(projectId));
  }

  private backupDirectory(projectId: ProjectId, id: string): string {
    return path.join(this.projectDirectory(projectId), encodeURIComponent(id));
  }

  async create(projectId: ProjectId, reason: string, files: BackupSource[]): Promise<BackupManifest> {
    if (files.length === 0) throw new TypeError("backup must contain at least one source");
    const id = this.ids.newId("backup");
    const createdAt = this.clock.now().toISOString();
    const projectDirectory = this.projectDirectory(projectId);
    const publishedDirectory = this.backupDirectory(projectId, id);
    const temporaryDirectory = path.join(projectDirectory, `.${encodeURIComponent(id)}.tmp`);
    let published = false;
    try {
      await mkdir(projectDirectory, { recursive: true });
      await mkdir(temporaryDirectory, { recursive: false });
      const entries: BackupManifestEntry[] = [];
      const seen = new Set<string>();
      for (const source of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
        const relative = safeRelativePath(source.path);
        if (seen.has(relative)) throw new TypeError("backup source path is duplicated");
        seen.add(relative);
        const bytes = await readFile(source.resolved);
        const contentHash = digest(bytes);
        await writeSynced(path.join(temporaryDirectory, "payload", relative), bytes);
        entries.push({ path: source.path, contentHash, byteSize: bytes.byteLength });
      }
      const core = { id, projectId, createdAt, reason, entries };
      const manifest: BackupManifest = {
        ...core,
        revisionId: null,
        manifestHash: manifestDigest(core),
        payloadPrunedAt: null,
      };
      await writeSynced(
        path.join(temporaryDirectory, "manifest.json"),
        `${canonicalizeJson(manifest)}\n`,
      );
      await this.operations.beforeVerify(temporaryDirectory);
      if (!(await this.verifyDirectory(temporaryDirectory, manifest))) {
        throw new Error("backup verification failed before publish");
      }
      await this.operations.syncDirectory(temporaryDirectory);
      await this.operations.rename(temporaryDirectory, publishedDirectory);
      published = true;
      await this.operations.syncDirectory(projectDirectory);
      this.database.run(sql`
        INSERT INTO backup_manifest (
          id, project_id, revision_id, reason, entries, manifest_hash, created_at, payload_pruned_at
        ) VALUES (
          ${id}, ${projectId}, NULL, ${reason}, ${canonicalizeJson(entries)},
          ${manifest.manifestHash}, ${createdAt}, NULL
        )
      `);
      return manifest;
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
      if (published) await rm(publishedDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private row(id: string): StoredBackup | undefined {
    return this.database.get<StoredBackup>(sql`
      SELECT id, project_id AS projectId, revision_id AS revisionId, reason, entries,
        manifest_hash AS manifestHash, created_at AS createdAt,
        payload_pruned_at AS payloadPrunedAt
      FROM backup_manifest WHERE id = ${id}
    `);
  }

  async read(id: string): Promise<BackupManifest | null> {
    const row = this.row(id);
    if (!row) return null;
    const manifest = storedManifest(row);
    try {
      const disk = JSON.parse(await readFile(
        path.join(this.backupDirectory(manifest.projectId, id), "manifest.json"),
        "utf8",
      )) as BackupManifest;
      const immutableDisk = {
        id: disk.id,
        projectId: disk.projectId,
        createdAt: disk.createdAt,
        reason: disk.reason,
        entries: disk.entries,
        manifestHash: disk.manifestHash,
      };
      const immutableDatabase = {
        id: manifest.id,
        projectId: manifest.projectId,
        createdAt: manifest.createdAt,
        reason: manifest.reason,
        entries: manifest.entries,
        manifestHash: manifest.manifestHash,
      };
      return canonicalizeJson(immutableDisk) === canonicalizeJson(immutableDatabase)
        ? manifest
        : null;
    } catch {
      return null;
    }
  }

  async readPayloads(id: string): Promise<BackupPayload[]> {
    const manifest = await this.read(id);
    if (!manifest || manifest.payloadPrunedAt !== null) return [];
    const directory = this.backupDirectory(manifest.projectId, id);
    const payloads: BackupPayload[] = [];
    for (const entry of manifest.entries) {
      const bytes = await readFile(path.join(directory, "payload", safeRelativePath(entry.path)));
      const contentHash = digest(bytes);
      if (contentHash !== entry.contentHash || bytes.byteLength !== entry.byteSize) {
        throw new Error("backup payload integrity check failed");
      }
      payloads.push({ path: entry.path, bytes, contentHash });
    }
    return payloads;
  }

  private async verifyDirectory(directory: string, manifest: BackupManifest): Promise<boolean> {
    try {
      const core = {
        id: manifest.id,
        projectId: manifest.projectId,
        createdAt: manifest.createdAt,
        reason: manifest.reason,
        entries: manifest.entries,
      };
      if (manifest.manifestHash !== manifestDigest(core)) return false;
      for (const entry of manifest.entries) {
        const bytes = await readFile(path.join(directory, "payload", safeRelativePath(entry.path)));
        if (digest(bytes) !== entry.contentHash || bytes.byteLength !== entry.byteSize) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async verify(id: string): Promise<boolean> {
    const manifest = await this.read(id);
    return manifest !== null
      && manifest.payloadPrunedAt === null
      && this.verifyDirectory(this.backupDirectory(manifest.projectId, id), manifest);
  }

  async list(projectId: ProjectId): Promise<BackupManifest[]> {
    const rows = this.database.all<StoredBackup>(sql`
      SELECT id, project_id AS projectId, revision_id AS revisionId, reason, entries,
        manifest_hash AS manifestHash, created_at AS createdAt,
        payload_pruned_at AS payloadPrunedAt
      FROM backup_manifest WHERE project_id = ${projectId} ORDER BY created_at, id
    `);
    return rows.map(storedManifest);
  }

  /** Lists all backup metadata for trusted local administration without widening the Core port. */
  async listAll(): Promise<BackupManifest[]> {
    const rows = this.database.all<StoredBackup>(sql`
      SELECT id, project_id AS projectId, revision_id AS revisionId, reason, entries,
        manifest_hash AS manifestHash, created_at AS createdAt,
        payload_pruned_at AS payloadPrunedAt
      FROM backup_manifest ORDER BY created_at, id
    `);
    return rows.map(storedManifest);
  }

  private async reconcilePruneTombstones(): Promise<void> {
    for (const manifest of await this.listAll()) {
      const directory = this.backupDirectory(manifest.projectId, manifest.id);
      const payload = path.join(directory, "payload");
      const tombstone = path.join(directory, ".payload.pruning");
      const present = async (target: string) => {
        try { await stat(target); return true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      };
      const [hasPayload, hasTombstone] = await Promise.all([present(payload), present(tombstone)]);
      if (manifest.payloadPrunedAt === null && hasTombstone) {
        if (hasPayload) await rm(tombstone, { recursive: true, force: true });
        else await this.operations.rename(tombstone, payload);
        await this.operations.syncDirectory(directory);
      } else if (manifest.payloadPrunedAt !== null) {
        if (hasPayload && !hasTombstone) await this.operations.rename(payload, tombstone);
        await rm(tombstone, { recursive: true, force: true });
        await this.operations.syncDirectory(directory);
      }
    }
  }

  async prunePayloads(olderThan: Date): Promise<number> {
    await this.reconcilePruneTombstones();
    const rows = this.database.all<StoredBackup>(sql`
      SELECT backup_manifest.id AS id, backup_manifest.project_id AS projectId,
        backup_manifest.revision_id AS revisionId, backup_manifest.reason AS reason,
        backup_manifest.entries AS entries, backup_manifest.manifest_hash AS manifestHash,
        backup_manifest.created_at AS createdAt, backup_manifest.payload_pruned_at AS payloadPrunedAt
      FROM backup_manifest
      LEFT JOIN revision ON revision.id = backup_manifest.revision_id
      WHERE payload_pruned_at IS NULL
        AND COALESCE(revision.created_at, backup_manifest.created_at) < ${olderThan.toISOString()}
        AND NOT EXISTS (
          SELECT 1 FROM mutation_journal
          WHERE mutation_journal.backup_id = backup_manifest.id
            AND mutation_journal.status IN ('pending', 'orphaned')
        )
      ORDER BY backup_manifest.created_at, backup_manifest.id
    `);
    let pruned = 0;
    for (const row of rows) {
      const manifest = storedManifest(row);
      const directory = this.backupDirectory(manifest.projectId, manifest.id);
      const tombstone = path.join(directory, ".payload.pruning");
      await this.operations.rename(path.join(directory, "payload"), tombstone);
      await this.operations.syncDirectory(directory);
      await this.operations.beforePruneCommit?.(directory);
      const updated = this.database.run(sql`
        UPDATE backup_manifest SET payload_pruned_at = ${this.clock.now().toISOString()}
        WHERE id = ${manifest.id} AND payload_pruned_at IS NULL
      `);
      if (updated.changes !== 1) throw new Error("backup payload prune lost its durable transition");
      await this.operations.beforePruneDelete?.(directory);
      await rm(tombstone, { recursive: true, force: true });
      await this.operations.syncDirectory(directory);
      pruned += 1;
    }
    return pruned;
  }

  async cleanupOrphanPayloads(olderThan: Date): Promise<number> {
    let removed = 0;
    let projects: Dirent<string>[];
    try { projects = await readdir(this.backupsRoot, { withFileTypes: true }); }
    catch { return 0; }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectDirectory = path.join(this.backupsRoot, project.name);
      for (const backup of await readdir(projectDirectory, { withFileTypes: true })) {
        if (!backup.isDirectory()) continue;
        const directory = path.join(projectDirectory, backup.name);
        const metadata = await stat(directory);
        const encodedId = backup.name.startsWith(".") && backup.name.endsWith(".tmp")
          ? backup.name.slice(1, -4)
          : backup.name;
        const id = decodeURIComponent(encodedId);
        if (metadata.mtime >= olderThan || this.row(id)) continue;
        await rm(directory, { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }
}
