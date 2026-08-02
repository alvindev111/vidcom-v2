import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProjectId, RelPath } from "@vidcom/contracts";
import type { ClockPort, IdPort, ResolvedPath } from "@vidcom/core";
import { AppDataBackupStore, initializeDatabase } from "@vidcom/adapter";

import { dbOne, dbRun } from "../support/database";

const projectId = "project_backup" as ProjectId;
const otherProjectId = "project_backup_other" as ProjectId;
const now = "2026-08-02T12:00:00.000Z";

let root: string;
let sourceRoot: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;

function fixedClock(value = now): ClockPort {
  return { now: () => new Date(value) };
}

function fixedId(value: string): IdPort {
  return { newId: () => value };
}

function store(id: string, timestamp = now): AppDataBackupStore {
  return new AppDataBackupStore(root, database, fixedClock(timestamp), fixedId(id));
}

function backupDirectory(project: ProjectId, id: string): string {
  return path.join(root, "backups", encodeURIComponent(project), encodeURIComponent(id));
}

async function source(relative: string, content: string) {
  const resolved = path.join(sourceRoot, relative);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, content);
  return { path: relative as RelPath, resolved: resolved as ResolvedPath };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-backup-store-"));
  sourceRoot = path.join(root, "workspace", "project");
  await mkdir(sourceRoot, { recursive: true });
  database = await initializeDatabase(root);
  for (const id of [projectId, otherProjectId]) {
    dbRun(database, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
    id, sourceRoot, id, now, now);
  }
});

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

