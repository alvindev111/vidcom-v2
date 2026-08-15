import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/u;
const PORTABLE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9-]*$/u;
const MAX_SEAL_BYTES = 16 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;
const MAX_ASSET_COUNT = 64;
const MAX_ASSET_KEY_BYTES = 4096;

export const SEA_PRODUCT_CODE_PATH = ".sea-inputs/main-loader.cjs";

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields are invalid`);
  }
  return value;
}

function exactFileSeal(value, label, allowEmpty = false) {
  const seal = exactKeys(value, ["bytes", "sha256"], label);
  if (
    !Number.isSafeInteger(seal.bytes)
    || seal.bytes < (allowEmpty ? 0 : 1)
    || typeof seal.sha256 !== "string"
    || !CONTENT_HASH.test(seal.sha256)
  ) throw new Error(`${label} is invalid`);
  return Object.freeze({ bytes: seal.bytes, sha256: seal.sha256 });
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function exactAssetSeal(value, index) {
  const asset = exactKeys(value, ["bytes", "key", "sha256"], `SEA input asset ${index}`);
  if (
    typeof asset.key !== "string"
    || asset.key.length === 0
    || asset.key.includes("\0")
    || Buffer.byteLength(asset.key, "utf8") > MAX_ASSET_KEY_BYTES
  ) throw new Error(`SEA input asset ${index} key is invalid`);
  return Object.freeze({
    key: asset.key,
    ...exactFileSeal(
      { bytes: asset.bytes, sha256: asset.sha256 },
      `SEA input asset ${index}`,
      true,
    ),
  });
}

export function exactSeaInputProjection(value) {
  const projection = exactKeys(value, ["assets", "codePath", "main"], "SEA input projection");
  if (projection.codePath !== SEA_PRODUCT_CODE_PATH) {
    throw new Error("SEA input projection code path is invalid");
  }
  if (
    !Array.isArray(projection.assets)
    || projection.assets.length === 0
    || projection.assets.length > MAX_ASSET_COUNT
  ) throw new Error("SEA input projection assets are invalid");
  const assets = projection.assets.map(exactAssetSeal);
  for (let index = 0; index < assets.length; index += 1) {
    if (
      (index > 0 && compareUtf8(assets[index - 1].key, assets[index].key) >= 0)
    ) throw new Error("SEA input projection asset keys must be unique and UTF-8 sorted");
  }
  return Object.freeze({
    codePath: SEA_PRODUCT_CODE_PATH,
    main: exactFileSeal(projection.main, "SEA input main"),
    assets: Object.freeze(assets),
  });
}

export function exactSeaBuildSeal(value) {
  const seal = exactKeys(
    value,
    ["artifact", "blob", "generationId", "inputs", "schemaVersion", "tag"],
    "SEA build seal",
  );
  if (
    seal.schemaVersion !== 1
    || typeof seal.tag !== "string"
    || !PORTABLE_TOKEN.test(seal.tag)
    || typeof seal.generationId !== "string"
    || !PORTABLE_TOKEN.test(seal.generationId)
  ) throw new Error("SEA build seal is invalid");
  return Object.freeze({
    schemaVersion: 1,
    tag: seal.tag,
    generationId: seal.generationId,
    artifact: exactFileSeal(seal.artifact, "SEA artifact seal"),
    blob: exactFileSeal(seal.blob, "SEA blob seal"),
    inputs: exactSeaInputProjection(seal.inputs),
  });
}

export function parseSeaBuildSeal(record) {
  if (
    typeof record !== "string"
    || Buffer.byteLength(record, "utf8") === 0
    || Buffer.byteLength(record, "utf8") > MAX_SEAL_BYTES
  ) throw new Error("SEA build seal record is invalid");
  let value;
  try {
    value = JSON.parse(record);
  } catch {
    throw new Error("SEA build seal record is invalid");
  }
  return exactSeaBuildSeal(value);
}

export function serializeSeaBuildSeal(value) {
  return `${JSON.stringify(exactSeaBuildSeal(value))}\n`;
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

async function digestRegularFile(filename, label) {
  const resolved = path.resolve(filename);
  const before = await lstat(resolved, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error(`${label} must be one regular, non-linked file`);
  }
  if (before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} size is invalid`);
  }
  if (await realpath(resolved) !== resolved) throw new Error(`${label} must not traverse a symlink`);

  const handle = await open(resolved, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(before, opened)) throw new Error(`${label} changed while it was opened`);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
    let position = 0;
    while (position < Number(opened.size)) {
      const length = Math.min(buffer.byteLength, Number(opened.size) - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead !== length) throw new Error(`${label} was truncated while it was sealed`);
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const [after, current, canonical] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(resolved, { bigint: true }),
      realpath(resolved),
    ]);
    if (
      !sameIdentity(before, after)
      || !sameIdentity(before, current)
      || current.nlink !== 1n
      || canonical !== resolved
    ) throw new Error(`${label} changed while it was sealed`);
    return Object.freeze({
      bytes: position,
      sha256: `sha256:${hash.digest("hex")}`,
    });
  } finally {
    await handle.close();
  }
}

/** Captures final artifact/blob bytes plus the original SEA input projection. */
export async function createSeaBuildSeal(tag, generationId, artifact, blob, inputs) {
  const [artifactSeal, blobSeal] = await Promise.all([
    digestRegularFile(artifact, "SEA artifact"),
    digestRegularFile(blob, "retained SEA blob"),
  ]);
  return exactSeaBuildSeal({
    schemaVersion: 1,
    tag,
    generationId,
    artifact: artifactSeal,
    blob: blobSeal,
    inputs,
  });
}

/** Re-hashes both passive inputs against the byte authority held by the parent process. */
export async function verifySeaBuildSeal(value, expected, artifact, blob) {
  const seal = typeof value === "string" ? parseSeaBuildSeal(value) : exactSeaBuildSeal(value);
  if (seal.tag !== expected.tag || seal.generationId !== expected.generationId) {
    throw new Error("SEA build seal does not belong to this artifact generation");
  }
  const [artifactSeal, blobSeal] = await Promise.all([
    digestRegularFile(artifact, "SEA artifact"),
    digestRegularFile(blob, "retained SEA blob"),
  ]);
  if (
    artifactSeal.bytes !== seal.artifact.bytes
    || artifactSeal.sha256 !== seal.artifact.sha256
    || blobSeal.bytes !== seal.blob.bytes
    || blobSeal.sha256 !== seal.blob.sha256
  ) throw new Error("SEA artifact or retained blob differs from the parent-held build seal");
  return seal;
}
