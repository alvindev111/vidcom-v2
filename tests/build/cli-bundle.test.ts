import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CLI_ENTRY,
  bundleCommand,
  buildCliBundle,
  findTopLevelAwait,
} from "../../scripts/build-cli-bundle.mjs";
import { afterEach, describe, expect, it } from "vitest";

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

  it("emits a bundle the embedded Node loads with nothing else on disk", async () => {
    // The whole point of the bundle is that the SEA has no `node_modules` to
    // fall back on. Building into a temp directory and loading it from there
    // puts it outside every `node_modules` in this checkout, so an import the
    // bundler left external fails here instead of in the packaged smoke.
    const root = await scratchDirectory();
    const outfile = path.join(root, "main.cjs");
    await buildCliBundle(CLI_ENTRY, outfile);
    expect((await stat(outfile)).size).toBeGreaterThan(0);

    const loaded = spawnSync(process.execPath, ["-e", "require(process.argv[1])", outfile], {
      cwd: root,
      encoding: "utf8",
    });
    expect(loaded.stderr).not.toMatch(/MODULE_NOT_FOUND|Cannot find module/u);
    expect(loaded.status).toBe(0);
  }, 120_000);
});
