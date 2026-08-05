import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { ErrorCode, type DomainError, type RelPath } from "@vidcom/contracts";
import {
  err,
  ok,
  type AbsolutePath,
  type MotionLibrary,
  type MotionLibraryFilesPort,
  type Result,
} from "@vidcom/core";

const requireFromAdapter = createRequire(import.meta.url);
const resolveFromAdapter = Reflect.get(requireFromAdapter, "resolve") as (specifier: string) => string;

/**
 * Locates an installed package's root directory. Deep `require.resolve` is not
 * usable here: `animejs`, `motion` and `three` all declare an `exports` map that
 * rejects the browser build path — and `three` rejects its own `package.json` —
 * so the entry point is resolved instead and the tree walked up to the manifest.
 */
function resolvedPackageRoot(packageName: string): string | null {
  let directory: string;
  try {
    directory = path.dirname(Reflect.apply(resolveFromAdapter, requireFromAdapter, [packageName]));
  } catch {
    return null;
  }
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
        if (parsed.name === packageName) return directory;
      } catch {
        return null;
      }
    }
    directory = path.dirname(directory);
  }
  return null;
}

function installedVersion(root: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Serves the motion library catalogue from the adapter's own installed packages,
 * so a vendored copy always carries the version the manifest promises. A version
 * mismatch fails loudly rather than shipping unpinned bytes into a project.
 *
 * `libraryRoot` exists for the packaged runtime, which has no `node_modules` to
 * resolve against: point it at the directory the distribution extracts, laid out
 * as `<packageName>/<packagePath>` and keeping each `package.json` so the version
 * pin is still checked. Omitted, the checkout's installed packages are used.
 */
export class NodeModulesMotionLibraryFiles implements MotionLibraryFilesPort {
  constructor(private readonly libraryRoot?: AbsolutePath) {}

  private packageRoot(packageName: string): string | null {
    if (!this.libraryRoot) return resolvedPackageRoot(packageName);
    const candidate = path.join(this.libraryRoot, packageName);
    return existsSync(path.join(candidate, "package.json")) ? candidate : null;
  }

  async read(
    library: MotionLibrary,
  ): Promise<Result<Array<{ projectPath: RelPath; content: string }>, DomainError>> {
    const root = this.packageRoot(library.packageName);
    if (!root) {
      return err({
        code: ErrorCode.StorageUnavailable,
        message: `motion library ${library.packageName} is not available${this.libraryRoot ? " in the distributed library root" : " from the installed packages"}`,
      });
    }
    const version = installedVersion(root);
    if (version !== library.version) {
      return err({
        code: ErrorCode.StorageUnavailable,
        message: `motion library ${library.packageName} is pinned to ${library.version} but ${version ?? "an unreadable version"} is installed`,
      });
    }
    const files: Array<{ projectPath: RelPath; content: string }> = [];
    for (const file of library.files) {
      const source = path.resolve(root, file.packagePath);
      const relative = path.relative(root, source);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return err({ code: ErrorCode.PathInvalid, message: "motion library file escapes its package" });
      }
      try {
        files.push({ projectPath: file.projectPath, content: await readFile(source, "utf8") });
      } catch {
        return err({
          code: ErrorCode.StorageUnavailable,
          message: `motion library file ${file.packagePath} is missing from ${library.packageName}`,
        });
      }
    }
    return ok(files);
  }
}
