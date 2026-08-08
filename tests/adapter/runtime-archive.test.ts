import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  extractRuntimeArchive,
  parseEmbeddedRuntimeManifest,
  resolveRuntimeArchives,
  RuntimeAssetError,
  type EmbeddedArchive,
} from "@vidcom/adapter";
import { ErrorCode } from "@vidcom/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  archiveFor,
  digest,
  HOST_SUPPORTED,
  HOST_TAG,
  runtimeManifest,
  tarball,
  type TarEntry,
} from "../support/runtime-fixture";

const ENTRY_PATH = "runtime.txt";
const SCRIPT_PATH = "bin/run.sh";
const SCRIPT_MODE = 0o755;
const BODY = Buffer.from("vidcom runtime fixture\n", "utf8");
const SCRIPT_BODY = Buffer.from("#!/bin/sh\nexit 0\n", "utf8");
const OTHER_TAG = HOST_TAG === "linux-x64" ? "win32-x64" : "linux-x64";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(".");
const builderScript = path.join(repositoryRoot, "scripts", "build-runtime-archives.mjs");

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-runtime-archive-")));
  roots.push(root);
  return root;
}

function goodArchive(key = "node"): { bytes: Buffer; archive: EmbeddedArchive } {
  return archiveFor(key, [
    { path: ENTRY_PATH, content: BODY },
    { path: SCRIPT_PATH, content: SCRIPT_BODY, mode: SCRIPT_MODE },
  ]);
}

function manifestValue(mutate: (value: Record<string, unknown>) => void): unknown {
  const value = JSON.parse(JSON.stringify(runtimeManifest("1.0.0", [goodArchive().archive]))) as
    Record<string, unknown>;
  mutate(value);
  return value;
}

function rejection(value: unknown): RuntimeAssetError {
  expect(value).toBeInstanceOf(RuntimeAssetError);
  return value as RuntimeAssetError;
}

function parseFailure(value: unknown): RuntimeAssetError {
  try {
    parseEmbeddedRuntimeManifest(value);
  } catch (error) {
    return rejection(error);
  }
  throw new Error("expected the manifest parser to reject this value");
}

/** Extracts into a fresh, still-absent destination and returns the thrown error. */
async function extractionFailure(
  bytes: Buffer,
  archive: EmbeddedArchive,
): Promise<{ error: RuntimeAssetError; destination: string }> {
  const destination = path.join(await temporaryRoot(), "target");
  try {
    await extractRuntimeArchive({ bytes: Uint8Array.from(bytes), archive, destination });
  } catch (error) {
    return { error: rejection(error), destination };
  }
  throw new Error("expected the extractor to reject this archive");
}

async function absent(pathname: string): Promise<boolean> {
  return lstat(pathname).then(() => false, () => true);
}

describe.skipIf(!HOST_SUPPORTED)("embedded runtime manifest parsing", () => {
  it("accepts the canonical manifest and freezes its projection", () => {
    const manifest = parseEmbeddedRuntimeManifest(
      JSON.parse(JSON.stringify(runtimeManifest("1.0.0", [goodArchive().archive]))),
    );
    expect(manifest.artifactVersion).toBe("1.0.0");
    expect(manifest.archives).toHaveLength(1);
    expect(manifest.archives[0]?.entries.map((entry) => entry.path)).toEqual([ENTRY_PATH, SCRIPT_PATH]);
    expect(Object.isFrozen(manifest)).toBe(true);
  });

  it.each([
    ["an unexpected top-level key", (value: Record<string, unknown>) => { value.extra = 1; }],
    ["an unsupported schema version", (value: Record<string, unknown>) => { value.schemaVersion = 2; }],
    ["an artifact version colliding with current.json", (value: Record<string, unknown>) => {
      value.artifactVersion = "current.json";
    }],
    ["an artifact version that is not a path segment", (value: Record<string, unknown>) => {
      value.artifactVersion = "1.0.0/nested";
    }],
    ["no archives at all", (value: Record<string, unknown>) => { value.archives = []; }],
    ["an archive key colliding with the installed manifest", (value: Record<string, unknown>) => {
      (value.archives as Array<Record<string, unknown>>)[0]!.key = "runtime-manifest.json";
    }],
    ["a duplicate archive key", (value: Record<string, unknown>) => {
      const archives = value.archives as Array<Record<string, unknown>>;
      archives.push({ ...archives[0]! });
    }],
    ["an entry inside the ready-marker namespace", (value: Record<string, unknown>) => {
      const archive = (value.archives as Array<Record<string, unknown>>)[0]!;
      (archive.entries as Array<Record<string, unknown>>)[0]!.path = ".ready-payload";
    }],
    ["an entry escaping its archive root", (value: Record<string, unknown>) => {
      const archive = (value.archives as Array<Record<string, unknown>>)[0]!;
      (archive.entries as Array<Record<string, unknown>>)[0]!.path = "../escape.txt";
    }],
    ["a non-canonical entry hash", (value: Record<string, unknown>) => {
      const archive = (value.archives as Array<Record<string, unknown>>)[0]!;
      (archive.entries as Array<Record<string, unknown>>)[0]!.sha256 = "sha256:not-a-hash";
    }],
    ["an unsupported archive platform", (value: Record<string, unknown>) => {
      (value.archives as Array<Record<string, unknown>>)[0]!.platform = "sunos-sparc";
    }],
    ["python packages that are not exact pins", (value: Record<string, unknown>) => {
      (value.pythonPackages as Record<string, string[]>)[HOST_TAG] = ["certifi>=2024.2.2"];
    }],
    ["python packages that are unsorted", (value: Record<string, unknown>) => {
      (value.pythonPackages as Record<string, string[]>)[HOST_TAG] = ["zstandard==0.22.0", "certifi==2024.2.2"];
    }],
    ["an empty python package set", (value: Record<string, unknown>) => {
      (value.pythonPackages as Record<string, string[]>)[HOST_TAG] = [];
    }],
  ])("rejects %s", (_label, mutate) => {
    const error = parseFailure(manifestValue(mutate));
    expect(error.code).toBe(ErrorCode.RuntimeManifestInvalid);
  });
});

