import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";

import {
  AppDataAssetStager,
  CompositionHf,
  initializeDatabase,
  LargePreviousContentStore,
  MutationJournal,
  WorkspaceFs,
  WorkspaceLease,
} from "@vidcom/adapter";
import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import {
  EntryRegistry,
  ProjectIdentityService,
  scanWorkspace,
  WriteAuthority,
  type AbsolutePath,
  type ClockPort,
  type ProjectIdentity,
  type ProjectRef,
} from "@vidcom/core";

import { createSequentialIdPort } from "../support/deterministic";
import { dbRun } from "../support/database";

const roots: string[] = [];
const databases: Array<{ destroy(): Promise<void> }> = [];
const clock: ClockPort = { now: () => new Date("2026-08-04T12:00:00.000Z") };
const digest = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function identity(id: string, extra: Record<string, unknown> = {}): ProjectIdentity & Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: id as ProjectId,
    platform: null,
    render: { defaultPresetId: "horizontal-youtube", outputDirectory: "renders" },
    narration: { defaultProviderId: null, defaultVoiceId: null },
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
    ...extra,
  };
}

const composition = (scene = true) => `<html><body><main data-composition-id="root" data-width="1920" data-height="1080" data-duration="4">${
  scene ? '<section data-composition-id="scene-1" data-start="0" data-duration="4"></section>' : ""
}</main></body></html>`;

