import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ContentHash } from "@vidcom/contracts";
import type { AbsolutePath } from "@vidcom/core";
import { bootstrapProject, WriteAuthority } from "@vidcom/core";
import {
  initializeDatabase,
  MutationJournal,
  projectRegistrationLocationExists,
  WorkspaceFs,
  WorkspaceLease,
} from "@vidcom/adapter";
import { createFixedClock, createSequentialIdPort } from "../support/deterministic";
import { dbAll, dbOne } from "../support/database";

const digest = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

let root: string;
let appData: string;
let workspaceRoot: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;

async function createProject(slug: string, identity?: string, previewSettings?: string) {
  const directory = path.join(workspaceRoot, slug);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "hyperframes.json"), "{}\n");
  await writeFile(path.join(directory, "index.html"), `<main>${slug}</main>\n`);
  if (identity) await writeFile(path.join(directory, "vidcom.json"), identity);
  if (previewSettings) await writeFile(path.join(directory, "preview-settings.json"), previewSettings);
  return directory;
}

async function createRuntime() {
  const clock = createFixedClock("2026-08-01T00:00:00.000Z");
  const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
  const journal = new MutationJournal(database, clock);
  const lease = new WorkspaceLease(database, clock, createSequentialIdPort());
  const acquired = await lease.acquire(workspaceRoot as AbsolutePath, "test:1:boot");
  if (!acquired.ok) throw new Error("test lease was denied");
  const authority = new WriteAuthority({
    workspace,
    journal,
    compositeJournal: journal,
    lease,
    leaseId: acquired.leaseId,
    hashContent: digest,
    invalidate() {},
    notifyEvents() {},
  });
  return { clock, workspace, journal, authority };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-bootstrap-test-"));
  appData = path.join(root, "app-data");
  workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  database = await initializeDatabase(appData);
});

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

describe("bootstrapProject", () => {
  it("assigns a missing ID without touching composition and seeds revision zero", async () => {
    await createProject("alpha");
    const before = await readFile(path.join(workspaceRoot, "alpha/index.html"), "utf8");
    const runtime = await createRuntime();
    const [candidate] = await runtime.workspace.listProjectCandidates();
    const result = await bootstrapProject(
      {
        ...runtime,
        ids: createSequentialIdPort(),
        hashContent: digest,
        registrationLocationExists: projectRegistrationLocationExists,
      },
      candidate,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { identityCreated: true, duplicateReassigned: false, ref: { id: "project_0001" } },
    });
    expect(JSON.parse(await readFile(path.join(workspaceRoot, "alpha/vidcom.json"), "utf8"))).toEqual({
      id: "project_0001",
    });
    expect(await readFile(path.join(workspaceRoot, "alpha/index.html"), "utf8")).toBe(before);
    expect(dbOne(database, "SELECT revision, backing_path FROM entity_state")).toEqual({
      revision: 0,
      backing_path: "preview-settings.json",
    });
    expect(dbOne(database, "SELECT status FROM mutation_journal LIMIT 1")).toEqual({
      status: "committed",
    });
  });

  it("is idempotent and preserves identity when the project directory moves", async () => {
    await createProject("alpha", '{"id":"project_stable"}\n');
    const runtime = await createRuntime();
    let [candidate] = await runtime.workspace.listProjectCandidates();
    const deps = {
      ...runtime,
      ids: createSequentialIdPort(),
      hashContent: digest,
      registrationLocationExists: projectRegistrationLocationExists,
    };
    await expect(bootstrapProject(deps, candidate)).resolves.toMatchObject({
      ok: true,
      value: { identityCreated: false, duplicateReassigned: false, ref: { id: "project_stable" } },
    });
    await rename(path.join(workspaceRoot, "alpha"), path.join(workspaceRoot, "moved"));
    [candidate] = await runtime.workspace.listProjectCandidates();
    await expect(bootstrapProject(deps, candidate)).resolves.toMatchObject({
      ok: true,
      value: { ref: { id: "project_stable", slug: "moved" }, duplicateReassigned: false },
    });
    expect(dbAll(database, "SELECT id, slug FROM project_registry")).toEqual([
      { id: "project_stable", slug: "moved" },
    ]);
    expect(dbAll(database, "SELECT * FROM revision")).toEqual([]);
  });

  it("reassigns the project opened later when two live directories share an ID", async () => {
    await createProject("alpha", '{"id":"project_copied"}\n');
    await createProject("beta", '{"id":"project_copied"}\n', '{"bgm":{"volume":0.4}}\n');
    const runtime = await createRuntime();
    const [alpha, beta] = await runtime.workspace.listProjectCandidates();
    const deps = {
      ...runtime,
      ids: createSequentialIdPort(),
      hashContent: digest,
      registrationLocationExists: projectRegistrationLocationExists,
    };
    await bootstrapProject(deps, alpha);
    await expect(bootstrapProject(deps, beta)).resolves.toMatchObject({
      ok: true,
      value: {
        identityCreated: false,
        duplicateReassigned: true,
        ref: { id: "project_0001", slug: "beta" },
      },
    });
    expect(JSON.parse(await readFile(path.join(workspaceRoot, "alpha/vidcom.json"), "utf8"))).toEqual({
      id: "project_copied",
    });
    expect(JSON.parse(await readFile(path.join(workspaceRoot, "beta/vidcom.json"), "utf8"))).toEqual({
      id: "project_0001",
    });
    expect(dbAll(database, "SELECT id, slug FROM project_registry ORDER BY slug")).toEqual([
      { id: "project_copied", slug: "alpha" },
      { id: "project_0001", slug: "beta" },
    ]);
    expect(dbAll(database, "SELECT project_id, revision FROM entity_state ORDER BY project_id")).toEqual([
      { project_id: "project_0001", revision: 1 },
      { project_id: "project_copied", revision: 0 },
    ]);
    expect(dbOne(database, "SELECT action, detail FROM audit_entry WHERE action = ?", "project.id.reassigned")).toEqual({
      action: "project.id.reassigned",
      detail: JSON.stringify({ duplicateFrom: "project_copied" }),
    });
  });
});
