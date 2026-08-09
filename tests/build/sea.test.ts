import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MACHO_SEGMENT,
  POSTJECT,
  POSTJECT_CLI,
  SEA_FUSE,
  SEA_INTEGRITY_ARGUMENT,
  SEA_PRIMARY_BUNDLE_ASSET,
  SEA_RESOURCE,
  artifactPath,
  assertSeaInputSnapshot,
  assertEmbeddedNodeVersion,
  assertInputsPresent,
  assertRuntimeArchiveHashes,
  copyBoundRegularFile,
  hostRuntimeArchives,
  injectSeaBlob,
  postjectArguments,
  requiredInputs,
  runtimeAssets,
  seaConfig,
  snapshotSeaInputs,
} from "../../scripts/build-sea.mjs";
import {
  SEA_BOOTSTRAP_ENTRY,
  buildSeaBootstrap,
} from "../../scripts/build-sea-bootstrap.mjs";
import {
  prepareArtifactBuildAuthority,
  revalidateArtifactBuildAuthority,
} from "../../scripts/artifact-publish.mjs";
import { SEA_MAIN_LOADER_PATH } from "../../scripts/artifact-layout.mjs";
import {
  verifyEmbeddedSeaInputs,
  verifyInjectedSeaBlob,
  verifyParentSeaBuildSeal,
} from "../../scripts/verify-artifact.mjs";
import { verifyActiveSeaResource } from "../../scripts/sea-resource.mjs";
import { verifySeaPreparationBlob } from "../../scripts/sea-blob.mjs";
import {
  createSeaBuildSeal,
  parseSeaBuildSeal,
  serializeSeaBuildSeal,
} from "../../scripts/sea-build-seal.mjs";
import { removeTree } from "../support/platform";
import { describe, expect, it } from "vitest";

const HOST_TAG = { darwin: "darwin-arm64", win32: "win32-x64", linux: "linux-x64" }[
  process.platform as "darwin" | "win32" | "linux"
];
const HOST_MANIFEST = {
  versions: { node: process.version.slice(1) },
  archives: [
    {
      key: "node",
      platform: HOST_TAG,
      sha256: `sha256:${createHash("sha256").update("nn").digest("hex")}`,
      bytes: 2,
    },
    {
      key: "hyperframes",
      platform: HOST_TAG,
      sha256: `sha256:${createHash("sha256").update("h").digest("hex")}`,
      bytes: 1,
    },
  ],
};

function elfNote(name: Buffer, description: Buffer): Buffer {
  const paddedName = name.length + ((4 - (name.length % 4)) % 4);
  const paddedDescription = description.length + ((4 - (description.length % 4)) % 4);
  const note = Buffer.alloc(12 + paddedName + paddedDescription);
  note.writeUInt32LE(name.length, 0);
  note.writeUInt32LE(description.length, 4);
  name.copy(note, 12);
  description.copy(note, 12 + paddedName);
  return note;
}

function syntheticElf(blob: Buffer, withPrefixCollision = false): Buffer {
  const active = elfNote(Buffer.from("NODE_SEA_BLOB\0", "ascii"), blob);
  const notes = withPrefixCollision
    ? Buffer.concat([elfNote(Buffer.from("NODE", "ascii"), Buffer.from("_SEAdecoy", "ascii")), active])
    : active;
  const noteOffset = 0x200;
  const image = Buffer.alloc(noteOffset + notes.length);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(image);
  image[4] = 2;
  image[5] = 1;
  image[6] = 1;
  image.writeUInt16LE(2, 16);
  image.writeUInt16LE(62, 18);
  image.writeUInt32LE(1, 20);
  image.writeBigUInt64LE(BigInt(64), 32);
  image.writeUInt16LE(64, 52);
  image.writeUInt16LE(56, 54);
  image.writeUInt16LE(2, 56);

  image.writeUInt32LE(1, 64);
  image.writeBigUInt64LE(BigInt(0), 72);
  image.writeBigUInt64LE(BigInt(0x400000), 80);
  image.writeBigUInt64LE(BigInt(image.length), 96);
  image.writeBigUInt64LE(BigInt(image.length), 104);
  image.writeBigUInt64LE(BigInt(0x1000), 112);

  const noteHeader = 64 + 56;
  image.writeUInt32LE(4, noteHeader);
  image.writeBigUInt64LE(BigInt(noteOffset), noteHeader + 8);
  image.writeBigUInt64LE(BigInt(0x400000 + noteOffset), noteHeader + 16);
  image.writeBigUInt64LE(BigInt(notes.length), noteHeader + 32);
  image.writeBigUInt64LE(BigInt(notes.length), noteHeader + 40);
  image.writeBigUInt64LE(BigInt(4), noteHeader + 48);
  notes.copy(image, noteOffset);
  return image;
}

