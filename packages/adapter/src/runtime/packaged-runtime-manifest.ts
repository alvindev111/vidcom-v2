import path from "node:path";

import { ErrorCode, MOTION_LIBRARIES } from "@vidcom/contracts";

import { resolveRuntimePaths, type RuntimePaths } from "./runtime-paths";
import {
  RUNTIME_MOTION_PACKAGES,
  resolveRuntimeArchiveRoots,
  resolveRuntimeArchives,
  RuntimeAssetError,
  type EmbeddedArchive,
  type EmbeddedRuntimeManifest,
  type RuntimeMotionPackage,
} from "./runtime-asset-source";

const PACKAGED_RUNTIME_DIRECTORY = "native";
export const PACKAGED_RUNTIME_MIGRATION_ENTRIES = [
  "drizzle/20260801144629_foundation/migration.sql",
  "drizzle/20260802070444_unusual_robbie_robertson/migration.sql",
  "drizzle/20260802120436_late_sheva_callister/migration.sql",
  "drizzle/20260802123804_lumpy_old_lace/migration.sql",
  "drizzle/20260804140510_flippant_tenebrous/migration.sql",
  "drizzle/20260804163227_perpetual_secret_warriors/migration.sql",
  "drizzle/20260804164719_tearful_natasha_romanoff/migration.sql",
  "drizzle/20260804165335_fuzzy_vampiro/migration.sql",
  "drizzle/20260804165459_majestic_mach_iv/migration.sql",
  "drizzle/20260804174203_fresh_ultimo/migration.sql",
  "drizzle/20260804180557_spotty_catseye/migration.sql",
  "drizzle/20260807144527_amazing_kitty_pryde/migration.sql",
  "drizzle/20260808073614_normal_stature/migration.sql",
] as const;
const PACKAGED_RUNTIME_MIGRATION_ENTRY_SET = new Set<string>(PACKAGED_RUNTIME_MIGRATION_ENTRIES);

const COMMON_NATIVE_PACKAGES = [
  "sharp",
  "@img/colour",
  "detect-libc",
  "semver",
  "esbuild",
  "onnxruntime-node",
  "onnxruntime-common",
] as const;

const REQUIRED_HYPERFRAMES_ENTRIES = [
  "bin/hyperframes.mjs",
  "package.json",
  "bin/hyperframe.manifest.json",
  "bin/hyperframe.runtime.iife.js",
] as const;

const EXPECTED_PRODUCT_VERSIONS = Object.freeze({
  node: "24.9.0",
  hyperframes: "0.7.86",
  esbuild: "0.25.12",
  cpython: "3.12.13+20260805",
  vieneu: "3.2.4",
});

const REQUIRED_MOTION_ENTRIES = MOTION_LIBRARIES.flatMap((library) => [
  `motion-libraries/${library.packageName}/package.json`,
  ...library.files.map(({ packagePath }) =>
    `motion-libraries/${library.packageName}/${packagePath}`),
]);

const EXPECTED_MOTION_VERSIONS = Object.freeze(Object.fromEntries(
  MOTION_LIBRARIES.map((library) => [library.packageName, library.version]),
) as Record<RuntimeMotionPackage, string>);

interface HostProductContract {
  nodeEntries: readonly { path: string; executable?: boolean }[];
  nativePackageNames: readonly string[];
  nativeCriticalEntries: readonly string[];
  nativeCriticalPatterns: readonly RegExp[];
}

function hostProductContract(platformTag: string): HostProductContract {
  const suffix = platformTag === "win32-x64" ? ".exe" : "";
  const platformPackageNames = platformTag === "darwin-arm64"
    ? ["@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64", "@esbuild/darwin-arm64"]
    : platformTag === "linux-x64"
      ? ["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64", "@esbuild/linux-x64"]
      : ["@img/sharp-win32-x64", "@esbuild/win32-x64"];
  const python = platformTag === "win32-x64" ? "python/python.exe" : "python/bin/python3";
  const onnxPlatform = platformTag === "win32-x64" ? "win32" : platformTag.split("-", 1)[0]!;
  const onnxArchitecture = platformTag.endsWith("-arm64") ? "arm64" : "x64";
  const onnxRoot = `node_modules/onnxruntime-node/bin/napi-v3/${onnxPlatform}/${onnxArchitecture}`;
  const esbuildPlatformEntry = platformTag === "win32-x64"
    ? "node_modules/@esbuild/win32-x64/esbuild.exe"
    : `node_modules/@esbuild/${platformTag}/bin/esbuild`;
  const sharpPlatform = platformTag;
  const nativeCriticalPatterns = [
    new RegExp(`^node_modules/@img/sharp-${sharpPlatform}/lib/[^/]+\\.node$`, "u"),
    platformTag === "win32-x64"
      ? new RegExp(`^${onnxRoot}/onnxruntime\\.dll$`, "u")
      : platformTag === "darwin-arm64"
        ? new RegExp(`^${onnxRoot}/libonnxruntime(?:\\.[0-9.]+)?\\.dylib$`, "u")
        : new RegExp(`^${onnxRoot}/libonnxruntime\\.so(?:\\.[0-9.]+)?$`, "u"),
  ];
  if (platformTag !== "win32-x64") {
    nativeCriticalPatterns.push(
      new RegExp(
        `^node_modules/@img/sharp-libvips-${sharpPlatform}/lib/[^/]+\\.(?:dylib|so(?:\\.[0-9.]+)?)$`,
        "u",
      ),
    );
  }
  return {
    nodeEntries: [
      { path: "cli/boot.cjs" },
      { path: `bin/ffmpeg${suffix}`, executable: true },
      { path: `bin/ffprobe${suffix}`, executable: true },
      { path: `bin/esbuild${suffix}`, executable: true },
      { path: python, executable: true },
      { path: "vieneu/worker.py" },
      ...PACKAGED_RUNTIME_MIGRATION_ENTRIES.map((path) => ({ path })),
    ],
    nativePackageNames: [...COMMON_NATIVE_PACKAGES, ...platformPackageNames],
    nativeCriticalEntries: [
      "node_modules/onnxruntime-node/dist/index.js",
      `${onnxRoot}/onnxruntime_binding.node`,
      esbuildPlatformEntry,
    ],
    nativeCriticalPatterns,
  };
}

