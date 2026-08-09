import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { PRODUCT_MIGRATION_PATHS } from "../../scripts/artifact-runtime-contract.mjs";
import {
  assertExactPythonPackages,
  assertNoDarwinRuntimeSearchPaths,
  assertPortableDarwinDependencies,
  commitRuntimeGeneration,
  copyContainedTree,
  commandLine,
  esbuildPlatformBinaryRelative,
  hostPlatformTag,
  materializedTreeSha256,
  nativePackageNamesFor,
  parseRuntimeInputsValue,
  privateProbeEnvironment,
  probeStagedNativeClosure,
  prunePythonBuildTools,
  recoverRuntimeGeneration,
  resolveNativePackageRoots,
  resolvePackageDirectory,
  stageNativeClosure,
  stageArtifactRuntime,
} from "../../scripts/stage-artifact-runtime.mjs";

const roots: string[] = [];
const HOST_TAG = hostPlatformTag();
const SUFFIX = process.platform === "win32" ? ".exe" : "";
const MOTION_LIBRARIES = [
  { packageName: "animejs", version: "4.5.0", files: [{ packagePath: "dist/bundles/anime.umd.min.js" }] },
  { packageName: "gsap", version: "3.15.0", files: [{ packagePath: "dist/gsap.min.js" }] },
  { packageName: "lottie-web", version: "5.13.0", files: [{ packagePath: "build/player/lottie.min.js" }] },
  { packageName: "motion", version: "12.43.0", files: [{ packagePath: "dist/motion.js" }] },
  {
    packageName: "three",
    version: "0.185.1",
    files: [{ packagePath: "build/three.module.min.js" }, { packagePath: "build/three.core.min.js" }],
  },
] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "vidcom-runtime-stage-")));
  roots.push(root);
  return root;
}

async function executableCopy(destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(process.execPath, destination);
  await chmod(destination, 0o755);
}

async function sha256Pin(filename: string): Promise<string> {
  return `sha256:${createHash("sha256").update(await readFile(filename)).digest("hex")}`;
}

