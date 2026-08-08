import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mimeTypeFor, resolveAsset } from "../packages/cli/src/sea-static-host.ts";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const EXPORT_DIRECTORY = path.join(REPOSITORY_ROOT, "out");
export const PACK_PATH = path.join(REPOSITORY_ROOT, "dist", "sea", "frontend.pack");
export const MANIFEST_PATH = path.join(REPOSITORY_ROOT, "dist", "sea", "frontend-manifest.json");

function fail(message, details) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`build-frontend-pack: ${message}${payload}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

/** Every file the export wrote, as manifest keys, in a stable order. */
export async function exportedFiles(root) {
  const found = [];
  const visit = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      // Only regular files: a symlink in the export would mean the pack points
      // at something outside it, and the pack has to be self-contained.
      else if (entry.isFile()) found.push(path.relative(root, target).split(path.sep).join("/"));
    }
  };
  await visit(root);
  // Sorted so two builds of the same export produce byte-identical output.
  return found.sort();
}

/**
 * Describes one asset the way the host will need it.
 *
 * The cache policy is asked of the resolver rather than decided here. The
 * resolver is what answers the browser at runtime, so deriving the manifest
 * from it is what keeps the two from disagreeing — and a disagreement here
 * means an asset is cached forever under a rule the host never applied.
 */
export function describeAsset(assetPath, bytes, offset) {
  const resolution = resolveAsset(`/${assetPath}`);
  if (resolution === null) {
    fail("the export wrote a file the resolver refuses to serve", { path: assetPath });
  }
  return {
    path: assetPath,
    offset,
    length: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mime: mimeTypeFor(assetPath),
    cachePolicy: resolution.cachePolicy,
  };
}

/**
 * Concatenates the export into one pack plus a manifest of offsets.
 *
 * Raw bytes, not base64: the pack is read straight out of the executable as an
 * immutable view, and base64 would cost a third more space in the binary and a
 * decode of the whole frontend before the first byte is served.
 */
export async function buildFrontendPack(
  exportDirectory = EXPORT_DIRECTORY,
  packPath = PACK_PATH,
  manifestPath = MANIFEST_PATH,
) {
  let names;
  try {
    names = await exportedFiles(exportDirectory);
  } catch (error) {
    return fail("the static export has not been built yet", {
      expected: exportDirectory,
      cause: error instanceof Error ? error.message : String(error),
      hint: "run the static export first; build:artifact does this for you",
    });
  }
  if (names.length === 0) fail("the static export is empty", { directory: exportDirectory });

  const chunks = [];
  const entries = [];
  let offset = 0;
  for (const name of names) {
    const bytes = await readFile(path.join(exportDirectory, name));
    entries.push(describeAsset(name, bytes, offset));
    chunks.push(bytes);
    offset += bytes.length;
  }

  await mkdir(path.dirname(packPath), { recursive: true });
  await writeFile(packPath, Buffer.concat(chunks));
  await writeFile(manifestPath, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
  return { entries, bytes: offset };
}

async function main() {
  const { entries, bytes } = await buildFrontendPack();
  process.stderr.write(`build-frontend-pack: ${entries.length} assets, ${bytes} bytes\n`);
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  main().catch(() => {
    // `fail` already reported the reason and set the exit code.
  });
}
