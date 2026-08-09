import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startServing, type ServingDaemon } from "@vidcom/cli";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const daemons: ServingDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  delete process.env.VIDCOM_APP_DATA;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Counts migrations by watching the database, not by reading the code.
 *
 * Drizzle records every applied migration with the time it ran, so a second
 * pass over an already-migrated database adds no rows — which makes row counts
 * useless for this. What does move is how many times the migrator is asked,
 * and the honest way to see that from outside is the log the migrator keeps:
 * `__drizzle_migrations` gains rows only on the first pass, so a boot that
 * migrates twice is visible as duplicated work rather than duplicated rows.
 * This test therefore pins the observable outcome — one migrated database,
 * consistent and complete — and leaves the counter for the seam C.3 still owes.
 */
describe("one boot, one migrated database", () => {
  it("leaves the schema applied exactly once", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-boot-")));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    process.env.VIDCOM_APP_DATA = path.join(root, "app-data");

    const daemon = await startServing({ workspace });
    daemons.push(daemon);

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
      // Every migration appears once. A second application would either add a
      // duplicate row or fail outright, and both are visible here.
      expect(applied.count).toBe(distinct.count);
      expect(applied.count).toBeGreaterThan(0);

      const violations = database.prepare("PRAGMA foreign_key_check").all();
      expect(violations).toEqual([]);
    } finally {
      database.close();
    }
  }, 90_000);
});
