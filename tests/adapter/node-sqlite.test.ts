import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AppSettingsStore,
  createSqliteClient,
  migrateDatabase,
  openVidcomDatabase,
} from "@vidcom/adapter";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("Drizzle node:sqlite driver", () => {
  it("exposes the native result metadata Drizzle uses for conditional writes", async () => {
    const database = createSqliteClient(":memory:");
    try {
      database.$client.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, status TEXT NOT NULL)");
      database.$client.prepare("INSERT INTO probe(id, status) VALUES (?, ?)").run(1, "queued");
      const claimed = database.$client.prepare(
        "UPDATE probe SET status = ? WHERE id = ? AND status = ?",
      ).run("running", 1, "queued");
      const missed = database.$client.prepare(
        "UPDATE probe SET status = ? WHERE id = ? AND status = ?",
      ).run("running", 1, "queued");
      expect(claimed.changes).toBe(1);
      expect(missed.changes).toBe(0);
    } finally {
      await database.destroy();
    }
  });

  it("runs typed Drizzle persistence over the built-in driver", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-drizzle-"));
    roots.push(root);
    const database = openVidcomDatabase(root);
    try {
      await migrateDatabase(database);
      const settings = new AppSettingsStore(database, () => new Date("2026-08-01T00:00:00.000Z"));
      settings.set("workspace", "/tmp/projects");
      expect(settings.get("workspace")).toBe("/tmp/projects");
    } finally {
      await database.destroy();
    }
  });
});