describe.skipIf(!HOST_SUPPORTED)("runtime archive resolution", () => {
  it("returns only the archives belonging to the host platform", () => {
    const host = archiveFor("node", [{ path: ENTRY_PATH, content: BODY }]).archive;
    const foreign = archiveFor("ffmpeg", [{ path: ENTRY_PATH, content: BODY }], OTHER_TAG).archive;
    const manifest = runtimeManifest("1.0.0", [host, foreign]);

    const resolved = resolveRuntimeArchives(manifest, process.platform, process.arch);
    expect(resolved.map((archive) => archive.key)).toEqual(["node"]);
  });

  it("names the requested and supported platforms when the host has no archive", () => {
    const foreign = archiveFor("node", [{ path: ENTRY_PATH, content: BODY }], OTHER_TAG).archive;
    const manifest = runtimeManifest("1.0.0", [foreign]);

    let error: RuntimeAssetError | undefined;
    try {
      resolveRuntimeArchives(manifest, "aix", "ppc64");
    } catch (caught) {
      error = rejection(caught);
    }
    expect(error?.code).toBe(ErrorCode.RuntimeManifestInvalid);
    expect(error?.message).toContain("aix-ppc64");
    expect(error?.message).toContain(OTHER_TAG);
    expect(error?.details).toMatchObject({ requested: "aix-ppc64", supported: [OTHER_TAG] });
  });
});

describe.skipIf(!HOST_SUPPORTED)("runtime archive extraction on a real filesystem", () => {
  it("extracts a verified archive and applies the manifest modes", async () => {
    const { bytes, archive } = goodArchive();
    const destination = path.join(await temporaryRoot(), "target");

    const result = await extractRuntimeArchive({ bytes: Uint8Array.from(bytes), archive, destination });
    expect(result.files).toBe(2);
    expect(result.bytes).toBe(BODY.byteLength + SCRIPT_BODY.byteLength);
    expect((await lstat(destination)).mode & 0o777).toBe(0o700);
    if (process.platform !== "win32") {
      expect((await lstat(path.join(destination, SCRIPT_PATH))).mode & 0o777).toBe(SCRIPT_MODE);
    }
  });

  it.each<[string, readonly TarEntry[], string]>([
    ["an absolute path", [{ path: "/etc/passwd", content: BODY }], "unsafe path"],
    ["a traversal path", [{ path: "../escape.txt", content: BODY }], "unsafe path"],
    ["a symlink", [{ path: ENTRY_PATH, type: "symlink", linkname: "/etc/passwd" }], "link or special file"],
    ["a hardlink", [{ path: ENTRY_PATH, type: "hardlink", linkname: "runtime.txt" }], "link or special file"],
    ["a character device", [{ path: ENTRY_PATH, type: "character-device" }], "link or special file"],
    [
      "a file absent from the manifest",
      [
        { path: ENTRY_PATH, content: BODY },
        { path: SCRIPT_PATH, content: SCRIPT_BODY, mode: SCRIPT_MODE },
        { path: "stowaway.txt", content: BODY },
      ],
      "absent from the manifest",
    ],
  ])("rejects %s and leaves no destination", async (_label, entries, fragment) => {
    const bytes = tarball(entries);
    const archive: EmbeddedArchive = {
      ...goodArchive().archive,
      sha256: digest(bytes),
      bytes: bytes.byteLength,
    };

    const { error, destination } = await extractionFailure(bytes, archive);
    expect(error.code).toBe(ErrorCode.RuntimeManifestInvalid);
    expect(error.message).toContain(fragment);
    expect(await absent(destination)).toBe(true);
  });

  it("rejects an archive whose checksum does not match the manifest", async () => {
    const { bytes, archive } = goodArchive();
    const { error, destination } = await extractionFailure(bytes, {
      ...archive,
      sha256: digest(Buffer.from("other", "utf8")),
    });
    expect(error.code).toBe(ErrorCode.RuntimeManifestInvalid);
    expect(error.message).toContain("checksum");
    expect(await absent(destination)).toBe(true);
  });

  it("rejects an archive whose byte length does not match the manifest", async () => {
    const { bytes, archive } = goodArchive();
    const { error, destination } = await extractionFailure(bytes, {
      ...archive,
      bytes: archive.bytes + 1,
    });
    expect(error.code).toBe(ErrorCode.RuntimeManifestInvalid);
    expect(error.message).toContain("byte length");
    expect(await absent(destination)).toBe(true);
  });

  it("rejects an archive missing a declared entry", async () => {
    const partial = tarball([{ path: ENTRY_PATH, content: BODY }]);
    const { error, destination } = await extractionFailure(partial, {
      ...goodArchive().archive,
      sha256: digest(partial),
      bytes: partial.byteLength,
    });
    expect(error.code).toBe(ErrorCode.RuntimeManifestInvalid);
    expect(error.details).toMatchObject({ missing: [SCRIPT_PATH] });
    expect(await absent(destination)).toBe(true);
  });

  it("rejects a written file whose content hash drifts from the manifest", async () => {
    const drifted = tarball([
      { path: ENTRY_PATH, content: Buffer.from("drifted\n", "utf8") },
      { path: SCRIPT_PATH, content: SCRIPT_BODY, mode: SCRIPT_MODE },
    ]);
    const { error, destination } = await extractionFailure(drifted, {
      ...goodArchive().archive,
      sha256: digest(drifted),
      bytes: drifted.byteLength,
    });
    expect(error.code).toBe(ErrorCode.RuntimeExtractionIncomplete);
    expect(error.details).toMatchObject({ path: ENTRY_PATH });
    expect(await absent(destination)).toBe(true);
  });
});

