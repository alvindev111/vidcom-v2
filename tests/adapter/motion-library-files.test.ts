import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ErrorCode } from "@vidcom/contracts";
import { NodeModulesMotionLibraryFiles } from "@vidcom/adapter";
import {
  findMotionLibrary,
  MOTION_LIBRARIES,
  type AbsolutePath,
  type MotionLibrary,
} from "@vidcom/core";

const files = new NodeModulesMotionLibraryFiles();

describe("NodeModulesMotionLibraryFiles", () => {
  it.each(MOTION_LIBRARIES.map((library) => [library.id, library] as const))(
    "reads the pinned browser build of %s from the installed package",
    async (_id, library) => {
      const result = await files.read(library);
      expect(result.ok, JSON.stringify(result.ok ? null : result.error)).toBe(true);
      if (!result.ok) return;
      expect(result.value.map(({ projectPath }) => projectPath))
        .toEqual(library.files.map(({ projectPath }) => projectPath));
      for (const file of result.value) expect(file.content.length).toBeGreaterThan(1_000);
    },
  );

  it("serves a Three.js pair whose module half still imports its sibling by name", async () => {
    const three = findMotionLibrary("three")!;
    const result = await files.read(three);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [module, core] = result.value;
    // Vendoring must keep both files together: the module half resolves its
    // sibling relatively, so a lone three.module.min.js fails at load time.
    expect(module!.content).toContain('from"./three.core.min.js"');
    expect(core!.projectPath.endsWith("/three.core.min.js")).toBe(true);
  });

  it("installs a global library that really does define its declared global", async () => {
    const gsap = findMotionLibrary("gsap")!;
    const result = await files.read(gsap);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]!.content).toContain(gsap.globalName!);
  });

  it("refuses to vendor a package whose installed version drifted from the pin", async () => {
    const drifted: MotionLibrary = { ...findMotionLibrary("gsap")!, version: "0.0.1" };
    const result = await files.read(drifted);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.StorageUnavailable);
      expect(result.error.message).toContain("pinned to 0.0.1");
    }
  });

  it("reports an uninstalled package instead of throwing", async () => {
    const absent: MotionLibrary = { ...findMotionLibrary("gsap")!, packageName: "not-a-real-motion-package" };
    const result = await files.read(absent);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.StorageUnavailable);
  });

  it("serves the same bytes from a distributed library root that has no node_modules", async () => {
    // What the packaged runtime does: there is nothing to resolve, so it is
    // handed the directory the distribution extracted.
    const gsap = findMotionLibrary("gsap")!;
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-motion-dist-"));
    const packageRoot = path.join(root, gsap.packageName);
    await mkdir(path.join(packageRoot, path.dirname(gsap.files[0].packagePath)), { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({ name: gsap.packageName, version: gsap.version })}\n`,
    );
    const fromCheckout = await files.read(gsap);
    if (!fromCheckout.ok) throw new Error("checkout read failed");
    await writeFile(path.join(packageRoot, gsap.files[0].packagePath), fromCheckout.value[0]!.content);

    const distributed = new NodeModulesMotionLibraryFiles(root as AbsolutePath);
    const result = await distributed.read(gsap);
    expect(result.ok, JSON.stringify(result.ok ? null : result.error)).toBe(true);
    if (result.ok) expect(result.value).toEqual(fromCheckout.value);

    // An empty distribution must fail loudly rather than silently skip vendoring,
    // and must not quietly substitute the checkout's installed copy: a named root
    // is the packaged path's proof that the distribution shipped the library.
    // Development names no root at all — see `composition-root`.
    const empty = new NodeModulesMotionLibraryFiles(
      (await mkdtemp(path.join(tmpdir(), "vidcom-motion-empty-"))) as AbsolutePath,
    );
    const missing = await empty.read(gsap);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe(ErrorCode.StorageUnavailable);
      expect(missing.error.message).toContain("distributed library root");
    }
  });

  it("rejects a file path that escapes its package", async () => {
    const escaping: MotionLibrary = {
      ...findMotionLibrary("gsap")!,
      files: [{ packagePath: "../../../etc/passwd", projectPath: "assets/vendor/gsap-3.15.0/gsap.min.js" as never }],
    };
    const result = await files.read(escaping);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.PathInvalid);
  });
});