async function packageFixture(
  root: string,
  packageName: string,
  version: string,
  files: readonly string[] = [],
): Promise<string> {
  const packageRoot = path.join(root, packageName.replaceAll("/", "__"));
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: packageName, version })}\n`,
    "utf8",
  );
  for (const filename of files) {
    const target = path.join(packageRoot, ...filename.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    const content = filename.endsWith(".mjs")
      ? "export {};\n"
      : /\.(?:cjs|js)$/u.test(filename)
        ? "module.exports = {};\n"
        : `${packageName}:${filename}\n`;
    await writeFile(target, content, "utf8");
  }
  return packageRoot;
}

interface Fixture {
  root: string;
  paths: { inputsFile: string; bootFile: string; outputRoot: string; configFile: string };
  nativePackageRoots: Map<string, string>;
  motionPackageRoots: Map<string, string>;
  hyperframesRoot: string;
  drizzleRoot: string;
  pythonRoot: string;
  vieneuWorker: string;
  ffmpegPath: string;
  ffprobePath: string;
}

async function fixture(): Promise<Fixture> {
  const root = await temporaryRoot();
  const inputsRoot = path.join(root, "release-inputs");
  const ffmpegPath = path.join(inputsRoot, `ffmpeg${SUFFIX}`);
  const ffprobePath = path.join(inputsRoot, `ffprobe${SUFFIX}`);
  await executableCopy(ffmpegPath);
  await executableCopy(ffprobePath);

  const pythonRoot = path.join(inputsRoot, "python");
  const pythonPath = process.platform === "win32"
    ? path.join(pythonRoot, "python.exe")
    : path.join(pythonRoot, "bin", "python3.12");
  await executableCopy(pythonPath);
  const runtimePython = process.platform === "win32"
    ? pythonPath
    : path.join(pythonRoot, "bin", "python3");
  if (runtimePython !== pythonPath) await symlink(path.basename(pythonPath), runtimePython);
  await mkdir(path.join(pythonRoot, "lib", "python3.12", "ensurepip"), { recursive: true });
  await writeFile(path.join(pythonRoot, "lib", "python3.12", "ensurepip", "__init__.py"), "# build only\n");
  await mkdir(path.join(pythonRoot, "lib", "python3.12", "site-packages", "pip-26.2.dist-info"), { recursive: true });
  await writeFile(path.join(pythonRoot, "lib", "python3.12", "site-packages", "pip-26.2.dist-info", "METADATA"), "pip\n");
  await writeFile(path.join(pythonRoot, process.platform === "win32" ? "pip.exe" : "bin/pip"), "build only\n");

  const vieneuRoot = path.join(inputsRoot, "vieneu");
  const vieneuWorker = path.join(vieneuRoot, "worker.py");
  await mkdir(vieneuRoot, { recursive: true });
  await writeFile(vieneuWorker, "# frozen worker fixture\n", "utf8");

  const bootFile = path.join(root, "secondary", "boot.cjs");
  await mkdir(path.dirname(bootFile), { recursive: true });
  await writeFile(bootFile, "exports.runBootstrappedCli = async () => 0;\n", "utf8");

  const hyperframesRoot = path.join(root, "packages", "hyperframes");
  await mkdir(path.join(hyperframesRoot, "bin"), { recursive: true });
  await mkdir(path.join(hyperframesRoot, "dist"), { recursive: true });
  await writeFile(
    path.join(hyperframesRoot, "package.json"),
    `${JSON.stringify({ name: "hyperframes", version: "0.7.86" })}\n`,
    "utf8",
  );
  await writeFile(path.join(hyperframesRoot, "bin", "hyperframes.mjs"), "export {};\n", "utf8");
  const runtime = Buffer.from("globalThis.__hyperframesFixture = true;\n");
  await writeFile(path.join(hyperframesRoot, "dist", "hyperframe.runtime.iife.js"), runtime);
  await writeFile(
    path.join(hyperframesRoot, "dist", "hyperframe.manifest.json"),
    `${JSON.stringify({ sha256: createHash("sha256").update(runtime).digest("hex") })}\n`,
    "utf8",
  );

  const motionPackageRoots = new Map<string, string>();
  for (const library of MOTION_LIBRARIES) {
    motionPackageRoots.set(library.packageName, await packageFixture(
      path.join(root, "motion-packages"),
      library.packageName,
      library.version,
      library.files.map(({ packagePath }) => packagePath),
    ));
  }

  const nativePackageRoots = new Map<string, string>();
  for (const packageName of nativePackageNamesFor(HOST_TAG)) {
    const version = packageName === "esbuild" || packageName.startsWith("@esbuild/")
      ? "0.25.12"
      : "1.0.0";
    const files = packageName.startsWith("@esbuild/")
      ? [esbuildPlatformBinaryRelative(HOST_TAG)]
      : ["index.js"];
    const packageRoot = await packageFixture(path.join(root, "native-packages"), packageName, version, files);
    if (packageName.startsWith("@esbuild/")) {
      await executableCopy(path.join(packageRoot, esbuildPlatformBinaryRelative(HOST_TAG)));
    }
    nativePackageRoots.set(packageName, packageRoot);
  }

  const drizzleRoot = path.join(root, "drizzle");
  for (const runtimePath of PRODUCT_MIGRATION_PATHS) {
    const relative = runtimePath.replace(/^drizzle\//u, "");
    const migration = path.join(drizzleRoot, ...relative.split("/"));
    await mkdir(path.dirname(migration), { recursive: true });
    await writeFile(migration, `-- ${relative}\nSELECT 1;\n`, "utf8");
    await writeFile(path.join(path.dirname(migration), "snapshot.json"), "{}\n", "utf8");
  }
  await mkdir(path.join(drizzleRoot, "20990101000000_injected"), { recursive: true });
  await writeFile(
    path.join(drizzleRoot, "20990101000000_injected", "migration.sql"),
    "SELECT 'must not ship';\n",
  );

  const pythonTreeSha256 = await materializedTreeSha256(pythonRoot) as string;
  const pythonProjection = path.join(root, "python-runtime-projection");
  await copyContainedTree(pythonRoot, pythonProjection);
  await prunePythonBuildTools(pythonProjection);
  const projectedRuntimePython = process.platform === "win32"
    ? path.join(pythonProjection, "python.exe")
    : path.join(pythonProjection, "bin", "python3");
  await chmod(projectedRuntimePython, 0o755);
  const pythonRuntimeTreeSha256 = await materializedTreeSha256(pythonProjection) as string;
  await rm(pythonProjection, { recursive: true });
  const pythonPackagesPath = path.join(inputsRoot, `${HOST_TAG}-python-packages.txt`);
  await writeFile(pythonPackagesPath, "demo==1.0\nvieneu==3.2.4\n", "utf8");

  const inputsFile = path.join(root, "runtime-inputs.json");
  await writeFile(inputsFile, `${JSON.stringify({
    schemaVersion: 1,
    artifactVersion: "test-runtime-1",
    platform: HOST_TAG,
    ffmpegPath,
    ffmpegVersion: "8.0.1",
    ffmpegSha256: await sha256Pin(ffmpegPath),
    ffprobePath,
    ffprobeVersion: "8.0.1",
    ffprobeSha256: await sha256Pin(ffprobePath),
    pythonRoot,
    pythonPath,
    cpythonVersion: "3.12.13+20260805",
    pythonSha256: await sha256Pin(pythonPath),
    pythonTreeSha256,
    pythonRuntimeTreeSha256,
    pythonPackagesPath,
    pythonPackagesSha256: await sha256Pin(pythonPackagesPath),
    vieneuRoot,
    vieneuWorkerSha256: await sha256Pin(vieneuWorker),
  }, null, 2)}\n`, "utf8");
  const outputRoot = path.join(root, "runtime-stage");
  return {
    root,
    paths: {
      inputsFile,
      bootFile,
      outputRoot,
      configFile: path.join(outputRoot, ".build", "runtime-config.json"),
    },
    nativePackageRoots,
    motionPackageRoots,
    hyperframesRoot,
    drizzleRoot,
    pythonRoot,
    vieneuWorker,
    ffmpegPath,
    ffprobePath,
  };
}

async function mutateInputs(
  input: Fixture,
  mutate: (value: Record<string, string | number>) => void | Promise<void>,
): Promise<void> {
  const parsed = JSON.parse(await readFile(input.paths.inputsFile, "utf8")) as Record<string, string | number>;
  await mutate(parsed);
  await writeFile(input.paths.inputsFile, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

async function writePriorGeneration(input: Fixture): Promise<void> {
  await mkdir(path.join(input.paths.outputRoot, ".build"), { recursive: true });
  await writeFile(path.join(input.paths.outputRoot, "prior.txt"), "prior stage\n");
  await writeFile(input.paths.configFile, "prior config\n");
  await writeFile(path.join(input.paths.outputRoot, ".build", "python-packages.txt"), "prior pins\n");
}

async function expectPriorGeneration(input: Fixture): Promise<void> {
  expect(await readFile(path.join(input.paths.outputRoot, "prior.txt"), "utf8")).toBe("prior stage\n");
  expect(await readFile(input.paths.configFile, "utf8")).toBe("prior config\n");
  expect(await readFile(path.join(input.paths.outputRoot, ".build", "python-packages.txt"), "utf8"))
    .toBe("prior pins\n");
}

async function writeTransactionGeneration(root: string, label: string): Promise<void> {
  await mkdir(path.join(root, ".build"), { recursive: true });
  await mkdir(path.join(root, "node"), { recursive: true });
  await mkdir(path.join(root, "hyperframes"), { recursive: true });
  await writeFile(path.join(root, ".build", "runtime-config.json"), `${label} config\n`);
  await writeFile(path.join(root, ".build", "python-packages.txt"), `${label} pins\n`);
  await writeFile(path.join(root, "node", "payload.txt"), `${label} node\n`);
  await writeFile(path.join(root, "hyperframes", "payload.txt"), `${label} hyperframes\n`);
}

async function regularFiles(root: string, relativeRoot = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await regularFiles(absolute, relative));
    else files.push(relative);
  }
  return files.sort();
}

function stageOptions(input: Fixture, packages = ["demo==1.0", "vieneu==3.2.4"]) {
  return {
    hostTag: HOST_TAG,
    requiredNodeVersion: process.versions.node,
    expectedPythonPackages: ["demo==1.0", "vieneu==3.2.4"],
    nativePackageRoots: input.nativePackageRoots,
    motionLibraries: MOTION_LIBRARIES,
    motionPackageRoots: input.motionPackageRoots,
    hyperframesRoot: input.hyperframesRoot,
    drizzleRoot: input.drizzleRoot,
    bundleHyperframes: async (_entry: string, outfile: string) => {
      await writeFile(outfile, "export const staged = true;\n", "utf8");
    },
    probeRuntime: async (paths: Record<string, string>) => {
      for (const executable of Object.values(paths)) {
        const child = spawnSync(executable, ["--version"], { encoding: "utf8", shell: false });
        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
      }
      return {
        ffmpeg: "8.0.1",
        ffprobe: "8.0.1",
        esbuild: "0.25.12",
        cpython: "3.12.13",
        vieneu: "3.2.4",
        pythonPackages: packages,
      };
    },
  };
}

describe("artifact runtime staging", () => {
  it("requires every release authority path explicitly", async () => {
    const root = await temporaryRoot();
    const required = ["--inputs", "a", "--boot", "b", "--output", "c", "--config", "d"];
    expect(() => commandLine(required)).toThrow(/absolute normalized/u);
    expect(() => commandLine(required.slice(0, -2))).toThrow(/usage/u);
    expect(() => parseRuntimeInputsValue({})).toThrow(/unexpected keys/u);
    const digest = `sha256:${"0".repeat(64)}`;
    expect(() => parseRuntimeInputsValue({
      schemaVersion: 1,
      artifactVersion: "v1",
      platform: HOST_TAG,
      ffmpegPath: path.join(root, "ffmpeg"),
      ffmpegVersion: "8.0.1",
      ffmpegSha256: digest,
      ffprobePath: path.join(root, "ffprobe"),
      ffprobeVersion: "8.0.1",
      ffprobeSha256: digest,
      pythonRoot: path.join(root, "python"),
      pythonPath: path.join(root, "python", "python"),
      cpythonVersion: "3.12.13+20260805",
      pythonSha256: digest,
      pythonTreeSha256: digest,
      pythonRuntimeTreeSha256: digest,
      pythonPackagesPath: path.join(root, "python-packages.txt"),
      pythonPackagesSha256: digest,
      vieneuRoot: path.join(root, "vieneu"),
      vieneuWorkerSha256: digest,
    })).not.toThrow();
  });

  it("pins the exact native closure for all three supported hosts", () => {
    expect(nativePackageNamesFor("darwin-arm64")).toEqual(expect.arrayContaining([
      "sharp",
      "onnxruntime-node",
      "onnxruntime-common",
      "@img/sharp-darwin-arm64",
      "@img/sharp-libvips-darwin-arm64",
      "@esbuild/darwin-arm64",
    ]));
    expect(nativePackageNamesFor("linux-x64")).toContain("@img/sharp-libvips-linux-x64");
    expect(nativePackageNamesFor("win32-x64")).toContain("@img/sharp-win32-x64");
    expect((nativePackageNamesFor("win32-x64") as string[])
      .some((name: string) => name.includes("libvips"))).toBe(false);
  });

  it("resolves optional packages from the owning HyperFrames package store", async () => {
    const manifest = await realpath(path.resolve("node_modules/hyperframes/package.json"));
    const resolver = createRequire(manifest);
    expect(await resolvePackageDirectory("sharp", resolver)).toContain("sharp@");
    const roots = await resolveNativePackageRoots(path.dirname(manifest), HOST_TAG) as Map<string, string>;
    for (const packageName of nativePackageNamesFor(HOST_TAG) as string[]) {
      const packageRoot = roots.get(packageName)!;
      const parsed = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as { name: string };
      expect(parsed.name).toBe(packageName);
    }
  });

  it("rejects every non-system Darwin dylib and every LC_RPATH", () => {
    expect(() => assertPortableDarwinDependencies([
      "/tmp/ffmpeg:",
      "\t/opt/homebrew/opt/libx264/lib/libx264.dylib (compatibility version 1.0.0)",
    ].join("\n"), "FFmpeg")).toThrow(/non-portable/u);
    expect(() => assertPortableDarwinDependencies([
      "/tmp/ffmpeg:",
      "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)",
      "\t@rpath/libavcodec.dylib (compatibility version 1.0.0)",
    ].join("\n"), "FFmpeg")).toThrow(/non-portable/u);
    expect(() => assertNoDarwinRuntimeSearchPaths([
      "Load command 9",
      "          cmd LC_RPATH",
      "      cmdsize 40",
      "         path /opt/homebrew/lib (offset 12)",
    ].join("\n"), "FFmpeg")).toThrow(/no dylib closure/u);
  });

  it("removes Python build tooling and bytecode from a real tree", async () => {
    const root = await temporaryRoot();
    const paths = [
      "bin/pip",
      "bin/cffi-gen-src",
      "bin/python3.12-config",
      "Scripts/huggingface-cli.exe",
      "lib/python3.12/site-packages/demo-1.0.dist-info/RECORD",
      "lib/python3.12/ensurepip/__init__.py",
      "lib/python3.12/site-packages/pip/__init__.py",
      "lib/python3.12/site-packages/pip-26.2.dist-info/METADATA",
      "lib/python3.12/site-packages/demo/__pycache__/demo.pyc",
    ];
    for (const filename of paths) {
      const target = path.join(root, filename);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "build only\n");
    }
    await writeFile(path.join(root, "bin", "python3"), "runtime interpreter\n");
    const metadata = path.join(root, "lib", "python3.12", "site-packages", "demo-1.0.dist-info", "METADATA");
    await writeFile(metadata, "Name: demo\nVersion: 1.0\n");
    await prunePythonBuildTools(root);
    for (const filename of paths) expect(existsSync(path.join(root, filename)), filename).toBe(false);
    expect(await readFile(path.join(root, "bin", "python3"), "utf8")).toBe("runtime interpreter\n");
    expect(await readFile(metadata, "utf8")).toContain("Version: 1.0");
  });

  it("stages two deterministic archive roots through real filesystem and child processes", async () => {
    const input = await fixture();
    const esbuildPackageName = nativePackageNamesFor(HOST_TAG)
      .find((packageName: string) => packageName.startsWith("@esbuild/"));
    const esbuildPackage = input.nativePackageRoots.get(esbuildPackageName!);
    const esbuildInput = path.join(esbuildPackage!, esbuildPlatformBinaryRelative(HOST_TAG));
    await link(esbuildInput, path.join(input.root, `package-cache-esbuild${SUFFIX}`));
    expect((await lstat(esbuildInput)).nlink).toBeGreaterThan(1);
    const hyperframesInput = path.join(input.hyperframesRoot, "bin", "hyperframes.mjs");
    await link(hyperframesInput, path.join(input.root, "package-cache-hyperframes.mjs"));
    expect((await lstat(hyperframesInput)).nlink).toBeGreaterThan(1);
    const hyperframesManifestInput = path.join(input.hyperframesRoot, "dist", "hyperframe.manifest.json");
    await link(hyperframesManifestInput, path.join(input.root, "package-cache-hyperframe-manifest.json"));
    expect((await lstat(hyperframesManifestInput)).nlink).toBeGreaterThan(1);
    const hyperframesRuntimeInput = path.join(input.hyperframesRoot, "dist", "hyperframe.runtime.iife.js");
    await link(hyperframesRuntimeInput, path.join(input.root, "package-cache-hyperframe-runtime.js"));
    expect((await lstat(hyperframesRuntimeInput)).nlink).toBeGreaterThan(1);
    const gsap = MOTION_LIBRARIES.find(({ packageName }) => packageName === "gsap")!;
    const gsapInput = path.join(input.motionPackageRoots.get(gsap.packageName)!, gsap.files[0].packagePath);
    await link(gsapInput, path.join(input.root, "package-cache-gsap.js"));
    expect((await lstat(gsapInput)).nlink).toBeGreaterThan(1);
    const result = await stageArtifactRuntime(input.paths, stageOptions(input));

    expect(await readFile(path.join(input.paths.outputRoot, "node", "cli", "boot.cjs"), "utf8"))
      .toContain("runBootstrappedCli");
    expect(await readFile(path.join(input.paths.outputRoot, "node", "vieneu", "worker.py"), "utf8"))
      .toBe("# frozen worker fixture\n");
    for (const runtimePath of PRODUCT_MIGRATION_PATHS) {
      expect(existsSync(path.join(input.paths.outputRoot, "node", runtimePath)), runtimePath).toBe(true);
      expect(existsSync(path.join(input.paths.outputRoot, "node", path.dirname(runtimePath), "snapshot.json")))
        .toBe(false);
    }
    expect(existsSync(path.join(
      input.paths.outputRoot,
      "node",
      "drizzle",
      "20990101000000_injected",
      "migration.sql",
    ))).toBe(false);
    const stagedEsbuild = path.join(input.paths.outputRoot, "node", "bin", `esbuild${SUFFIX}`);
    expect(existsSync(stagedEsbuild)).toBe(true);
    expect((await lstat(stagedEsbuild)).nlink).toBe(1);
    expect(existsSync(path.join(input.paths.outputRoot, "node", "python", "lib", "python3.12", "ensurepip"))).toBe(false);
    expect(existsSync(path.join(input.paths.outputRoot, "node", "python", "bin", "pip"))).toBe(false);
    const runtimePython = process.platform === "win32"
      ? path.join(input.paths.outputRoot, "node", "python", "python.exe")
      : path.join(input.paths.outputRoot, "node", "python", "bin", "python3");
    expect((await lstat(runtimePython)).isFile()).toBe(true);
    expect((await lstat(runtimePython)).isSymbolicLink()).toBe(false);

    for (const packageName of nativePackageNamesFor(HOST_TAG)) {
      for (const archive of ["node", "hyperframes"]) {
        expect(existsSync(path.join(
          input.paths.outputRoot,
          archive,
          "node_modules",
          ...packageName.split("/"),
          "package.json",
        )), `${archive}:${packageName}`).toBe(true);
      }
    }
    const stagedHyperframes = path.join(input.paths.outputRoot, "hyperframes", "bin", "hyperframes.mjs");
    expect(existsSync(stagedHyperframes)).toBe(true);
    expect((await lstat(stagedHyperframes)).nlink).toBe(1);
    const stagedHyperframesManifest = path.join(input.paths.outputRoot, "hyperframes", "bin", "hyperframe.manifest.json");
    const stagedHyperframesRuntime = path.join(input.paths.outputRoot, "hyperframes", "bin", "hyperframe.runtime.iife.js");
    expect((await lstat(stagedHyperframesManifest)).nlink).toBe(1);
    expect((await lstat(stagedHyperframesRuntime)).nlink).toBe(1);
    for (const library of MOTION_LIBRARIES) {
      for (const file of library.files) {
        const stagedMotionAsset = path.join(
          input.paths.outputRoot,
          "hyperframes",
          "motion-libraries",
          library.packageName,
          ...file.packagePath.split("/"),
        );
        expect(existsSync(stagedMotionAsset)).toBe(true);
        expect((await lstat(stagedMotionAsset)).nlink).toBe(1);
      }
    }

    const config = JSON.parse(await readFile(input.paths.configFile, "utf8")) as typeof result.config;
    expect(config).toEqual(result.config);
    expect(config.archives).toEqual([
      expect.objectContaining({ key: "hyperframes", target: "hyperframes" }),
      expect.objectContaining({ key: "node", target: "native" }),
    ]);
    expect(config.pythonPackages).toEqual({ [HOST_TAG]: result.pinsFile });
    expect(await readFile(result.pinsFile, "utf8")).toBe("demo==1.0\nvieneu==3.2.4\n");
    expect((await readdir(path.join(input.paths.outputRoot, ".build"))).sort())
      .toEqual(["python-packages.txt", "runtime-config.json"]);
  }, 120_000);

  it("does not replace a prior stage or config when the staged Python pins drift", async () => {
    const input = await fixture();
    await writePriorGeneration(input);

    await expect(stageArtifactRuntime(
      input.paths,
      stageOptions(input, ["unexpected==1.0", "vieneu==3.2.4"]),
    )).rejects.toThrow(/does not match measured release evidence/u);
    await expectPriorGeneration(input);
  }, 120_000);

  it("rejects hard-linked and symlinked release executables before staging", async () => {
    const hardLinked = await fixture();
    const parsed = JSON.parse(await readFile(hardLinked.paths.inputsFile, "utf8")) as Record<string, string>;
    const hardlinkPath = path.join(path.dirname(parsed.ffmpegPath!), `ffmpeg-hardlink${SUFFIX}`);
    await link(parsed.ffmpegPath!, hardlinkPath);
    parsed.ffmpegPath = hardlinkPath;
    await writeFile(hardLinked.paths.inputsFile, `${JSON.stringify(parsed)}\n`, "utf8");
    await expect(stageArtifactRuntime(hardLinked.paths, stageOptions(hardLinked)))
      .rejects.toThrow(/real regular file/u);

    if (process.platform !== "win32") {
      const symbolic = await fixture();
      const symbolicInputs = JSON.parse(await readFile(symbolic.paths.inputsFile, "utf8")) as Record<string, string>;
      const symlinkPath = path.join(path.dirname(symbolicInputs.ffmpegPath!), "ffmpeg-symlink");
      await symlink(symbolicInputs.ffmpegPath!, symlinkPath);
      symbolicInputs.ffmpegPath = symlinkPath;
      await writeFile(symbolic.paths.inputsFile, `${JSON.stringify(symbolicInputs)}\n`, "utf8");
      await expect(stageArtifactRuntime(symbolic.paths, stageOptions(symbolic)))
        .rejects.toThrow(/real regular file/u);
    }
  }, 120_000);

  it("binds media, CPython build, and VieNeu worker provenance before replacing a generation", async () => {
    const media = await fixture();
    await writePriorGeneration(media);
    await writeFile(media.ffmpegPath, Buffer.concat([await readFile(media.ffmpegPath), Buffer.from("drift")]));
    await chmod(media.ffmpegPath, 0o755);
    await expect(stageArtifactRuntime(media.paths, stageOptions(media)))
      .rejects.toThrow(/approved digest/u);
    await expectPriorGeneration(media);

    const python = await fixture();
    await writePriorGeneration(python);
    await mutateInputs(python, (value) => {
      value.cpythonVersion = "3.12.13+wrong-build";
    });
    await expect(stageArtifactRuntime(python.paths, stageOptions(python)))
      .rejects.toThrow(/standalone build/u);
    await expectPriorGeneration(python);

    const pythonTree = await fixture();
    await writePriorGeneration(pythonTree);
    const modulePath = path.join(pythonTree.pythonRoot, "lib", "python3.12", "site-packages", "demo.py");
    await mkdir(path.dirname(modulePath), { recursive: true });
    await writeFile(modulePath, "# tree drift with unchanged interpreter and metadata\n");
    await expect(stageArtifactRuntime(pythonTree.paths, stageOptions(pythonTree)))
      .rejects.toThrow(/Python tree does not match/u);
    await expectPriorGeneration(pythonTree);

    const worker = await fixture();
    await writePriorGeneration(worker);
    await writeFile(worker.vieneuWorker, "# one-byte worker drift\n", "utf8");
    await expect(stageArtifactRuntime(worker.paths, stageOptions(worker)))
      .rejects.toThrow(/approved digest/u);
    await expectPriorGeneration(worker);
  }, 120_000);

  it("rejects every source/output alias before deleting an embedded media input", async () => {
    const input = await fixture();
    await writePriorGeneration(input);
    const embeddedMedia = path.join(input.paths.outputRoot, `embedded-ffmpeg${SUFFIX}`);
    await executableCopy(embeddedMedia);
    const before = await sha256Pin(embeddedMedia);
    await mutateInputs(input, async (value) => {
      value.ffmpegPath = embeddedMedia;
      value.ffmpegSha256 = await sha256Pin(embeddedMedia);
    });
    await expect(stageArtifactRuntime(input.paths, stageOptions(input)))
      .rejects.toThrow(/disjoint from every input/u);
    expect(await sha256Pin(embeddedMedia)).toBe(before);
    await expectPriorGeneration(input);
  }, 120_000);

  it("rejects symlinked output parents without touching the external authority", async () => {
    if (process.platform === "win32") return;
    const input = await fixture();
    const external = path.join(input.root, "external-output-authority");
    const linkedParent = path.join(input.root, "linked-parent");
    await mkdir(external);
    await writeFile(path.join(external, "sentinel.txt"), "external sentinel\n");
    await symlink(external, linkedParent);
    input.paths.outputRoot = path.join(linkedParent, "runtime-stage");
    input.paths.configFile = path.join(input.paths.outputRoot, ".build", "runtime-config.json");
    await expect(stageArtifactRuntime(input.paths, stageOptions(input)))
      .rejects.toThrow(/parent (?:changed authority|chain must contain only real directories)/u);
    expect(await readFile(path.join(external, "sentinel.txt"), "utf8")).toBe("external sentinel\n");
    expect(existsSync(path.join(external, "runtime-stage"))).toBe(false);
    // Same budget as its siblings: this builds the same real fixture they do,
    // and it was the only one left on the five-second default — which held
    // until the package search began walking the repository as a fallback.
  }, 120_000);

  it("rejects external file and directory symlinks and source hardlinks before publication", async () => {
    if (process.platform === "win32") return;
    for (const kind of ["file-symlink", "directory-symlink", "hardlink"] as const) {
      const input = await fixture();
      await writePriorGeneration(input);
      const external = path.join(input.root, `outside-${kind}`);
      if (kind === "directory-symlink") {
        await mkdir(external);
        await writeFile(path.join(external, "secret.txt"), "external secret\n");
        await symlink(external, path.join(input.pythonRoot, "external-directory"));
      } else {
        await writeFile(external, "external secret\n");
        const nested = path.join(input.pythonRoot, kind === "hardlink" ? "hard-linked-secret" : "external-file");
        if (kind === "hardlink") await link(external, nested);
        else await symlink(external, nested);
      }
      await expect(stageArtifactRuntime(input.paths, stageOptions(input)))
        .rejects.toThrow(kind === "hardlink" ? /hard-linked/u : /escapes its source authority/u);
      expect(await readFile(
        kind === "directory-symlink" ? path.join(external, "secret.txt") : external,
        "utf8",
      )).toBe("external secret\n");
      await expectPriorGeneration(input);
    }
  }, 120_000);

  it("rejects single-file symlinks instead of erasing their provenance", async () => {
    if (process.platform === "win32") return;
    for (const kind of ["package-manifest", "motion-asset", "runtime-asset", "esbuild"] as const) {
      const input = await fixture();
      await writePriorGeneration(input);
      const external = path.join(input.root, `${kind}-external`);
      let candidate: string;
      if (kind === "package-manifest") {
        const packageRoot = input.nativePackageRoots.get("sharp")!;
        candidate = path.join(packageRoot, "package.json");
        await writeFile(external, JSON.stringify({ name: "sharp", version: "1.0.0" }));
      } else if (kind === "motion-asset") {
        const library = MOTION_LIBRARIES[0];
        candidate = path.join(input.motionPackageRoots.get(library.packageName)!, library.files[0].packagePath);
        await writeFile(external, "module.exports = {};\n");
      } else if (kind === "runtime-asset") {
        candidate = path.join(input.hyperframesRoot, "dist", "hyperframe.runtime.iife.js");
        await writeFile(external, "globalThis.external = true;\n");
      } else {
        const platformPackage = HOST_TAG === "darwin-arm64"
          ? "@esbuild/darwin-arm64"
          : HOST_TAG === "linux-x64"
            ? "@esbuild/linux-x64"
            : "@esbuild/win32-x64";
        candidate = path.join(
          input.nativePackageRoots.get(platformPackage)!,
          esbuildPlatformBinaryRelative(HOST_TAG),
        );
        await executableCopy(external);
      }
      await rm(candidate);
      await symlink(external, candidate);
      await expect(stageArtifactRuntime(input.paths, stageOptions(input)))
        .rejects.toThrow(/real regular file/u);
      await expectPriorGeneration(input);
    }
  }, 120_000);

  it("publishes with an in-process mutex and rolls back a failed switch", async () => {
    const root = await temporaryRoot();
    const destination = path.join(root, "runtime-stage");
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await writeTransactionGeneration(destination, "prior");
    await writeTransactionGeneration(first, "first");
    await writeTransactionGeneration(second, "second");
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publication = commitRuntimeGeneration(first, destination, {
      beforeCommit: async () => {
        entered();
        await releasePromise;
      },
    });
    await enteredPromise;
    await expect(commitRuntimeGeneration(second, destination)).rejects.toThrow(/active in-process/u);
    release();
    await publication;
    expect(await readFile(path.join(destination, ".build", "runtime-config.json"), "utf8"))
      .toBe("first config\n");

    const third = path.join(root, "third");
    await writeTransactionGeneration(third, "third");
    await expect(commitRuntimeGeneration(third, destination, {
      afterPreviousRename: () => {
        throw new Error("injected publish failure");
      },
    })).rejects.toThrow(/injected publish failure/u);
    expect(await readFile(path.join(destination, ".build", "runtime-config.json"), "utf8"))
      .toBe("first config\n");
  });

  it("recovers SIGKILL switch boundaries only when journal digests match", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryRoot();
    const destination = path.join(root, "runtime-stage");
    const next = path.join(root, "next");
    await writeTransactionGeneration(destination, "prior");
    await writeTransactionGeneration(next, "next");
    const moduleUrl = pathToFileURL(path.resolve("scripts/stage-artifact-runtime.mjs")).href;
    const childCode = `