describe("workspace scan and project identity on real filesystem", () => {
  it("classifies one level, caches parsing, and revokes invalid entry identity after repair", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-scan-"));
    roots.push(root);
    for (const slug of ["authored", "empty", "broken-id", "broken-composition", "candidate", ".hidden", "node_modules"]) {
      await mkdir(path.join(root, slug), { recursive: true });
    }
    await Promise.all([
      writeFile(path.join(root, "authored", "vidcom.json"), `${JSON.stringify(identity("project_authored"))}\n`),
      writeFile(path.join(root, "authored", "hyperframes.json"), "{}\n"),
      writeFile(path.join(root, "authored", "index.html"), composition()),
      writeFile(path.join(root, "empty", "vidcom.json"), `${JSON.stringify(identity("project_empty"))}\n`),
      writeFile(path.join(root, "broken-id", "vidcom.json"), "{not-json"),
      writeFile(path.join(root, "broken-composition", "vidcom.json"), `${JSON.stringify(identity("project_broken"))}\n`),
      writeFile(path.join(root, "broken-composition", "index.html"), "<html>missing host</html>"),
      writeFile(path.join(root, "candidate", "hyperframes.json"), "{}\n"),
      writeFile(path.join(root, "candidate", "index.html"), composition()),
      writeFile(path.join(root, ".hidden", "vidcom.json"), `${JSON.stringify(identity("project_hidden"))}\n`),
      writeFile(path.join(root, "node_modules", "vidcom.json"), `${JSON.stringify(identity("project_modules"))}\n`),
    ]);
    const workspace = new WorkspaceFs(root as AbsolutePath);
    const parser = new CompositionHf();
    let parseCount = 0;
    const counted = new Proxy(parser, {
      get(target, property, receiver) {
        if (property === "parseProject") return async (...args: Parameters<CompositionHf["parseProject"]>) => {
          parseCount += 1;
          return target.parseProject(...args);
        };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const entries = new EntryRegistry(createSequentialIdPort());
    const identities = new ProjectIdentityService({
      workspace,
      composition: parser,
      clock,
      authority: {} as WriteAuthority,
    });
    const dependencies = { workspace, identity: identities, entries, composition: counted };
    const first = await scanWorkspace(dependencies, root as AbsolutePath);
    expect(first.map((entry) => [entry.slug, entry.kind, "state" in entry ? entry.state : null])).toEqual([
      ["authored", "project", "authored"],
      ["broken-composition", "project", "invalid"],
      ["broken-id", "project", "invalid"],
      ["candidate", "candidate", null],
      ["empty", "project", "empty"],
    ]);
    expect((await workspace.listProjects()).map((project) => project.slug)).not.toContain("candidate");
    const invalid = first.find((entry) => entry.kind === "project" && entry.slug === "broken-id");
    if (!invalid || !("entryId" in invalid)) throw new Error("invalid entry was not returned");
    expect(entries.resolve(invalid.entryId)?.root).toBe(await realpath(path.join(root, "broken-id")));
    const coldParseCount = parseCount;
    await scanWorkspace(dependencies, root as AbsolutePath);
    expect(parseCount).toBe(coldParseCount);

    await writeFile(path.join(root, "broken-id", "vidcom.json"), `${JSON.stringify(identity("project_repaired"))}\n`);
    const repaired = await scanWorkspace(dependencies, root as AbsolutePath);
    expect(repaired.find((entry) => entry.slug === "broken-id")).toMatchObject({ state: "empty", projectId: "project_repaired" });
    expect(entries.resolve(invalid.entryId)).toBeNull();
    entries.clear();
    expect(entries.resolve(invalid.entryId)).toBeNull();
  });

  it("is strict, names unknown fields without values, rejects future schema, and serializes deterministically", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-identity-"));
    roots.push(root);
    const projectRoot = path.join(root, "project");
    await mkdir(projectRoot);
    const workspace = new WorkspaceFs(root as AbsolutePath);
    const service = new ProjectIdentityService({
      workspace,
      composition: new CompositionHf(),
      clock,
      authority: {} as WriteAuthority,
    });
    await writeFile(path.join(projectRoot, "vidcom.json"), `${JSON.stringify(identity("project_identity", { unexpected: "DO_NOT_LEAK" }))}\n`);
    expect(await service.read(projectRoot as AbsolutePath)).toEqual({
      ok: false,
      reason: { code: "identity_parse_error", field: "unexpected" },
    });
    await writeFile(path.join(projectRoot, "vidcom.json"), `${JSON.stringify({ ...identity("project_identity"), schemaVersion: 2 })}\n`);
    expect(await service.read(projectRoot as AbsolutePath)).toEqual({
      ok: false,
      reason: { code: "identity_parse_error", field: "schemaVersion" },
    });
    const value = identity("project_identity");
    expect(service.serialize(value)).toBe(service.serialize(value));
    expect(service.serialize(value)).toMatch(/\n$/u);
  });

  it("lazy-backfills a legacy marker through real journaled WriteAuthority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-backfill-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const projectRoot = path.join(workspaceRoot, "project");
    const appData = path.join(root, "app-data");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "vidcom.json"), '{"id":"project_legacy"}\n');
    await writeFile(path.join(projectRoot, "index.html"), composition(false));
    await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
    const database = await initializeDatabase(appData);
    databases.push(database);
    dbRun(database, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
    "project_legacy", workspaceRoot, "project", clock.now().toISOString(), clock.now().toISOString());
    const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
    const journal = new MutationJournal(database, clock, new LargePreviousContentStore(appData));
    const lease = new WorkspaceLease(database, clock, createSequentialIdPort());
    const acquired = await lease.acquire(workspaceRoot as AbsolutePath, "test:identity-backfill");
    if (!acquired.ok) throw new Error("lease denied");
    const authority = new WriteAuthority({
      workspace,
      journal,
      compositeJournal: journal,
      lease,
      leaseId: acquired.leaseId,
      hashContent: digest,
      stagedAssets: new AppDataAssetStager(appData),
      invalidate() {},
      notifyEvents() {},
    });
    const service = new ProjectIdentityService({ workspace, authority, composition: new CompositionHf(), clock });
    const ref: ProjectRef = {
      id: "project_legacy" as ProjectId,
      slug: "project",
      root: projectRoot as AbsolutePath,
      entry: "index.html" as RelPath,
    };
    const result = await service.backfillPlatform(ref);
    expect(result).toMatchObject({ ok: true, value: { platform: { presetId: "horizontal-youtube" } } });
    expect(JSON.parse(await readFile(path.join(projectRoot, "vidcom.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      id: "project_legacy",
      platform: { width: 1920, height: 1080 },
    });
    expect(await journal.latestSourceRevision(ref.id)).toBe(1);
    const second = await service.backfillPlatform(ref);
    expect(second).toMatchObject({ ok: true });
    expect(await journal.latestSourceRevision(ref.id)).toBe(1);
  });

  it("backfills the three checked-in legacy prototype projects from their real compositions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-prototype-backfill-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const appData = path.join(root, "app-data");
    await mkdir(workspaceRoot, { recursive: true });
    const slugs = ["kinetic-type", "swiss-grid", "warm-grain"] as const;
    for (const slug of slugs) {
      await cp(new URL(`../../projects/${slug}`, import.meta.url), path.join(workspaceRoot, slug), { recursive: true });
    }
    const database = await initializeDatabase(appData);
    databases.push(database);
    const refs: ProjectRef[] = [];
    for (const slug of slugs) {
      const rootPath = path.join(workspaceRoot, slug);
      const marker = JSON.parse(await readFile(path.join(rootPath, "vidcom.json"), "utf8")) as { id: string };
      dbRun(database, `INSERT INTO project_registry
        (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
      marker.id, workspaceRoot, slug, clock.now().toISOString(), clock.now().toISOString());
      refs.push({
        id: marker.id as ProjectId,
        slug,
        root: rootPath as AbsolutePath,
        entry: "index.html" as RelPath,
      });
    }
    const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
    const journal = new MutationJournal(database, clock, new LargePreviousContentStore(appData));
    const lease = new WorkspaceLease(database, clock, createSequentialIdPort());
    const acquired = await lease.acquire(workspaceRoot as AbsolutePath, "test:prototype-backfill");
    if (!acquired.ok) throw new Error("lease denied");
    const authority = new WriteAuthority({
      workspace,
      journal,
      compositeJournal: journal,
      lease,
      leaseId: acquired.leaseId,
      hashContent: digest,
      stagedAssets: new AppDataAssetStager(appData),
      invalidate() {},
      notifyEvents() {},
    });
    const service = new ProjectIdentityService({ workspace, authority, composition: new CompositionHf(), clock });
    for (const ref of refs) {
      const result = await service.backfillPlatform(ref);
      expect(result).toMatchObject({ ok: true, value: { schemaVersion: 1, id: ref.id } });
      expect(result.ok && result.value.platform).not.toBeNull();
      expect(await journal.latestSourceRevision(ref.id)).toBeTypeOf("number");
    }
  }, 15_000);

  it("meets the 100-project cold and warm scan budgets on real files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-scan-perf-"));
    roots.push(root);
    const marker = `${JSON.stringify(identity("placeholder"))}\n`;
    await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      const slug = `project-${String(index).padStart(3, "0")}`;
      const directory = path.join(root, slug);
      await mkdir(directory);
      await Promise.all([
        writeFile(path.join(directory, "vidcom.json"), marker.replace("placeholder", `project_${index}`)),
        writeFile(path.join(directory, "hyperframes.json"), "{}\n"),
        writeFile(path.join(directory, "index.html"), composition()),
      ]);
    }));
    const workspace = new WorkspaceFs(root as AbsolutePath);
    const parser = new CompositionHf();
    const service = new ProjectIdentityService({ workspace, composition: parser, clock, authority: {} as WriteAuthority });
    const dependencies = {
      workspace,
      identity: service,
      entries: new EntryRegistry(createSequentialIdPort()),
      composition: parser,
    };
    const metadataStart = performance.now();
    const directories = await workspace.listWorkspaceDirectories(root as AbsolutePath);
    await Promise.all(directories.flatMap((directory) => [
      workspace.statWorkspaceFile(directory.root, "vidcom.json"),
      workspace.statWorkspaceFile(directory.root, "hyperframes.json"),
      workspace.statWorkspaceFile(directory.root, "index.html"),
    ]));
    const metadataMs = performance.now() - metadataStart;
    const coldStart = performance.now();
    expect(await scanWorkspace(dependencies, root as AbsolutePath)).toHaveLength(100);
    const coldMs = performance.now() - coldStart;
    const warmSamplesMs: number[] = [];
    for (let sample = 0; sample < 3; sample += 1) {
      const warmStart = performance.now();
      expect(await scanWorkspace(dependencies, root as AbsolutePath)).toHaveLength(100);
      warmSamplesMs.push(performance.now() - warmStart);
    }
    const warmP50Ms = [...warmSamplesMs].sort((left, right) => left - right)[1]!;
    expect({ metadataMs, coldMs, warmP50Ms, warmSamplesMs }).toMatchObject({
      metadataMs: expect.any(Number),
      coldMs: expect.any(Number),
      warmP50Ms: expect.any(Number),
      warmSamplesMs: [expect.any(Number), expect.any(Number), expect.any(Number)],
    });
    expect(metadataMs).toBeLessThan(500);
    expect(coldMs).toBeLessThan(2_000);
    expect(warmP50Ms, JSON.stringify({ warmP50Ms, warmSamplesMs })).toBeLessThan(100);
  }, 15_000);
});
