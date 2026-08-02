import { mkdtemp, rm, stat } from "node:fs/promises";
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

  it("creates app-data and every live SQLite file owner-only under a permissive umask", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-sqlite-permissions-"));
    roots.push(root);
    const appData = path.join(root, "app-data");
    const previousUmask = process.umask(0);
    let database: ReturnType<typeof openVidcomDatabase> | null = null;
    try {
      database = openVidcomDatabase(appData);
      await migrateDatabase(database);
      expect((await stat(appData)).mode & 0o777).toBe(0o700);
      for (const filename of ["vidcom.sqlite", "vidcom.sqlite-wal", "vidcom.sqlite-shm"]) {
        expect((await stat(path.join(appData, filename))).mode & 0o777, filename).toBe(0o600);
      }
    } finally {
      process.umask(previousUmask);
      await database?.destroy();
    }
  });
});
