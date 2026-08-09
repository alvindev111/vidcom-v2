import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * An empty PATH, not a filtered one.
 *
 * Filtering by directory name was wrong and the smoke said so on the first real
 * run: `/opt/homebrew/bin` holds `node` while containing none of the words a
 * filter looks for. The promise under test is that the executable carries its
 * own Node and its own Python, and the only way to state that is to hand it a
 * PATH with nothing on it at all.
 */
export function emptyPath(binDirectory) {
  return binDirectory;
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
    PATH: emptyPath(path.join(root, "empty-bin")),
    HOME: home,
    USERPROFILE: home,
    // Seeded caches live under the temporary HOME, so a warm run reads them and
    // a cold run is genuinely cold.
    XDG_CACHE_HOME: path.join(home, ".cache"),
    HF_HOME: path.join(home, ".cache", "huggingface"),
    VIDCOM_APP_DATA: path.join(root, "app-data"),
    // The same hand-off `app` mode mints for a browser, supplied here instead.
    // `serve` is headless by design and opens nothing, so a smoke that waited
    // for it to print a token would wait forever — and using `app` would put a
    // browser window on a runner.
    VIDCOM_BOOTSTRAP_NONCE: randomBytes(32).toString("base64url"),
    // Strict turns a missing required component into a failure rather than a
    // skip, which is the whole point of running this in a job (R8.4).
    VIDCOM_DOCTOR_STRICT: "1",
  };
}

export async function createSmokeRoot() {
  // Canonical from the start. On macOS `mkdtemp` hands back a path under
  // `/var`, which is a symlink to `/private/var` — and the filesystem browser
  // walks real directories, so a fixture addressed through the symlink cannot
  // be descended into.
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-smoke-")));
  const workspace = path.join(root, "workspace");
  await Promise.all([
    mkdir(path.join(root, "home", ".cache", "huggingface"), { recursive: true }),
    mkdir(path.join(root, "app-data"), { recursive: true }),
    mkdir(workspace, { recursive: true }),
    // The artifact is launched from here, so anything it drops beside its
    // working directory shows up as an entry nobody put there.
    mkdir(path.join(root, "cwd"), { recursive: true }),
    // The only directory on PATH, and it stays empty: `which node` has to come
    // back with nothing rather than with something the runner installed.
    mkdir(path.join(root, "empty-bin"), { recursive: true }),
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
