import { chmod, lstat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { REPOSITORY_ROOT } from "./artifact-layout.mjs";

/**
 * Restores the execute bit `node-pty`'s spawn helper needs on Darwin.
 *
 * On macOS — and only there — `node-pty` does not fork: it `posix_spawn`s a
 * `spawn-helper` binary shipped inside its prebuild, which then execs the real
 * command. A helper without the execute bit therefore fails every pty open with
 * `posix_spawnp failed.` — no errno, no path, nothing naming the file.
 *
 * The bit goes missing during install rather than in the published package: the
 * macOS CI runner's `bun install` produced `0644` where a developer machine had
 * `0755`, so the four real-pty tests failed on that runner alone while Linux and
 * Windows — which take the fork path — stayed green.
 *
 * The artifact build already asserts this for the runtime it stages. This exists
 * for the other direction: a test run out of a checkout, where nothing had ever
 * stated the requirement.
 */
export const NODE_PTY_HELPER_PLATFORMS = Object.freeze(["darwin-arm64", "darwin-x64"]);

function fail(message, details) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  throw new Error(`normalize-node-pty-helper: ${message}${payload}`);
}

/**
 * Where the installed `node-pty` actually is.
 *
 * Resolved through the adapter, which is the package that declares it — asking
 * from the repository root finds nothing, because the dependency belongs to the
 * workspace rather than to the root manifest.
 */
export function nodePtyRoot(repositoryRoot = REPOSITORY_ROOT) {
  const requireFromAdapter = createRequire(
    path.join(repositoryRoot, "packages", "adapter", "package.json"),
  );
  return path.dirname(requireFromAdapter.resolve("node-pty/package.json"));
}

/**
 * Marks every present Darwin spawn helper executable and reports what changed.
 *
 * A prebuild for another platform being absent is normal — an install carries
 * the ones it needs — so a missing directory is not a failure. A helper that is
 * present and cannot be made executable is.
 */
export async function normalizeNodePtyHelpers(packageRoot = nodePtyRoot(), platform = process.platform) {
  // Windows has no POSIX execute bit and no spawn helper — node-pty talks to
  // ConPTY there. Saying so here rather than at the call site keeps the one
  // statement of where this requirement exists in one place.
  if (platform !== "darwin") return [];
  const normalized = [];
  for (const platform of NODE_PTY_HELPER_PLATFORMS) {
    const helper = path.join(packageRoot, "prebuilds", platform, "spawn-helper");
    const metadata = await lstat(helper).catch(() => null);
    if (metadata === null) continue;
    if (!metadata.isFile()) fail("the spawn helper is not a regular file", { helper });
    if ((metadata.mode & 0o111) !== 0) continue;
    await chmod(helper, 0o755);
    const repaired = await lstat(helper);
    if ((repaired.mode & 0o111) === 0) fail("the spawn helper is still not executable", { helper });
    normalized.push(helper);
  }
  return normalized;
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  normalizeNodePtyHelpers()
    .then((normalized) => {
      if (process.platform !== "darwin") {
        process.stderr.write("normalize-node-pty-helper: not needed off Darwin\n");
        return;
      }
      process.stderr.write(normalized.length === 0
        ? "normalize-node-pty-helper: the spawn helper was already executable\n"
        : `normalize-node-pty-helper: marked executable ${normalized.join(", ")}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
