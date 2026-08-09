import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertBuildableTarget,
  buildArtifactReport,
  formatBuildArtifactJson,
  hostPlatformTag,
  parseBuildArtifactArguments,
  planSteps,
  verifierArgumentsWithSeaBuildSeal,
} from "../../scripts/build-artifact.mjs";
import {
  SECONDARY_BUNDLE_PATH,
  runtimeAssetRoot,
  runtimeConfigPath,
  runtimeStageRoot,
} from "../../scripts/artifact-layout.mjs";
import { describe, expect, it } from "vitest";

const HOST_TAG = { darwin: "darwin-arm64", win32: "win32-x64", linux: "linux-x64" }[
  process.platform as "darwin" | "win32" | "linux"
];

describe("build:artifact", () => {
  it("is wired as a script the way the other node scripts are", async () => {
    const manifest = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["build:artifact"]).toBe("node scripts/build-artifact.mjs");
  });

  it("runs the steps in dependency order", () => {
    // Order is not cosmetic: the pack needs the export, the bundle needs the
    // pack, and the SEA needs the bundle.
    expect(planSteps().map((entry) => entry.name)).toEqual([
      "static export (G.6)",
      "frontend pack (H.2)",
      "secondary cjs bundle (H.1)",
      "runtime staging (D.3)",
      "runtime archives (B.3)",
      "SEA bootstrap bundle (H.1)",
      "sea native (H.4)",
      "verify artifact (L.1)",
    ]);
  });

  it.each([["--target"], ["--runtime-inputs"], ["--runtime-inputs", "--json"]])(
    "rejects missing flag values before a build plan exists: %j",
    (...argv) => {
      expect(() => parseBuildArtifactArguments(argv)).toThrow(/requires/u);
    },
  );

  it("passes one concrete host layout through staging, archives, SEA, and verification", () => {
    const inputs = path.resolve("fixtures", "runtime-inputs.json");
    const plan = planSteps({ tag: HOST_TAG, runtimeInputs: inputs });
    const staging = plan.find((entry) => entry.name.startsWith("runtime staging"));
    expect(staging?.args).toEqual([
      "scripts/stage-artifact-runtime.mjs",
      "--inputs", inputs,
      "--boot", SECONDARY_BUNDLE_PATH,
      "--output", runtimeStageRoot(HOST_TAG),
      "--config", runtimeConfigPath(HOST_TAG),
    ]);
    const archives = plan.find((entry) => entry.name.startsWith("runtime archives"));
    expect(archives?.args).toEqual([
      "scripts/build-runtime-archives.mjs",
      "--config", runtimeConfigPath(HOST_TAG),
      "--output", runtimeAssetRoot(HOST_TAG),
    ]);
    expect(plan.find((entry) => entry.name.startsWith("sea native"))?.args).toEqual([
      "scripts/build-sea.mjs", HOST_TAG, "--generation", "plan",
    ]);
    expect(plan.find((entry) => entry.name.startsWith("verify artifact"))?.args).toEqual([
      "scripts/verify-artifact.mjs", HOST_TAG, "--generation", "plan",
    ]);
  });

  it("passes the in-memory SEA byte seal to the verifier without persisting it in the generation", () => {
    const record = JSON.stringify({
      schemaVersion: 1,
      tag: HOST_TAG,
      generationId: "build-generation",
      artifact: { bytes: 10, sha256: `sha256:${"a".repeat(64)}` },
      blob: { bytes: 5, sha256: `sha256:${"b".repeat(64)}` },
      inputs: {
        codePath: ".sea-inputs/main-loader.cjs",
        main: { bytes: 4, sha256: `sha256:${"c".repeat(64)}` },
        assets: [{ key: "asset.bin", bytes: 5, sha256: `sha256:${"d".repeat(64)}` }],
      },
    });
    const args = verifierArgumentsWithSeaBuildSeal(
      ["scripts/verify-artifact.mjs", HOST_TAG, "--generation", "build-generation"],
      record,
      HOST_TAG,
      "build-generation",
    );
    expect(args.slice(0, -2)).toEqual([
      "scripts/verify-artifact.mjs", HOST_TAG, "--generation", "build-generation",
    ]);
    expect(args.at(-2)).toBe("--seal");
    expect(JSON.parse(args.at(-1) ?? "")).toMatchObject({
      schemaVersion: 1,
      tag: HOST_TAG,
      generationId: "build-generation",
    });
    expect(() => verifierArgumentsWithSeaBuildSeal(args, record, HOST_TAG, "other-generation"))
      .toThrow(/does not belong/u);
    expect(() => verifierArgumentsWithSeaBuildSeal(args, record, "foreign-host", "build-generation"))
      .toThrow(/does not belong/u);
  });

  it("runs the pack step under the runtime that can read the resolver", () => {
    // The manifest records the cache policy the host applies at runtime, and
    // the only way to guarantee they agree is to call the same function. That
    // function lives in TypeScript, which Bun runs directly.
    const pack = planSteps().find((entry) => entry.name.startsWith("frontend pack"));
    expect(pack?.command).toBe("bun");
  });

  it("reports the verified provenance rather than only a path and platform", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-build-report-"));
    try {
      const published = path.join(root, "dist", "artifact", HOST_TAG);
      const artifact = path.join(published, process.platform === "win32" ? "vidcom.exe" : "vidcom");
      const provenance = { runtime: { versions: { node: process.version.slice(1) }, archives: {} } };
      await mkdir(path.dirname(artifact), { recursive: true });
      await writeFile(path.join(published, "artifact-manifest.json"), JSON.stringify(provenance));
      expect(buildArtifactReport(artifact)).toEqual(provenance);
      const stdout = formatBuildArtifactJson(artifact);
      expect(stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(stdout)).toEqual(provenance);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts every step with a binary all three platforms can spawn", () => {
    // On Windows `npm` is a `.cmd`, and Node refuses to spawn one without a
    // shell — a step written that way fails there for a reason that has nothing
    // to do with what the step does.
    for (const entry of planSteps()) {
      expect(entry.command, entry.name).not.toBe("npm");
    }
  });

  it("names the checklist task that owns each step", () => {
    // A step that has no owner is a step nobody notices is missing.
    for (const entry of planSteps()) {
      expect(entry.name, entry.name).toMatch(/\([A-Z]\.\d+\)$/u);
    }
  });

  it("accepts the host platform", () => {
    expect(assertBuildableTarget(undefined)).toBe(HOST_TAG);
    expect(assertBuildableTarget(HOST_TAG)).toBe(HOST_TAG);
  });

  it.each([
    ["darwin", "arm64", "darwin-arm64"],
    ["win32", "x64", "win32-x64"],
    ["linux", "x64", "linux-x64"],
  ])("maps only a measured %s-%s host", (platform, architecture, expected) => {
    expect(hostPlatformTag(
      platform as NodeJS.Platform,
      architecture as NodeJS.Architecture,
    )).toBe(expected);
  });

  it.each([
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["win32", "arm64"],
  ])("refuses an unmeasured %s-%s host before staging", (platform, architecture) => {
    expect(() => assertBuildableTarget(
      undefined,
      platform as NodeJS.Platform,
      architecture as NodeJS.Architecture,
    )).toThrow(/unsupported build host/u);
  });

  it("refuses to cross-build", () => {
    // The artifact embeds a Node binary and a native runtime for the machine it
    // was made on; a "Linux build" made on macOS runs nowhere.
    const foreign = HOST_TAG === "linux-x64" ? "win32-x64" : "linux-x64";
    expect(() => assertBuildableTarget(foreign)).toThrow(/cross-building/u);
  });
});
