import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, copyFile, cp, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ARTIFACT_ALLOWLIST,
  FORBIDDEN_PATTERNS,
  assertAllowedRuntimeEntry,
  assertReleasable,
  artifactManifest,
  buildToolProvenance,
  finalExecutableForbiddenAdditions,
  formatChecksums,
  scanFileForForbidden,
  scanForForbidden,
  unexpectedEntries,
  verifyFrontendPayload,
  verifyRuntimePayload,
  writeNewArtifactFile,
} from "../../scripts/verify-artifact.mjs";
import { buildFrontendPack } from "../../scripts/build-frontend-pack.mjs";
import { PACKAGED_RUNTIME_MIGRATION_ENTRIES } from "@vidcom/adapter/runtime-bootstrap";
import type { ContentHash } from "@vidcom/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  HOST_TAG,
  archiveFor,
  productRuntimeFixtureEntries,
  runtimeManifest,
  type FixtureFile,
} from "../support/runtime-fixture";

const roots: string[] = [];
function manifestHash(bytes: string | Buffer): ContentHash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
}

async function writeFixtureFiles(root: string, files: readonly FixtureFile[]): Promise<void> {
  for (const file of files) {
    const filename = path.join(root, ...file.path.split("/"));
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, file.content);
    await chmod(filename, file.mode ?? 0o644);
  }
}

// One of these roots holds a full isolated install, so cleanup is deleting tens
// of thousands of files rather than a handful. The default hook timeout is
// generous for a test directory and far too short for that, and the run it
// killed had already done all the work it was checking.
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}, 300_000);

