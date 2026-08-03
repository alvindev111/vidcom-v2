import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import { reconcilePendingMutations, type AbsolutePath, type ProjectRef } from "@vidcom/core";
import { initializeDatabase, MutationJournal, WorkspaceFs } from "@vidcom/adapter";
import { createFixedClock } from "../support/deterministic";
import { dbAll, dbOne, dbRun } from "../support/database";

type Database = Awaited<ReturnType<typeof initializeDatabase>>;
type CrashStage = "after-journal" | "mid-write" | "after-rename" | "mid-commit";

const projectId = "project_recovery" as ProjectId;
const oldContent = "old content";
const newContent = "new content";
const digest = (content: string): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

let root: string;
let appData: string;
let workspaceRoot: string;
let projectRoot: string;
let database: Database | null;
let ref: ProjectRef;

function crashProgram(stage: CrashStage): string {
  const databasePath = path.join(appData, "vidcom.sqlite");
  const target = path.join(projectRoot, "index.html");
  const temporary = path.join(projectRoot, ".index.html.crash.tmp");
  const now = "2026-08-01T00:00:00.000Z";
  return `
    import { DatabaseSync } from "node:sqlite";
    import { openSync, closeSync, fsyncSync, renameSync, writeFileSync } from "node:fs";
    const db = new DatabaseSync(${JSON.stringify(databasePath)});
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
    db.prepare(\`INSERT INTO mutation_journal
      (project_id, kind, path, entity, from_hash, previous_content, previous_byte_size, to_hash, actor, created_at, settled_at)
      VALUES (?, 'file', 'index.html', NULL, ?, ?, ?, ?, 'user', ?, NULL)\`)
      .run(${JSON.stringify(projectId)}, ${JSON.stringify(digest(oldContent))},
        new TextEncoder().encode(${JSON.stringify(oldContent)}), ${oldContent.length},
        ${JSON.stringify(digest(newContent))}, ${JSON.stringify(now)});
    const stage = ${JSON.stringify(stage)};
    if (stage !== "after-journal") {
      writeFileSync(${JSON.stringify(temporary)}, ${JSON.stringify(newContent)});
      // "r+" not "r": Windows refuses FlushFileBuffers on a read-only handle.
      const fd = openSync(${JSON.stringify(temporary)}, "r+"); fsyncSync(fd); closeSync(fd);
    }
    if (stage === "after-rename" || stage === "mid-commit") {
      renameSync(${JSON.stringify(temporary)}, ${JSON.stringify(target)});
    }
    if (stage === "mid-commit") {
      db.exec("BEGIN IMMEDIATE");
      const revision = db.prepare(\`INSERT INTO revision
        (project_id, kind, path, entity, content_hash, parent_revision, actor, summary, created_at)
        VALUES (?, 'file', 'index.html', NULL, ?, NULL, 'user', NULL, ?)\`)
        .run(${JSON.stringify(projectId)}, ${JSON.stringify(digest(newContent))}, ${JSON.stringify(now)}).lastInsertRowid;
      db.prepare("INSERT INTO revision_blob (revision_id, previous_content, byte_size) VALUES (?, ?, ?)")
        .run(revision, new TextEncoder().encode(${JSON.stringify(oldContent)}), ${oldContent.length});
      db.prepare("UPDATE mutation_journal SET status = 'committed', settled_at = ? WHERE status = 'pending'")
        .run(${JSON.stringify(now)});
    }
    process.stdout.write("READY\\n");
    await new Promise(() => {});
  `;
}

async function killAt(stage: CrashStage): Promise<void> {
  const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "--eval", crashProgram(stage)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child did not reach ${stage}`)), 5_000);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      if (code !== null) {
        clearTimeout(timeout);
        reject(new Error(`child exited ${code}: ${stderr}`));
      }
    });
    child.stdout.once("data", () => { clearTimeout(timeout); resolve(); });
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

async function reconcile() {
  database = await initializeDatabase(appData);
  const journal = new MutationJournal(database, createFixedClock("2026-08-01T00:01:00.000Z"));
  const report = await reconcilePendingMutations({
    workspace: new WorkspaceFs(workspaceRoot as AbsolutePath),
    journal,
    async resolveProjectRef() { return ref; },
  });
  return { journal, report };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-journal-recovery-"));
  appData = path.join(root, "app-data");
  workspaceRoot = path.join(root, "workspace");
  projectRoot = path.join(workspaceRoot, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
  await writeFile(path.join(projectRoot, "vidcom.json"), JSON.stringify({ id: projectId }));
  await writeFile(path.join(projectRoot, "index.html"), oldContent);
  ref = {
    id: projectId,
    slug: "project",
    root: projectRoot as AbsolutePath,
    entry: "index.html" as RelPath,
  };
  database = await initializeDatabase(appData);
  const now = "2026-08-01T00:00:00.000Z";
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  projectId, workspaceRoot, "project", now, now);
  await database.destroy();
  database = null;
});

afterEach(async () => {
  await database?.destroy();
  await rm(root, { recursive: true, force: true });
});

describe("journal crash recovery", () => {
  it.each(["after-journal", "mid-write"] as const)("aborts when killed at %s before rename", async (stage) => {
    await killAt(stage);
    const { report } = await reconcile();
    expect(report).toMatchObject({ aborted: [1], recovered: [], orphaned: [] });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe(oldContent);
    expect(dbOne(database!, "SELECT status FROM mutation_journal LIMIT 1")).toEqual({
      status: "aborted",
    });
  });

  it.each(["after-rename", "mid-commit"] as const)("recovers when killed at %s after rename", async (stage) => {
    await killAt(stage);
    const { report } = await reconcile();
    expect(report).toMatchObject({ aborted: [], recovered: [1], orphaned: [] });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe(newContent);
    expect(dbOne(database!, "SELECT status FROM mutation_journal LIMIT 1")).toEqual({
      status: "recovered",
    });
    expect(dbAll(database!, "SELECT * FROM revision")).toHaveLength(1);
    expect(dbOne(database!, "SELECT byte_size FROM revision_blob LIMIT 1")).toEqual({
      byte_size: oldContent.length,
    });
  });

  it("surfaces orphaned when another writer changes a renamed file before restart", async () => {
    await killAt("after-rename");
    const thirdContent = "third-party content";
    await writeFile(path.join(projectRoot, "index.html"), thirdContent);
    const { report } = await reconcile();
    expect(report).toMatchObject({ aborted: [], recovered: [], orphaned: [1] });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe(thirdContent);
    expect(dbOne(database!, "SELECT action, detail FROM audit_entry LIMIT 1")).toEqual({
      action: "mutation.orphaned",
      detail: JSON.stringify({
        fromHash: digest(oldContent),
        toHash: digest(newContent),
        actualHash: digest(thirdContent),
      }),
    });
  });
});
