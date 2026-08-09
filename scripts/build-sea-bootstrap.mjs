import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PRIMARY_BUNDLE_PATH, REPOSITORY_ROOT } from "./artifact-layout.mjs";
import { assertNoTopLevelAwait, stripBuildRoot } from "./build-cli-bundle.mjs";

export const SEA_BOOTSTRAP_ENTRY = path.join(
  REPOSITORY_ROOT,
  "packages",
  "cli",
  "src",
  "sea-bootstrap.ts",
);

const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => name.startsWith("node:") ? name : `node:${name}`),
]);

function fail(message, details) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`build-sea-bootstrap: ${message}${payload}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

export function bootstrapBundleCommand(entry = SEA_BOOTSTRAP_ENTRY, outfile = PRIMARY_BUNDLE_PATH) {
  return {
    command: "bun",
    args: [
      "build",
      entry,
      "--target=node",
      "--format=cjs",
      `--outfile=${outfile}`,
      "--sourcemap=none",
      "--packages=bundle",
    ],
  };
}

/** Literal CommonJS loads are the only imports Node SEA can perform itself. */
export function nonBuiltinRequires(source) {
  const modules = new Set();
  const expression = /\brequire\(\s*["']([^"']+)["']\s*\)/gu;
  for (const match of source.matchAll(expression)) {
    const requested = match[1];
    if (!BUILTINS.has(requested)) modules.add(requested);
  }
  return [...modules].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

export async function assertBuiltinsOnlyBundle(outfile) {
  const source = await readFile(outfile, "utf8");
  const external = nonBuiltinRequires(source);
  if (external.length > 0) {
    fail("the primary SEA bootstrap still requires files outside the executable", { external });
  }
}

export async function buildSeaBootstrap(entry = SEA_BOOTSTRAP_ENTRY, outfile = PRIMARY_BUNDLE_PATH) {
  await assertNoTopLevelAwait(entry);
  await mkdir(path.dirname(outfile), { recursive: true });
  const { command, args } = bootstrapBundleCommand(entry, outfile);
  const result = spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    shell: false,
  });
  if (result.error) fail("the bootstrap bundler could not start", { cause: result.error.message });
  if (result.status !== 0) fail("bootstrap bundling failed", { exitCode: result.status });
  await stripBuildRoot(outfile);
  await assertBuiltinsOnlyBundle(outfile);
  return outfile;
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  buildSeaBootstrap().then((outfile) => {
    process.stderr.write(`build-sea-bootstrap: ${path.relative(REPOSITORY_ROOT, outfile)}\n`);
  }).catch((error) => {
    if (!process.exitCode) {
      process.stderr.write(`build-sea-bootstrap: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });
}