describe("build tool provenance", () => {
  it("reports the tools that actually produced the artifact", () => {
    const tools = buildToolProvenance();
    expect(tools.tar).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(tools.postject).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("refuses a tar that is not the one the repository pins", () => {
    // Recording the version is not enough. A tar resolved to something other
    // than the pin writes archives nobody reviewed, and the artifact still
    // looks like the release it claims to be.
    expect(() => buildToolProvenance({ declaredTar: "7.5.22", installedTar: "7.4.0" }))
      .toThrow(/not the one this repository pins/u);
  });

  it("refuses a floating injector spec", () => {
    // postject edits the executable format directly, so a range rather than a
    // version means the shipped bytes are decided at build time by whatever
    // happened to resolve.
    expect(() => buildToolProvenance({ postject: "postject@^1.0.0" }))
      .toThrow(/pinned to an exact version/u);
    expect(() => buildToolProvenance({ postject: "postject@1.0.0-alpha.6" })).not.toThrow();
  });

  it("records Bun rather than comparing it, and says so", () => {
    // Bun is the toolchain, not a dependency, so there is no lockfile entry to
    // check against — but naming the one that built the artifact still beats
    // saying nothing.
    expect(buildToolProvenance({ bun: "1.3.14" }).bun).toBe("1.3.14");
  });
});

describe("release gate", () => {
  it("refuses a release built from a modified tree", () => {
    // Recorded for everyone, refused only for a release: a developer building
    // from local edits should get an artifact and an honest label, while a
    // release that cannot name its commit is not a release.
    expect(() => assertReleasable({ dirty: true, commit: "abc1234" }))
      .toThrow(/modified working tree/u);
  });

  it("refuses a release that cannot name its commit", () => {
    expect(() => assertReleasable({ dirty: false, commit: "unknown" }))
      .toThrow(/name the commit/u);
  });

  it("lets a clean build through", () => {
    expect(assertReleasable({ dirty: false, commit: "abc1234" })).toMatchObject({ dirty: false });
  });
});

describe("artifact content scan", () => {
  it.each(["hardlink", ...(process.platform === "win32" ? [] : ["symlink"])] as const)(
    "does not overwrite external provenance through a pre-created %s",
    async (kind) => {
      const root = realpathSync(await mkdtemp(path.join(tmpdir(), `vidcom-provenance-${kind}-`)));
      roots.push(root);
      const generation = path.join(root, "generation");
      const outside = path.join(root, "outside.txt");
      const destination = path.join(generation, "artifact-manifest.json");
      await mkdir(generation);
      await writeFile(outside, "preserve-me\n");
      if (kind === "hardlink") await link(outside, destination);
      else await symlink(outside, destination, "file");

      await expect(writeNewArtifactFile(destination, generation, "new-bytes\n"))
        .rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(outside, "utf8")).toBe("preserve-me\n");
    },
  );

  it.each([
    ["a development origin", "fetch('http://localhost:3000/api')", "dev-origin"],
    ["a sourcemap link", "//# sourceMappingURL=main.js.map", "sourcemap-url"],
    ["a spaced sourcemap link", "//# sourceMappingURL = main.js.map", "sourcemap-url"],
    ["a legacy sourcemap link", "//@ sourceMappingURL=main.js.map", "sourcemap-url"],
    ["a CSS sourcemap link", "/*# sourceMappingURL=main.css.map */", "sourcemap-url"],
    ["an AWS key", "const k = 'AKIAIOSFODNN7EXAMPLE'", "aws-key"],
    ["an API key", "const k = 'sk-abcdefghijklmnopqrstuvwxyz'", "openai-key"],
    ["an Anthropic key", "const k = 'sk-ant-abcdefghijklmnopqrstuvwxyz'", "anthropic-key"],
    ["a GitHub token", "const k = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'", "github-token"],
    ["a fine-grained GitHub token", "const k = 'github_pat_abcdefghijklmnopqrstuvwxyz_123456'", "github-token"],
    ["a Hugging Face token", "const k = 'hf_abcdefghijklmnopqrstuvwxyz'", "huggingface-token"],
    ["a private key", "-----BEGIN PRIVATE KEY-----", "private-key"],
  ])("refuses %s", (_label, text, id) => {
    // Each of these is invisible until it is embarrassing: a key that works, a
    // sourcemap that hands over the whole source, an origin pointing at a
    // machine that does not exist for the user.
    expect(scanForForbidden(text, "").map((hit) => hit.id)).toContain(id);
  });

  it("refuses the build machine's own directory", () => {
    // It says nothing about the user's install and everything about ours.
    expect(scanForForbidden("built from /Users/builder/vidcom", "/Users/builder/vidcom")
      .map((hit) => hit.id)).toContain("build-root");
  });

  it("refuses a percent-encoded Windows file URL for a root with spaces", () => {
    expect(scanForForbidden(
      "const source = 'file:///C:/Build%20Root/vidcom-v2/packages/cli/src/main.ts'",
      "C:\\Build Root\\vidcom-v2",
    ).map((hit) => hit.id)).toContain("build-root");
  });

  it("refuses URL-component and JavaScript-escaped Windows root spellings", () => {
    const root = "C:\\Build#Root\\vidcom-v2";
    expect(scanForForbidden(
      "const source = 'file:///C:/Build%23Root/vidcom-v2/packages/cli/src/main.ts'",
      root,
    ).map((hit) => hit.id)).toContain("build-root");
    expect(scanForForbidden(
      String.raw`const source = 'C:\\Build#Root\\vidcom-v2\\packages\\cli\\src\\main.ts'`,
      root,
    ).map((hit) => hit.id)).toContain("build-root");
  });

  it("reports everything it found, not the first thing", () => {
    // A build that leaked two things should say so once, rather than across two
    // runs.
    const hits = scanForForbidden(
      "http://localhost:3000 and AKIAIOSFODNN7EXAMPLE",
      "",
    );
    expect(hits).toHaveLength(2);
  });

  it("passes ordinary content", () => {
    expect(scanForForbidden("const answer = 42;", "/Users/builder/vidcom")).toEqual([]);
  });

  it("detects a forbidden marker when it exists only in the primary or final binary", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-final-scan-")));
    roots.push(root);
    const primary = path.join(root, "bootstrap.cjs");
    const artifact = path.join(root, "vidcom");
    await Promise.all([
      writeFile(primary, "const key = 'sk-abcdefghijklmnopqrstuvwxyz';"),
      writeFile(artifact, "prefix AKIAIOSFODNN7EXAMPLE suffix"),
    ]);
    expect((await scanFileForForbidden(primary, process.cwd())).map((hit) => hit.id)).toContain("openai-key");
    expect((await scanFileForForbidden(artifact, process.cwd())).map((hit) => hit.id)).toContain("aws-key");
  });

  it("subtracts only exact forbidden occurrences inherited from the host executable", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-binary-baseline-")));
    roots.push(root);
    const baseline = path.join(root, "node");
    const unchanged = path.join(root, "unchanged-sea");
    const injected = path.join(root, "injected-sea");
    const nodeBytes = "prefix AKIAIOSFODNN7EXAMPLE and //# sourceMappingURL=fixture.map\n";
    await Promise.all([
      writeFile(baseline, nodeBytes),
      writeFile(unchanged, `${nodeBytes}ordinary injected bytes\n`),
      writeFile(injected, `${nodeBytes}const token = 'sk-abcdefghijklmnopqrstuvwxyz';\n`),
    ]);
    await expect(finalExecutableForbiddenAdditions(unchanged, baseline, "")).resolves.toEqual([]);
    await expect(finalExecutableForbiddenAdditions(injected, baseline, "")).resolves.toEqual([
      { id: "openai-key", why: "an OpenAI API key" },
    ]);
  });

  it("gives every rule a reason a reader can act on", () => {
    for (const rule of FORBIDDEN_PATTERNS) {
      expect(rule.why, rule.id).toBeTruthy();
    }
  });
});

