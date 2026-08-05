import { z } from "zod";

import type { RelPath } from "./domain";

/**
 * Motion libraries the studio vendors into a project instead of loading from a
 * CDN. A remote `<script>` costs the render its `reproducible` flag and stops
 * working entirely once the app is packaged for offline use, so the pinned copy
 * is the only supported form.
 */
export type MotionLibraryId = "gsap" | "anime" | "motion-one" | "lottie" | "three";

/**
 * `global` libraries load with a plain `<script src>` and install a browser
 * global; `module` libraries have no UMD build and need `<script type="module">`.
 */
export type MotionLibraryLoader = "global" | "module";

export interface MotionLibraryFile {
  /** Forward-slashed path inside the npm package. */
  packagePath: string;
  /** Destination inside the project, always under `assets/vendor/`. */
  projectPath: RelPath;
}

export interface MotionLibrary {
  id: MotionLibraryId;
  packageName: string;
  /** Pinned version; the adapter refuses to vendor a different installed one. */
  version: string;
  loader: MotionLibraryLoader;
  /** Browser global the library installs, or null for `module` loaders. */
  globalName: string | null;
  /** One line telling an author when this library is the right choice. */
  role: string;
  /**
   * Every file that must land in the project. Sibling files matter: Three.js
   * ships `three.module.min.js` with a hardcoded `./three.core.min.js` import,
   * so both are vendored into the same directory under their original names.
   */
  files: readonly [MotionLibraryFile, ...MotionLibraryFile[]];
  /** The file a composition references; the first entry of `files`. */
  entry: RelPath;
  /**
   * Lowercase fragments identifying this library inside a remote script URL.
   * Kept narrow on purpose: a bare "motion" or "three" would flag unrelated
   * scripts, and a false diagnostic teaches an author to ignore the real ones.
   */
  urlTokens: readonly string[];
}

function library(
  id: MotionLibraryId,
  packageName: string,
  version: string,
  loader: MotionLibraryLoader,
  globalName: string | null,
  role: string,
  packagePaths: readonly [string, ...string[]],
  urlTokens: readonly string[],
): MotionLibrary {
  const directory = `assets/vendor/${id}-${version}`;
  const vendored = (packagePath: string): MotionLibraryFile => ({
    packagePath,
    projectPath: `${directory}/${packagePath.slice(packagePath.lastIndexOf("/") + 1)}` as RelPath,
  });
  const [first, ...rest] = packagePaths;
  const files: [MotionLibraryFile, ...MotionLibraryFile[]] = [vendored(first), ...rest.map(vendored)];
  return {
    id,
    packageName,
    version,
    loader,
    globalName,
    role,
    files,
    entry: files[0].projectPath,
    urlTokens,
  };
}

/** Pinned catalogue; versions MUST match what the adapter package installs. */
export const MOTION_LIBRARIES: readonly MotionLibrary[] = [
  library(
    "gsap",
    "gsap",
    "3.15.0",
    "global",
    "gsap",
    "Default choice for DOM, SVG and kinetic typography timelines.",
    ["dist/gsap.min.js"],
    ["gsap"],
  ),
  library(
    "anime",
    "animejs",
    "4.5.0",
    "global",
    "anime",
    "Lighter timeline alternative when GSAP would be overkill.",
    ["dist/bundles/anime.umd.min.js"],
    ["animejs", "anime.min.js", "anime.umd"],
  ),
  library(
    "motion-one",
    "motion",
    "12.43.0",
    "global",
    "Motion",
    "Web Animations API wrapper for small browser-native motion.",
    ["dist/motion.js"],
    ["motion@", "/motion/", "motion.min.js", "motion.dev"],
  ),
  library(
    "lottie",
    "lottie-web",
    "5.13.0",
    "global",
    "lottie",
    "Plays After Effects animations delivered as Lottie JSON.",
    ["build/player/lottie.min.js"],
    ["lottie"],
  ),
  library(
    "three",
    "three",
    "0.185.1",
    "module",
    null,
    "3D scenes, shaders and particle systems.",
    ["build/three.module.min.js", "build/three.core.min.js"],
    ["three@", "/three/", "three.min.js", "three.module", "three.core"],
  ),
];

export const MOTION_LIBRARY_IDS: readonly MotionLibraryId[] = MOTION_LIBRARIES.map(({ id }) => id);

/**
 * Boundary schema derived from the catalogue, so adding a library cannot leave a
 * transport rejecting an id the studio already vendors.
 */
export const MotionLibraryIdSchema = z.enum(
  MOTION_LIBRARY_IDS as [MotionLibraryId, ...MotionLibraryId[]],
);

export function findMotionLibrary(id: string): MotionLibrary | null {
  return MOTION_LIBRARIES.find((candidate) => candidate.id === id) ?? null;
}

/** The tag an author puts in `<head>` once the library is vendored. */
export function motionLibraryScriptTag(library: MotionLibrary, prefix = ""): string {
  return library.loader === "module"
    ? `<script type="module" src="${prefix}${library.entry}"></script>`
    : `<script src="${prefix}${library.entry}"></script>`;
}

/**
 * The specifier to `import` from inside the author's own module script, or null
 * when the library installs a browser global instead.
 *
 * A `module` library needs this: its `<script type="module" src>` tag runs the
 * module but binds no name, so a tag alone gives the author nothing to call.
 */
export function motionLibraryImportSpecifier(library: MotionLibrary): string | null {
  return library.loader === "module" ? `./${library.entry}` : null;
}

export interface RemoteMotionLibraryUse {
  id: MotionLibraryId;
  url: string;
  file: RelPath;
}

/**
 * Finds remote `<script src>` tags that load a catalogued motion library, so
 * diagnostics can point the author at the vendored copy instead.
 */
export function scanRemoteMotionLibraries(
  documents: readonly { path: RelPath; html: string }[],
): RemoteMotionLibraryUse[] {
  const found: RemoteMotionLibraryUse[] = [];
  const seen = new Set<string>();
  for (const document of documents) {
    for (const tag of document.html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu)) {
      const url = tag[1]!.trim();
      if (!/^(?:https?:)?\/\//iu.test(url)) continue;
      const lower = url.toLowerCase();
      const match = MOTION_LIBRARIES.find(({ urlTokens }) => urlTokens.some((token) => lower.includes(token)));
      if (!match) continue;
      const key = `${document.path}\0${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ id: match.id, url, file: document.path });
    }
  }
  return found;
}
