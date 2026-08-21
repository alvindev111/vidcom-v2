import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  checkPathPurpose,
  checkPathSyntax,
  findMotionLibrary,
  inferMutationPurpose,
  installMotionLibrary,
  MOTION_LIBRARIES,
  motionLibraryImportSpecifier,
  motionLibraryScriptTag,
  ok,
  scanRemoteMotionLibraries,
  type AbsolutePath,
  type CompositeRequest,
  type MotionLibrary,
  type MotionLibraryInstallDependencies,
  type ProjectRef,
  type ResolvedPath,
} from "@vidcom/core";

const TEST_ORIGIN = { kind: "system", sessionId: null, label: null, historyAction: "ignore", historyOperation: null } as const;
const projectId = "project_motion" as ProjectId;
const ref: ProjectRef = {
  id: projectId,
  slug: "motion",
  root: "/workspace/motion" as AbsolutePath,
  entry: "index.html" as RelPath,
};
const existingHash = `sha256:${"a".repeat(64)}` as ContentHash;
const writtenHash = `sha256:${"b".repeat(64)}` as ContentHash;

function harness(options: {
  files?: Map<string, string>;
  read?: MotionLibraryInstallDependencies["motionLibraries"]["read"];
  refFound?: boolean;
} = {}) {
  const files = options.files ?? new Map<string, string>();
  const requests: CompositeRequest[] = [];
  const dependencies: MotionLibraryInstallDependencies = {
    workspace: {
      readProjectRef: async () => options.refFound === false ? null : ref,
      resolve: async (_ref, path) => ok(path as ResolvedPath),
      readFile: async (path: ResolvedPath) => {
        const content = files.get(path);
        return content === undefined ? null : { content, contentHash: existingHash };
      },
    } as MotionLibraryInstallDependencies["workspace"],
    motionLibraries: {
      read: options.read ?? (async (library: MotionLibrary) => ok(library.files.map(({ projectPath }) => ({
        projectPath,
        content: `/* ${projectPath} */\n`,
      })))),
    },
    authority: {
      mutateSource: async (request: CompositeRequest) => {
        requests.push(request);
        return ok({
          projectRevision: 7,
          entityRevision: null,
          fileHashes: Object.fromEntries(
            request.steps.filter((step) => step.kind === "write").map((step) => [step.path, writtenHash]),
          ) as Record<RelPath, ContentHash>,
          diagnostics: [],
          changeSeq: 1,
        });
      },
    },
  };
  return { dependencies, requests, files };
}

describe("motion library catalogue", () => {
  it("vendors every library under a path the write authority already allows", () => {
    for (const library of MOTION_LIBRARIES) {
      for (const file of library.files) {
        expect(checkPathSyntax(file.projectPath), file.projectPath).toBeNull();
        expect(inferMutationPurpose("source", file.projectPath)).toBe("write-asset");
        expect(checkPathPurpose(file.projectPath, "write-asset"), file.projectPath).toBeNull();
        // The preview server refuses to serve a path it cannot read back.
        expect(checkPathPurpose(file.projectPath, "read-asset"), file.projectPath).toBeNull();
      }
    }
  });

  it("keeps a multi-file library's siblings in one directory under their original names", () => {
    const three = findMotionLibrary("three")!;
    // three.module.min.js imports "./three.core.min.js" by that exact name, so
    // renaming or splitting the pair breaks the module at load time.
    expect(three.files.map(({ projectPath }) => projectPath)).toEqual([
      "assets/vendor/three-0.185.1/three.module.min.js",
      "assets/vendor/three-0.185.1/three.core.min.js",
    ]);
    expect(motionLibraryScriptTag(three))
      .toBe('<script type="module" src="assets/vendor/three-0.185.1/three.module.min.js"></script>');
  });

  it("emits a plain script tag for global libraries", () => {
    expect(motionLibraryScriptTag(findMotionLibrary("gsap")!))
      .toBe('<script src="assets/vendor/gsap-3.15.0/gsap.min.js"></script>');
    expect(findMotionLibrary("unknown-library")).toBeNull();
  });

  it("offers an import specifier only where a tag alone binds no name", () => {
    // A module library's tag executes but exports nothing to the page, so the
    // author needs a specifier; a global library needs none.
    expect(motionLibraryImportSpecifier(findMotionLibrary("three")!))
      .toBe("./assets/vendor/three-0.185.1/three.module.min.js");
    for (const id of ["gsap", "anime", "motion-one", "lottie"]) {
      const library = findMotionLibrary(id)!;
      expect(library.loader).toBe("global");
      expect(library.globalName).not.toBeNull();
      expect(motionLibraryImportSpecifier(library), id).toBeNull();
    }
  });

  it("does not mistake an unrelated remote script for a catalogued library", () => {
    // "motion" and "three" are ordinary English words; a warning that fires on
    // them is a warning authors learn to ignore.
    expect(scanRemoteMotionLibraries([{
      path: "index.html" as RelPath,
      html: [
        '<script src="https://example.com/motion-blur-shader.js"></script>',
        '<script src="https://example.com/three-column-layout.js"></script>',
        '<script src="https://example.com/anime-list-widget.js"></script>',
      ].join("\n"),
    }])).toEqual([]);
  });

  it("finds catalogued libraries loaded from a CDN and ignores local and unrelated scripts", () => {
    const found = scanRemoteMotionLibraries([
      {
        path: "index.html" as RelPath,
        html: [
          '<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>',
          '<script src="assets/vendor/gsap-3.15.0/gsap.min.js"></script>',
          '<script src="https://example.com/analytics.js"></script>',
        ].join("\n"),
      },
      {
        path: "compositions/scene-1.html" as RelPath,
        html: '<script src="//unpkg.com/three@0.180.0/build/three.module.min.js"></script>',
      },
    ]);
    expect(found).toEqual([
      {
        id: "gsap",
        url: "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js",
        file: "index.html",
      },
      {
        id: "three",
        url: "//unpkg.com/three@0.180.0/build/three.module.min.js",
        file: "compositions/scene-1.html",
      },
    ]);
  });
});

