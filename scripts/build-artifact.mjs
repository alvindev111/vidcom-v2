import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  darwin: "darwin-arm64",
  win32: "win32-x64",
  linux: "linux-x64",
};

function fail(message, details) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`build-artifact: ${message}${payload}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function platformTag() {
  const tag = PLATFORM_TAGS[process.platform];
  if (!tag) fail(`unsupported build platform ${process.platform}`, { supported: Object.keys(PLATFORM_TAGS) });
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
function step(name, command, args) {
  process.stderr.write(`build-artifact: ${name}\n`);
  const result = spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    shell: false,
  });
  if (result.error) fail(`${name} could not start`, { cause: result.error.message });
  if (result.status !== 0) fail(`${name} failed`, { exitCode: result.status });
}

function commandLine(argv) {
  const options = { json: false, target: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") {
      options.json = true;
      continue;
    }
    if (flag === "--target") {
      options.target = argv[index + 1];
      index += 1;
      continue;
    }
    fail(`unknown argument ${flag}`, { usage: "build-artifact [--target <tag>] [--json]" });
  }
  return options;
}

export function planSteps() {
  // The order is the dependency order, and each entry names the checklist task
  // that owns it so a missing step is traceable to the work that adds it.
  return [
    { name: "runtime archives (B.3)", command: process.execPath, args: ["scripts/build-runtime-archives.mjs"] },
    // `bun`, not `npm`: on Windows `npm` is a `.cmd` and Node refuses to spawn
    // one without a shell, so this step would fail there for a reason that has
    // nothing to do with the export. Bun is a real executable on all three.
    { name: "static export (G.6)", command: "bun", args: ["run", "build"] },
    // The pack step runs under Bun so it can read the resolver in
    // `sea-static-host.ts` directly. The manifest's cache policy has to be the
    // one the host applies at runtime, and the only way to guarantee that is to
    // ask the same function rather than restate its rules here.
    { name: "frontend pack (H.2)", command: "bun", args: ["scripts/build-frontend-pack.mjs"] },
    { name: "cjs bundle (H.1)", command: process.execPath, args: ["scripts/build-cli-bundle.mjs"] },
    { name: "sea native (H.4)", command: process.execPath, args: ["scripts/build-sea.mjs"] },
    { name: "verify artifact (L.1)", command: process.execPath, args: ["scripts/verify-artifact.mjs"] },
  ];
}

export function assertBuildableTarget(target) {
  const tag = platformTag();
  if (target !== undefined && target !== tag) {
    fail("cross-building is not supported", { requested: target, host: tag });
  }
  return tag;
}

function main(argv) {
  const options = commandLine(argv);
  const tag = assertBuildableTarget(options.target);

  for (const entry of planSteps()) step(entry.name, entry.command, entry.args);

  const artifact = path.join(REPOSITORY_ROOT, "dist", "artifact", tag);
  // stderr carries progress; stdout stays clean so `--json` can be piped.
  process.stderr.write(`build-artifact: ${artifact} (${tag})\n`);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ artifact, platform: tag })}\n`);
  }
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  try {
    main(process.argv.slice(2));
  } catch {
    // `fail` already reported the reason and set the exit code.
  }
}