export interface ValidatedPackagedRuntimeManifest {
  archives: readonly EmbeddedArchive[];
  archiveRoots: Readonly<Record<string, string>>;
  versionRoot: string;
  runtimePaths: RuntimePaths;
}

function invalid(message: string, missing: readonly string[]): never {
  throw new RuntimeAssetError(
    ErrorCode.RuntimeManifestInvalid,
    message,
    { missing: [...missing] },
  );
}

function requireUniqueArchive(
  archives: readonly EmbeddedArchive[],
  key: string,
): EmbeddedArchive {
  const matches = archives.filter((archive) => archive.key === key);
  if (matches.length !== 1) invalid("the packaged runtime manifest is incomplete", [key]);
  return matches[0]!;
}

function missingNativeClosure(
  archive: EmbeddedArchive,
  contract: HostProductContract,
): string[] {
  const paths = new Set(archive.entries.map((entry) => entry.path));
  return [
    ...contract.nativePackageNames
      .map((name) => `node_modules/${name}/package.json`)
      .filter((required) => !paths.has(required)),
    ...contract.nativeCriticalEntries.filter((required) => !paths.has(required)),
    ...contract.nativeCriticalPatterns.flatMap((pattern) =>
      archive.entries.some((entry) => pattern.test(entry.path)) ? [] : [pattern.source]),
  ].map((required) => `${archive.key}:${required}`);
}

/**
 * Applies product-level manifest requirements before extraction can mutate the
 * app-data runtime. The generic manager deliberately accepts other valid
 * archive sets; a VidCom artifact requires one exact-host product toolchain.
 */
export function validatePackagedRuntimeManifest(
  appDataRoot: string,
  manifest: EmbeddedRuntimeManifest,
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
): ValidatedPackagedRuntimeManifest {
  const archives = resolveRuntimeArchives(manifest, platform, architecture);
  const requestedPlatform = `${platform}-${architecture}`;
  if (
    archives.length !== 2
    || archives.length !== manifest.archives.length
    || new Set(archives.map((archive) => archive.key)).size !== archives.length
    || archives.some((archive) => archive.platform !== requestedPlatform)
    || archives.some((archive) => archive.key !== "node" && archive.key !== "hyperframes")
  ) {
    invalid("the packaged runtime manifest must contain one exact-host archive set", [requestedPlatform]);
  }

  const node = requireUniqueArchive(archives, "node");
  const hyperframes = requireUniqueArchive(archives, "hyperframes");
  const contract = hostProductContract(requestedPlatform);
  const missing: string[] = [
    ...Object.entries(EXPECTED_PRODUCT_VERSIONS).flatMap(([name, expected]) =>
      manifest.versions[name as keyof typeof EXPECTED_PRODUCT_VERSIONS] === expected
        ? []
        : [`versions.${name}:${expected}`]),
    ...RUNTIME_MOTION_PACKAGES.flatMap((name) =>
      manifest.versions.motion[name] === EXPECTED_MOTION_VERSIONS[name]
        ? []
        : [`versions.motion.${name}:${EXPECTED_MOTION_VERSIONS[name]}`]),
    ...contract.nodeEntries.flatMap((required) => {
      const entry = node.entries.find((candidate) => candidate.path === required.path);
      if (!entry) return [`node:${required.path}`];
      if (
        requestedPlatform !== "win32-x64"
        && required.executable === true
        && (entry.mode & 0o111) === 0
      ) {
        return [`node:${required.path}:executable`];
      }
      return [];
    }),
    ...node.entries
      .filter((entry) =>
        entry.path.startsWith("drizzle/")
        && entry.path.endsWith("/migration.sql")
        && !PACKAGED_RUNTIME_MIGRATION_ENTRY_SET.has(entry.path))
      .map((entry) => `node:${entry.path}:unexpected`),
    ...REQUIRED_HYPERFRAMES_ENTRIES.filter((required) =>
      !hyperframes.entries.some((entry) => entry.path === required))
      .map((required) => `hyperframes:${required}`),
    ...REQUIRED_MOTION_ENTRIES
      .filter((required) => !hyperframes.entries.some((entry) => entry.path === required))
      .map((required) => `hyperframes:${required}`),
    ...missingNativeClosure(node, contract),
    ...missingNativeClosure(hyperframes, contract),
  ];
  if (missing.length > 0) {
    invalid("the packaged runtime manifest is missing required product entries", missing);
  }

  const versionRoot = path.join(
    appDataRoot,
    PACKAGED_RUNTIME_DIRECTORY,
    manifest.artifactVersion,
  );
  const archiveRoots = resolveRuntimeArchiveRoots(archives, versionRoot);
  const runtimePaths = resolveRuntimePaths({
    mode: "artifact",
    appDataRoot,
    versionRoot,
    archiveRoots,
  });
  return Object.freeze({ archives, archiveRoots, versionRoot, runtimePaths });
}
