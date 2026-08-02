import { closeSync, mkdirSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { sql } from "drizzle-orm";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";

import { secureAppDataDirectorySync, secureCredentialFileSync } from "../fs/credential-store";

export type VidcomDatabase = NodeSQLiteDatabase & {
  $client: DatabaseSync;
  destroy(): Promise<void>;
};

function precreateOwnerOnlyFile(filename: string): void {
  const descriptor = openSync(filename, "a", 0o600);
  closeSync(descriptor);
  secureCredentialFileSync(filename);
}

/** Opens Drizzle directly on Node's built-in SQLite driver and owns its lifecycle. */
export function createSqliteClient(filename: string): VidcomDatabase {
  const protectedFiles = filename === ":memory:"
    ? []
    : [filename, `${filename}-wal`, `${filename}-shm`];
  for (const protectedFile of protectedFiles) precreateOwnerOnlyFile(protectedFile);
  const client = new DatabaseSync(filename);
  if (protectedFiles.length > 0) {
    try {
      for (const protectedFile of protectedFiles) secureCredentialFileSync(protectedFile);
    } catch (error) {
      client.close();
      throw error;
    }
  }
  const database = drizzle({ client }) as VidcomDatabase;
  database.run(sql`PRAGMA foreign_keys = ON`);
  database.run(sql`PRAGMA busy_timeout = 5000`);
  if (protectedFiles.length > 0) {
    database.run(sql`PRAGMA journal_mode = WAL`);
    for (const protectedFile of protectedFiles) secureCredentialFileSync(protectedFile);
  }
  database.destroy = async () => client.close();
  return database;
}

/** Opens the sole operational database under an explicitly injected app-data root. */
export function openVidcomDatabase(appDataRoot: string): VidcomDatabase {
  mkdirSync(appDataRoot, { recursive: true, mode: 0o700 });
  secureAppDataDirectorySync(appDataRoot);
  return createSqliteClient(path.join(appDataRoot, "vidcom.sqlite"));
}
