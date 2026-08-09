import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertBuildableTarget } from "./build-artifact.mjs";
import { BUNDLE_PATH } from "./build-cli-bundle.mjs";
import { MANIFEST_PATH, PACK_PATH } from "./build-frontend-pack.mjs";
import { artifactPath } from "./build-sea.mjs";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function fail(message, details) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`verify-artifact: ${message}${payload}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

/**
 * What must never be in a shipped file.
 *
 * Each is a thing that is invisible until it is embarrassing: a key that works,
 * a sourcemap that hands over the whole source, a development origin that makes
 * the artifact talk to a machine that is not there, and the build machine's own
 * directory layout.
 */
export const FORBIDDEN_PATTERNS = [
  { id: "dev-origin", pattern: /localhost:3000/u, why: "a development origin cannot be reachable from a user's machine" },
  { id: "sourcemap-url", pattern: /\/\/# sourceMappingURL=/u, why: "a sourcemap hands over the entire original source" },
  { id: "aws-key", pattern: /AKIA[0-9A-Z]{16}/u, why: "an AWS access key" },
  { id: "openai-key", pattern: /\bsk-[A-Za-z0-9]{20,}/u, why: "an API key" },
  { id: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u, why: "a private key" },
];

/**
 * Scans text for anything that must not ship.
 *
 * Returns every hit rather than the first: a build that leaked two things
 * should say so once, not across two runs.
 */
export function scanForForbidden(text, buildRoot) {
  const found = [];
  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(text)) found.push({ id: rule.id, why: rule.why });
  }
  if (buildRoot && buildRoot.length > 0 && text.includes(buildRoot)) {
    found.push({
      id: "build-root",
      why: "the build machine's absolute path says nothing about the user's install",
    });
  }
  return found;
}

/** Files a shipped artifact directory may contain, and nothing else. */
export const ARTIFACT_ALLOWLIST = new Set([
  "vidcom",
  "vidcom.exe",
  "SHA256SUMS",
  "artifact-manifest.json",
]);

export function unexpectedEntries(entries) {
  return entries.filter((name) => !ARTIFACT_ALLOWLIST.has(name));
}

async function sha256Of(target) {
  return `${createHash("sha256").update(await readFile(target)).digest("hex")}`;
}

function gitOutput(args) {
  const result = spawnSync("git", args, { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * Everything a bug report needs to identify this exact build.
 *
 * `dirty` is recorded rather than refused here, and the release job is what
 * insists on `false`: a developer building locally from a modified tree should
 * get an artifact plus an honest label, not a failure.
 */
export async function artifactManifest(tag, artifact) {
  return {
    version: 1,
    platform: tag,
    commit: gitOutput(["rev-parse", "HEAD"]) ?? "unknown",
    dirty: (gitOutput(["status", "--porcelain"]) ?? "") !== "",
    node: process.version,
    createdAt: new Date().toISOString(),
    files: {
      [path.basename(artifact)]: await sha256Of(artifact),
    },
  };
}

export function formatChecksums(files) {
  // The `sha256sum -c` format, so a user can verify a download with a tool they
  // already have rather than one we ask them to install.
  return `${Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, digest]) => `${digest}  ${name}`)
    .join("\n")}\n`;
}

async function assertNoForbiddenContent(buildRoot) {
  const targets = [
    { name: "cjs bundle", file: BUNDLE_PATH },
    { name: "frontend manifest", file: MANIFEST_PATH },
    { name: "frontend pack", file: PACK_PATH },
  ];
  for (const target of targets) {
    if (!existsSync(target.file)) fail(`${target.name} is missing`, { expected: target.file });
    const text = await readFile(target.file, "latin1");
    const found = scanForForbidden(text, buildRoot);
    if (found.length > 0) {
      fail(`${target.name} contains something that must not ship`, { found });
    }
  }
}

async function assertNoLooseSources(directory) {
  const entries = await readdir(directory);
  const unexpected = unexpectedEntries(entries);
  if (unexpected.length > 0) {
    // A `.map` or a stray `.ts` beside the executable is the same leak as one
    // embedded in it, and easier to miss.
    fail("the artifact directory holds files that are not part of the release", { unexpected });
  }
}

export async function verifyArtifact(target) {
  const tag = assertBuildableTarget(target);
  const artifact = artifactPath(tag);
  if (!existsSync(artifact)) fail("there is no artifact to verify", { expected: artifact });
  if ((await stat(artifact)).size === 0) fail("the artifact is empty", { artifact });

  await assertNoForbiddenContent(REPOSITORY_ROOT);

  const directory = path.dirname(artifact);
  const manifest = await artifactManifest(tag, artifact);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "artifact-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(directory, "SHA256SUMS"), formatChecksums(manifest.files), "utf8");

  // Written first, then checked: the two files we just wrote are part of the
  // release, and anything else in there is not.
  await assertNoLooseSources(directory);
  return manifest;
}

async function main(argv) {
  const manifest = await verifyArtifact(argv[0]);
  process.stderr.write(
    `verify-artifact: ${manifest.platform} ${manifest.commit}${manifest.dirty ? " (dirty)" : ""}\n`,
  );
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  main(process.argv.slice(2)).catch(() => {
    // `fail` already reported the reason and set the exit code.
  });
}
