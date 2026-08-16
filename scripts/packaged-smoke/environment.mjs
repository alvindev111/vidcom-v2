import { randomBytes } from "node:crypto";
import { cp, mkdtemp, mkdir, readdir, realpath, rm } from "node:fs/promises";
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
export function smokeEnvironment(root, base = process.env, directories = {}) {
  const home = directories.home ?? path.join(root, "home");
  return {
    ...Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith("VIDCOM_"))),
    PATH: emptyPath(directories.emptyBin ?? path.join(root, "empty-bin")),
    HOME: home,
    USERPROFILE: home,
    // Seeded caches live under the temporary HOME, so a warm run reads them and
    // a cold run is genuinely cold.
    XDG_CACHE_HOME: path.join(home, ".cache"),
    HF_HOME: path.join(home, ".cache", "huggingface"),
    VIDCOM_APP_DATA: directories.appData ?? path.join(root, "app-data"),
    // The same hand-off `app` mode mints for a browser, supplied here instead.
    // `serve` is headless by design and opens nothing, so a smoke that waited
    // for it to print a token would wait forever — and using `app` would put a
    // browser window on a runner.
    VIDCOM_BOOTSTRAP_NONCE: randomBytes(32).toString("base64url"),
    // Strict turns a missing required component into a failure rather than a
    // skip, which is the whole point of running this in a job (R8.4).
    VIDCOM_DOCTOR_STRICT: "1",
    ...(base.VIDCOM_SMOKE_RELEASE === "1" ? { VIDCOM_SMOKE_RELEASE: "1" } : {}),
    ...(base.VIDCOM_SMOKE_EXPECTED_COMMIT
      ? { VIDCOM_SMOKE_EXPECTED_COMMIT: base.VIDCOM_SMOKE_EXPECTED_COMMIT }
      : {}),
  };
}

/**
 * Resolves every harness path after creation so Windows 8.3 aliases cannot split identity.
 *
 * @param {Record<string, string>} directories
 * @param {(pathname: string) => Promise<string>} canonicalize
 */
export async function canonicalSmokeDirectories(directories, canonicalize = realpath) {
  return Object.freeze(Object.fromEntries(await Promise.all(
    Object.entries(directories).map(async ([name, pathname]) => [name, await canonicalize(pathname)]),
  )));
}

/**
 * Copies one cache directory, and says which entries it could not copy.
 *
 * `tolerateErrors` splits the two directions this runs in. Seeding a cache
 * before the run is part of the setup a step then makes claims about, so a
 * failure there has to stop the run. Persisting it afterwards is an
 * optimisation for the next run — a failure costs a download, and letting it
 * throw once cost thirteen steps of evidence, which is the trade this argument
 * exists to stop being made silently.
 */
export async function copyCacheContents(source, destination, options = {}) {
  const entries = await readdir(source, { withFileTypes: true }).catch(() => []);
  // An absent cache must remain absent. Creating an empty component directory
  // makes the production coordinator classify it as `ready`, which turns a
  // first install into a forced repair instead of a normal download.
  if (entries.length === 0) return [];
  await mkdir(destination, { recursive: true });
  const failures = [];
  for (const entry of entries) {
    try {
      await cp(path.join(source, entry.name), path.join(destination, entry.name), {
        recursive: true,
        force: true,
        // Hugging Face snapshots use relative links into their sibling blob
        // store. Node otherwise rewrites them to the temporary smoke root, so
        // the persisted cache becomes dangling as soon as that root is removed.
        verbatimSymlinks: true,
      });
    } catch (error) {
      if (options.tolerateErrors !== true) throw error;
      failures.push({
        entry: path.join(destination, entry.name),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failures;
}

export async function createSmokeRoot() {
  const requestedRoot = await mkdtemp(path.join(tmpdir(), "vidcom-smoke-"));
  const requested = {
    root: requestedRoot,
    workspace: path.join(requestedRoot, "workspace"),
    cwd: path.join(requestedRoot, "cwd"),
    appData: path.join(requestedRoot, "app-data"),
    home: path.join(requestedRoot, "home"),
    emptyBin: path.join(requestedRoot, "empty-bin"),
  };
  await Promise.all([
    mkdir(path.join(requested.home, ".cache", "huggingface"), { recursive: true }),
    mkdir(requested.appData, { recursive: true }),
    mkdir(requested.workspace, { recursive: true }),
    // The artifact is launched from here, so anything it drops beside its
    // working directory shows up as an entry nobody put there.
    mkdir(requested.cwd, { recursive: true }),
    // The only directory on PATH, and it stays empty: `which node` has to come
    // back with nothing rather than with something the runner installed.
    mkdir(requested.emptyBin, { recursive: true }),
  ]);
  // Canonicalize the children, not just the temp parent. Windows can report the
  // parent through RUNNER~1 while production opens app-data/workspace through
  // their long names; discovery hashes the workspace string, so those aliases
  // must collapse before the harness derives either identity.
  const directories = await canonicalSmokeDirectories(requested);
  const { root, workspace, cwd, appData, home, emptyBin } = directories;
  const cacheRoot = process.env.VIDCOM_SMOKE_CACHE_ROOT
    ? path.resolve(process.env.VIDCOM_SMOKE_CACHE_ROOT)
    : null;
  if (cacheRoot) {
    await Promise.all([
      copyCacheContents(path.join(cacheRoot, "home-cache"), path.join(root, "home", ".cache")),
      copyCacheContents(path.join(cacheRoot, "browser-cache"), path.join(root, "app-data", "browser-cache")),
      copyCacheContents(path.join(cacheRoot, "model-cache"), path.join(root, "app-data", "models")),
    ]);
  }
  return {
    root,
    workspace,
    cwd,
    appData,
    environment: smokeEnvironment(root, process.env, { home, emptyBin, appData }),
    async dispose() {
      const failures = cacheRoot
        ? (await Promise.all([
          copyCacheContents(path.join(root, "home", ".cache"), path.join(cacheRoot, "home-cache"), { tolerateErrors: true }),
          copyCacheContents(path.join(root, "app-data", "browser-cache"), path.join(cacheRoot, "browser-cache"), { tolerateErrors: true }),
          copyCacheContents(path.join(root, "app-data", "models"), path.join(cacheRoot, "model-cache"), { tolerateErrors: true }),
        ])).flat()
        : [];
      // Removed even when the write-back could not finish: a smoke root left on
      // disk is hundreds of megabytes per run, and the entries that failed are
      // named in the report rather than kept around to be guessed at.
      await rm(root, { recursive: true, force: true });
      return failures;
    },
  };
}
