import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * PATH entries that would let the artifact cheat.
 *
 * The promise being tested is that the executable carries its own Node and its
 * own Python. A runner has both installed for the rest of CI, so leaving them
 * on PATH means a packaged build with a broken runtime still passes — and the
 * failure only appears on a user's machine, which is the one place nobody is
 * watching.
 */
export const FORBIDDEN_PATH_MARKERS = Object.freeze([
  "node", "nodejs", "python", "python3", "bun", "hostedtoolcache", "pyenv", "nvm",
]);

export function scrubbedPath(rawPath, delimiter = path.delimiter) {
  return (rawPath ?? "")
    .split(delimiter)
    .filter(Boolean)
    .filter((entry) => {
      const lowered = entry.toLowerCase();
      return !FORBIDDEN_PATH_MARKERS.some((marker) => lowered.includes(marker));
    })
    .join(delimiter);
}

/**
 * The environment the packaged executable is allowed to see.
 *
 * `HOME` is redirected rather than emptied: the artifact writes its caches
 * somewhere, and pointing that somewhere at a temporary directory is what makes
 * "the artifact left nothing behind" checkable instead of assumed. The download
 * caches are seeded because their absence is a different test — R8.2 is about a
 * clean machine, not a machine without a network.
 */
export function smokeEnvironment(root, base = process.env) {
  const home = path.join(root, "home");
  return {
    ...Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith("VIDCOM_"))),
    PATH: scrubbedPath(base.PATH),
    HOME: home,
    USERPROFILE: home,
    // Seeded caches live under the temporary HOME, so a warm run reads them and
    // a cold run is genuinely cold.
    XDG_CACHE_HOME: path.join(home, ".cache"),
    HF_HOME: path.join(home, ".cache", "huggingface"),
    VIDCOM_APP_DATA: path.join(root, "app-data"),
    // Strict turns a missing required component into a failure rather than a
    // skip, which is the whole point of running this in a job (R8.4).
    VIDCOM_DOCTOR_STRICT: "1",
  };
}

export async function createSmokeRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-smoke-"));
  const workspace = path.join(root, "workspace");
  await Promise.all([
    mkdir(path.join(root, "home", ".cache", "huggingface"), { recursive: true }),
    mkdir(path.join(root, "app-data"), { recursive: true }),
    mkdir(workspace, { recursive: true }),
    // The artifact is launched from here, so anything it drops beside its
    // working directory shows up as an entry nobody put there.
    mkdir(path.join(root, "cwd"), { recursive: true }),
  ]);
  return {
    root,
    workspace,
    cwd: path.join(root, "cwd"),
    appData: path.join(root, "app-data"),
    environment: smokeEnvironment(root),
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
