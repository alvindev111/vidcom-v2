import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CompositionHf,
  FsRenderProjectAdapter,
  FsRenderRootAdapter,
  HyperframesCompositionDependencyGraph,
  HyperframesThumbnailRenderer,
  LargePreviousContentStore,
  MutationJournal,
  NodeProcessSupervisor,
  ThumbnailCacheAdapter,
  WorkspaceFs,
  initializeDatabase,
} from "@vidcom/adapter";
import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  ThumbnailBatchScheduler,
  ThumbnailService,
  sampleTimelineThumbnailTimes,
  type AbsolutePath,
  type ProcessRunInput,
  type ProcessSupervisorPort,
  type ProjectRef,
  type RuntimeAssetGuardPort,
  type SupervisedProcessResult,
} from "@vidcom/core";

import { removeTree } from "../support/platform";

const roots: string[] = [];
const databases: Array<{ destroy(): Promise<void> }> = [];
const FFMPEG_SENTINEL = path.join(path.sep, "runtime", "ffmpeg-sentinel");
const hashContent = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

afterEach(async () => {
  // Windows refuses to unlink an open SQLite file, so every database opened by a
  // case is closed here even when its assertions threw.
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
  await Promise.all(roots.splice(0).map((root) => removeTree(root)));
});

const SNAPSHOT_SCRIPT = `import { writeFile } from "node:fs/promises";
import path from "node:path";
const argv = process.argv.slice(2);
const mode = argv[0];
const marker = argv[1];
const marks = (argv[argv.indexOf("--at") + 1] ?? "").split(",").filter(Boolean);
const output = argv[argv.indexOf("--output") + 1];
await writeFile(marker, String(process.pid), "utf8");
if (mode === "fail") {
  process.stderr.write("injected snapshot failure\\n");
  process.exit(3);
}
if (mode === "hang") {
  setInterval(() => {}, 1_000);
} else {
  await Promise.all(marks.map((value, index) => writeFile(
    path.join(output, \`frame-\${String(index).padStart(2, "0")}-at-\${Number(Number(value).toFixed(3))}s.png\`),
    Buffer.from([137, 80, 78, 71, index]),
  )));
}
`;

const FFMPEG_SCRIPT = `import { writeFile } from "node:fs/promises";
const argv = process.argv.slice(2);
const frames = Number(argv[argv.indexOf("-frames:v") + 1]);
const pattern = argv[argv.length - 1];
for (let index = 0; index < frames; index += 1) {
  await writeFile(
    pattern.replace("%03d", String(index).padStart(3, "0")),
    Buffer.from([82, 73, 70, 70, index, 87, 69, 66, 80]),
  );
}
`;

/** Real supervised children; only the probed FFmpeg binary is redirected to a portable stand-in. */
class RecordingProcessAdapter implements ProcessSupervisorPort {
  readonly calls: ProcessRunInput[] = [];
  readonly results: SupervisedProcessResult[] = [];
  private readonly supervisor = new NodeProcessSupervisor(30_000);

  constructor(private readonly ffmpegScript: string) {}

  async run(input: ProcessRunInput): Promise<SupervisedProcessResult> {
    this.calls.push(input);
    const command = input.command[0] === FFMPEG_SENTINEL
      ? [process.execPath, this.ffmpegScript, ...input.command.slice(1)]
      : input.command;
    const result = await this.supervisor.run({ ...input, command });
    this.results.push(result);
    return result;
  }
}

const guard: RuntimeAssetGuardPort = {
  async open() { return { csp: "default-src 'self'", bootstrapScript: "", token: "token" }; },
  async close() { return { mediaViolations: [], externalDependencies: [] }; },
};

async function treeDigest(root: string, prefix = ""): Promise<string[]> {
  const rows: string[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const absolute = path.join(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) rows.push(`${relative}/`, ...await treeDigest(absolute, relative));
    else rows.push(`${relative}:${hashContent(await readFile(absolute))}`);
  }
  return rows;
}