describe("installMotionLibrary", () => {
  it("writes every file of a multi-file library as one composite mutation", async () => {
    const { dependencies, requests } = harness();
    const result = await installMotionLibrary(dependencies, { projectId, libraryId: "three" }, "agent");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("installed");
    expect(result.value.revision).toBe(7);
    expect(result.value.changeSeq).toBe(1);
    expect(result.value.library.loader).toBe("module");
    expect(result.value.files.map(({ contentHash }) => contentHash)).toEqual([writtenHash, writtenHash]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.steps.map((step) => step.kind === "write" ? step.path : null)).toEqual([
      "assets/vendor/three-0.185.1/three.module.min.js",
      "assets/vendor/three-0.185.1/three.core.min.js",
    ]);
    expect(requests[0]!.steps.every((step) => step.kind === "write" && step.expectedContentHash === null)).toBe(true);
  });

  it("is a no-op when every file already matches, and reports that nothing was written", async () => {
    const gsap = findMotionLibrary("gsap")!;
    const files = new Map([[gsap.entry, `/* ${gsap.entry} */\n`]]);
    const { dependencies, requests } = harness({ files });
    // An MCP caller needs the signal: write authority is never reached here, so no
    // journal exists to own the invocation's audit.
    let unchanged = 0;
    const result = await installMotionLibrary(
      dependencies,
      { projectId, libraryId: "gsap" },
      "agent",
      { origin: TEST_ORIGIN, toolAudit: null, noteUnchanged: () => { unchanged += 1; } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("already_installed");
    expect(result.value.revision).toBeNull();
    expect(result.value.changeSeq).toBeNull();
    expect(result.value.files).toEqual([{ path: gsap.entry, contentHash: existingHash }]);
    expect(requests).toHaveLength(0);
    expect(unchanged).toBe(1);
  });

  it("overwrites a stale copy against its current hash", async () => {
    const gsap = findMotionLibrary("gsap")!;
    const { dependencies, requests } = harness({ files: new Map([[gsap.entry, "/* older build */\n"]]) });
    const result = await installMotionLibrary(dependencies, { projectId, libraryId: "gsap" }, "agent");
    expect(result.ok).toBe(true);
    expect(requests[0]!.steps).toEqual([{
      kind: "write",
      path: gsap.entry,
      content: `/* ${gsap.entry} */\n`,
      expectedContentHash: existingHash,
    }]);
  });

  it("rejects an unknown library before touching the project", async () => {
    const { dependencies, requests } = harness();
    const result = await installMotionLibrary(dependencies, { projectId, libraryId: "matter-js" }, "agent");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.SchemaInvalid);
    expect(requests).toHaveLength(0);
  });

  it("reports a missing project and a failed library read without writing", async () => {
    const missing = await installMotionLibrary(
      harness({ refFound: false }).dependencies, { projectId, libraryId: "gsap" }, "agent",
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe(ErrorCode.ProjectNotFound);

    const unreadable = harness({
      read: async () => ({ ok: false, error: { code: ErrorCode.StorageUnavailable, message: "not installed" } }),
    });
    const result = await installMotionLibrary(unreadable.dependencies, { projectId, libraryId: "gsap" }, "agent");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.StorageUnavailable);
    expect(unreadable.requests).toHaveLength(0);
  });
});