describe("AppDataBackupStore", () => {
  it("publishes a canonical, sorted manifest without absolute source paths", async () => {
    const index = await source("index.html", "<main>hello</main>");
    const scene = await source("src/scenes/b.html", "scene");
    const manifest = await store("backup_layout").create(projectId, "before delete", [scene, index]);

    expect(manifest.entries.map((entry) => entry.path)).toEqual(["index.html", "src/scenes/b.html"]);
    const disk = await readFile(path.join(backupDirectory(projectId, manifest.id), "manifest.json"), "utf8");
    expect(disk).not.toContain(sourceRoot);
    expect(JSON.parse(disk)).toEqual(manifest);
    expect(await store("unused").verify(manifest.id)).toBe(true);
  });

  it("does not leave a published manifest when source copy or database publication fails", async () => {
    const missing = {
      path: "missing.html" as RelPath,
      resolved: path.join(sourceRoot, "missing.html") as ResolvedPath,
    };
    await expect(store("backup_missing").create(projectId, "missing", [missing])).rejects.toThrow();
    expect(await exists(backupDirectory(projectId, "backup_missing"))).toBe(false);

    const file = await source("index.html", "hello");
    const missingProject = "project_not_registered" as ProjectId;
    await expect(store("backup_fk_failure").create(missingProject, "fk failure", [file])).rejects.toThrow();
    expect(await exists(backupDirectory(missingProject, "backup_fk_failure"))).toBe(false);
    expect(dbOne(database, "SELECT id FROM backup_manifest WHERE id = ?", "backup_fk_failure")).toBeUndefined();
  });

  it.each([
    ["fsync", {
      async beforeVerify() {},
      async syncDirectory() { throw new Error("injected fsync failure"); },
      async rename() {},
    }],
    ["verify", {
      async beforeVerify(directory: string) {
        await writeFile(path.join(directory, "payload", "index.html"), "tampered before verify");
      },
      async syncDirectory() {},
      async rename() {},
    }],
    ["rename", {
      async beforeVerify() {},
      async syncDirectory() {},
      async rename() { throw new Error("injected rename failure"); },
    }],
  ] as const)("cleans temporary state after an injected %s failure", async (_stage, operations) => {
    const file = await source("index.html", "hello");
    const failed = new AppDataBackupStore(
      root,
      database,
      fixedClock(),
      fixedId(`backup_${_stage}_failure`),
      operations,
    );
    await expect(failed.create(projectId, "injected", [file])).rejects.toThrow();
    const projectDirectory = path.join(root, "backups", encodeURIComponent(projectId));
    expect(await exists(path.join(projectDirectory, `backup_${_stage}_failure`))).toBe(false);
    expect(await exists(path.join(projectDirectory, `.backup_${_stage}_failure.tmp`))).toBe(false);
    expect(dbOne(database, "SELECT id FROM backup_manifest WHERE id = ?", `backup_${_stage}_failure`)).toBeUndefined();
  });

  it("reads verified payloads, detects tampering, and scopes lists by project", async () => {
    const first = await source("index.html", "first");
    const second = await source("src/scene.html", "second");
    const own = await store("backup_own").create(projectId, "own", [first, second]);
    await store("backup_other").create(otherProjectId, "other", [first]);

    const reader = store("unused");
    await expect(reader.read(own.id)).resolves.toEqual(own);
    await expect(reader.readPayloads(own.id)).resolves.toEqual([
      expect.objectContaining({ path: "index.html", bytes: Buffer.from("first") }),
      expect.objectContaining({ path: "src/scene.html", bytes: Buffer.from("second") }),
    ]);
    await expect(reader.list(projectId)).resolves.toEqual([own]);

    await writeFile(path.join(backupDirectory(projectId, own.id), "payload", "index.html"), "tampered");
    await expect(reader.verify(own.id)).resolves.toBe(false);
    await expect(reader.readPayloads(own.id)).rejects.toThrow("integrity");
  });

  it("rejects a tampered immutable manifest even when payload bytes are intact", async () => {
    const file = await source("index.html", "hello");
    const manifest = await store("backup_manifest_tamper").create(projectId, "original", [file]);
    const filename = path.join(backupDirectory(projectId, manifest.id), "manifest.json");
    const disk = JSON.parse(await readFile(filename, "utf8")) as Record<string, unknown>;
    disk.reason = "tampered";
    await writeFile(filename, JSON.stringify(disk));

    await expect(store("unused").read(manifest.id)).resolves.toBeNull();
    await expect(store("unused").verify(manifest.id)).resolves.toBe(false);
  });

  it("prunes only payloads older than the cutoff while retaining metadata and boundary payloads", async () => {
    const file = await source("index.html", "hello");
    const old = await store("backup_old", "2026-06-01T00:00:00.000Z").create(projectId, "old", [file]);
    const boundaryTime = "2026-07-03T00:00:00.000Z";
    const boundary = await store("backup_boundary", boundaryTime).create(projectId, "boundary", [file]);
    const pruner = store("unused", now);

    await expect(pruner.prunePayloads(new Date(boundaryTime))).resolves.toBe(1);
    expect(await exists(path.join(backupDirectory(projectId, old.id), "payload"))).toBe(false);
    expect(await exists(path.join(backupDirectory(projectId, boundary.id), "payload"))).toBe(true);
    await expect(pruner.read(old.id)).resolves.toMatchObject({ id: old.id, payloadPrunedAt: now });
    await expect(pruner.readPayloads(old.id)).resolves.toEqual([]);
    expect(dbOne<{ id: string }>(database, "SELECT id FROM backup_manifest WHERE id = ?", old.id)).toEqual({ id: old.id });
  });

  it("removes unreferenced payload directories only after the 24-hour grace boundary", async () => {
    const file = await source("index.html", "hello");
    const referenced = await store("backup_referenced").create(projectId, "referenced", [file]);
    const projectDirectory = path.join(root, "backups", encodeURIComponent(projectId));
    const old = path.join(projectDirectory, "backup_orphan_old");
    const boundary = path.join(projectDirectory, "backup_orphan_boundary");
    const fresh = path.join(projectDirectory, ".backup_orphan_fresh.tmp");
    await Promise.all([mkdir(old), mkdir(boundary), mkdir(fresh)]);

    const cutoff = new Date("2026-08-01T12:00:00.000Z");
    await utimes(old, new Date(cutoff.getTime() - 1), new Date(cutoff.getTime() - 1));
    await utimes(boundary, cutoff, cutoff);
    await utimes(fresh, new Date(cutoff.getTime() + 1), new Date(cutoff.getTime() + 1));
    await utimes(backupDirectory(projectId, referenced.id), new Date(0), new Date(0));

    await expect(store("unused").cleanupOrphanPayloads(cutoff)).resolves.toBe(1);
    expect(await exists(old)).toBe(false);
    expect(await exists(boundary)).toBe(true);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(backupDirectory(projectId, referenced.id))).toBe(true);
  });
});