async function fixture(options: { mode: "ok" | "fail" | "hang"; runtimeDigest?: string } = { mode: "ok" }) {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-thumbnail-pipeline-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const appDataRoot = path.join(root, "app-data");
  const scriptRoot = path.join(root, "bin");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(scriptRoot, { recursive: true });
  const snapshotScript = path.join(scriptRoot, "fake-snapshot.mjs");
  const ffmpegScript = path.join(scriptRoot, "fake-ffmpeg.mjs");
  const marker = path.join(scriptRoot, "child.pid");
  await writeFile(snapshotScript, SNAPSHOT_SCRIPT, "utf8");
  await writeFile(ffmpegScript, FFMPEG_SCRIPT, "utf8");

  const projects: Record<string, ProjectRef> = {};
  for (const slug of ["alpha", "beta"]) {
    const projectRoot = path.join(workspaceRoot, slug);
    await mkdir(path.join(projectRoot, "scenes"), { recursive: true });
    await writeFile(
      path.join(projectRoot, "index.html"),
      `<!doctype html><html><head><title>${slug}</title></head><body>`
      + `<main data-composition-id="main" data-start="0" data-duration="8"`
      + ` data-width="1920" data-height="1080" data-fps="30">`
      + `<section data-composition-id="scene-a" data-composition-src="scenes/a.html"`
      + ` data-start="6" data-duration="2"></section>`
      + `</main></body></html>\n`,
      "utf8",
    );
    await writeFile(
      path.join(projectRoot, "scenes", "a.html"),
      `<template><section data-composition-id="scene-a">`
      + `<link rel="stylesheet" href="../styles/a.css"><p>${slug}</p></section></template>\n`,
      "utf8",
    );
    projects[slug] = {
      id: `project_${slug}` as ProjectId,
      slug,
      root: projectRoot as AbsolutePath,
      entry: "index.html" as RelPath,
    };
  }

  const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
  const composition = new CompositionHf();
  const processes = new RecordingProcessAdapter(ffmpegScript);
  const dependencies = new HyperframesCompositionDependencyGraph();
  const service = new ThumbnailService({
    workspace,
    composition,
    dependencies,
    hashContent,
    runtimeDigest: options.runtimeDigest ?? hashContent("runtime-source"),
    rendererVersion: "0.7.86",
  });
  const cache = new ThumbnailCacheAdapter(appDataRoot);
  let job = 0;
  const renderer = new HyperframesThumbnailRenderer({
    process: processes,
    roots: new FsRenderRootAdapter({
      stagingRoot: path.join(appDataRoot, "render-roots") as AbsolutePath,
      ffmpegPath: FFMPEG_SENTINEL as AbsolutePath,
      ffprobePath: FFMPEG_SENTINEL as AbsolutePath,
      clock: { now: () => new Date("2026-08-19T00:00:00.000Z") },
    }),
    renderProjects: new FsRenderProjectAdapter(),
    binaries: {
      async probe() {
        return {
          ok: true,
          value: {
            hyperframesCommand: [process.execPath, snapshotScript, options.mode, marker],
            browserPath: process.execPath as AbsolutePath,
            ffmpegPath: FFMPEG_SENTINEL as AbsolutePath,
            ffprobePath: FFMPEG_SENTINEL as AbsolutePath,
            warnings: [],
          },
        };
      },
    },
    guard,
    ids: { newId: () => `thumbnail-${(job += 1)}` },
    runtimeSource: () => "globalThis.__runtime = true;",
    injectGuard: (document) => document,
    buildDocument: (ref) => composition.buildDocument(ref, DEFAULT_PREVIEW_SETTINGS, {
      mode: "render",
      root: true,
      runtimeUrl: "./.vidcom-runtime.js",
      fileBaseUrl: "./",
    }),
  });
  const scheduler = new ThumbnailBatchScheduler(service, renderer, { cache });
  const cacheRoot = path.join(appDataRoot, "cache", "thumbnails");
  const namespace = (projectId: ProjectId) =>
    path.join(cacheRoot, createHash("sha256").update(projectId).digest("hex"));
  return {
    appDataRoot,
    cache,
    cacheRoot,
    dependencies,
    marker,
    namespace,
    processes,
    projects,
    scheduler,
    service,
    stagingRoot: path.join(appDataRoot, "render-roots"),
    workspace,
    async cachedFiles(): Promise<string[]> {
      const files: string[] = [];
      for (const entry of await readdir(cacheRoot, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue;
        for (const file of await readdir(path.join(cacheRoot, entry.name))) {
          files.push(`${entry.name}/${file}`);
        }
      }
      return files.sort();
    },
  };
}

const request = (atSeconds: readonly number[]) => ({
  sceneId: "scene-a",
  atSeconds,
  profile: "timeline-v1" as const,
});

describe("thumbnail renderer, cache and scheduler over real temp projects", () => {
  it("renders one snapshot and one WebP conversion per batch without touching either project", async () => {
    const harness = await fixture();
    const marks = sampleTimelineThumbnailTimes(2, 2, 30);
    expect(marks).toEqual([0.5, 1.5]);
    const database = await initializeDatabase(harness.appDataRoot);
    databases.push(database);
    const journal = new MutationJournal(
      database,
      { now: () => new Date("2026-08-19T00:00:00.000Z") },
      new LargePreviousContentStore(harness.appDataRoot),
    );
    const before = {
      alpha: await treeDigest(harness.projects.alpha!.root),
      beta: await treeDigest(harness.projects.beta!.root),
      revision: await journal.latestSourceRevision(harness.projects.alpha!.id),
    };

    const alpha = await harness.scheduler.request(
      harness.projects.alpha!,
      request(marks),
      new AbortController().signal,
    );

    expect(alpha.map((item) => item.result.ok)).toEqual([true, true]);
    expect(alpha.map((item) => item.key.atSeconds)).toEqual(marks);
    expect(alpha.every((item) => item.result.ok
      && item.result.value[0] === 0x52 && item.result.value[1] === 0x49)).toBe(true);
    expect(harness.processes.calls).toHaveLength(2);
    const [snapshot, conversion] = harness.processes.calls;
    expect(snapshot!.command).toContain("snapshot");
    expect(snapshot!.command[snapshot!.command.indexOf("--at") + 1]).toBe("0.5,1.5");
    expect(snapshot!.command.join(" ")).not.toContain("6.5");
    expect(conversion!.command[0]).toBe(FFMPEG_SENTINEL);
    expect(conversion!.command[conversion!.command.indexOf("-c:v") + 1]).toBe("libwebp");
    expect(conversion!.command[conversion!.command.indexOf("-vf") + 1]).toBe("scale=160:90");
    expect(conversion!.command.at(-1)!.endsWith(".webp")).toBe(true);
    expect(harness.processes.results.every((result) => result.status === "exited")).toBe(true);

    const beta = await harness.scheduler.request(
      harness.projects.beta!,
      request(marks),
      new AbortController().signal,
    );

    expect(beta.map((item) => item.result.ok)).toEqual([true, true]);
    expect(beta[0]!.key.fingerprint).not.toBe(alpha[0]!.key.fingerprint);
    expect(harness.processes.calls).toHaveLength(4);
    expect(await readdir(harness.namespace(harness.projects.alpha!.id))).toHaveLength(2);
    expect(await readdir(harness.namespace(harness.projects.beta!.id))).toHaveLength(2);

    expect(await treeDigest(harness.projects.alpha!.root)).toEqual(before.alpha);
    expect(await treeDigest(harness.projects.beta!.root)).toEqual(before.beta);
    expect(await journal.latestSourceRevision(harness.projects.alpha!.id)).toBe(before.revision);
    await expect(access(path.join(harness.projects.alpha!.root, "snapshots")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(harness.stagingRoot)).resolves.toEqual([]);
  });

  it("serves the cache without a process and misses when a dependency appears or runtime identity changes", async () => {
    const harness = await fixture();
    const marks = sampleTimelineThumbnailTimes(2, 2, 30);
    const first = await harness.scheduler.request(
      harness.projects.alpha!,
      request(marks),
      new AbortController().signal,
    );
    expect(harness.processes.calls).toHaveLength(2);

    const cached = await harness.scheduler.request(
      harness.projects.alpha!,
      request(marks),
      new AbortController().signal,
    );
    expect(cached.map((item) => item.result.ok)).toEqual([true, true]);
    expect(harness.processes.calls).toHaveLength(2);
    expect(await harness.cachedFiles()).toHaveLength(2);

    await mkdir(path.join(harness.projects.alpha!.root, "styles"), { recursive: true });
    await writeFile(path.join(harness.projects.alpha!.root, "styles", "a.css"), ".hero { color: red }\n", "utf8");
    harness.dependencies.invalidate(harness.projects.alpha!.id, ["styles/a.css" as RelPath]);
    const present = await harness.scheduler.request(
      harness.projects.alpha!,
      request(marks),
      new AbortController().signal,
    );
    expect(present[0]!.key.fingerprint).not.toBe(first[0]!.key.fingerprint);
    expect(harness.processes.calls).toHaveLength(4);
    expect(await harness.cachedFiles()).toHaveLength(4);

    const renamedRuntime = new ThumbnailService({
      workspace: harness.workspace,
      composition: new CompositionHf(),
      dependencies: new HyperframesCompositionDependencyGraph(),
      hashContent,
      runtimeDigest: hashContent("another-runtime-source"),
      rendererVersion: "0.7.86",
    });
    const replanned = await renamedRuntime.plan(harness.projects.alpha!, request(marks));
    expect(replanned.ok).toBe(true);
    if (!replanned.ok) return;
    expect(replanned.value.fingerprint).not.toBe(present[0]!.key.fingerprint);
    expect(await harness.cache.get(harness.projects.alpha!.id, renamedRuntime.renderKey(replanned.value.keys[0]!)))
      .toBeNull();
  });

  it("kills the real snapshot child on abort and publishes nothing", async () => {
    const harness = await fixture({ mode: "hang" });
    const controller = new AbortController();
    const pending = harness.scheduler.request(
      harness.projects.alpha!,
      request(sampleTimelineThumbnailTimes(2, 2, 30)),
      controller.signal,
    );
    const childPid = await (async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const value = await readFile(harness.marker, "utf8").catch(() => "");
        if (value) return Number(value);
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("the supervised snapshot child never started");
    })();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.processes.results).toHaveLength(1);
    const [terminated] = harness.processes.results;
    expect(terminated!.status).toBe("terminated");
    if (terminated!.status === "terminated") {
      expect(terminated!.proof).toMatchObject({ reason: "abort", exhaustive: true, survivors: [] });
      expect(terminated!.proof.capturedPids).toContain(childPid);
    }
    expect(harness.processes.calls).toHaveLength(1);
    expect(await harness.cachedFiles()).toEqual([]);
    await expect(readdir(harness.stagingRoot)).resolves.toEqual([]);
  });

  it("turns an injected snapshot failure into placeholders and publishes nothing", async () => {
    const harness = await fixture({ mode: "fail" });

    const results = await harness.scheduler.request(
      harness.projects.alpha!,
      request(sampleTimelineThumbnailTimes(2, 2, 30)),
      new AbortController().signal,
    );

    expect(results).toHaveLength(2);
    expect(results.every((item) => !item.result.ok
      && item.result.error.code === ErrorCode.Internal)).toBe(true);
    expect(harness.processes.calls).toHaveLength(1);
    expect(await harness.cachedFiles()).toEqual([]);
    await expect(readdir(harness.stagingRoot)).resolves.toEqual([]);
  });
});
