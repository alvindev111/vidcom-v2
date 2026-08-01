import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { migrate } from "drizzle-orm/node-sqlite/migrator";

import { openVidcomDatabase, type VidcomDatabase } from "./client";

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/** Applies the forward-only Drizzle migration history. */
export async function migrateDatabase(database: VidcomDatabase): Promise<void> {
  const result = migrate(database, { migrationsFolder });
  if (result && "exitCode" in result) throw new Error(`Drizzle migration failed: ${result.exitCode}`);
}

/** Opens the app-data database and completes migrations as one startup prerequisite. */
export async function initializeDatabase(appDataRoot: string): Promise<VidcomDatabase> {
  const database = openVidcomDatabase(appDataRoot);
  try {
    await migrateDatabase(database);
    return database;
  } catch (error) {
    await database.destroy();
    throw error;
  }
}