/** Reads the measured evidence through the builder's own loader, not a copy of it. */
async function expectedPins(): Promise<readonly string[]> {
  const { stdout } = await execFileAsync(process.execPath, [
    "-e",
    "import('./scripts/build-runtime-archives.mjs')"
    + ".then((module) => module.loadExpectedPythonPackages())"
    + ".then((expected) => process.stdout.write(JSON.stringify(expected)))",
  ], { cwd: repositoryRoot });
  return (JSON.parse(stdout) as Record<string, readonly string[]>)[HOST_TAG] ?? [];
}

async function builderProject(pins: readonly string[]): Promise<{ config: string; output: string }> {
  const root = await temporaryRoot();
  const source = path.join(root, "src");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, ENTRY_PATH), BODY);
  await writeFile(path.join(root, "packages.txt"), `${pins.join("\n")}\n`, "utf8");

  const config = path.join(root, "runtime-archives.json");
  await writeFile(config, `${JSON.stringify({
    artifactVersion: "1.0.0",
    versions: {
      node: "24.9.0",
      hyperframes: "1.0.0",
      esbuild: "0.25.0",
      ffmpeg: "7.1",
      cpython: "3.12.7",
      vieneu: "1.0.0",
      motion: {
        animejs: "3.2.2",
        gsap: "3.12.5",
        "lottie-web": "5.12.2",
        motion: "11.0.0",
        three: "0.164.0",
      },
    },
    pythonPackages: { [HOST_TAG]: "./packages.txt" },
    archives: [{ key: "node", platform: HOST_TAG, source: "./src", target: "runtime" }],
  }, null, 2)}\n`, "utf8");
  return { config, output: path.join(root, "out") };
}

function runBuilder(project: { config: string; output: string }): Promise<{ stdout: string }> {
  return execFileAsync(process.execPath, [
    builderScript,
    "--config",
    project.config,
    "--output",
    project.output,
  ], { cwd: repositoryRoot });
}

describe.skipIf(!HOST_SUPPORTED)("runtime archive builder python package gate", () => {
  it("builds when the shipped package set matches the measured evidence exactly", async () => {
    const project = await builderProject(await expectedPins());
    await runBuilder(project);

    const manifest = JSON.parse(
      await readFile(path.join(project.output, "runtime-manifest.json"), "utf8"),
    ) as { archives: Array<{ key: string }>; pythonPackages: Record<string, string[]> };
    expect(manifest.archives.map((archive) => archive.key)).toEqual(["node"]);
    expect(manifest.pythonPackages[HOST_TAG]).toHaveLength(55);
  });

  it.each([
    ["one package is missing", (pins: string[]) => pins.slice(0, -1)],
    ["one package is extra", (pins: string[]) => [...pins, "zzz-stowaway==1.0.0"]],
    ["one version drifts", (pins: string[]) => [...pins.slice(0, -1), `${pins.at(-1)!.split("==")[0]}==0.0.0`]],
    ["pip is shipped", (pins: string[]) => [...pins, "pip==24.0"]],
  ])("fails the build when %s", async (_label, mutate) => {
    const project = await builderProject(mutate([...await expectedPins()]));
    const failure = await runBuilder(project).catch((error: unknown) => error as { stderr: string });
    expect(failure).toHaveProperty("stderr");
    expect((failure as { stderr: string }).stderr).toMatch(/Python package set mismatch|pip must not be present/u);
    expect(await absent(path.join(project.output, "runtime-manifest.json"))).toBe(true);
  });
});
