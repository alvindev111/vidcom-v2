import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrateDatabase } from "@vidcom/adapter";
import { startServing, type ServingDaemon } from "@vidcom/cli";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const daemons: ServingDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  delete process.env.VIDCOM_APP_DATA;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Counts the real migrator across serve -> host -> coordinator -> foundation. */
describe("one boot, one migrated database", () => {
  it("calls migration exactly once and leaves a consistent schema", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-boot-")));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    process.env.VIDCOM_APP_DATA = path.join(root, "app-data");
    let migrationCalls = 0;
    const countedMigration: typeof migrateDatabase = async (database) => {
      migrationCalls += 1;
      await migrateDatabase(database);
    };

    const daemon = await startServing({ workspace }, { migrate: countedMigration });
    daemons.push(daemon);
    expect(migrationCalls).toBe(1);

    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path.join(root, "app-data", "vidcom.sqlite"), {
      readOnly: true,
    });
    try {
      const applied = database.prepare(
        "SELECT count(*) AS count FROM __drizzle_migrations",
      ).get() as { count: number };
      const distinct = database.prepare(
        "SELECT count(DISTINCT hash) AS count FROM __drizzle_migrations",
      ).get() as { count: number };
      // Counter proves invocation count; the database assertions prove that
      // the one invocation performed the real migration rather than a stub.
      expect(applied.count).toBe(distinct.count);
      expect(applied.count).toBeGreaterThan(0);

      const violations = database.prepare("PRAGMA foreign_key_check").all();
      expect(violations).toEqual([]);
    } finally {
      database.close();
    }
  }, 90_000);
});
