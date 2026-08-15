import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  SEA_PRODUCT_CODE_PATH,
  exactSeaInputProjection,
} from "./sea-build-seal.mjs";

const SEA_MAGIC = 0x0143da20;
const PRODUCT_FLAGS = (1 << 0) | (1 << 3);
const EXEC_ARGV_EXTENSION_ENV = 1;
const MAX_ASSET_COUNT = 64;
const MAX_TEXT_BYTES = 4096;
const STREAM_CHUNK_BYTES = 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function invalid(message) {
  return new Error(`invalid SEA preparation blob: ${message}`);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

async function openBoundFile(filename, label, allowEmpty = true) {
  const resolved = path.resolve(filename);
  const before = await lstat(resolved, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw invalid(`${label} must be one regular, non-linked file`);
  }
  if (
    (!allowEmpty && before.size === 0n)
    || before.size < 0n
    || before.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) throw invalid(`${label} size is invalid`);
  if (await realpath(resolved) !== resolved) throw invalid(`${label} must not traverse a symlink`);
  const handle = await open(resolved, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (sameIdentity(before, opened)) {
      return { filename: resolved, handle, identity: before, size: Number(before.size) };
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  throw invalid(`${label} changed while it was opened`);
}

async function assertBoundFileUnchanged(file, label) {
  const [opened, current, canonical] = await Promise.all([
    file.handle.stat({ bigint: true }),
    lstat(file.filename, { bigint: true }),
    realpath(file.filename),
  ]);
  if (
    !sameIdentity(file.identity, opened)
    || !sameIdentity(file.identity, current)
    || current.nlink !== 1n
    || canonical !== file.filename
  ) throw invalid(`${label} changed during verification`);
}

function assertRange(offset, size, limit, label) {
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(size)
    || offset < 0
    || size < 0
    || offset > limit
    || size > limit - offset
  ) throw invalid(`${label} is outside the blob`);
}

async function readExact(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return offset;
}

async function readAt(blob, offset, size, label) {
  assertRange(offset, size, blob.size, label);
  const bytes = Buffer.allocUnsafe(size);
  if (await readExact(blob.handle, bytes, offset) !== size) throw invalid(`${label} is truncated`);
  return bytes;
}

async function readLength(blob, cursor, label) {
  const bytes = await readAt(blob, cursor, 8, `${label} length`);
  const value = bytes.readBigUInt64LE(0);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid(`${label} length exceeds the safe file range`);
  return Number(value);
}

async function readView(blob, cursor, label) {
  const size = await readLength(blob, cursor, label);
  const offset = cursor + 8;
  assertRange(offset, size, blob.size, label);
  return { offset, size, next: offset + size };
}

async function readText(blob, cursor, label) {
  const view = await readView(blob, cursor, label);
  if (view.size === 0 || view.size > MAX_TEXT_BYTES) throw invalid(`${label} size is invalid`);
  let value;
  try {
    value = utf8.decode(await readAt(blob, view.offset, view.size, label));
  } catch {
    throw invalid(`${label} is not UTF-8`);
  }
  if (value.includes("\0")) throw invalid(`${label} contains NUL`);
  return { value, next: view.next };
}

async function parseProductBlob(blob) {
  const header = await readAt(blob, 0, 9, "SEA header");
  if (header.readUInt32LE(0) !== SEA_MAGIC) throw invalid("magic is invalid");
  if (header.readUInt32LE(4) !== PRODUCT_FLAGS) throw invalid("flags differ from the product configuration");
  if (header.readUInt8(8) !== EXEC_ARGV_EXTENSION_ENV) {
    throw invalid("exec argv extension differs from the product configuration");
  }
  let cursor = 9;
  const codePath = await readText(blob, cursor, "SEA code path");
  cursor = codePath.next;
  if (codePath.value !== SEA_PRODUCT_CODE_PATH) throw invalid("code path differs from the sealed loader path");
  const main = await readView(blob, cursor, "SEA main code");
  cursor = main.next;
  if (main.size === 0) throw invalid("main code is empty");
  const count = await readLength(blob, cursor, "SEA asset count");
  cursor += 8;
  if (count === 0 || count > MAX_ASSET_COUNT) throw invalid("asset count is invalid");
  const assets = [];
  const keys = new Set();
  for (let index = 0; index < count; index += 1) {
    const key = await readText(blob, cursor, `SEA asset key ${index}`);
    cursor = key.next;
    if (keys.has(key.value)) throw invalid("asset keys are duplicated");
    keys.add(key.value);
    const content = await readView(blob, cursor, `SEA asset ${key.value}`);
    cursor = content.next;
    assets.push({ key: key.value, offset: content.offset, size: content.size });
  }
  if (cursor !== blob.size) throw invalid("trailing bytes remain after the asset table");
  assets.sort((left, right) => compareUtf8(left.key, right.key));
  return {
    codePath: codePath.value,
    main: { offset: main.offset, size: main.size },
    assets,
  };
}

async function verifySpanSeal(blob, span, expected, label) {
  if (span.size !== expected.bytes) throw invalid(`${label} size differs from the sealed input`);
  const buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  const hash = createHash("sha256");
  let compared = 0;
  while (compared < span.size) {
    const length = Math.min(STREAM_CHUNK_BYTES, span.size - compared);
    const bytes = buffer.subarray(0, length);
    if (await readExact(blob.handle, bytes, span.offset + compared) !== length) {
      throw invalid(`${label} is truncated`);
    }
    hash.update(bytes);
    compared += length;
  }
  const sha256 = `sha256:${hash.digest("hex")}`;
  if (sha256 !== expected.sha256) throw invalid(`${label} bytes differ from the sealed input`);
  return { bytes: span.size, sha256 };
}

/**
 * Parses Node 24.9's supported-host SEA blob without executing its main code.
 * The product fixes all optional flags, so every byte must be main or one exact
 * raw asset and the cursor must finish at EOF.
 */
export async function verifySeaPreparationBlob(filename, sealedProjection) {
  const blob = await openBoundFile(filename, "SEA preparation blob", false);
  try {
    const parsed = await parseProductBlob(blob);
    const projection = exactSeaInputProjection(sealedProjection);
    const expectedAssets = projection.assets;
    if (
      parsed.assets.length !== expectedAssets.length
      || parsed.assets.some((asset, index) => asset.key !== expectedAssets[index].key)
    ) throw invalid("asset keys differ from the sealed input set");

    const main = await verifySpanSeal(blob, parsed.main, projection.main, "SEA main code");
    const assets = [];
    for (let index = 0; index < parsed.assets.length; index += 1) {
      const asset = parsed.assets[index];
      const expected = expectedAssets[index];
      assets.push({
        key: asset.key,
        ...await verifySpanSeal(blob, asset, expected, `SEA asset ${asset.key}`),
      });
    }
    await assertBoundFileUnchanged(blob, "SEA preparation blob");
    return Object.freeze({ schemaVersion: 1, codePath: parsed.codePath, main, assets });
  } finally {
    await blob.handle.close();
  }
}