const { commitRuntimeGeneration } = await import(${JSON.stringify(moduleUrl)});
const [temporary, destination] = process.argv.slice(1);
await commitRuntimeGeneration(temporary, destination, {
  afterPreviousRename() { process.kill(process.pid, "SIGKILL"); },
});
`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", childCode, next, destination], {
      encoding: "utf8",
      shell: false,
    });
    expect(child.signal).toBe("SIGKILL");
    const backup = `${destination}.previous`;
    expect(existsSync(destination)).toBe(false);
    expect(await readFile(path.join(backup, ".build", "runtime-config.json"), "utf8"))
      .toBe("prior config\n");

    await mkdir(destination);
    await writeFile(path.join(destination, "foreign.txt"), "foreign generation\n");
    await expect(recoverRuntimeGeneration(destination)).rejects.toThrow(/publish journal/u);
    expect(await readFile(path.join(backup, ".build", "runtime-config.json"), "utf8"))
      .toBe("prior config\n");
    await rm(destination, { recursive: true });
    await recoverRuntimeGeneration(destination);
    expect(await readFile(path.join(destination, ".build", "runtime-config.json"), "utf8"))
      .toBe("prior config\n");

    const committed = path.join(root, "committed");
    await writeTransactionGeneration(committed, "committed");
    const afterDestinationCode = `
