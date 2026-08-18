import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FsRenderProjectAdapter,
  FsRenderRootAdapter,
  HyperframesThumbnailRenderer,
} from "@vidcom/adapter";
import { type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  ok,
  type AbsolutePath,
  type ProcessRunInput,
  type ProcessSupervisorPort,
  type ProjectRef,
  type RuntimeAssetGuardPort,
  type ThumbnailKey,
} from "@vidcom/core";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const profile = {
  width: 160,
  height: 90,
  fps: 30,
  runtimeDigest: "runtime:a",
  rendererVersion: "renderer:v1",
};
const keys: ThumbnailKey[] = [0.5, 1.5].map((atSeconds) => ({
  sceneId: "scene-a",
  fingerprint: `sha256:${"a".repeat(64)}` as ContentHash,
  atSeconds,
  profile,
}));

async function fixture(process: ProcessSupervisorPort) {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-thumbnail-renderer-"));
  roots.push(root);
  const projectRoot = path.join(root, "project");
  const stagingRoot = path.join(root, "app-data", "render-roots");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "index.html"), "<!doctype html><html><head></head><body></body></html>");
  const ref: ProjectRef = {
    id: "project_thumbnail_renderer" as ProjectId,
    slug: "thumbnail-renderer",
    root: projectRoot as AbsolutePath,
    entry: "index.html" as RelPath,
  };
  const guard: RuntimeAssetGuardPort = {
    async open() { return { csp: "default-src 'self'", bootstrapScript: "", token: "token" }; },
    async close() { return { mediaViolations: [], externalDependencies: [] }; },
  };
  const renderer = new HyperframesThumbnailRenderer({
    process,
    roots: new FsRenderRootAdapter({
      stagingRoot: stagingRoot as AbsolutePath,
      ffmpegPath: "/runtime/ffmpeg" as AbsolutePath,
      ffprobePath: "/runtime/ffprobe" as AbsolutePath,
      clock: { now: () => new Date("2026-08-19T00:00:00.000Z") },
    }),
    renderProjects: new FsRenderProjectAdapter(),
    binaries: {
      async probe() {
        return ok({
          hyperframesCommand: ["/runtime/node", "/runtime/hyperframes.mjs"],
          browserPath: "/runtime/chrome" as AbsolutePath,
          ffmpegPath: "/runtime/ffmpeg" as AbsolutePath,
          ffprobePath: "/runtime/ffprobe" as AbsolutePath,
          warnings: [],
        });
      },
    },
    guard,
    ids: { newId: () => "thumbnail-test" },
    runtimeSource: () => "globalThis.__runtime = true;",
    injectGuard: (document) => document,
    buildDocument: async () => `<!doctype html><html><head></head><body><main data-composition-id="main" data-start="0" data-duration="12" data-width="1920" data-height="1080" data-fps="30"><section data-composition-id="scene-a" data-start="6" data-duration="2"></section><section data-composition-id="scene-b" data-start="8" data-duration="2"></section></main></body></html>`,
  });
  return { renderer, ref, projectRoot, stagingRoot };
}

describe("HyperframesThumbnailRenderer", () => {
  it("runs one local-time snapshot batch and one resolved FFmpeg sequence conversion", async () => {
    const calls: ProcessRunInput[] = [];
    let stagedDocument = "";
    const process: ProcessSupervisorPort = {
      async run(input) {
        calls.push(input);
        if (calls.length === 1) {
          stagedDocument = await readFile(path.join(input.cwd!, "index.html"), "utf8");
          const output = input.command[input.command.indexOf("--output") + 1]!;
          const marks = input.command[input.command.indexOf("--at") + 1]!.split(",");
          await Promise.all(marks.map((mark, index) => writeFile(
            path.join(output, `frame-${String(index).padStart(2, "0")}-at-${Number(Number(mark).toFixed(3))}s.png`),
            new Uint8Array([index + 1]),
          )));
        } else {
          const outputPattern = input.command.at(-1)!;
          await Promise.all(keys.map((_key, index) => writeFile(
            outputPattern.replace("%03d", String(index).padStart(3, "0")),
            new Uint8Array([82, 73, 70, 70, index]),
          )));
        }
        return { status: "exited", output: { exitCode: 0, stdout: "", stderr: "", timedOut: false } };
      },
    };
    const { renderer, ref, projectRoot, stagingRoot } = await fixture(process);
    const signal = new AbortController().signal;

    const rendered = await renderer.renderBatch(ref, keys, signal);

    expect(rendered).toHaveLength(2);
    expect(rendered.every((item) => item.result.ok)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.command).toContain("snapshot");
    expect(calls[0]!.command).toContain("0.5,1.5");
    expect(calls[1]!.command[0]).toBe("/runtime/ffmpeg");
    expect(calls.every((call) => call.signal === signal)).toBe(true);
    expect(stagedDocument).toContain('data-composition-id="scene-a" data-start="0"');
    expect(stagedDocument).not.toContain('data-composition-id="scene-b"');
    await expect(access(path.join(projectRoot, "snapshots"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(stagingRoot, "thumbnail-test"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates abort through the snapshot process, skips FFmpeg and releases staging", async () => {
    const calls: ProcessRunInput[] = [];
    const controller = new AbortController();
    const process: ProcessSupervisorPort = {
      async run(input) {
        calls.push(input);
        controller.abort();
        return {
          status: "terminated",
          proof: { reason: "abort", rootPid: 1, capturedPids: [1], capturedGroups: [], survivors: [], sweeps: 1, exhaustive: true },
          warnings: [],
        };
      },
    };
    const { renderer, ref, stagingRoot } = await fixture(process);

    await expect(renderer.renderBatch(ref, keys, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(1);
    await expect(access(path.join(stagingRoot, "thumbnail-test"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
