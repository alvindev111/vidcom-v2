import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { sql } from "drizzle-orm";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";

import { secureCredentialFileSync } from "../fs/credential-store";

export type VidcomDatabase = NodeSQLiteDatabase & {
  $client: DatabaseSync;
  destroy(): Promise<void>;
};

/** Opens Drizzle directly on Node's built-in SQLite driver and owns its lifecycle. */
export function createSqliteClient(filename: string): VidcomDatabase {
  const client = new DatabaseSync(filename);
  if (filename !== ":memory:") {
    try {
      secureCredentialFileSync(filename);
    } catch (error) {
      client.close();
      throw error;
    }
  }
  const database = drizzle({ client }) as VidcomDatabase;
  database.run(sql`PRAGMA foreign_keys = ON`);
  database.run(sql`PRAGMA busy_timeout = 5000`);
  if (filename !== ":memory:") database.run(sql`PRAGMA journal_mode = WAL`);
  database.destroy = async () => client.close();
  return database;
}

/** Opens the sole operational database under an explicitly injected app-data root. */
export function openVidcomDatabase(appDataRoot: string): VidcomDatabase {
  mkdirSync(appDataRoot, { recursive: true });
  return createSqliteClient(path.join(appDataRoot, "vidcom.sqlite"));
}
