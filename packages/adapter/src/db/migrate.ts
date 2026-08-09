import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-sqlite/migrator";

import { openVidcomDatabase, type VidcomDatabase } from "./client";

const sourceMigrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Where the migration history lives, for a build that has been packaged.
 *
 * A packaged build cannot use the module-relative path. L.1 rewrites
 * `import.meta.url` to the `/vidcom` marker precisely so the build machine's
 * directories never ship, which leaves the source-relative answer pointing at
 * nothing. The extracted runtime carries the same history beside the Node
 * archive, and that is the copy a packaged build must read.
 */
export function resolveMigrationsFolder(
  installedRuntimeRoot?: string | null,
): string {
  return installedRuntimeRoot ? resolve(installedRuntimeRoot, "drizzle") : sourceMigrationsFolder;
}

const defaultMigrationsFolder = sourceMigrationsFolder;

/** Applies a forward-only Drizzle migration history, with an override for migration fixtures. */
export async function migrateDatabase(
  database: VidcomDatabase,
  migrationsFolder = defaultMigrationsFolder,
): Promise<void> {
  database.run(sql`PRAGMA foreign_keys = OFF`);
  try {
    const result = migrate(database, { migrationsFolder });
    if (result && "exitCode" in result) throw new Error(`Drizzle migration failed: ${result.exitCode}`);
  } finally {
    database.run(sql`PRAGMA foreign_keys = ON`);
  }
  const violation = database.get<{ count: number }>(sql`
    SELECT count(*) AS count FROM pragma_foreign_key_check
  `);
  if (violation?.count) throw new Error(`Drizzle migration left ${violation.count} foreign-key violations`);
}

/** Opens the app-data database and completes migrations as one startup prerequisite. */
export async function initializeDatabase(
  appDataRoot: string,
  migrationsFolder = defaultMigrationsFolder,
): Promise<VidcomDatabase> {
  const database = openVidcomDatabase(appDataRoot);
  try {
    await migrateDatabase(database, migrationsFolder);
    return database;
  } catch (error) {
    await database.destroy();
    throw error;
  }
}
