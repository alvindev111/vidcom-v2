import path from "node:path";

import {
  assertComplete,
  resolveRuntimePaths,
  RUNTIME_PATH_NAMES,
  RuntimeAssetError,
  type RuntimePaths,
} from "@vidcom/adapter";
import { ErrorCode } from "@vidcom/contracts";
import { describe, expect, it } from "vitest";

const APP_DATA = path.resolve("/app-data");
const VERSION_ROOT = path.join(APP_DATA, "native", "1.0.0");

function artifactInput(archiveRoots: Record<string, string>) {
  return { mode: "artifact" as const, versionRoot: VERSION_ROOT, archiveRoots, appDataRoot: APP_DATA };
}

const COMPLETE_ARCHIVES = {
  hyperframes: path.join(VERSION_ROOT, "hyperframes"),
  node: path.join(VERSION_ROOT, "node"),
};

describe("runtime path resolution", () => {
  it("resolves all five paths from the extracted runtime in artifact mode", () => {
    const paths = resolveRuntimePaths(artifactInput(COMPLETE_ARCHIVES));
    expect(paths.mode).toBe("artifact");
    for (const name of RUNTIME_PATH_NAMES) {
      expect(path.isAbsolute(paths[name])).toBe(true);
    }
    expect(paths.hyperframesCliPath).toBe(
      path.join(VERSION_ROOT, "hyperframes", "bin", "hyperframes.mjs"),
    );
    expect(paths.nativeDependenciesRoot).toBe(path.join(VERSION_ROOT, "node"));
  });

  it("never reaches require.resolve on the artifact path", () => {
    // A packaged binary has no node_modules, so falling back to require.resolve
    // would be a silent reach for something that cannot exist. Proven by making
    // the resolver unusable and showing artifact mode does not care.
    const exploding = () => { throw new Error("require.resolve must not run in an artifact"); };
    expect(() => resolveRuntimePaths({
      ...artifactInput(COMPLETE_ARCHIVES),
      // @ts-expect-error artifact mode has no resolver seam; supplying one proves it is unused.
      resolve: exploding,
    })).not.toThrow();
  });

  it.each([
    ["hyperframes", { node: COMPLETE_ARCHIVES.node }],
    ["node", { hyperframes: COMPLETE_ARCHIVES.hyperframes }],
  ])("fails at bootstrap with a code when the %s archive is absent", (_label, archives) => {
    let error: RuntimeAssetError | undefined;
    try {
      resolveRuntimePaths(artifactInput(archives));
    } catch (caught) {
      error = caught as RuntimeAssetError;
    }
    // A coded failure here rather than a confusing one mid-render is the point.
    expect(error).toBeInstanceOf(RuntimeAssetError);
    expect(error?.code).toBe(ErrorCode.RuntimeManifestInvalid);
    expect((error?.details as { missing?: string[] } | undefined)?.missing?.length)
      .toBeGreaterThan(0);
  });

  it("resolves through the injected resolver in development mode", () => {
    const seen: string[] = [];
    const paths = resolveRuntimePaths({
      mode: "development",
      appDataRoot: APP_DATA,
      resolve: (specifier) => {
        seen.push(specifier);
        return path.join(APP_DATA, "node_modules", specifier);
      },
    });
    expect(seen).toEqual(["hyperframes/bin/hyperframes.mjs", "hyperframes/package.json"]);
    expect(paths.mode).toBe("development");
    expect(paths.motionLibraryRoot).toBe(path.join(APP_DATA, "motion-libraries"));
  });

  it.each(RUNTIME_PATH_NAMES)("rejects an incomplete set missing %s", (name) => {
    const complete = resolveRuntimePaths(artifactInput(COMPLETE_ARCHIVES));
    const partial: Partial<RuntimePaths> = { ...complete };
    delete partial[name];
    expect(() => { assertComplete(partial); }).toThrow(RuntimeAssetError);
  });

  it("rejects a path set whose artifact/development mode was lost", () => {
    const complete = resolveRuntimePaths(artifactInput(COMPLETE_ARCHIVES));
    const partial: Partial<RuntimePaths> = { ...complete };
    delete partial.mode;
    expect(() => { assertComplete(partial); }).toThrow(RuntimeAssetError);
  });

  it("rejects a relative path even when every field is present", () => {
    const complete = resolveRuntimePaths(artifactInput(COMPLETE_ARCHIVES));
    expect(() => { assertComplete({ ...complete, motionLibraryRoot: "motion-libraries" }); })
      .toThrow(RuntimeAssetError);
  });
});
