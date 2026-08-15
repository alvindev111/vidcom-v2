import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { artifactPath, createArtifactGenerationId } from "./artifact-publish.mjs";
import {
  SECONDARY_BUNDLE_PATH,
  runtimeAssetRoot,
  runtimeConfigPath,
  runtimeInputPath,
  runtimeStageRoot,
} from "./artifact-layout.mjs";
import { parseSeaBuildSeal, serializeSeaBuildSeal } from "./sea-build-seal.mjs";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Platform tags this build knows how to produce.
 *
 * One per host. There is no cross-build: the artifact embeds a Node binary and
 * an extracted native runtime for the machine it was made on, and a "Linux
 * build" produced on macOS would be a file that cannot run anywhere. Failing
 * here is better than shipping that.
 */
export const PLATFORM_TAGS = {
  darwin: { arm64: "darwin-arm64" },
  win32: { x64: "win32-x64" },
  linux: { x64: "linux-x64" },
};

function fail(message, details) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`build-artifact: ${message}${payload}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

export function hostPlatformTag(platform = process.platform, architecture = process.arch) {
  const tag = PLATFORM_TAGS[platform]?.[architecture];
  if (!tag) {
    fail(`unsupported build host ${platform}-${architecture}`, {
      supported: Object.values(PLATFORM_TAGS).flatMap((architectures) => Object.values(architectures)),
    });
  }
  return tag;
}

/**
 * Runs one build step, and stops the whole build if it fails.
 *
 * Fail-fast is the point rather than a preference: a stale `frontend.pack`
 * carried past a failed pack step and bundled with fresh code produces an
 * artifact that only misbehaves once someone runs it, which is the most
 * expensive place to find out.
 */
function step(name, command, args, captureStdout = false, forwardCapturedStdout = true) {
  process.stderr.write(`build-artifact: ${name}\n`);
  const result = spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    stdio: captureStdout ? ["ignore", "pipe", "inherit"] : ["ignore", "inherit", "inherit"],
    shell: false,
    encoding: captureStdout ? "utf8" : undefined,
  });
  if (captureStdout && forwardCapturedStdout && result.stdout) process.stderr.write(result.stdout);
  if (result.error) fail(`${name} could not start`, { cause: result.error.message });
  if (result.status !== 0) fail(`${name} failed`, { exitCode: result.status });
  return captureStdout ? result.stdout ?? "" : "";
}

export function verifierArgumentsWithSeaBuildSeal(args, record, tag, generationId) {
  const seal = parseSeaBuildSeal(record);
  if (seal.tag !== tag || seal.generationId !== generationId) {
    fail("SEA build seal does not belong to this build plan");
  }
  return [...args, "--seal", serializeSeaBuildSeal(seal).trimEnd()];
}

export function parseBuildArtifactArguments(argv) {
  const options = { json: false, release: false, target: undefined, runtimeInputs: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") {
      options.json = true;
      continue;
    }
    if (flag === "--release") {
      options.release = true;
      continue;
    }
    if (flag === "--target") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail("--target requires a platform tag", {
          usage: "build-artifact [--target <tag>] [--runtime-inputs <file>] [--release] [--json]",
        });
      }
      options.target = value;
      index += 1;
      continue;
    }
    if (flag === "--runtime-inputs") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail("--runtime-inputs requires a file", {
          usage: "build-artifact [--target <tag>] [--runtime-inputs <file>] [--release] [--json]",
        });
      }
      options.runtimeInputs = value;
      index += 1;
      continue;
    }
    fail(`unknown argument ${flag}`, {
      usage: "build-artifact [--target <tag>] [--runtime-inputs <file>] [--release] [--json]",
    });
  }
  return options;
}

export function planSteps({
  tag = hostPlatformTag(),
  runtimeInputs = runtimeInputPath(tag),
  generationId = "plan",
  release = false,
} = {}) {
  const stageRoot = runtimeStageRoot(tag);
  const configPath = runtimeConfigPath(tag);
  const assetRoot = runtimeAssetRoot(tag);
  // The order is the dependency order, and each entry names the checklist task
  // that owns it so a missing step is traceable to the work that adds it.
  return [
    // `bun`, not `npm`: on Windows `npm` is a `.cmd` and Node refuses to spawn
    // one without a shell, so this step would fail there for a reason that has
    // nothing to do with the export. Bun is a real executable on all three.
    { name: "static export (G.6)", command: "bun", args: ["run", "build"] },
    // The pack step runs under Bun so it can read the resolver in
    // `sea-static-host.ts` directly. The manifest's cache policy has to be the
    // one the host applies at runtime, and the only way to guarantee that is to
    // ask the same function rather than restate its rules here.
    { name: "frontend pack (H.2)", command: "bun", args: ["scripts/build-frontend-pack.mjs"] },
    { name: "secondary cjs bundle (H.1)", command: process.execPath, args: ["scripts/build-cli-bundle.mjs"] },
    {
      name: "runtime staging (D.3)",
      command: process.execPath,
      args: [
        "scripts/stage-artifact-runtime.mjs",
        "--inputs", path.resolve(runtimeInputs),
        "--boot", SECONDARY_BUNDLE_PATH,
        "--output", stageRoot,
        "--config", configPath,
      ],
    },
    {
      name: "runtime archives (B.3)",
      command: process.execPath,
      args: [
        "scripts/build-runtime-archives.mjs",
        "--config", configPath,
        "--output", assetRoot,
      ],
    },
    { name: "SEA bootstrap bundle (H.1)", command: process.execPath, args: ["scripts/build-sea-bootstrap.mjs"] },
    {
      name: "sea native (H.4)",
      command: process.execPath,
      args: ["scripts/build-sea.mjs", tag, "--generation", generationId],
      producesSeaBuildSeal: true,
    },
    {
      name: "verify artifact (L.1)",
      command: process.execPath,
      args: [
        "scripts/verify-artifact.mjs",
        tag,
        "--generation",
        generationId,
        ...(release ? ["--release"] : []),
      ],
      requiresSeaBuildSeal: true,
    },
  ];
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function acquireArtifactBuildLock(
  tag,
  root = path.join(REPOSITORY_ROOT, "dist", "artifact"),
) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(tag)) {
    throw new Error(`invalid artifact build-lock tag ${tag}`);
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
    || path.resolve(realpathSync(root)) !== path.resolve(root)) {
    throw new Error("artifact build-lock root must be one canonical real directory");
  }
  const lockPath = path.join(root, `.build-${tag}.lock`);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeFileSync(
          path.join(lockPath, "owner.json"),
          `${JSON.stringify({ version: 1, pid: process.pid, token })}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }

      let released = false;
      return {
        path: lockPath,
        release() {
          if (released) return;
          const owner = JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8"));
          if (owner.token !== token || owner.pid !== process.pid) {
            throw new Error(`artifact build lock ownership changed for ${tag}`);
          }
          rmSync(lockPath, { recursive: true, force: true });
          released = true;
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let owner;
    try {
      owner = JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8"));
    } catch {
      throw new Error(`artifact build lock is incomplete for ${tag}; refuse unsafe reclaim`);
    }
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string") {
      throw new Error(`artifact build lock is invalid for ${tag}; refuse unsafe reclaim`);
    }
    if (processIsAlive(owner.pid)) {
      throw new Error(`artifact build already active for ${tag} (pid ${owner.pid})`);
    }

    const stalePath = `${lockPath}.stale-${randomUUID()}`;
    try {
      renameSync(lockPath, stalePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    rmSync(stalePath, { recursive: true, force: true });
  }
  throw new Error(`could not acquire artifact build lock for ${tag}`);
}

export function assertBuildableTarget(
  target,
  platform = process.platform,
  architecture = process.arch,
) {
  const tag = hostPlatformTag(platform, architecture);
  if (target !== undefined && target !== tag) {
    fail("cross-building is not supported", { requested: target, host: tag });
  }
  return tag;
}

export function buildArtifactReport(artifact) {
  const provenancePath = path.join(path.dirname(artifact), "artifact-manifest.json");
  return JSON.parse(readFileSync(provenancePath, "utf8"));
}

export function formatBuildArtifactJson(artifact) {
  return `${JSON.stringify(buildArtifactReport(artifact))}\n`;
}

function main(argv) {
  const options = parseBuildArtifactArguments(argv);
  const tag = assertBuildableTarget(options.target);
  const runtimeInputs = options.runtimeInputs === undefined
    ? runtimeInputPath(tag)
    : path.resolve(options.runtimeInputs);
  const generationId = createArtifactGenerationId();
  const buildLock = acquireArtifactBuildLock(tag);

  try {
  let seaBuildSeal;
  for (const entry of planSteps({
    tag,
    runtimeInputs,
    generationId,
    release: options.release,
  })) {
    const args = entry.requiresSeaBuildSeal
      ? verifierArgumentsWithSeaBuildSeal(entry.args, seaBuildSeal, tag, generationId)
      : entry.args;
    const captureStdout = options.json || entry.producesSeaBuildSeal === true;
    const stdout = step(
      entry.name,
      entry.command,
      args,
      captureStdout,
      entry.producesSeaBuildSeal !== true,
    );
    if (entry.producesSeaBuildSeal) {
      const seal = parseSeaBuildSeal(stdout);
      if (seal.tag !== tag || seal.generationId !== generationId) {
        fail("SEA build seal does not belong to this build plan");
      }
      seaBuildSeal = serializeSeaBuildSeal(seal).trimEnd();
    }
  }

  const artifact = artifactPath(tag);
  // stderr carries progress; stdout stays clean so `--json` can be piped.
  process.stderr.write(`build-artifact: ${artifact} (${tag})\n`);
  if (options.json) {
    process.stdout.write(formatBuildArtifactJson(artifact));
  }
  } finally {
    buildLock.release();
  }
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (!process.exitCode) {
      process.stderr.write(`build-artifact: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
