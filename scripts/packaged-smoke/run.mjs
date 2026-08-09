import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { artifactPath } from "../build-sea.mjs";
import { hostPlatformTag } from "../stage-artifact-runtime.mjs";
import {
  failedStepIds,
  parseSmokeArgs,
  selectSteps,
  smokeExitCode,
} from "./steps.mjs";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Why a step could not run, when it could not.
 *
 * Named rather than swallowed: every step below drives the packaged executable,
 * and the executable needs its runtime extracted. Saying so is the difference
 * between a smoke that is honestly incomplete and one that looks green.
 */
function blockedReason() {
  // `hostPlatformTag()` resolves platform *and* architecture. The build's own
  // table is keyed by both, so indexing it with the platform alone yields an
  // object that reads as a tag right up until something tries to use it.
  let tag;
  try {
    tag = hostPlatformTag();
  } catch {
    return `there is no artifact for ${process.platform}-${process.arch}`;
  }
  const artifact = artifactPath(tag);
  if (!existsSync(artifact)) {
    return `no artifact at ${path.relative(REPOSITORY_ROOT, artifact)}; run \`bun run build:artifact\``;
  }
  return null;
}

function hostArtifactTag() {
  try {
    return hostPlatformTag();
  } catch {
    return `${process.platform}-${process.arch}`;
  }
}

async function runStep(step) {
  const startedAt = Date.now();
  const blocked = blockedReason();
  if (blocked !== null) {
    return {
      id: step.id,
      required: step.required,
      status: "skipped",
      durationMs: Date.now() - startedAt,
      detail: blocked,
    };
  }
  // Each step's body lands with the platform job that runs it (M.3a–M.3d).
  // Until then a present artifact still reports honestly rather than passing.
  return {
    id: step.id,
    required: step.required,
    status: "skipped",
    durationMs: Date.now() - startedAt,
    detail: "this step has no body yet",
  };
}

async function main(argv) {
  const options = parseSmokeArgs(argv);
  const results = [];
  for (const step of selectSteps(options)) {
    const result = await runStep(step);
    results.push(result);
    // Progress on stderr so stdout stays clean for the evidence document.
    process.stderr.write(
      `${result.status.padEnd(7)} ${result.id} ${String(result.durationMs)}ms`
      + `${result.detail === undefined ? "" : ` — ${result.detail}`}\n`,
    );
  }

  process.stdout.write(`${JSON.stringify({
    version: 1,
    platform: hostArtifactTag(),
    strict: options.strict === true,
    steps: results,
  }, null, 2)}\n`);

  const failed = failedStepIds(results, options);
  if (failed.length > 0) {
    // Named, never just "smoke failed": thirteen steps and one message is a
    // report somebody has to reproduce locally to understand.
    process.stderr.write(`packaged-smoke: failed at ${failed.join(", ")}\n`);
  }
  process.exitCode = smokeExitCode(results, options);
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`packaged-smoke: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
