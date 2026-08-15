import { randomUUID } from "node:crypto";
import { chmod, lstat, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

const ELF_HEADER_BYTES = 64;
const PROGRAM_HEADER_BYTES = 56;
const ELF_MACHINE_X64 = 62;
const PT_LOAD = 1;
const PT_NOTE = 4;
const PT_PHDR = 6;
const PF_READ = 4;
const PAGE_BYTES = 4096;
const SEGMENT_ADDRESS_GAP = 128 * 1024 * 1024;
const COPY_BYTES = 1024 * 1024;
const MAX_PROGRAM_HEADERS = 4096;
const NOTE_NAME = Buffer.from("NODE_SEA_BLOB\0", "ascii");
export const ELF_SEA_INJECTOR = "vidcom-elf-stream-v1";

function fail(message) {
  throw new Error(`inject-elf-sea: ${message}`);
}

function align(value, multiple) {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(multiple) || multiple <= 0) {
    fail("alignment input is invalid");
  }
  const remainder = value % multiple;
  const result = remainder === 0 ? value : value + multiple - remainder;
  if (!Number.isSafeInteger(result)) fail("alignment overflows the safe file range");
  return result;
}

function safeNumber(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${label} exceeds the safe file range`);
  return Number(value);
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

async function boundRegularFile(filename, label) {
  const resolved = path.resolve(filename);
  const metadata = await lstat(resolved, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    fail(`${label} must be one regular, non-linked file`);
  }
  // Resolve ancestor aliases once (notably macOS /tmp -> /private/tmp), then
  // keep every later operation bound to the canonical path. lstat above still
  // rejects a symlink at the user-selected leaf.
  return { path: await realpath(resolved), metadata };
}

function parseProgramHeader(bytes) {
  return {
    type: bytes.readUInt32LE(0),
    flags: bytes.readUInt32LE(4),
    offset: safeNumber(bytes.readBigUInt64LE(8), "ELF segment offset"),
    address: safeNumber(bytes.readBigUInt64LE(16), "ELF segment address"),
    physicalAddress: safeNumber(bytes.readBigUInt64LE(24), "ELF segment physical address"),
    fileSize: safeNumber(bytes.readBigUInt64LE(32), "ELF segment file size"),
    memorySize: safeNumber(bytes.readBigUInt64LE(40), "ELF segment memory size"),
    alignment: safeNumber(bytes.readBigUInt64LE(48), "ELF segment alignment"),
  };
}

function serializeProgramHeader(entry) {
  const bytes = Buffer.alloc(PROGRAM_HEADER_BYTES);
  bytes.writeUInt32LE(entry.type, 0);
  bytes.writeUInt32LE(entry.flags, 4);
  bytes.writeBigUInt64LE(BigInt(entry.offset), 8);
  bytes.writeBigUInt64LE(BigInt(entry.address), 16);
  bytes.writeBigUInt64LE(BigInt(entry.physicalAddress), 24);
  bytes.writeBigUInt64LE(BigInt(entry.fileSize), 32);
  bytes.writeBigUInt64LE(BigInt(entry.memorySize), 40);
  bytes.writeBigUInt64LE(BigInt(entry.alignment), 48);
  return bytes;
}

async function readExactly(handle, bytes, position, label) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, position + offset);
    if (result.bytesRead === 0) fail(`${label} is truncated`);
    offset += result.bytesRead;
  }
}

async function writeExactly(handle, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    if (result.bytesWritten === 0) fail("write made no progress");
    offset += result.bytesWritten;
  }
}

async function copyHandle(source, destination, sourcePosition, destinationPosition, bytes) {
  const buffer = Buffer.allocUnsafe(COPY_BYTES);
  let copied = 0;
  while (copied < bytes) {
    const length = Math.min(buffer.length, bytes - copied);
    const chunk = buffer.subarray(0, length);
    await readExactly(source, chunk, sourcePosition + copied, "SEA blob");
    await writeExactly(destination, chunk, destinationPosition + copied);
    copied += length;
  }
}

async function findFuse(handle, fileSize, fuse) {
  const needle = Buffer.from(`${fuse}:`, "ascii");
  const chunk = Buffer.allocUnsafe(COPY_BYTES + needle.length - 1);
  let carry = 0;
  let position = 0;
  let match = -1;
  while (position < fileSize) {
    const length = Math.min(COPY_BYTES, fileSize - position);
    const view = chunk.subarray(carry, carry + length);
    await readExactly(handle, view, position, "ELF executable");
    const available = carry + length;
    let from = 0;
    while (from < available) {
      const index = chunk.subarray(0, available).indexOf(needle, from);
      if (index === -1) break;
      const absolute = position - carry + index;
      if (match !== -1 && match !== absolute) fail("SEA sentinel occurs more than once");
      match = absolute;
      from = index + 1;
    }
    carry = Math.min(needle.length - 1, available);
    chunk.copyWithin(0, available - carry, available);
    position += length;
  }
  if (match === -1) fail("SEA sentinel is absent");
  const state = Buffer.alloc(1);
  await readExactly(handle, state, match + needle.length, "SEA sentinel state");
  if (state[0] !== 0x30) fail("SEA sentinel is already active or malformed");
  return match + needle.length;
}

/**
 * Streams one Node SEA blob into an x86-64 ELF without postject's 256 MiB WASM heap.
 *
 * The program-header table moves into a gap covered by an existing PT_LOAD.
 * The original PT_NOTE is repointed to the canonical NODE_SEA_BLOB note, and a
 * new read-only PT_LOAD maps those bytes for Node and the independent verifier.
 */
export async function injectElfSea(executable, blob, sentinelFuse) {
  const [target, resource] = await Promise.all([
    boundRegularFile(executable, "ELF executable"),
    boundRegularFile(blob, "SEA blob"),
  ]);
  const originalSize = safeNumber(target.metadata.size, "ELF executable size");
  const blobSize = safeNumber(resource.metadata.size, "SEA blob size");
  if (blobSize <= 0 || blobSize > 0xffffffff) fail("SEA blob size is outside the ELF note format");

  const source = await open(target.path, "r");
  const blobHandle = await open(resource.path, "r");
  const temporary = `${target.path}.elf-inject-${process.pid}-${randomUUID()}`;
  let output;
  try {
    const [openedTarget, openedBlob] = await Promise.all([
      source.stat({ bigint: true }),
      blobHandle.stat({ bigint: true }),
    ]);
    if (!sameIdentity(target.metadata, openedTarget) || !sameIdentity(resource.metadata, openedBlob)) {
      fail("an injection input changed before its file descriptor was bound");
    }
    const header = Buffer.alloc(ELF_HEADER_BYTES);
    await readExactly(source, header, 0, "ELF header");
    if (
      !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      || header[4] !== 2
      || header[5] !== 1
      || header.readUInt16LE(18) !== ELF_MACHINE_X64
      || header.readUInt16LE(52) !== ELF_HEADER_BYTES
    ) fail("executable is not supported little-endian x86-64 ELF");
    const tableOffset = safeNumber(header.readBigUInt64LE(32), "ELF program-header offset");
    const entrySize = header.readUInt16LE(54);
    const entryCount = header.readUInt16LE(56);
    if (entrySize !== PROGRAM_HEADER_BYTES || entryCount <= 0 || entryCount >= MAX_PROGRAM_HEADERS) {
      fail("ELF program-header table is unsupported");
    }
    if (tableOffset > originalSize || entryCount * entrySize > originalSize - tableOffset) {
      fail("ELF program-header table is outside the executable");
    }
    const table = Buffer.alloc(entryCount * entrySize);
    await readExactly(source, table, tableOffset, "ELF program-header table");
    const entries = Array.from({ length: entryCount }, (_, index) => (
      parseProgramHeader(table.subarray(index * entrySize, (index + 1) * entrySize))
    ));
    const phdrIndexes = entries.map((entry, index) => entry.type === PT_PHDR ? index : -1).filter((index) => index >= 0);
    const noteIndexes = entries.map((entry, index) => entry.type === PT_NOTE ? index : -1).filter((index) => index >= 0);
    const loads = entries.filter((entry) => entry.type === PT_LOAD);
    if (phdrIndexes.length !== 1 || noteIndexes.length !== 1 || loads.length === 0) {
      fail("ELF must contain exactly one PT_PHDR, one PT_NOTE, and at least one PT_LOAD");
    }

    const relocatedTableBytes = (entryCount + 1) * PROGRAM_HEADER_BYTES;
    const loadIndexes = entries.map((entry, index) => entry.type === PT_LOAD ? index : -1).filter((index) => index >= 0);
    const tableCandidates = loadIndexes.flatMap((index, order) => {
      const entry = entries[index];
      const next = loads[order + 1];
      if (entry.fileSize !== entry.memorySize || !next) return [];
      const fileGap = next.offset - (entry.offset + entry.fileSize);
      const addressGap = next.address - (entry.address + entry.memorySize);
      return fileGap >= relocatedTableBytes && addressGap >= relocatedTableBytes
        ? [{ index, fileGap, tableOffset: entry.offset + entry.fileSize, tableAddress: entry.address + entry.memorySize }]
        : [];
    }).sort((left, right) => right.fileGap - left.fileGap);
    if (tableCandidates.length === 0) fail("ELF has no mapped gap for a relocated program-header table");
    const tablePlacement = tableCandidates[0];
    const segmentOffset = align(originalSize, PAGE_BYTES);
    const noteOffset = segmentOffset;
    const paddedNameBytes = align(NOTE_NAME.length, 4);
    const paddedBlobBytes = align(blobSize, 4);
    const noteBytes = 12 + paddedNameBytes + paddedBlobBytes;
    const segmentBytes = noteOffset - segmentOffset + noteBytes;
    const maxAddress = Math.max(...loads.map((entry) => entry.address + entry.memorySize));
    const segmentAddress = align(Math.max(
      maxAddress + SEGMENT_ADDRESS_GAP,
      segmentOffset + SEGMENT_ADDRESS_GAP,
    ), PAGE_BYTES);
    if (loads.some((entry) => segmentAddress < entry.address + entry.memorySize)) {
      fail("new ELF SEA segment overlaps an existing load segment");
    }

    entries[phdrIndexes[0]] = {
      type: PT_PHDR,
      flags: PF_READ,
      offset: tablePlacement.tableOffset,
      address: tablePlacement.tableAddress,
      physicalAddress: tablePlacement.tableAddress,
      fileSize: relocatedTableBytes,
      memorySize: relocatedTableBytes,
      alignment: 8,
    };
    entries[tablePlacement.index] = {
      ...entries[tablePlacement.index],
      fileSize: entries[tablePlacement.index].fileSize + relocatedTableBytes,
      memorySize: entries[tablePlacement.index].memorySize + relocatedTableBytes,
    };
    const noteAddress = segmentAddress + noteOffset - segmentOffset;
    entries[noteIndexes[0]] = {
      type: PT_NOTE,
      flags: PF_READ,
      offset: noteOffset,
      address: noteAddress,
      physicalAddress: noteAddress,
      fileSize: noteBytes,
      memorySize: noteBytes,
      alignment: 4,
    };
    const newLoad = {
      type: PT_LOAD,
      flags: PF_READ,
      offset: segmentOffset,
      address: segmentAddress,
      physicalAddress: segmentAddress,
      fileSize: segmentBytes,
      memorySize: segmentBytes,
      alignment: PAGE_BYTES,
    };
    entries.splice(loadIndexes.at(-1) + 1, 0, newLoad);

    output = await open(temporary, "wx+", Number(target.metadata.mode & 0o777n));
    await copyHandle(source, output, 0, 0, originalSize);
    header.writeBigUInt64LE(BigInt(tablePlacement.tableOffset), 32);
    header.writeUInt16LE(entryCount + 1, 56);
    await writeExactly(output, header, 0);
    const fuseStateOffset = await findFuse(source, originalSize, sentinelFuse);
    await writeExactly(output, Buffer.from("1"), fuseStateOffset);
    const relocatedTable = Buffer.concat(entries.map(serializeProgramHeader));
    await writeExactly(output, relocatedTable, tablePlacement.tableOffset);
    const noteHeader = Buffer.alloc(12);
    noteHeader.writeUInt32LE(NOTE_NAME.length, 0);
    noteHeader.writeUInt32LE(blobSize, 4);
    noteHeader.writeUInt32LE(0, 8);
    await writeExactly(output, noteHeader, noteOffset);
    await writeExactly(output, NOTE_NAME, noteOffset + 12);
    const blobOffset = noteOffset + 12 + paddedNameBytes;
    await copyHandle(blobHandle, output, 0, blobOffset, blobSize);
    if (paddedBlobBytes > blobSize) {
      await writeExactly(output, Buffer.alloc(paddedBlobBytes - blobSize), blobOffset + blobSize);
    }
    await output.truncate(segmentOffset + segmentBytes);
    await output.sync();
    await output.close();
    output = null;
    await chmod(temporary, Number(target.metadata.mode & 0o777n));

    const [sourceAfter, blobAfter] = await Promise.all([
      lstat(target.path, { bigint: true }),
      lstat(resource.path, { bigint: true }),
    ]);
    if (!sameIdentity(target.metadata, sourceAfter) || !sameIdentity(resource.metadata, blobAfter)) {
      fail("an injection input changed while it was being streamed");
    }
    // Windows does not allow replacing a file while this process still holds
    // the source handle open. Closing both authenticated inputs here does not
    // weaken publication: rename replaces the exact leaf and never follows a
    // destination symlink or writes through a destination hardlink.
    await Promise.all([source.close(), blobHandle.close()]);
    await rename(temporary, target.path);
  } finally {
    await Promise.allSettled([source.close(), blobHandle.close(), output?.close()]);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
