import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { builtinModules, createRequire } from "node:module";

import {
  CLI_ENTRY,
  EXTERNAL_PACKAGES,
  bundleCommand,
  buildCliBundle,
  escapeSourcemapMarkers,
  findTopLevelAwait,
} from "../../scripts/build-cli-bundle.mjs";
import {
  buildRootEncodings,
  containsBuildRootEncoding,
  replaceBuildRootEncodings,
} from "../../scripts/build-root-provenance.mjs";
import { afterEach, describe, expect, it } from "vitest";

import { resolveDevelopmentEsbuildBinary } from "../../packages/cli/src/compiler-preload";
import { COMPILER_PROBE_SENTINEL, COMPILER_PROBE_SUCCESS } from "../../packages/cli/src/compiler-probe-protocol";

const BUILTINS = new Set(builtinModules);
function isBuiltin(name: string): boolean {
  return name.startsWith("node:") || BUILTINS.has(name);
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratchDirectory(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-bundle-")));
  roots.push(root);
  return root;
}

async function scratchRepositoryDirectory(): Promise<string> {
  const distRoot = path.resolve("dist");
  await mkdir(distRoot, { recursive: true });
  const root = await mkdtemp(path.join(distRoot, ".compiler-bundle-"));
  roots.push(root);
  return root;
}

describe("cjs bundle", () => {
  it("bundles with the toolchain the repository already runs on", () => {
    // No bundler is declared as a dependency of any package here, and the only
    // copies of esbuild on disk are transitive ones at two different versions.
    // Bun is what every script and every test already runs through, so it costs
    // no dependency and no lockfile entry.
    const { command, args } = bundleCommand("entry.ts", "out.cjs");
    expect(command).toBe("bun");
    expect(args).toContain("--target=node");
    // Node SEA takes a CommonJS main; ESM is not an option.
    expect(args).toContain("--format=cjs");
    // Sourcemaps carry the build machine's absolute paths and the full original
    // source, both of which L.1 forbids in the artifact.
    expect(args).toContain("--sourcemap=none");
  });

  it.each([
    ["await start();", "a bare top-level await"],
    ["  await start();", "an indented one"],
  ])("rejects %s (%s)", (line) => {
    // Top-level await cannot be expressed in cjs at all, so this is a build
    // failure either way; catching it here names the line.
    expect(findTopLevelAwait(`import x from "y";\n${line}\n`)).not.toBeNull();
  });

  it.each([
    ["async function main() {\n  await start();\n}\n", "await inside a function"],
    ["const run = async () => {\n  await start();\n};\n", "await inside an arrow"],
    ["const awaited = 1;\n", "an identifier that merely starts with await"],
  ])("accepts %s (%s)", (source) => {
    expect(findTopLevelAwait(source)).toBeNull();
  });

  it("reports the line so the fix is obvious", () => {
    const source = "import x from \"y\";\nconst a = 1;\nawait start();\n";
    // Every asynchronous start-up step belongs inside main(); pointing at the
    // line is what turns that rule into an actionable message.
    expect(findTopLevelAwait(source)).toBe(3);
  });

  it("keeps the real CLI entry free of top-level await", async () => {
    expect(findTopLevelAwait(await readFile(CLI_ENTRY, "utf8"))).toBeNull();
  });

  it("escapes annotation markers without changing string or RegExp behavior", () => {
    const source = [
      "const marker = \"/*# sourceMappingURL=\";",
      "const matches = /\\/\\*# sourceMappingURL=/.test(marker);",
      "return { marker, matches };",
    ].join("\n");
    const escaped = escapeSourcemapMarkers(source);
    expect(escaped).not.toMatch(/(?:\/\/|\/\*)\s*[#@]\s*sourceMappingURL\s*=/u);
    expect(Function(escaped)()).toEqual({ marker: "/*# sourceMappingURL=", matches: true });
  });

  it("leaves Next out of the run path entirely", async () => {
    // The artifact serves a pre-rendered pack; nothing renders at request time.
    // A Next module reaching the bundle would mean some import still pulls the
    // framework in, and it would only show up as size and start-up cost that
    // nobody could explain.
    const root = await scratchDirectory();
    const outfile = path.join(root, "main.cjs");
    await buildCliBundle(CLI_ENTRY, outfile);
    expect(await readFile(outfile, "utf8")).not.toContain("node_modules/next/");
  }, 120_000);

  it("leaves out only what ships in the runtime archive", async () => {
    // Bundling a native package's JavaScript does not bring its `.node` binary
    // along, so the artifact would start and die at the first import — Phase 0
    // measured that for sharp and onnxruntime-node. They ride in the runtime
    // archive and are required from the extracted tree (DR-2). Anything *else*
    // left external would be an accident, and this is where it shows.
    const root = await scratchDirectory();
    const outfile = path.join(root, "main.cjs");
    await buildCliBundle(CLI_ENTRY, outfile);
    expect((await stat(outfile)).size).toBeGreaterThan(0);

    const source = await readFile(outfile, "utf8");
    expect(source).not.toMatch(/(?:\/\/|\/\*)\s*[#@]\s*sourceMappingURL\s*=/u);
    const required = new Set<string>();
    for (const match of source.matchAll(/\brequire\("([^"]+)"\)/gu)) {
      const name = match[1] ?? "";
      if (name.startsWith(".")) continue;
      required.add(name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]!);
    }
    const unexpected = [...required].filter((name) => !isBuiltin(name)
      && !EXTERNAL_PACKAGES.includes(name)
      // ajv writes these into generated code as strings, never as live imports.
      && !["ajv", "ajv-formats"].includes(name));
    expect(unexpected).toEqual([]);
  }, 120_000);

  it("carries none of the build machine's directory layout", async () => {
    // Bundling to CommonJS resolves every `import.meta.url` to an absolute file
    // URL of its source module. That leaks our layout into the shipped bytes,
    // and a `createRequire` anchored to a directory the user does not have
    // resolves against nothing at all.
    const root = await scratchDirectory();
    const outfile = path.join(root, "main.cjs");
    await buildCliBundle(CLI_ENTRY, outfile);
    expect(containsBuildRootEncoding(await readFile(outfile, "utf8"), process.cwd())).toBe(false);
  }, 120_000);

  it("recognizes and strips Windows, URL, slash, and percent-encoded build roots", () => {
    const buildRoot = "C:\\Build #?% Root\\vidcom-v2";
    const encodings = buildRootEncodings(buildRoot);
    expect(encodings).toContain("C:/Build #?% Root/vidcom-v2");
    expect(encodings).toContain("file:///C:/Build%20%23%3F%25%20Root/vidcom-v2");
    expect(encodings).toContain("C:\\\\Build #?% Root\\\\vidcom-v2");
    const source = encodings.map((value) => `const source = ${JSON.stringify(value)};`).join("\n");
    expect(containsBuildRootEncoding(source, buildRoot)).toBe(true);
    const stripped = replaceBuildRootEncodings(source, buildRoot);
    expect(stripped.replacements).toBeGreaterThan(0);
    expect(containsBuildRootEncoding(stripped.output, buildRoot)).toBe(false);
    expect(stripped.output).toContain("file:///C:/vidcom");
    expect(() => fileURLToPath("file:///C:/vidcom/packages/cli/src/main.ts")).not.toThrow();
  });

  it("keeps a rewritten POSIX file URL syntactically usable", () => {
    const buildRoot = "/Users/Build #?% Root/vidcom-v2";
    const source = "fileURLToPath('file:///Users/Build%20%23%3F%25%20Root/vidcom-v2/main.ts')";
    const stripped = replaceBuildRootEncodings(source, buildRoot);
    expect(stripped.output).toBe("fileURLToPath('file:///vidcom/main.ts')");
    expect(fileURLToPath("file:///vidcom/main.ts")).toBe("/vidcom/main.ts");
  });

  it("keeps main and HyperFrames lazy until the emitted CJS has configured esbuild", async () => {
    const root = await scratchRepositoryDirectory();
    const outfile = path.join(root, "main.cjs");
    await buildCliBundle(CLI_ENTRY, outfile);
    const requireFromTest = createRequire(import.meta.url);
    const hyperframesCore = requireFromTest.resolve("@hyperframes/core/package.json");
    const esbuildPackage = createRequire(hyperframesCore).resolve("esbuild/package.json");
    await cp(path.dirname(esbuildPackage), path.join(root, "node_modules", "esbuild"), {
      recursive: true,
      dereference: true,
    });
    const loader = path.join(root, "load-secondary.cjs");
    await writeFile(loader, [
      `const { runBootstrappedCli } = require(${JSON.stringify(outfile)});`,
      "Promise.resolve(runBootstrappedCli(process.argv.slice(2)))",
      "  .then((code) => { process.exitCode = code ?? 0; })",
      "  .catch((error) => { console.error(error); process.exitCode = 1; });",
      "",
    ].join("\n"), "utf8");

    const artifactVersion = "compiler-order-test";
    const runtimeAssets = path.join(root, "runtime-assets");
    const appDataRoot = path.join(root, "explicit-app-data");
    const settingsAppDataRoot = path.join(root, "settings-app-data");
    const settingsPath = path.join(root, "setting.json");
    const binaryName = process.platform === "win32" ? "esbuild.exe" : "esbuild";
    const artifactBinary = path.join(appDataRoot, "native", artifactVersion, "node", "bin", binaryName);
    await mkdir(path.dirname(artifactBinary), { recursive: true });
    await copyFile(resolveDevelopmentEsbuildBinary(), artifactBinary);
    await chmod(artifactBinary, 0o755);
    await mkdir(runtimeAssets, { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ appDataRoot: settingsAppDataRoot }), "utf8");
    await writeFile(path.join(runtimeAssets, "runtime-manifest.json"), JSON.stringify({
      artifactVersion,
      archives: [{ key: "node", platform: `${process.platform}-${process.arch}`, target: "node" }],
    }), "utf8");

    const result = spawnSync(process.execPath, [loader, COMPILER_PROBE_SENTINEL], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        APPDATA: process.env.APPDATA,
        HOME: process.env.HOME,
        NODE_ENV: "test",
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        TMPDIR: process.env.TMPDIR,
        VIDCOM_APP_DATA: appDataRoot,
        VIDCOM_RUNTIME_ASSETS: runtimeAssets,
        VIDCOM_SETTINGS: settingsPath,
        WINDIR: process.env.WINDIR,
        // If Bun eagerly initializes main, HyperFrames snapshots this hostile
        // binary before the async preload replaces it and the transform fails.
        ESBUILD_BINARY_PATH: process.execPath,
        ESBUILD_WORKER_THREADS: "0",
      },
      timeout: 30_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(COMPILER_PROBE_SUCCESS);

    const settingsBinary = path.join(
      settingsAppDataRoot,
      "native",
      artifactVersion,
      "node",
      "bin",
      binaryName,
    );
    await mkdir(path.dirname(settingsBinary), { recursive: true });
    await copyFile(resolveDevelopmentEsbuildBinary(), settingsBinary);
    await chmod(settingsBinary, 0o755);
    const settingsResult = spawnSync(process.execPath, [loader, COMPILER_PROBE_SENTINEL], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        APPDATA: process.env.APPDATA,
        HOME: process.env.HOME,
        NODE_ENV: "test",
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        TMPDIR: process.env.TMPDIR,
        VIDCOM_RUNTIME_ASSETS: runtimeAssets,
        VIDCOM_SETTINGS: settingsPath,
        WINDIR: process.env.WINDIR,
        ESBUILD_BINARY_PATH: process.execPath,
        ESBUILD_WORKER_THREADS: "0",
      },
      timeout: 30_000,
    });
    expect(settingsResult.error).toBeUndefined();
    expect(settingsResult.status, settingsResult.stderr).toBe(0);
    expect(settingsResult.stdout.trim()).toBe(COMPILER_PROBE_SUCCESS);
  }, 120_000);
});
