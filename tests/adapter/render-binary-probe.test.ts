import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeRenderBinaryProbe } from "@vidcom/adapter";
import { ErrorCode, WarningCode } from "@vidcom/contracts";
import type { AbsolutePath } from "@vidcom/core";

const roots: string[] = [];

async function fixture(version = "0.7.86") {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-binary-probe-"));
  roots.push(root);
  const paths = {
    hyperframesCliPath: path.join(root, "hyperframes.mjs") as AbsolutePath,
    hyperframesPackagePath: path.join(root, "package.json") as AbsolutePath,
    browserPath: path.join(root, "chromium") as AbsolutePath,
    ffmpegPath: path.join(root, "ffmpeg") as AbsolutePath,
    ffprobePath: path.join(root, "ffprobe") as AbsolutePath,
  };
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(paths.hyperframesCliPath, "export {};\n"),
    writeFile(paths.hyperframesPackagePath, JSON.stringify({ version })),
    writeFile(paths.browserPath, "binary"),
    writeFile(paths.ffmpegPath, "binary"),
    writeFile(paths.ffprobePath, "binary"),
  ]);
  await Promise.all([
    chmod(paths.browserPath, 0o755),
    chmod(paths.ffmpegPath, 0o755),
    chmod(paths.ffprobePath, 0o755),
  ]);
  return paths;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("NodeRenderBinaryProbe", () => {
  for (const [missingName, key] of [
    ["hyperframes", "hyperframesCliPath"],
    ["chromium", "browserPath"],
    ["ffmpeg", "ffmpegPath"],
    ["ffprobe", "ffprobePath"],
  ] as const) {
    it(`reports exactly ${missingName} when its real path is absent`, async () => {
      const paths = await fixture();
      paths[key] = path.join(path.dirname(paths[key]), `missing-${missingName}`) as AbsolutePath;
      const result = await new NodeRenderBinaryProbe(paths).probe();
      expect(result).toEqual({
        ok: false,
        error: {
          code: ErrorCode.RenderBinaryMissing,
          message: `render binaries are missing: ${missingName}`,
          details: { missing: [missingName] },
        },
      });
    });
  }

  it("returns usable paths and warns on a major/minor version drift", async () => {
    const paths = await fixture("0.8.0");
    const result = await new NodeRenderBinaryProbe(paths).probe();
    expect(result).toMatchObject({
      ok: true,
      value: {
        hyperframesCommand: [process.execPath, paths.hyperframesCliPath],
        browserPath: paths.browserPath,
        ffmpegPath: paths.ffmpegPath,
        ffprobePath: paths.ffprobePath,
        warnings: [{ code: WarningCode.EngineVersionDrift }],
      },
    });
  });
});