describe("artifact directory", () => {
  it("holds the executable and its provenance, and nothing else", () => {
    // A stray `.map` or `.ts` beside the executable is the same leak as one
    // embedded in it, and easier to miss.
    expect(unexpectedEntries(["vidcom", "SHA256SUMS", "artifact-manifest.json"])).toEqual([]);
    expect(unexpectedEntries(["vidcom", "main.cjs.map"])).toEqual(["main.cjs.map"]);
    expect([...ARTIFACT_ALLOWLIST].sort()).toEqual([
      "SHA256SUMS",
      "artifact-manifest.json",
      "vidcom",
      "vidcom.exe",
    ]);
  });

  it("writes checksums in the format a user's own tool reads", () => {
    // `sha256sum -c` rather than a shape that needs a tool we ask them to
    // install.
    expect(formatChecksums({ vidcom: "abc123" })).toBe("abc123  vidcom\n");
  });

  it("binds exact tool versions and runtime archive hashes into provenance", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-manifest-")));
    roots.push(root);
    const artifact = path.join(root, "vidcom");
    await writeFile(artifact, "artifact bytes");
    const versions = {
      node: process.version.slice(1),
      hyperframes: "0.7.86",
      esbuild: "0.25.12",
      ffmpeg: "6.0",
      cpython: "3.12.13+20260805",
      vieneu: "3.2.4",
      motion: { animejs: "4", gsap: "3", "lottie-web": "5", motion: "12", three: "0.18" },
    };
    const runtimeManifest = {
      artifactVersion: "fixture-v1",
      versions,
      archives: [
        { key: "hyperframes", platform: HOST_TAG, sha256: `sha256:${"a".repeat(64)}`, bytes: 10 },
        { key: "node", platform: HOST_TAG, sha256: `sha256:${"b".repeat(64)}`, bytes: 20 },
      ],
    };
    const provenance = await artifactManifest(HOST_TAG, artifact, runtimeManifest);
    expect(provenance.runtime).toEqual({
      artifactVersion: "fixture-v1",
      versions,
      archives: {
        hyperframes: { sha256: runtimeManifest.archives[0]!.sha256, bytes: 10 },
        node: { sha256: runtimeManifest.archives[1]!.sha256, bytes: 20 },
      },
    });
    expect(provenance.files.vidcom).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("runtime payload provenance", () => {
  it("binds the exact staged entry set, archive bytes, and secondary bundle", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-runtime-verify-")));
    roots.push(root);
    const assetRoot = path.join(root, "assets");
    const stageRoot = path.join(root, "stage");
    const archiveRoot = path.join(assetRoot, "runtime-archives");
    const metadataRoot = path.join(stageRoot, ".build");
    const secondaryBundle = path.join(root, "secondary.cjs");
    await Promise.all([
      mkdir(archiveRoot, { recursive: true }),
      mkdir(metadataRoot, { recursive: true }),
    ]);
    const bootBytes = Buffer.from("module.exports = { runBootstrappedCli: async () => 0 };\n", "utf8");
    const migrations = PACKAGED_RUNTIME_MIGRATION_ENTRIES.map((migration) => ({
      path: migration,
      content: Buffer.from(`-- ${migration}\n`, "utf8"),
    }));
    const fixture = productRuntimeFixtureEntries(migrations);
    const baseNodeFiles: FixtureFile[] = [
      { path: "cli/boot.cjs", content: bootBytes },
      ...fixture.node,
      ...fixture.native,
      // A directory name which prefixes a sibling dist-info directory sorts
      // differently under a depth-first walk than under a full-path sort.
      { path: "node_modules/sharp/annotated_doc/__init__.js", content: Buffer.from("module.exports = {};\n") },
      {
        path: "node_modules/sharp/annotated_doc-0.0.5.dist-info/METADATA",
        content: Buffer.from("Name: annotated-doc\nVersion: 0.0.5\n"),
      },
    ];
    const hyperframesFiles: FixtureFile[] = [...fixture.hyperframes, ...fixture.native];
    await Promise.all([
      writeFixtureFiles(path.join(stageRoot, "node"), baseNodeFiles),
      writeFixtureFiles(path.join(stageRoot, "hyperframes"), hyperframesFiles),
    ]);
    await Promise.all([
      writeFile(secondaryBundle, bootBytes),
      writeFile(path.join(metadataRoot, "python-packages.txt"), "fixture==1\n"),
      writeFile(path.join(metadataRoot, "runtime-config.json"), "{}\n"),
    ]);
    const nodeArchive = path.join(archiveRoot, "node.tar.gz");
    const hyperframesArchive = path.join(archiveRoot, "hyperframes.tar.gz");
    const builtNode = archiveFor("node", baseNodeFiles, HOST_TAG, "native");
    const builtHyperframes = archiveFor("hyperframes", hyperframesFiles, HOST_TAG, "hyperframes");
    await Promise.all([
      writeFile(nodeArchive, builtNode.bytes),
      writeFile(hyperframesArchive, builtHyperframes.bytes),
    ]);
    const baseManifest = runtimeManifest("fixture-v1", [builtHyperframes.archive, builtNode.archive]);
    const manifest = {
      ...baseManifest,
      archives: [
        { ...builtHyperframes.archive, entries: [...builtHyperframes.archive.entries] },
        { ...builtNode.archive, entries: [...builtNode.archive.entries] },
      ],
    };
    const publishArchive = async (
      key: "hyperframes" | "node",
      files: readonly FixtureFile[],
    ) => {
      const index = key === "hyperframes" ? 0 : 1;
      const target = key === "hyperframes" ? "hyperframes" : "native";
      const archiveFile = key === "hyperframes" ? hyperframesArchive : nodeArchive;
      const built = archiveFor(key, files, HOST_TAG, target);
      await writeFile(archiveFile, built.bytes);
      manifest.archives[index] = { ...built.archive, entries: [...built.archive.entries] };
      await writeFile(path.join(assetRoot, "runtime-manifest.json"), JSON.stringify(manifest));
    };
    const publishNodeArchive = (files: readonly FixtureFile[]) => publishArchive("node", files);
    await writeFile(path.join(assetRoot, "runtime-manifest.json"), JSON.stringify(manifest));

    await expect(verifyRuntimePayload(HOST_TAG, { assetRoot, stageRoot, secondaryBundle }))
      .resolves.toMatchObject({ manifest });

    const completenessCases = [
      { key: "node" as const, path: PACKAGED_RUNTIME_MIGRATION_ENTRIES[0] },
      { key: "node" as const, path: baseNodeFiles.find((file) => file.path.startsWith("bin/ffmpeg"))!.path },
      { key: "node" as const, path: baseNodeFiles.find((file) => file.path.startsWith("python/"))!.path },
      { key: "node" as const, path: "node_modules/sharp/package.json" },
      { key: "hyperframes" as const, path: "bin/hyperframes.mjs" },
      { key: "hyperframes" as const, path: "motion-libraries/gsap/package.json" },
    ];
    for (const candidate of completenessCases) {
      const baseFiles = candidate.key === "node" ? baseNodeFiles : hyperframesFiles;
      const omitted = baseFiles.find((file) => file.path === candidate.path)!;
      await rm(path.join(stageRoot, candidate.key, ...candidate.path.split("/")), { force: true });
      await publishArchive(candidate.key, baseFiles.filter((file) => file.path !== candidate.path));
      await expect(verifyRuntimePayload(HOST_TAG, { assetRoot, stageRoot, secondaryBundle }))
        .rejects.toThrow(/missing required product entries/u);
      await writeFixtureFiles(path.join(stageRoot, candidate.key), [omitted]);
      await publishArchive(candidate.key, baseFiles);
    }

    const forbiddenSource = path.join(stageRoot, "node", "node_modules", "sharp", "src", "source.ts");
    await mkdir(path.dirname(forbiddenSource), { recursive: true });
    await writeFile(forbiddenSource, "export const leaked = true;\n");
    await chmod(forbiddenSource, 0o644);
    const forbiddenFile = {
      path: "node_modules/sharp/src/source.ts",
      content: await readFile(forbiddenSource),
      mode: (await stat(forbiddenSource)).mode & 0o777,
    };
    await publishNodeArchive([...baseNodeFiles, forbiddenFile]);
    await expect(verifyRuntimePayload(HOST_TAG, { assetRoot, stageRoot, secondaryBundle }))
      .rejects.toThrow(/source, declaration, or sourcemap/u);

    await rm(path.join(stageRoot, "node", "node_modules"), { recursive: true });
    await writeFixtureFiles(path.join(stageRoot, "node"), fixture.native);
    await publishNodeArchive(baseNodeFiles);

    const foreignMigrationRelative = "drizzle/20990101000000_foreign/migration.sql";
    const foreignMigration = path.join(stageRoot, "node", ...foreignMigrationRelative.split("/"));
    await mkdir(path.dirname(foreignMigration), { recursive: true });
    await writeFile(foreignMigration, "CREATE TABLE hostile(value TEXT);\n");
    await chmod(foreignMigration, 0o644);
    const foreignMigrationFile = {
      path: foreignMigrationRelative,
      content: await readFile(foreignMigration),
      mode: (await stat(foreignMigration)).mode & 0o777,
    };
    await publishNodeArchive([...baseNodeFiles, foreignMigrationFile]);
    await expect(verifyRuntimePayload(HOST_TAG, { assetRoot, stageRoot, secondaryBundle }))
      .rejects.toThrow(/missing required product entries/u);

    await rm(path.join(stageRoot, "node", "drizzle"), { recursive: true });
    await writeFixtureFiles(path.join(stageRoot, "node"), migrations);
    await publishNodeArchive(baseNodeFiles);

    const unexpectedArchive = path.join(archiveRoot, "foreign.tar.gz");
    await writeFile(unexpectedArchive, "foreign");
    await expect(verifyRuntimePayload(HOST_TAG, { assetRoot, stageRoot, secondaryBundle }))
      .rejects.toThrow(/unexpected or missing entries/u);
    await rm(unexpectedArchive);
    const unexpectedStage = path.join(stageRoot, "node", "unexpected.txt");
    await writeFile(unexpectedStage, "not declared");
    await expect(verifyRuntimePayload(HOST_TAG, { assetRoot, stageRoot, secondaryBundle }))
      .rejects.toThrow(/differs from the archived entry set/u);
    await rm(unexpectedStage);

    const malformedBytes = Buffer.from("this is not a tar archive", "utf8");
    await writeFile(nodeArchive, malformedBytes);
    manifest.archives[1]!.sha256 = manifestHash(malformedBytes);
    manifest.archives[1]!.bytes = malformedBytes.byteLength;
    await writeFile(path.join(assetRoot, "runtime-manifest.json"), JSON.stringify(manifest));
    await expect(verifyRuntimePayload(HOST_TAG, { assetRoot, stageRoot, secondaryBundle }))
      .rejects.toThrow();
  });

  it("allows only exact motion catalogue files", () => {
    const allowed = new Set([
      "motion-libraries/gsap/package.json",
      "motion-libraries/gsap/dist/gsap.min.js",
    ]);
    expect(() => assertAllowedRuntimeEntry(
      "hyperframes",
      HOST_TAG,
      "motion-libraries/gsap/dist/gsap.min.js",
      allowed,
    )).not.toThrow();
    expect(() => assertAllowedRuntimeEntry(
      "hyperframes",
      HOST_TAG,
      "motion-libraries/gsap/extra.js",
      allowed,
    )).toThrow(/pinned product catalogue/u);
  });
});

describe("frontend payload provenance", () => {
  it("rejects a mixed manifest/pack generation, gaps, and trailing bytes", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-frontend-verify-")));
    roots.push(root);
    const manifestFile = path.join(root, "frontend-manifest.json");
    const packFile = path.join(root, "frontend.pack");
    const pack = Buffer.from("abc", "utf8");
    const entries = [
      {
        path: "a.html",
        offset: 0,
        length: 1,
        sha256: createHash("sha256").update(pack.subarray(0, 1)).digest("hex"),
        mime: "text/html; charset=utf-8",
        cachePolicy: "no-store",
      },
      {
        path: "b.js",
        offset: 1,
        length: 2,
        sha256: createHash("sha256").update(pack.subarray(1)).digest("hex"),
        mime: "text/javascript; charset=utf-8",
        cachePolicy: "immutable",
      },
    ];
    await Promise.all([
      writeFile(packFile, pack),
      writeFile(manifestFile, JSON.stringify({ entries })),
    ]);
    await expect(verifyFrontendPayload(manifestFile, packFile)).resolves.toEqual({ entries });

    await writeFile(packFile, "abd");
    await expect(verifyFrontendPayload(manifestFile, packFile)).rejects.toThrow(/do not match/u);
    await writeFile(packFile, pack);
    entries[1]!.offset = 2;
    await writeFile(manifestFile, JSON.stringify({ entries }));
    await expect(verifyFrontendPayload(manifestFile, packFile)).rejects.toThrow(/contiguously/u);
    entries[1]!.offset = 1;
    await writeFile(packFile, "abc-extra");
    await writeFile(manifestFile, JSON.stringify({ entries }));
    await expect(verifyFrontendPayload(manifestFile, packFile)).rejects.toThrow(/every pack byte/u);

    const sourcemapEntry = {
      ...entries[0]!,
      path: "_next/static/app.js.map",
      offset: 0,
      length: pack.length,
      sha256: createHash("sha256").update(pack).digest("hex"),
    };
    await writeFile(packFile, pack);
    await writeFile(manifestFile, JSON.stringify({ entries: [sourcemapEntry] }));
    await expect(verifyFrontendPayload(manifestFile, packFile)).rejects.toThrow(/sourcemap path/u);
  });
});

describe("the frontend pack this build produces", () => {
  // POSIX only, and the reason is what the case is about rather than where it
  // runs. The pack is whatever `next build` writes from these sources, and the
  // property under test — that no development origin was inlined — is decided
  // by the build configuration, not by the host. On Windows the isolated
  // projection cannot be installed at all: bun resolves workspace members
  // through relative symlinks that climb out of the temp directory
  // (`..\..\..\..\..\..\runneradmin\...`) and fails to link them. Two
  // platforms build the pack; all three check its contents through
  // `verifyFrontendPayload` above.
  it.skipIf(process.platform === "win32")("carries no development origin", async () => {
    // The dev origin is injected at runtime by the host and never inlined, so
    // there is nothing to leak — and this is the check that keeps it that way.
    // Build every time in an isolated checkout projection. Reusing repo-root
    // `out` made this test green on bytes from an older HEAD and left `.next`
    // and `out` behind for lint to scan.
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-provenance-")));
    roots.push(root);
    const buildRoot = path.join(root, "build");
    await mkdir(buildRoot);
    for (const filename of [
      "components.json",
      "bun.lock",
      "next.config.ts",
      "package.json",
      "postcss.config.mjs",
      "tsconfig.base.json",
      "tsconfig.json",
    ]) {
      await copyFile(path.resolve(filename), path.join(buildRoot, filename));
    }
    // `next-env.d.ts` is generated and git-ignored, so a clean checkout has
    // none — copying it unconditionally made this pass on a developer machine
    // and fail on every runner. The build writes it itself; carrying it over
    // when it happens to exist keeps the projection closer to the checkout.
    if (existsSync(path.resolve("next-env.d.ts"))) {
      await copyFile(path.resolve("next-env.d.ts"), path.join(buildRoot, "next-env.d.ts"));
    }
    await Promise.all([
      cp(path.resolve("src"), path.join(buildRoot, "src"), { recursive: true }),
      cp(path.resolve("packages"), path.join(buildRoot, "packages"), {
        recursive: true,
        filter(source) {
          return !source.split(path.sep).includes("node_modules")
            && !path.basename(source).startsWith(".artifact-")
            && path.basename(source) !== "__pycache__";
        },
      }),
    ]);
    // Not `--frozen-lockfile`. The projection copies the root manifest, the
    // lockfile and the workspace manifests, and on Windows the resolved set
    // differs enough that bun wants to write the lockfile — which is a fact
    // about optional platform packages, not about the thing under test. The
    // subject here is the frontend pack; the lockfile is audited by CI's own
    // install step, which does run frozen.
    const installed = spawnSync("bun", ["install"], {
      cwd: buildRoot,
      encoding: "utf8",
      shell: false,
    });
    expect(installed.status, `isolated install failed: ${installed.stderr ?? installed.error?.message ?? ""}`)
      .toBe(0);
    // Through bun, which is a real executable everywhere. `npm` on Windows is
    // a `.cmd`, and Node refuses to spawn one without a shell.
    const built = spawnSync("bun", ["run", "build"], {
      cwd: buildRoot,
      encoding: "utf8",
      shell: false,
    });
    expect(built.status, `the static export could not be built: ${built.stderr ?? built.error?.message ?? ""}`)
      .toBe(0);
    const packPath = path.join(root, "frontend.pack");
    const manifestPath = path.join(root, "frontend-manifest.json");
    await buildFrontendPack(path.join(buildRoot, "out"), packPath, manifestPath);

    const pack = await readFile(packPath, "latin1");
    expect(scanForForbidden(pack, process.cwd())).toEqual([]);
  }, 300_000);
});