function syntheticInjectableElf(): Buffer {
  const fuse = Buffer.from(`NODE_SEA_FUSE_${SEA_FUSE}:0`, "ascii");
  const image = Buffer.alloc(0x1100);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(image);
  image[4] = 2;
  image[5] = 1;
  image[6] = 1;
  image.writeUInt16LE(2, 16);
  image.writeUInt16LE(62, 18);
  image.writeUInt32LE(1, 20);
  image.writeBigUInt64LE(BigInt(64), 32);
  image.writeUInt16LE(64, 52);
  image.writeUInt16LE(56, 54);
  image.writeUInt16LE(4, 56);

  const header = (index: number) => 64 + index * 56;
  image.writeUInt32LE(6, header(0));
  image.writeUInt32LE(4, header(0) + 4);
  image.writeBigUInt64LE(BigInt(64), header(0) + 8);
  image.writeBigUInt64LE(BigInt(0x400040), header(0) + 16);
  image.writeBigUInt64LE(BigInt(0x400040), header(0) + 24);
  image.writeBigUInt64LE(BigInt(4 * 56), header(0) + 32);
  image.writeBigUInt64LE(BigInt(4 * 56), header(0) + 40);
  image.writeBigUInt64LE(BigInt(8), header(0) + 48);

  image.writeUInt32LE(1, header(1));
  image.writeUInt32LE(5, header(1) + 4);
  image.writeBigUInt64LE(BigInt(0), header(1) + 8);
  image.writeBigUInt64LE(BigInt(0x400000), header(1) + 16);
  image.writeBigUInt64LE(BigInt(0x400000), header(1) + 24);
  image.writeBigUInt64LE(BigInt(0x200), header(1) + 32);
  image.writeBigUInt64LE(BigInt(0x200), header(1) + 40);
  image.writeBigUInt64LE(BigInt(0x1000), header(1) + 48);

  image.writeUInt32LE(1, header(2));
  image.writeUInt32LE(4, header(2) + 4);
  image.writeBigUInt64LE(BigInt(0x1000), header(2) + 8);
  image.writeBigUInt64LE(BigInt(0x401000), header(2) + 16);
  image.writeBigUInt64LE(BigInt(0x401000), header(2) + 24);
  image.writeBigUInt64LE(BigInt(0x100), header(2) + 32);
  image.writeBigUInt64LE(BigInt(0x100), header(2) + 40);
  image.writeBigUInt64LE(BigInt(0x1000), header(2) + 48);

  image.writeUInt32LE(4, header(3));
  image.writeUInt32LE(4, header(3) + 4);
  image.writeBigUInt64LE(BigInt(0x140), header(3) + 8);
  image.writeBigUInt64LE(BigInt(0x400140), header(3) + 16);
  image.writeBigUInt64LE(BigInt(0x400140), header(3) + 24);
  image.writeBigUInt64LE(BigInt(16), header(3) + 32);
  image.writeBigUInt64LE(BigInt(16), header(3) + 40);
  image.writeBigUInt64LE(BigInt(4), header(3) + 48);
  fuse.copy(image, 0x180);
  return image;
}

function syntheticPe(blob: Buffer): Buffer {
  const peOffset = 0x80;
  const optionalOffset = peOffset + 24;
  const optionalSize = 0xf0;
  const sectionOffset = optionalOffset + optionalSize;
  const resourceOffset = 0x200;
  const resourceRva = 0x1000;
  const dataRelative = 0x100;
  const resourceSize = 0x180;
  const image = Buffer.alloc(resourceOffset + 0x300);
  image.writeUInt16LE(0x5a4d, 0);
  image.writeUInt32LE(peOffset, 0x3c);
  Buffer.from("PE\0\0", "binary").copy(image, peOffset);
  image.writeUInt16LE(0x8664, peOffset + 4);
  image.writeUInt16LE(1, peOffset + 6);
  image.writeUInt16LE(optionalSize, peOffset + 20);
  image.writeUInt16LE(0x20b, optionalOffset);
  image.writeUInt32LE(16, optionalOffset + 108);
  image.writeUInt32LE(resourceRva, optionalOffset + 128);
  image.writeUInt32LE(resourceSize, optionalOffset + 132);

  Buffer.from(".rsrc\0\0\0", "ascii").copy(image, sectionOffset);
  image.writeUInt32LE(0x300, sectionOffset + 8);
  image.writeUInt32LE(resourceRva, sectionOffset + 12);
  image.writeUInt32LE(0x300, sectionOffset + 16);
  image.writeUInt32LE(resourceOffset, sectionOffset + 20);

  image.writeUInt16LE(1, resourceOffset + 14);
  image.writeUInt32LE(10, resourceOffset + 16);
  image.writeUInt32LE(0x80000020, resourceOffset + 20);
  image.writeUInt16LE(1, resourceOffset + 0x20 + 12);
  image.writeUInt32LE(0x80000080, resourceOffset + 0x20 + 16);
  image.writeUInt32LE(0x80000040, resourceOffset + 0x20 + 20);
  image.writeUInt16LE(1, resourceOffset + 0x40 + 14);
  image.writeUInt32LE(0, resourceOffset + 0x40 + 16);
  image.writeUInt32LE(0x60, resourceOffset + 0x40 + 20);
  image.writeUInt32LE(resourceRva + dataRelative, resourceOffset + 0x60);
  image.writeUInt32LE(blob.length, resourceOffset + 0x64);
  image.writeUInt16LE("NODE_SEA_BLOB".length, resourceOffset + 0x80);
  Buffer.from("NODE_SEA_BLOB", "utf16le").copy(image, resourceOffset + 0x82);
  blob.copy(image, resourceOffset + dataRelative);
  return image;
}

