import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function fail(message, details) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`build-cli-bundle: ${message}${payload}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

/**
 * Finds the esbuild the runtime archive already ships.
 *
 * No bundler is declared as a dependency of this repository, and the only
 * copies on disk are transitive ones in the package store — at two different
 * versions, so reaching for a hoisted copy would be both undeclared and
 * ambiguous. `build:artifact` builds the runtime archives before it gets here,
 * so by this point the pinned binary exists, and using it makes the compiler
 * that builds the artifact the same one the artifact runs.
 */
export function esbuildBinaryPath(runtimeRoot) {
  const executable = process.platform === "win32" ? "esbuild.exe" : "esbuild";
  return path.join(runtimeRoot, "node", "bin", executable);
}

export function assertEsbuildAvailable(runtimeRoot) {
  const binary = esbuildBinaryPath(runtimeRoot);
  if (!existsSync(binary)) {
    fail("the runtime archive has not been extracted yet", {
      expected: binary,
      hint: "run scripts/build-runtime-archives.mjs first; build:artifact does this for you",
    });
  }
  return binary;
}

const TOP_LEVEL_AWAIT = /^\s*await\s/mu;

/**
 * Rejects top-level await before the bundle is built.
 *
 * Node SEA takes a CommonJS main, and esbuild cannot emit top-level await in
 * `cjs` format at all — so this is a build failure either way. Checking here
 * names the file, which esbuild's own message does not always do clearly, and
 * makes the rule visible next to the reason for it: every asynchronous
 * start-up step belongs inside `main()`.
 */
export function findTopLevelAwait(source) {
  const lines = source.split("\n");
  let depth = 0;
  for (const [index, line] of lines.entries()) {
    if (depth === 0 && TOP_LEVEL_AWAIT.test(line)) return index + 1;
    for (const character of line) {
      if (character === "{" || character === "(") depth += 1;
      if (character === "}" || character === ")") depth = Math.max(0, depth - 1);
    }
  }
  return null;
}

export async function assertNoTopLevelAwait(entryPath) {
  const source = await readFile(entryPath, "utf8");
  const line = findTopLevelAwait(source);
  if (line !== null) {
    fail("top-level await cannot be bundled into a CommonJS SEA main", {
      file: path.relative(REPOSITORY_ROOT, entryPath),
      line,
      hint: "move the awaited work inside main()",
    });
  }
}

async function main() {
  const runtimeRoot = process.env.VIDCOM_RUNTIME_ROOT
    ?? path.join(REPOSITORY_ROOT, "dist", "runtime");
  const entry = path.join(REPOSITORY_ROOT, "packages", "cli", "src", "main.ts");

  await assertNoTopLevelAwait(entry);
  assertEsbuildAvailable(runtimeRoot);
  process.stderr.write("build-cli-bundle: preflight passed\n");
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  main().catch(() => {
    // `fail` already reported the reason and set the exit code.
  });
}
