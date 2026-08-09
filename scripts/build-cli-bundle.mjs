import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function fail(message, details) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`build-cli-bundle: ${message}${payload}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

export const CLI_ENTRY = path.join(REPOSITORY_ROOT, "packages", "cli", "src", "main.ts");
export const BUNDLE_PATH = path.join(REPOSITORY_ROOT, "dist", "sea", "main.cjs");

/**
 * The bundler is Bun, which the repository already needs to run at all.
 *
 * No bundler is declared as a dependency of any package here, and the only
 * copies of esbuild on disk are transitive ones in the package store at two
 * different versions — undeclared and ambiguous. Bun is neither: every script
 * and every test in this repository already runs through it, so using its
 * bundler adds nothing to `package.json` and nothing to the lockfile.
 *
 * It bundles for a Node target, which is what matters: the SEA main runs under
 * the embedded Node binary, not under Bun. Phase 0 ruled out Bun as the
 * *runtime* (native addons did not load from a compiled executable); that
 * decision is about what executes the artifact, not about what compiles it.
 */
export function bundleCommand(entry = CLI_ENTRY, outfile = BUNDLE_PATH) {
  return {
    command: "bun",
    args: [
      "build",
      entry,
      "--target=node",
      // Node SEA takes a CommonJS main; there is no ESM option here.
      "--format=cjs",
      `--outfile=${outfile}`,
      // L.1 forbids sourcemaps in the artifact: they carry the build machine's
      // absolute paths and the full original source.
      "--sourcemap=none",
      ...EXTERNAL_PACKAGES.flatMap((name) => ["--external", name]),
    ],
  };
}

/**
 * Packages the bundle must not inline.
 *
 * Every one of these either is a native addon or loads one. Bundling their
 * JavaScript does not bring the `.node` binary along, so the artifact starts
 * and then dies at the first import with a message about a missing native
 * build — Phase 0 measured exactly that for `sharp` and `onnxruntime-node`.
 * They ship in the runtime archive instead and are required from the extracted
 * tree (DR-2), which is also why an artifact whose runtime has not been
 * extracted fails with "cannot find module" rather than something stranger.
 */
export const EXTERNAL_PACKAGES = [
  "sharp",
  "onnxruntime-node",
  "esbuild",
  "hyperframes",
  "@hyperframes/core",
  "@hyperframes/studio-server",
  "@hyperframes/sdk",
  "@hyperframes/parsers",
  "@hyperframes/lint",
  // The HyperFrames packages require it at runtime; a second bundled copy would
  // mean two DOMParser implementations disagreeing about the same document.
  "linkedom",
];

const TOP_LEVEL_AWAIT = /^\s*await\s/mu;

/**
 * Rejects top-level await before the bundle is built.
 *
 * Node SEA takes a CommonJS main, and top-level await cannot be expressed in
 * `cjs` format at all — so this is a build failure either way. Checking here
 * names the file and the line, which a bundler's own message does not always
 * do clearly, and makes the rule visible next to the reason for it: every
 * asynchronous start-up step belongs inside `main()`.
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

/**
 * Builds the CommonJS main the SEA embeds.
 *
 * The entry is checked before the bundler runs rather than after: the emitted
 * bundle is one enormous line-shifted file, so a failure there names a line
 * nobody can act on, while the same failure named on the source points at the
 * statement to move.
 */
export async function buildCliBundle(entry = CLI_ENTRY, outfile = BUNDLE_PATH) {
  await assertNoTopLevelAwait(entry);
  await mkdir(path.dirname(outfile), { recursive: true });

  const { command, args } = bundleCommand(entry, outfile);
  const result = spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    shell: false,
  });
  if (result.error) {
    fail("the bundler could not start", {
      command,
      cause: result.error.message,
      hint: "bun is the toolchain this repository runs on; install it before building the artifact",
    });
  }
  if (result.status !== 0) fail("bundling failed", { exitCode: result.status });

  await stripBuildRoot(outfile);
  return outfile;
}

/**
 * Removes the build machine's own directory from the emitted bundle.
 *
 * Bundling to CommonJS resolves every `import.meta.url` to an absolute file URL
 * of the source module, so the shipped bytes carry the layout of whatever
 * machine built them. Two reasons that has to go: L.1 forbids it outright, and
 * the paths are worse than useless in a packaged build — a `createRequire`
 * anchored to a directory that does not exist on the user's machine resolves
 * against nothing at all.
 *
 * A fixed marker rather than a relative path: nothing should be tempted to
 * treat it as somewhere real.
 */
export async function stripBuildRoot(outfile, root = REPOSITORY_ROOT) {
  const source = await readFile(outfile, "utf8");
  if (!source.includes(root)) return 0;
  const stripped = source.split(root).join("/vidcom");
  await writeFile(outfile, stripped, "utf8");
  return source.split(root).length - 1;
}

async function main() {
  const outfile = await buildCliBundle();
  process.stderr.write(`build-cli-bundle: ${path.relative(REPOSITORY_ROOT, outfile)}\n`);
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  main().catch(() => {
    // `fail` already reported the reason and set the exit code.
  });
}
