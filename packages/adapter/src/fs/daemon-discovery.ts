import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { secureAppDataDirectorySync, secureCredentialFile } from "./credential-store";

export const DAEMON_RECORD_SCHEMA_VERSION = 1;
const DAEMON_DIRECTORY = "daemon";

export interface DaemonRecord {
  schemaVersion: number;
  workspaceRoot: string;
  workspaceHash: string;
  instanceId: string;
  pid: number;
  host: "127.0.0.1";
  port: number;
  startedAt: string;
}

/**
 * Names the record after the workspace it describes.
 *
 * A hash rather than the path itself: workspace roots contain separators,
 * spaces and characters Windows refuses in a filename, and encoding them would
 * make two different roots collide the moment the encoding is lossy.
 */
export function workspaceHash(workspaceRoot: string): string {
  return `sha256:${createHash("sha256").update(workspaceRoot).digest("hex")}`;
}

function recordPath(appDataRoot: string, workspaceRoot: string): string {
  const hash = workspaceHash(workspaceRoot);
  return path.join(appDataRoot, DAEMON_DIRECTORY, `${hash.slice("sha256:".length)}.json`);
}

/**
 * Rejects a record that does not describe what its filename claims.
 *
 * The file is discovery, not authority — but a record naming a different
 * workspace than the one asked for would send a client at a daemon that owns
 * someone else's tree, and every later check would pass because the client
 * would be talking to a real, healthy daemon.
 */
function parseRecord(raw: string, workspaceRoot: string): DaemonRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Partial<DaemonRecord>;
  if (record.schemaVersion !== DAEMON_RECORD_SCHEMA_VERSION) return null;
  if (record.workspaceRoot !== workspaceRoot) return null;
  if (record.workspaceHash !== workspaceHash(workspaceRoot)) return null;
  if (typeof record.instanceId !== "string" || record.instanceId.length === 0) return null;
  if (!Number.isInteger(record.pid) || (record.pid ?? 0) <= 0) return null;
  if (record.host !== "127.0.0.1") return null;
  if (!Number.isInteger(record.port) || (record.port ?? 0) < 1 || (record.port ?? 0) > 65_535) return null;
  if (typeof record.startedAt !== "string" || Number.isNaN(Date.parse(record.startedAt))) return null;
  return record as DaemonRecord;
}

/**
 * Where a client looks to find the daemon that owns a workspace.
 *
 * The file holds no secret, no attachment count and no lease id. The bearer
 * lives beside it under app-data and the lease lives in the database; putting
 * any of it here would publish authority in a file whose only job is to say
 * "something is listening over there".
 */
export class DaemonDiscoveryStore {
  constructor(private readonly appDataRoot: string) {}

  async read(workspaceRoot: string): Promise<DaemonRecord | null> {
    try {
      return parseRecord(await readFile(recordPath(this.appDataRoot, workspaceRoot), "utf8"), workspaceRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * Writes the record so no reader ever sees a partial one.
   *
   * Temp, fsync, rename: a client reading a half-written file would parse a
   * truncated JSON object and treat the daemon as absent, which is the one
   * outcome that makes it start a second daemon for the same workspace.
   */
  async publish(record: DaemonRecord): Promise<void> {
    const pathname = recordPath(this.appDataRoot, record.workspaceRoot);
    const directory = path.dirname(pathname);
    await mkdir(directory, { recursive: true });
    secureAppDataDirectorySync(directory);

    // Unique per call, not per instance. Two publishes of the same record —
    // a retry, or two processes racing to start a daemon — would otherwise
    // share one temp path, and the one that loses `wx` deletes the file the
    // winner is still writing. Both then fail and no record is ever published.
    const temporary = path.join(directory, `.${path.basename(pathname)}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        // On Windows the inherited ACL exists from creation, so the still-empty
        // file is restricted before any bytes become observable.
        await secureCredentialFile(temporary);
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, pathname);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /**
   * Removes the record only if it still describes the caller.
   *
   * A daemon that shuts down slowly would otherwise delete the record of the
   * daemon that has already replaced it, and the replacement stays invisible
   * while being perfectly healthy — the hardest shape of this bug to see.
   */
  async remove(workspaceRoot: string, instanceId: string): Promise<void> {
    const current = await this.read(workspaceRoot);
    if (current === null || current.instanceId !== instanceId) return;
    await rm(recordPath(this.appDataRoot, workspaceRoot), { force: true });
  }
}
