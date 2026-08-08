import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertEsbuildAvailable,
  esbuildBinaryPath,
  findTopLevelAwait,
} from "../../scripts/build-cli-bundle.mjs";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runtimeRoot(withEsbuild: boolean): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-bundle-")));
  roots.push(root);
  if (withEsbuild) {
    await mkdir(path.join(root, "node", "bin"), { recursive: true });
    await writeFile(esbuildBinaryPath(root), "#!/bin/sh\nexit 0\n", "utf8");
  }
  return root;
}

describe("cjs bundle preflight", () => {
  it("finds esbuild inside the extracted runtime, not in node_modules", async () => {
    // No bundler is declared as a dependency here, and the only copies on disk
    // are transitive ones at two different versions. The runtime archive ships
    // the pinned one, so the compiler that builds the artifact is the compiler
    // the artifact runs.
    const root = await runtimeRoot(true);
    expect(assertEsbuildAvailable(root)).toBe(esbuildBinaryPath(root));
    expect(esbuildBinaryPath(root)).not.toContain("node_modules");
  });

  it("says what to run first when the runtime has not been extracted", async () => {
    const root = await runtimeRoot(false);
    expect(() => assertEsbuildAvailable(root)).toThrow(/has not been extracted/u);
  });

  it.each([
    ["await start();", "a bare top-level await"],
    ["  await start();", "an indented one"],
  ])("rejects %s (%s)", (line) => {
    // esbuild cannot emit top-level await in cjs at all, so this is a build
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
    const { readFile } = await import("node:fs/promises");
    const entry = await readFile(path.resolve("packages/cli/src/main.ts"), "utf8");
    expect(findTopLevelAwait(entry)).toBeNull();
  });
});
