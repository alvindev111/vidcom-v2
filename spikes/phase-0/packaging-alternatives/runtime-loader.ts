import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { extract as extractTar } from "tar";

export type NativeRuntimeManifest = {
  schemaVersion: number;
  platform: string;
  architecture: string;
  sha256: string;
  archiveBytes: number;
  packages: string[];
};

export async function runPackagedNativeProbe(input: {
  archive: Uint8Array;
  manifest: NativeRuntimeManifest;
  host: "bun-loader" | "node-sea";
}) {
  const { archive, manifest, host } = input;
  const actualSha256 = createHash("sha256").update(archive).digest("hex");
  if (actualSha256 !== manifest.sha256) {
    throw new Error(
      `Native runtime checksum mismatch: ${actualSha256} != ${manifest.sha256}`,
    );
  }
  if (
    manifest.platform !== process.platform ||
    manifest.architecture !== process.arch
  ) {
    throw new Error(
      `Native runtime ${manifest.platform}-${manifest.architecture} cannot run on ${process.platform}-${process.arch}`,
    );
  }

  const cacheBase =
    process.env.VIDCOM_SPIKE_CACHE ??
    path.join(tmpdir(), "vidcom-phase-0-packaging");
  const runtimeRoot = path.join(cacheBase, manifest.sha256);
  const readyMarker = path.join(runtimeRoot, ".ready");
  const cacheHit =
    existsSync(readyMarker) &&
    readFileSync(readyMarker, "utf8").trim() === manifest.sha256;

  if (!cacheHit) {
    mkdirSync(cacheBase, { recursive: true });
    const temporaryRoot = `${runtimeRoot}.tmp-${process.pid}`;
    rmSync(temporaryRoot, { force: true, recursive: true });
    mkdirSync(temporaryRoot, { recursive: true });
    const temporaryArchive = path.join(temporaryRoot, "native-runtime.tar.gz");
    writeFileSync(temporaryArchive, archive);
    await extractTar({ cwd: temporaryRoot, file: temporaryArchive });
    unlinkSync(temporaryArchive);
    writeFileSync(path.join(temporaryRoot, ".ready"), `${manifest.sha256}\n`);
    rmSync(runtimeRoot, { force: true, recursive: true });
    renameSync(temporaryRoot, runtimeRoot);
  }

  if (host === "bun-loader") {
    process.env.NODE_PATH = path.join(runtimeRoot, "node_modules");
    (Module as unknown as { _initPaths(): void })._initPaths();
  }
  const requireFromRuntime = createRequire(path.join(runtimeRoot, "entry.cjs"));
  const ort = requireFromRuntime(
    path.join(
      runtimeRoot,
      "node_modules",
      "onnxruntime-node",
      "dist",
      "index.js",
    ),
  ) as {
    env: { versions: { node: string } };
    listSupportedBackends(): Array<{ name: string; bundled: boolean }>;
  };
  const sharp = requireFromRuntime(
    path.join(runtimeRoot, "node_modules", "sharp", "dist", "index.cjs"),
  ) as typeof import("sharp").default;
  const png = await sharp({
    create: {
      width: 2,
      height: 3,
      channels: 4,
      background: { r: 12, g: 34, b: 56, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const metadata = await sharp(png).metadata();

  return {
    ok: true,
    host,
    process: process.pid,
    executable: process.execPath,
    cacheHit,
    runtimeRoot,
    manifest: {
      platform: manifest.platform,
      architecture: manifest.architecture,
      sha256: manifest.sha256,
      archiveBytes: manifest.archiveBytes,
      packageCount: manifest.packages.length,
    },
    onnxruntime: {
      version: ort.env.versions.node,
      backends: ort.listSupportedBackends(),
    },
    sharp: {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      outputBytes: png.byteLength,
    },
  };
}
