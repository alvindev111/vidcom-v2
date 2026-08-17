import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { sql } from "drizzle-orm";
import { ErrorCode, type ContentHash, type ProjectId } from "@vidcom/contracts";
import type { AbsolutePath, ClockPort, JournalId, ResolvedPath } from "@vidcom/core";

import { writeAtomic } from "../fs/atomic-write";
import { LargePreviousContentStore } from "../fs/large-content-store";
import { WorkspaceFs } from "../fs/workspace-fs";
import { MutationJournal } from "./journal";
import type { VidcomDatabase } from "./client";

async function digest(filename: string): Promise<ContentHash | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return `sha256:${hash.digest("hex")}` as ContentHash;
  } catch { return null; }
  finally { await handle?.close(); }
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function safeTemporary(filename: string, tempRoot: string): Promise<string | null> {
  try {
    const root = await realpath(tempRoot);
    const resolved = path.resolve(filename);
    const parent = await realpath(path.dirname(resolved));
    if (parent !== root) return null;
    try {
      const [target, metadata] = await Promise.all([realpath(resolved), lstat(resolved)]);
      return !metadata.isSymbolicLink() && metadata.isFile() && contained(root, target) ? target : null;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? resolved : null;
    }
  } catch {
    return null;
  }
}

/** Resolves pending composite asset crash states before generic journal reconciliation. */
export async function reconcileStagedAssets(
  database: VidcomDatabase,
  clock: ClockPort,
  appDataRoot: string,
): Promise<void> {
  const rows = database.all<{
    id: number; projectId: string; toHash: string; previousContent: Uint8Array | null;
    previousObjectHash: string | null;
    stagedTmpPath: string | null; stagedTargetPath: string | null; stagedContentHash: string | null;
    workspaceRoot: string; slug: string;
  }>(sql`
    SELECT journal.id, journal.project_id AS projectId, journal.to_hash AS toHash,
      journal.previous_content AS previousContent, journal.previous_object_hash AS previousObjectHash,
      journal.staged_tmp_path AS stagedTmpPath,
      journal.staged_target_path AS stagedTargetPath, journal.staged_content_hash AS stagedContentHash,
      project.workspace_root AS workspaceRoot, project.slug
    FROM mutation_journal AS journal
    INNER JOIN project_registry AS project ON project.id = journal.project_id
    WHERE journal.status = 'pending' AND journal.staged_tmp_path IS NOT NULL
  `);
  const largeContent = new LargePreviousContentStore(appDataRoot);
  const journal = new MutationJournal(database, clock, largeContent);
  const tempRoot = path.resolve(appDataRoot, "tmp");
  for (const row of rows) {
    if (!row.stagedTmpPath || !row.stagedTargetPath) continue;
    const temporary = await safeTemporary(path.resolve(row.stagedTmpPath), tempRoot);
    const workspace = new WorkspaceFs(path.resolve(row.workspaceRoot) as AbsolutePath);
    const ref = await workspace.readProjectRef(row.projectId as ProjectId).catch(() => null);
    const resolved = ref?.slug === row.slug
      ? await workspace.resolve(ref, row.stagedTargetPath, "write-asset").catch(() => null)
      : null;
    if (!temporary || !ref || !resolved?.ok || !row.stagedContentHash) {
      await journal.orphan(row.id as JournalId, null);
      continue;
    }
    const projectRoot = ref.root;
    const target = resolved.value;
    const settings = path.join(projectRoot, "preview-settings.json");
    const [settingsHash, targetHash] = await Promise.all([digest(settings), digest(target)]);
    if (settingsHash === row.toHash && targetHash === row.stagedContentHash) {
      await rm(temporary, { force: true });
      continue;
    }
    await rm(temporary, { force: true });
    if (targetHash && targetHash !== row.stagedContentHash) {
      await journal.orphan(row.id as JournalId, targetHash);
      continue;
    }
    if (targetHash === row.stagedContentHash) await rm(target, { force: true });
    if (settingsHash === row.toHash) {
      const previousContent = row.previousContent
        ?? (row.previousObjectHash
          ? await largeContent.read(row.previousObjectHash as ContentHash)
          : null);
      if (previousContent) await writeAtomic(settings as ResolvedPath, previousContent);
      else await rm(settings, { force: true });
    }
    await journal.abort(row.id as JournalId, ErrorCode.StorageUnavailable);
  }
}