const { commitRuntimeGeneration } = await import(${JSON.stringify(moduleUrl)});
const [temporary, destination] = process.argv.slice(1);
await commitRuntimeGeneration(temporary, destination, {
  afterDestinationRename() { process.kill(process.pid, "SIGKILL"); },
});
`;
    const afterDestination = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", afterDestinationCode, committed, destination],
      { encoding: "utf8", shell: false },
    );
    expect(afterDestination.signal).toBe("SIGKILL");
    await recoverRuntimeGeneration(destination);
    expect(await readFile(path.join(destination, ".build", "runtime-config.json"), "utf8"))
      .toBe("committed config\n");
    expect(existsSync(`${destination}.previous`)).toBe(false);
    expect(existsSync(`${destination}.publish.json`)).toBe(false);
  }, 120_000);

  it("uses a private probe environment and cannot climb into checkout node_modules", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "home");
    const temporary = path.join(root, "tmp");
    await mkdir(home);
    await mkdir(temporary);
    const environment = privateProbeEnvironment(home, temporary) as Record<string, string | undefined>;
    for (const forbidden of [
      "NODE_PATH",
      "LD_LIBRARY_PATH",
      "DYLD_LIBRARY_PATH",
      "DYLD_FALLBACK_LIBRARY_PATH",
      "PYTHONPATH",
      "PYTHONHOME",
    ]) expect(environment[forbidden]).toBeUndefined();

    const archiveRoot = path.join(path.resolve("dist"), `.runtime-probe-${process.pid}-${Date.now()}`);
    roots.push(archiveRoot);
    for (const packageName of ["sharp", "esbuild", "onnxruntime-node"]) {
      const packageRoot = path.join(archiveRoot, "node_modules", packageName);
      await mkdir(packageRoot, { recursive: true });
      const requiresAncestor = packageName === "onnxruntime-node" ? "require('react');\n" : "";
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: packageName, main: "index.js" }));
      await writeFile(path.join(packageRoot, "index.js"), `${requiresAncestor}module.exports = {};\n`);
    }
    expect(() => probeStagedNativeClosure(archiveRoot, environment))
      .toThrow(/escaped staged closure/u);
  });

  it("stages and cold-loads the real Bun native closure without sources or sourcemaps", async () => {
    const manifest = await realpath(path.resolve("node_modules/hyperframes/package.json"));
    const packageRoots = await resolveNativePackageRoots(path.dirname(manifest), HOST_TAG) as Map<string, string>;
    const root = await temporaryRoot();
    const archiveRoot = path.join(root, "native-archive");
    await stageNativeClosure(packageRoots, HOST_TAG, archiveRoot);
    const files = await regularFiles(archiveRoot);
    expect(files.some((filename) => /(?:^|\/)esbuild\.exe$/u.test(filename)))
      .toBe(process.platform === "win32");
    expect(files.some((filename) => /\.(?:map|ts|tsx)$/u.test(filename))).toBe(false);
    // Group and other write bits, where they exist. Windows has none — Node
    // reports 0o666 for every regular file there — so asserting them would be
    // testing Node's emulation rather than what staging did. Windows protects
    // the same tree through its ACL, which `secureAppDataDirectorySync` sets and
    // the credential-store suites cover.
    if (process.platform !== "win32") {
      for (const filename of files) {
        expect((await lstat(path.join(archiveRoot, filename))).mode & 0o022, filename).toBe(0);
      }
    }
    for (const filename of files.filter((candidate) => /\.(?:cjs|mjs|js)$/u.test(candidate))) {
      expect(await readFile(path.join(archiveRoot, filename), "utf8"), filename)
        .not.toContain("//# sourceMappingURL=");
    }
  }, 120_000);

  it("reports exact Python pin drift and pip as release failures", () => {
    expect(() => assertExactPythonPackages(["a==1"], ["a==1"])).not.toThrow();
    expect(() => assertExactPythonPackages(
      ["pydantic-core==2", "pydantic==1"],
      ["pydantic-core==2", "pydantic==1"],
    )).not.toThrow();
    expect(() => assertExactPythonPackages(["pip==26.2"], ["pip==26.2"])).toThrow(/pip/u);
    expect(() => assertExactPythonPackages(["a==2"], ["a==1"])).toThrow(/does not match/u);
  });
});
