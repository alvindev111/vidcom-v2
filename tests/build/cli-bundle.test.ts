import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { builtinModules } from "node:module";

import {
  CLI_ENTRY,
  EXTERNAL_PACKAGES,
  bundleCommand,
  buildCliBundle,
  findTopLevelAwait,
} from "../../scripts/build-cli-bundle.mjs";
import { afterEach, describe, expect, it } from "vitest";

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
    expect(await readFile(outfile, "utf8")).not.toContain(process.cwd());
  }, 120_000);
});