const PRODUCT_SEA_CODE_PATH = ".sea-inputs/main-loader.cjs";

function byteSeal(bytes: Buffer) {
  return {
    bytes: bytes.length,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function inputProjection(
  main: Buffer,
  assets: Array<{ key: string; content: Buffer }>,
) {
  return {
    codePath: PRODUCT_SEA_CODE_PATH,
    main: byteSeal(main),
    assets: assets
      .map(({ key, content }) => ({ key, ...byteSeal(content) }))
      .sort((left, right) => Buffer.compare(Buffer.from(left.key), Buffer.from(right.key))),
  };
}

function seaView(bytes: Buffer): Buffer {
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

function syntheticProductSeaBlob(
  main: Buffer,
  assets: Array<{ key: string | Buffer; content: Buffer }>,
): Buffer {
  const header = Buffer.alloc(9);
  header.writeUInt32LE(0x0143da20, 0);
  header.writeUInt32LE(9, 4);
  header.writeUInt8(1, 8);
  const count = Buffer.alloc(8);
  count.writeBigUInt64LE(BigInt(assets.length));
  return Buffer.concat([
    header,
    seaView(Buffer.from(PRODUCT_SEA_CODE_PATH, "utf8")),
    seaView(main),
    count,
    ...assets.flatMap(({ key, content }) => [
      seaView(typeof key === "string" ? Buffer.from(key, "utf8") : key),
      seaView(content),
    ]),
  ]);
}

async function inputFixture(root: string) {
  const main = path.join(root, "source", "main-loader.cjs");
  const assets = {
    [SEA_PRIMARY_BUNDLE_ASSET]: path.join(root, "source", "bootstrap.cjs"),
    "frontend-manifest.json": path.join(root, "source", "frontend-manifest.json"),
    "frontend.pack": path.join(root, "source", "frontend.pack"),
    "runtime-manifest.json": path.join(root, "source", "runtime-manifest.json"),
    "runtime-archives/hyperframes.tar.gz": path.join(root, "source", "hyperframes.tar.gz"),
    "runtime-archives/node.tar.gz": path.join(root, "source", "node.tar.gz"),
  };
  await mkdir(path.dirname(main), { recursive: true });
  await Promise.all([
    writeFile(main, "module.exports = 'loader';\n"),
    writeFile(assets[SEA_PRIMARY_BUNDLE_ASSET], "module.exports = 'verified';\n"),
    writeFile(assets["frontend-manifest.json"], '{"entries":[]}\n'),
    writeFile(assets["frontend.pack"], "frontend"),
    writeFile(assets["runtime-manifest.json"], JSON.stringify(HOST_MANIFEST)),
    writeFile(assets["runtime-archives/hyperframes.tar.gz"], "h"),
    writeFile(assets["runtime-archives/node.tar.gz"], "nn"),
  ]);
  return { main, assets };
}

describe("sea build", () => {
  it("rejects every malformed SEA build seal shape and writes one canonical JSON line", () => {
    const valid = {
      schemaVersion: 1,
      tag: HOST_TAG,
      generationId: "strict-seal",
      artifact: { bytes: 10, sha256: `sha256:${"a".repeat(64)}` },
      blob: { bytes: 5, sha256: `sha256:${"b".repeat(64)}` },
      inputs: inputProjection(
        Buffer.from("main"),
        [{ key: "asset.bin", content: Buffer.from("asset") }],
      ),
    };
    const canonical = serializeSeaBuildSeal(valid);
    expect(canonical.endsWith("\n")).toBe(true);
    expect(canonical.slice(0, -1)).not.toContain("\n");
    expect(parseSeaBuildSeal(canonical)).toEqual(valid);

    const missingTopLevel = Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== "generationId"),
    );
    const missingInputs = Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== "inputs"),
    );
    const missingNested = { bytes: valid.artifact.bytes };
    const missingBlobNested = { sha256: valid.blob.sha256 };
    const invalid = [
      "{",
      JSON.stringify(missingTopLevel),
      JSON.stringify(missingInputs),
      JSON.stringify({ ...valid, extra: true }),
      JSON.stringify({ ...valid, artifact: missingNested }),
      JSON.stringify({ ...valid, blob: missingBlobNested }),
      JSON.stringify({ ...valid, artifact: { ...valid.artifact, extra: true } }),
      JSON.stringify({ ...valid, blob: { ...valid.blob, extra: true } }),
      JSON.stringify({ ...valid, inputs: { ...valid.inputs, extra: true } }),
      JSON.stringify({ ...valid, inputs: { ...valid.inputs, main: { bytes: 1 } } }),
      JSON.stringify({
        ...valid,
        inputs: {
          ...valid.inputs,
          assets: [{ ...valid.inputs.assets[0], extra: true }],
        },
      }),
      JSON.stringify({ ...valid, inputs: { ...valid.inputs, codePath: "main-loader.cjs" } }),
      JSON.stringify({
        ...valid,
        inputs: { ...valid.inputs, assets: [valid.inputs.assets[0], valid.inputs.assets[0]] },
      }),
      JSON.stringify({ ...valid, schemaVersion: 2 }),
      JSON.stringify({ ...valid, tag: "" }),
      JSON.stringify({ ...valid, generationId: "bad/generation" }),
      JSON.stringify({ ...valid, artifact: { ...valid.artifact, bytes: 0 } }),
      JSON.stringify({ ...valid, blob: { ...valid.blob, bytes: 1.5 } }),
      JSON.stringify({ ...valid, artifact: { ...valid.artifact, sha256: "sha256:nope" } }),
    ];
    for (const record of invalid) expect(() => parseSeaBuildSeal(record)).toThrow(/SEA /u);
  });

  it("accepts the parent-held seal as one strict CLI JSON argument", () => {
    const generationId = `cli-seal-parse-proof-${process.pid}`;
    const record = JSON.stringify({
      schemaVersion: 1,
      tag: HOST_TAG,
      generationId,
      artifact: { bytes: 1, sha256: `sha256:${"a".repeat(64)}` },
      blob: { bytes: 1, sha256: `sha256:${"b".repeat(64)}` },
      inputs: inputProjection(
        Buffer.from("main"),
        [{ key: "asset.bin", content: Buffer.from("asset") }],
      ),
    });
    const result = spawnSync(process.execPath, [
      "scripts/verify-artifact.mjs",
      HOST_TAG,
      "--generation",
      generationId,
      "--seal",
      record,
    ], {
      cwd: path.resolve("."),
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ENOENT|no such file/u);
    expect(result.stderr).not.toMatch(/must be an object|seal record is invalid/u);

    const invalidArgumentLists = [
      [HOST_TAG, "--generation", generationId],
      [HOST_TAG, "--seal", record, "--generation", generationId],
      [HOST_TAG, "--generation", generationId, "--seal", record, "extra"],
    ];
    for (const args of invalidArgumentLists) {
      const invalid = spawnSync(process.execPath, ["scripts/verify-artifact.mjs", ...args], {
        cwd: path.resolve("."),
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      });
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toMatch(/usage: verify-artifact/u);
    }
  });

  it("locates ELF and PE SEA resources by loader metadata rather than byte occurrence", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "vidcom-sea-container-formats-")));
    try {
      const blob = Buffer.from("retained-sea-blob\n", "utf8");
      const blobFile = path.join(root, "expected.blob");
      const elfFile = path.join(root, "vidcom-elf");
      const peFile = path.join(root, "vidcom.exe");
      const collisionFile = path.join(root, "vidcom-elf-prefix-collision");
      await Promise.all([
        writeFile(blobFile, blob),
        writeFile(elfFile, syntheticElf(blob)),
        writeFile(peFile, syntheticPe(blob)),
        writeFile(collisionFile, syntheticElf(blob, true)),
      ]);

      await expect(verifyActiveSeaResource(elfFile, blobFile)).resolves.toMatchObject({ format: "elf" });
      await expect(verifyActiveSeaResource(peFile, blobFile)).resolves.toMatchObject({ format: "pe" });
      await expect(verifyActiveSeaResource(collisionFile, blobFile))
        .rejects.toThrow(/non-canonical NODE_SEA-prefixed note/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("streams a Linux SEA resource into a loader-mapped ELF note", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "vidcom-elf-sea-injector-")));
    try {
      const executable = path.join(root, "vidcom");
      const blobFile = path.join(root, "sea-prep.blob");
      const blob = Buffer.from("streamed-linux-sea-blob\n", "utf8");
      await Promise.all([
        writeFile(executable, syntheticInjectableElf()),
        writeFile(blobFile, blob),
      ]);

      await injectSeaBlob(executable, blobFile, "linux");
      await expect(verifyActiveSeaResource(executable, blobFile)).resolves.toMatchObject({
        format: "elf",
      });
      await expect(injectSeaBlob(executable, blobFile, "linux"))
        .rejects.toThrow(/sentinel is already active/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passively validates the bounded Node 24.9 blob layout without executing its main", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "vidcom-sea-blob-parser-")));
    try {
      const marker = path.join(root, "main-executed.txt");
      const mainFile = path.join(root, "main-loader.cjs");
      const assetFile = path.join(root, "asset.bin");
      const blobFile = path.join(root, "product.blob");
      const main = Buffer.from(
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
        "utf8",
      );
      const asset = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      const good = syntheticProductSeaBlob(main, [{ key: "asset.bin", content: asset }]);
      await Promise.all([
        writeFile(mainFile, main),
        writeFile(assetFile, asset),
        writeFile(blobFile, good),
      ]);
      const projection = inputProjection(main, [{ key: "asset.bin", content: asset }]);
      await expect(verifySeaPreparationBlob(blobFile, projection)).resolves.toMatchObject({
        schemaVersion: 1,
        codePath: PRODUCT_SEA_CODE_PATH,
      });
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const countOffset = 9 + 8 + Buffer.byteLength(PRODUCT_SEA_CODE_PATH) + 8 + main.length;
      const invalid = new Map<string, Buffer>();
      const badMagic = Buffer.from(good);
      badMagic.writeUInt32LE(0, 0);
      invalid.set("magic", badMagic);
      const badFlags = Buffer.from(good);
      badFlags.writeUInt32LE(8, 4);
      invalid.set("flags", badFlags);
      const badExtension = Buffer.from(good);
      badExtension.writeUInt8(2, 8);
      invalid.set("extension", badExtension);
      const overflow = Buffer.from(good);
      overflow.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1), 9);
      invalid.set("u64 overflow", overflow);
      const badCount = Buffer.from(good);
      badCount.writeBigUInt64LE(BigInt(65), countOffset);
      invalid.set("asset count", badCount);
      invalid.set("truncation", good.subarray(0, good.length - 1));
      invalid.set("trailing bytes", Buffer.concat([good, Buffer.from([0])]));
      invalid.set("duplicate key", syntheticProductSeaBlob(main, [
        { key: "asset.bin", content: asset },
        { key: "asset.bin", content: asset },
      ]));
      invalid.set("invalid UTF-8", syntheticProductSeaBlob(main, [
        { key: Buffer.from([0xff]), content: asset },
      ]));
      invalid.set("BOM-prefixed key", syntheticProductSeaBlob(main, [
        { key: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("asset.bin")]), content: asset },
      ]));

      for (const [label, bytes] of invalid) {
        await writeFile(blobFile, bytes);
        await expect(verifySeaPreparationBlob(blobFile, projection), label)
          .rejects.toThrow(/invalid SEA preparation blob/u);
      }
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("turns off both forms of baked-in V8 state", () => {
    // Each bakes in bytes tied to one V8 build. A cache written by one Node and
    // read by another fails at start-up instead of falling back, and the Node
    // that writes the blob is the build machine's, matching the embedded one
    // only by convention.
    const config = seaConfig(HOST_TAG, HOST_MANIFEST);
    expect(config.useCodeCache).toBe(false);
    expect(config.useSnapshot).toBe(false);
  });

  it("embeds the frontend as assets rather than as files beside the binary", () => {
    // One file with nothing to unpack is the entire point of the artifact.
    expect(Object.keys(seaConfig(HOST_TAG, HOST_MANIFEST).assets).sort()).toEqual([
      SEA_PRIMARY_BUNDLE_ASSET,
      "frontend-manifest.json",
      "frontend.pack",
      "runtime-archives/hyperframes.tar.gz",
      "runtime-archives/node.tar.gz",
      "runtime-manifest.json",
    ]);
  });

  it("embeds only blobs declared for the exact build host", () => {
    expect(Object.keys(runtimeAssets(HOST_TAG, HOST_MANIFEST))).toEqual([
      "runtime-manifest.json",
      "runtime-archives/hyperframes.tar.gz",
      "runtime-archives/node.tar.gz",
    ]);
    const foreign = HOST_TAG === "linux-x64" ? "win32-x64" : "linux-x64";
    expect(() => hostRuntimeArchives(HOST_TAG, {
      archives: [{
        key: "foreign",
        platform: foreign,
        sha256: `sha256:${"c".repeat(64)}`,
        bytes: 1,
      }],
    })).toThrow(/another host/u);
    expect(() => hostRuntimeArchives(HOST_TAG, {
      archives: [HOST_MANIFEST.archives[0]],
    })).toThrow(/exact product archive set/u);
  });

  it("states every path relative to where the blob step runs", () => {
    // Node resolves these against the working directory, not against the
    // configuration file holding them. Getting it backwards fails with
    // "Cannot read main script", which reads like a missing bundle.
    const config = seaConfig(HOST_TAG, HOST_MANIFEST);
    for (const value of [config.main, config.output, ...Object.values(config.assets)]) {
      expect(path.isAbsolute(value), value).toBe(false);
      expect(value.startsWith("."), value).toBe(false);
    }
  });

  it("pins the external injector used for Mach-O and PE shipped bytes", () => {
    expect(POSTJECT).toMatch(/@\d/u);
    expect(POSTJECT_CLI).toMatch(/node_modules[/\\]postject[/\\]dist[/\\]cli\.js$/u);
  });

  it("refuses Node manifest drift before SEA output work begins", () => {
    expect(assertEmbeddedNodeVersion(HOST_MANIFEST, process.version)).toBe(process.version.slice(1));
    expect(() => assertEmbeddedNodeVersion(
      { ...HOST_MANIFEST, versions: { node: "0.0.0" } },
      "v24.9.0",
    )).toThrow(/does not match/u);
  });

  it("names the Mach-O segment the runtime actually looks in", () => {
    // Without it the blob lands somewhere Node does not read: the executable
    // builds, starts, and then reports that it has no embedded main.
    const darwin = postjectArguments("vidcom", "sea-prep.blob", "darwin");
    expect(darwin).toContain("--macho-segment-name");
    expect(darwin).toContain(MACHO_SEGMENT);
    expect(postjectArguments("vidcom", "sea-prep.blob", "linux")).not.toContain(MACHO_SEGMENT);
  });

  it("uses Node's own resource name and fuse", () => {
    const args = postjectArguments("vidcom", "sea-prep.blob", "linux");
    expect(args[1]).toBe(SEA_RESOURCE);
    expect(args).toContain(`NODE_SEA_FUSE_${SEA_FUSE}`);
  });

  it("names one executable per host, and gives Windows its extension", () => {
    // The artifact embeds this machine's Node binary and its native runtime, so
    // a "Linux build" made on macOS is a file that runs nowhere. Refusing a
    // foreign target is covered where that decision lives, in build:artifact.
    expect(artifactPath(HOST_TAG)).toContain(path.join("dist", "artifact", HOST_TAG));
    expect(path.basename(artifactPath(HOST_TAG)))
      .toBe(process.platform === "win32" ? "vidcom.exe" : "vidcom");
  });

  it("names the missing step rather than injecting whatever is lying around", () => {
    // A pack from a previous run injected next to a fresh bundle produces an
    // artifact that only misbehaves once someone runs it — the most expensive
    // place to find out.
    expect(() => assertInputsPresent([path.join("dist", "sea", "never-built.pack")]))
      .toThrow(/has not run/u);
    expect(requiredInputs(HOST_TAG, HOST_MANIFEST)).toHaveLength(7);
  });

  it("binds the blob step to a private immutable generation across source swaps", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "vidcom-sea-snapshot-")));
    try {
      const inputs = await inputFixture(root);
      const snapshotRoot = path.join(root, "generation", ".sea-inputs");
      await mkdir(path.dirname(snapshotRoot), { recursive: true });
      const snapshot = await snapshotSeaInputs(HOST_TAG, HOST_MANIFEST, snapshotRoot, { inputs });
      await writeFile(inputs.main, "module.exports = 'swapped';\n");
      await writeFile(inputs.assets["runtime-archives/node.tar.gz"], "outside");

      const checked = await assertSeaInputSnapshot(
        HOST_TAG,
        HOST_MANIFEST,
        snapshotRoot,
        snapshot.projection,
      );
      await expect(assertRuntimeArchiveHashes(HOST_TAG, HOST_MANIFEST, checked.assets)).resolves.toBeUndefined();
      expect(await readFile(checked.main, "utf8")).toContain("loader");
      expect(await readFile(checked.assets[SEA_PRIMARY_BUNDLE_ASSET], "utf8")).toContain("verified");
      const config = seaConfig(
        HOST_TAG,
        HOST_MANIFEST,
        path.join(path.dirname(snapshotRoot), ".sea-prep.blob"),
        checked,
        path.dirname(snapshotRoot),
      );
      expect(config.main).toBe(".sea-inputs/main-loader.cjs");
      expect(Object.values(config.assets).every((filename) => filename.startsWith(".sea-inputs/"))).toBe(true);

      const tamperedMain = Buffer.from("module.exports = 'tampered';\n", "utf8");
      await chmod(snapshot.main, 0o600);
      await writeFile(snapshot.main, tamperedMain);
      await expect(assertSeaInputSnapshot(
        HOST_TAG,
        HOST_MANIFEST,
        snapshotRoot,
        snapshot.projection,
      ))
        .rejects.toThrow(/differ from the sealed generation/u);

      const snapshotManifestFile = path.join(snapshotRoot, "snapshot-manifest.json");
      await chmod(snapshotManifestFile, 0o600);
      const snapshotManifest = JSON.parse(await readFile(snapshotManifestFile, "utf8")) as {
        entries: Array<{ key: string; bytes: number; sha256: string }>;
      };
      const mainRecord = snapshotManifest.entries.find(({ key }) => key === "main");
      if (!mainRecord) throw new Error("fixture main record is missing");
      Object.assign(mainRecord, byteSeal(tamperedMain));
      await writeFile(snapshotManifestFile, `${JSON.stringify(snapshotManifest, null, 2)}\n`);
      await expect(assertSeaInputSnapshot(
        HOST_TAG,
        HOST_MANIFEST,
        snapshotRoot,
        snapshot.projection,
      )).rejects.toThrow(/parent-held projection/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the original byte projection when the whole snapshot root is coherently replaced", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "vidcom-sea-snapshot-root-swap-")));
    try {
      const inputs = await inputFixture(root);
      const snapshotRoot = path.join(root, "generation", ".sea-inputs");
      const originalRoot = `${snapshotRoot}.original`;
      await mkdir(path.dirname(snapshotRoot), { recursive: true });
      const snapshot = await snapshotSeaInputs(HOST_TAG, HOST_MANIFEST, snapshotRoot, { inputs });

      await rename(snapshotRoot, originalRoot);
      await cp(originalRoot, snapshotRoot, { recursive: true, preserveTimestamps: true });
      const replacementMain = path.join(snapshotRoot, "main-loader.cjs");
      const replacementManifest = path.join(snapshotRoot, "snapshot-manifest.json");
      const malicious = Buffer.from("module.exports = 'replacement';\n", "utf8");
      await Promise.all([chmod(replacementMain, 0o600), chmod(replacementManifest, 0o600)]);
      await writeFile(replacementMain, malicious);
      const manifest = JSON.parse(await readFile(replacementManifest, "utf8")) as {
        schemaVersion: number;
        entries: Array<{ key: string; relative: string; bytes: number; sha256: string }>;
      };
      const mainRecord = manifest.entries.find(({ key }) => key === "main");
      if (!mainRecord) throw new Error("fixture main record is missing");
      Object.assign(mainRecord, byteSeal(malicious));
      await writeFile(replacementManifest, `${JSON.stringify(manifest, null, 2)}\n`);

      await expect(snapshot.assertAuthority()).rejects.toThrow(/snapshot authority changed/u);
      await expect(assertSeaInputSnapshot(
        HOST_TAG,
        HOST_MANIFEST,
        snapshotRoot,
        snapshot.projection,
      )).rejects.toThrow(/parent-held projection/u);
      expect(await readFile(path.join(originalRoot, "main-loader.cjs"), "utf8"))
        .toContain("loader");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when an input path is swapped after all source handles are bound", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "vidcom-sea-swap-")));
    try {
      const inputs = await inputFixture(root);
      const original = `${inputs.main}.original`;
      const snapshotRoot = path.join(root, "generation", ".sea-inputs");
      await mkdir(path.dirname(snapshotRoot), { recursive: true });
      await expect(snapshotSeaInputs(HOST_TAG, HOST_MANIFEST, snapshotRoot, {
        inputs,
        async onBoundary(boundary: string) {
          if (boundary !== "afterInputsOpened") return;
          await rename(inputs.main, original);
          await writeFile(inputs.main, "module.exports = 'outside';\n");
        },
      })).rejects.toThrow(/changed while its private snapshot|changed before the private snapshot/u);
      await expect(readFile(path.join(snapshotRoot, "main-loader.cjs"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not follow a nested snapshot directory link after source handles are bound", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "vidcom-sea-nested-link-")));
    try {
      const inputs = await inputFixture(root);
      const snapshotRoot = path.join(root, "generation", ".sea-inputs");
      const outside = path.join(root, "outside");
      const sentinel = path.join(outside, "sentinel.txt");
      await Promise.all([
        mkdir(path.dirname(snapshotRoot), { recursive: true }),
        mkdir(outside),
      ]);
      await writeFile(sentinel, "preserve-me\n");

      await expect(snapshotSeaInputs(HOST_TAG, HOST_MANIFEST, snapshotRoot, {
        inputs,
        async onBoundary(boundary: string) {
          if (boundary !== "afterInputsOpened") return;
          await symlink(outside, path.join(snapshotRoot, "frontend"), process.platform === "win32" ? "junction" : "dir");
        },
      })).rejects.toThrow(/real contained directory/u);
      expect(await readFile(sentinel, "utf8")).toBe("preserve-me\n");
      expect(await readdir(outside)).toEqual(["sentinel.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["symlink", "hardlink"] as const)(
    "does not overwrite an external file through a pre-created output %s",
    async (kind) => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), `vidcom-sea-output-${kind}-`)));
      try {
        const generation = path.join(root, "generation");
        const source = path.join(root, "source.bin");
        const outside = path.join(root, "outside.bin");
        const output = path.join(generation, "vidcom");
        await mkdir(generation);
        await Promise.all([writeFile(source, "new-bytes"), writeFile(outside, "preserve-me")]);
        if (kind === "symlink") await symlink(outside, output, "file");
        else await link(outside, output);

        await expect(copyBoundRegularFile("node-executable", source, output, generation))
          .rejects.toMatchObject({ code: "EEXIST" });
        expect(await readFile(outside, "utf8")).toBe("preserve-me");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not follow a replaced artifact generation while creating its SEA snapshot", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "vidcom-sea-generation-swap-")));
    try {
      const artifactRoot = path.join(root, "artifacts");
      const inputs = await inputFixture(root);
      const { generation, authority } = await prepareArtifactBuildAuthority(
        HOST_TAG,
        artifactRoot,
        { generationId: "authority-swap" },
      );
      const originalGeneration = `${generation}.original`;
      const outside = path.join(root, "outside");
      const sentinel = path.join(outside, "sentinel.txt");
      await mkdir(outside);
      await writeFile(sentinel, "preserve-me\n");
      await rename(generation, originalGeneration);
      await symlink(outside, generation, process.platform === "win32" ? "junction" : "dir");

      await expect(snapshotSeaInputs(
        HOST_TAG,
        HOST_MANIFEST,
        path.join(generation, ".sea-inputs"),
        {
          inputs,
          assertAuthority: () => revalidateArtifactBuildAuthority(authority),
        },
      )).rejects.toThrow(/generation|authority|symlink|junction/u);
      expect(await readFile(sentinel, "utf8")).toBe("preserve-me\n");
      await expect(readFile(path.join(outside, ".sea-inputs", "main-loader.cjs"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads the exact raw assets back from a real injected SEA", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "vidcom-sea-embedded-proof-")));
    const main = path.join(root, ".sea-inputs", "main-loader.cjs");
    const primary = path.join(root, "bootstrap.cjs");
    const fixtureA = path.join(root, "fixture-a.txt");
    const fixtureB = path.join(root, "fixture-b.txt");
    const maliciousMain = path.join(root, "main-a.cjs");
    const maliciousMarker = path.join(root, "main-a-executed.txt");
    const executableName = process.platform === "win32" ? "vidcom.exe" : "vidcom";

    const runChecked = (command: string, args: readonly string[], label: string) => {
      const result = spawnSync(command, [...args], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        shell: false,
        timeout: 120_000,
        windowsHide: true,
      });
      expect(
        result.status,
        `${label} failed: ${result.stderr ?? result.error?.message ?? ""}`,
      ).toBe(0);
    };

    const createBlob = async (label: string, fixture: string, mainFile = main) => {
      const blob = path.join(root, `${label}.blob`);
      const config = path.join(root, `${label}.json`);
      await writeFile(config, `${JSON.stringify({
        main: path.relative(root, mainFile).split(path.sep).join("/"),
        output: path.basename(blob),
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        assets: {
          [SEA_PRIMARY_BUNDLE_ASSET]: path.basename(primary),
          "fixture.txt": path.basename(fixture),
        },
      })}\n`);
      runChecked(process.execPath, ["--experimental-sea-config", config], `${label} blob`);
      return blob;
    };

    const inject = async (label: string, blob: string) => {
      const executable = path.join(root, `${label}-${executableName}`);
      await copyFile(process.execPath, executable);
      await chmod(executable, 0o755);
      if (process.platform === "darwin") {
        runChecked("codesign", ["--remove-signature", executable], `${label} remove signature`);
      }
      await injectSeaBlob(executable, blob);
      if (process.platform === "darwin") {
        runChecked("codesign", ["--sign", "-", "--force", executable], `${label} sign`);
      }
      return executable;
    };

    try {
      await mkdir(path.dirname(main), { recursive: true });
      await Promise.all([
        copyFile(SEA_MAIN_LOADER_PATH, main),
        buildSeaBootstrap(SEA_BOOTSTRAP_ENTRY, primary),
        writeFile(fixtureA, "generation-a\n"),
        writeFile(fixtureB, "generation-b\n"),
      ]);
      await writeFile(
        maliciousMain,
        `${await readFile(main, "utf8")}\nprocess.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(
          maliciousMarker,
        )}, "main-a-executed\\n");\n`,
      );
      const goodProjection = inputProjection(await readFile(main), [
        { key: SEA_PRIMARY_BUNDLE_ASSET, content: await readFile(primary) },
        { key: "fixture.txt", content: await readFile(fixtureA) },
      ]);

      const goodBlob = await createBlob("good", fixtureA);
      const good = await inject("good", goodBlob);
      await expect(verifyEmbeddedSeaInputs(goodBlob, goodProjection))
        .resolves.toMatchObject({ schemaVersion: 1 });
      await expect(verifyInjectedSeaBlob(good, goodBlob)).resolves.toMatchObject({ format: expect.any(String) });

      const wrongBlob = await createBlob("wrong", fixtureB);
      await expect(verifyEmbeddedSeaInputs(wrongBlob, goodProjection))
        .rejects.toThrow(/differs from the sealed input generation/u);

      const wrongMain = await createBlob("wrong-main", fixtureA, primary);
      await expect(verifyEmbeddedSeaInputs(wrongMain, goodProjection))
        .rejects.toThrow(/differs from the sealed input generation/u);

      const maliciousBlob = await createBlob("main-a", fixtureA, maliciousMain);
      const combinedBlob = path.join(root, "main-a-with-good-suffix.blob");
      await writeFile(combinedBlob, Buffer.concat([
        await readFile(maliciousBlob),
        await readFile(goodBlob),
      ]));
      const mainA = await inject("main-a", combinedBlob);
      await expect((async () => {
        await verifyInjectedSeaBlob(mainA, goodBlob);
        await verifyEmbeddedSeaInputs(combinedBlob, goodProjection);
      })()).rejects.toThrow(/active SEA resource differs/u);
      await expect(readFile(maliciousMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const sealedCandidate = path.join(root, `sealed-${executableName}`);
      const sealedBlob = path.join(root, "sealed.blob");
      await Promise.all([
        copyFile(good, sealedCandidate),
        copyFile(goodBlob, sealedBlob),
      ]);
      await chmod(sealedCandidate, 0o755);
      const parentSeal = await createSeaBuildSeal(
        HOST_TAG,
        "pair-swap",
        sealedCandidate,
        sealedBlob,
        goodProjection,
      );
      await expect(verifyParentSeaBuildSeal(
        parentSeal,
        { tag: HOST_TAG, generationId: "pair-swap" },
        sealedCandidate,
        sealedBlob,
      )).resolves.toMatchObject({ schemaVersion: 1 });
      await expect(verifyInjectedSeaBlob(sealedCandidate, sealedBlob))
        .resolves.toMatchObject({ format: expect.any(String) });
      await expect(verifyParentSeaBuildSeal(
        parentSeal,
        { tag: HOST_TAG, generationId: "pair-swap" },
        sealedCandidate,
        sealedBlob,
      )).resolves.toMatchObject({ schemaVersion: 1 });

      // Preserve the generation directory inode while coherently replacing
      // both child files after the final path-based authentication boundary.
      await Promise.all([
        copyFile(mainA, sealedCandidate),
        copyFile(combinedBlob, sealedBlob),
      ]);
      await expect(verifyEmbeddedSeaInputs(sealedBlob, goodProjection))
        .rejects.toThrow(/sealed input generation/u);
      await expect(readFile(maliciousMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      await expect(verifyInjectedSeaBlob(mainA, goodBlob))
        .rejects.toThrow(/active SEA resource differs/u);

      const probe = spawnSync(good, [SEA_INTEGRITY_ARGUMENT], { encoding: "utf8", shell: false });
      expect(probe.status, probe.stderr).toBe(0);
      expect(JSON.parse(probe.stdout).assets.map((asset: { key: string }) => asset.key)).toEqual([
        SEA_PRIMARY_BUNDLE_ASSET,
        "fixture.txt",
      ]);
    } finally {
      await removeTree(root);
    }
  }, 300_000);
});
