import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { create as createTar } from "tar";

const spikeRoot = path.resolve(import.meta.dirname, "..");
const artifactRoot = path.join(
  spikeRoot,
  ".artifacts",
  "packaging-alternatives",
);
const stagingRoot = path.join(artifactRoot, "native-runtime-stage");
const stagingModules = path.join(stagingRoot, "node_modules");
const archivePath = path.join(artifactRoot, "native-runtime.tar.gz");
const manifestPath = path.join(artifactRoot, "native-runtime-manifest.txt");

const platformSuffix = `${process.platform}-${process.arch}`;
const roots = [
  "onnxruntime-node",
  "sharp",
  `@img/sharp-${platformSuffix}`,
  `@img/sharp-libvips-${platformSuffix}`,
];

rmSync(stagingRoot, { force: true, recursive: true });
mkdirSync(stagingModules, { recursive: true });

const packages = new Set<string>();
const packageDependencies = new Map<string, string[]>();
const queue = [...roots];

while (queue.length > 0) {
  const packageName = queue.shift();
  if (!packageName || packages.has(packageName)) continue;

  const sourceDirectory = path.join(
    spikeRoot,
    "node_modules",
    ...packageName.split("/"),
  );
  const packageJsonPath = path.join(sourceDirectory, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `Missing runtime package for ${platformSuffix}: ${packageName}`,
    );
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const dependencies = Object.keys(packageJson.dependencies ?? {});
  packages.add(packageName);
  packageDependencies.set(packageName, dependencies);
  queue.push(...dependencies);

  const targetDirectory = path.join(stagingModules, ...packageName.split("/"));
  mkdirSync(path.dirname(targetDirectory), { recursive: true });
  cpSync(sourceDirectory, targetDirectory, {
    dereference: true,
    recursive: true,
  });
}

for (const [packageName, dependencies] of packageDependencies) {
  const packageDirectory = path.join(stagingModules, ...packageName.split("/"));
  const nestedModules = path.join(packageDirectory, "node_modules");
  rmSync(nestedModules, { force: true, recursive: true });
  for (const dependency of dependencies) {
    const dependencyLink = path.join(nestedModules, ...dependency.split("/"));
    const dependencyTarget = path.join(
      stagingModules,
      ...dependency.split("/"),
    );
    mkdirSync(path.dirname(dependencyLink), { recursive: true });
    symlinkSync(
      path.relative(path.dirname(dependencyLink), dependencyTarget),
      dependencyLink,
    );
  }
}

const onnxPlatformRoot = path.join(
  stagingModules,
  "onnxruntime-node",
  "bin",
  "napi-v3",
);
for (const platform of readdirSync(onnxPlatformRoot)) {
  const platformRoot = path.join(onnxPlatformRoot, platform);
  if (platform !== process.platform) {
    rmSync(platformRoot, { force: true, recursive: true });
    continue;
  }
  for (const architecture of readdirSync(platformRoot)) {
    if (architecture !== process.arch) {
      rmSync(path.join(platformRoot, architecture), {
        force: true,
        recursive: true,
      });
    }
  }
}

await createTar(
  {
    cwd: stagingRoot,
    file: archivePath,
    gzip: true,
    mtime: new Date(0),
    portable: true,
  },
  ["node_modules"],
);

const archive = readFileSync(archivePath);
const manifest = {
  schemaVersion: 1,
  platform: process.platform,
  architecture: process.arch,
  sha256: createHash("sha256").update(archive).digest("hex"),
  archiveBytes: statSync(archivePath).size,
  packages: [...packages].sort(),
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(JSON.stringify(manifest, null, 2));
