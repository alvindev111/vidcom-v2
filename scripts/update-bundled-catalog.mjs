#!/usr/bin/env node
/**
 * Maintainer tool that refreshes the frozen bundled catalog snapshot.
 *
 * Deliberately *not* part of `build` or `build:artifact`: those must never reach
 * the network, and a build that resolved `main` would produce a different
 * artifact from the same source. This script recomputes the digests of the bytes
 * already committed under `packages/adapter/assets/catalog/files/**` and writes
 * `manifest.json` beside them, so the snapshot stays reviewable in a source diff.
 *
 * Usage:
 *   node scripts/update-bundled-catalog.mjs
 *   node scripts/update-bundled-catalog.mjs --upstream-commit <40-hex> --upstream-committed-at <RFC3339>
 *
 * The upstream commit must be given explicitly. Resolving a branch here would
 * make the output depend on when the tool ran instead of on its inputs.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requireFromCli = createRequire(new URL("../packages/cli/package.json", import.meta.url));
const { tsImport } = requireFromCli("tsx/esm/api");

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CATALOG_ROOT = path.join(REPO_ROOT, "packages", "adapter", "assets", "catalog");
const FILES_ROOT = path.join(CATALOG_ROOT, "files");
const MANIFEST_PATH = path.join(CATALOG_ROOT, "manifest.json");
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** Curated declarations. Bytes live in the repo; digests are derived below. */
const CURATED = [
  {
    name: "title-card",
    kind: "template",
    title: "Title card",
    description: "Centered headline and subhead on a dark card.",
    category: "Openers",
    tags: ["intro", "text"],
    version: "1.0.0",
    entry: "templates/title-card/scene.html",
    durationSeconds: 4,
    compatibility: {
      aspectRatios: ["16:9"],
      minWidth: 1280,
      fps: null,
      minHyperframesVersion: null,
    },
    preview: { kind: "image", path: "templates/title-card/preview.svg" },
    dependencies: [],
    /** Directory under `files/` that holds every target of this package. */
    packageDir: "templates/title-card",
  },
];

function parseArgs(argv) {
  const options = { upstreamCommit: null, upstreamCommittedAt: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--upstream-commit") {
      options.upstreamCommit = argv[index + 1] ?? "";
      index += 1;
    } else if (flag === "--upstream-committed-at") {
      options.upstreamCommittedAt = argv[index + 1] ?? "";
      index += 1;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (options.upstreamCommit !== null && !COMMIT_PATTERN.test(options.upstreamCommit)) {
    throw new Error("--upstream-commit must be an explicit 40-character lowercase hex commit");
  }
  return options;
}

async function listTargets(relativeDir) {
  const absolute = path.join(FILES_ROOT, relativeDir);
  const entries = await readdir(absolute, { withFileTypes: true, recursive: true });
  const targets = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parent = path.relative(FILES_ROOT, entry.parentPath ?? entry.path);
    targets.push(path.join(parent, entry.name).split(path.sep).join("/"));
  }
  return targets.sort();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { catalogManifestDigest } = await tsImport(
    "../packages/adapter/src/catalog/bundled-catalog.ts",
    import.meta.url,
  );

  const items = [];
  for (const declaration of CURATED) {
    const { packageDir, ...rest } = declaration;
    const targets = await listTargets(packageDir);
    if (targets.length === 0) throw new Error(`no bytes committed for ${declaration.name}`);
    const files = {};
    for (const target of targets) {
      const bytes = await readFile(path.join(FILES_ROOT, target));
      files[target] = createHash("sha256").update(bytes).digest("hex");
    }
    if (!(rest.entry in files)) {
      throw new Error(`${declaration.name}: entry ${rest.entry} is not in the committed file set`);
    }
    const item = {
      ...rest,
      upstream: options.upstreamCommit === null
        ? null
        : { commit: options.upstreamCommit, committedAt: options.upstreamCommittedAt },
      integrity: { algo: "sha256", files, manifest: "" },
    };
    // The digest is computed over the normalized item, exactly as the loader and
    // the install path recompute it, so a mismatch is impossible to ship.
    item.integrity.manifest = catalogManifestDigest({
      ...item,
      tags: [...item.tags].map((tag) => tag.normalize("NFC")).sort(),
      source: { registry: "bundled", url: null, revision: null, committedAt: null },
      integrity: item.integrity,
      materialization: "verified",
    });
    items.push(item);
  }

  const manifest = { schemaVersion: 1, categoryRuleVersion: 1, items };
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`bundled catalog manifest written for ${items.length} item(s)\n`);
}

await main();
