import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const MACHO_MAGIC_64 = 0xfeedfacf;
const MACHO_FAT_MAGICS = new Set([0xcafebabe, 0xcafebabf]);
const MACHO_CPU_ARM64 = 0x0100000c;
const MACHO_EXECUTE = 2;
const MACHO_SEGMENT_64 = 0x19;
const MACHO_SEGMENT_NAME = "NODE_SEA";
const MACHO_SECTION_NAME = "__NODE_SEA_BLOB";
const ELF_MACHINE_X64 = 62;
const ELF_PT_LOAD = 1;
const ELF_PT_NOTE = 4;
const ELF_ACTIVE_NAME_PREFIX = Buffer.from("NODE_SEA", "ascii");
const ELF_CANONICAL_NAME = Buffer.from("NODE_SEA_BLOB\0", "ascii");
const PE_MACHINE_X64 = 0x8664;
const PE_OPTIONAL_MAGIC_64 = 0x20b;
const PE_RESOURCE_TYPE_RCDATA = 10;
const SEA_RESOURCE_NAME = "NODE_SEA_BLOB";
/** Far above Node's tables while bounding work requested by an untrusted executable header. */
const MAX_HEADER_RECORDS = 4096;
const STREAM_CHUNK_BYTES = 1024 * 1024;

function invalid(message) {
  return new Error(`invalid active SEA resource: ${message}`);
}

function safeNumber(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid(`${label} exceeds the safe file range`);
  return Number(value);
}

function assertRange(offset, size, limit, label) {
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(size)
    || offset < 0
    || size < 0
    || offset > limit
    || size > limit - offset
  ) throw invalid(`${label} is outside the executable`);
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs;
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

async function readAt(file, offset, size, label) {
  assertRange(offset, size, file.size, label);
  const bytes = Buffer.allocUnsafe(size);
  if (await readExact(file.handle, bytes, offset) !== size) throw invalid(`${label} is truncated`);
  return bytes;
}

function fixedName(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("ascii");
}

function align4(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 3) {
    throw invalid("ELF note alignment overflows");
  }
  return value + ((4 - (value % 4)) % 4);
}

async function openBoundFile(filename, label) {
  const resolved = path.resolve(filename);
  const before = await lstat(resolved, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw invalid(`${label} must be one regular, non-linked file`);
  }
  if (await realpath(resolved) !== resolved) throw invalid(`${label} must not traverse a symlink`);
  const handle = await open(resolved, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (sameIdentity(before, opened)) {
      return { filename: resolved, handle, identity: before, size: safeNumber(before.size, `${label} size`) };
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

async function locateMachOResource(file) {
  const header = await readAt(file, 0, 32, "Mach-O header");
  if (header.readUInt32LE(0) !== MACHO_MAGIC_64) throw invalid("Mach-O must be little-endian 64-bit");
  if (header.readUInt32LE(4) !== MACHO_CPU_ARM64 || header.readUInt32LE(12) !== MACHO_EXECUTE) {
    throw invalid("Mach-O is not the supported arm64 executable format");
  }
  const commandCount = header.readUInt32LE(16);
  const commandBytes = header.readUInt32LE(20);
  assertRange(32, commandBytes, file.size, "Mach-O load commands");
  if (
    commandCount === 0
    || commandCount > MAX_HEADER_RECORDS
    || commandCount > Math.floor(commandBytes / 8)
  ) {
    throw invalid("Mach-O load command count is invalid");
  }

  let cursor = 32;
  const commandEnd = 32 + commandBytes;
  const matches = [];
  for (let index = 0; index < commandCount; index += 1) {
    const commandHeader = await readAt(file, cursor, 8, "Mach-O load command");
    const command = commandHeader.readUInt32LE(0);
    const commandSize = commandHeader.readUInt32LE(4);
    if (commandSize < 8 || commandSize % 8 !== 0 || cursor + commandSize > commandEnd) {
      throw invalid("Mach-O load command size is invalid");
    }
    if (command === MACHO_SEGMENT_64) {
      matches.push(...await machOSegmentResources(file, cursor, commandSize));
    }
    cursor += commandSize;
  }
  if (cursor !== commandEnd) throw invalid("Mach-O load commands do not fill their declared range");
  if (matches.length !== 1) throw invalid("Mach-O must contain exactly one active SEA section");
  return { format: "macho", ranges: matches };
}

async function machOSegmentResources(file, commandOffset, commandSize) {
  if (commandSize < 72) throw invalid("Mach-O segment command is truncated");
  const segment = await readAt(file, commandOffset, 72, "Mach-O segment command");
  const segmentName = fixedName(segment.subarray(8, 24));
  const sectionCount = segment.readUInt32LE(64);
  if (
    sectionCount > MAX_HEADER_RECORDS
    || sectionCount > Math.floor((commandSize - 72) / 80)
    || 72 + sectionCount * 80 !== commandSize
  ) {
    throw invalid("Mach-O section table size is invalid");
  }
  if (segmentName !== MACHO_SEGMENT_NAME) return [];

  const vmAddress = safeNumber(segment.readBigUInt64LE(24), "Mach-O segment address");
  const fileOffset = safeNumber(segment.readBigUInt64LE(40), "Mach-O segment file offset");
  const fileSize = safeNumber(segment.readBigUInt64LE(48), "Mach-O segment file size");
  assertRange(fileOffset, fileSize, file.size, "Mach-O SEA segment");
  const matches = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const section = await readAt(file, commandOffset + 72 + index * 80, 80, "Mach-O section");
    if (
      fixedName(section.subarray(0, 16)) !== MACHO_SECTION_NAME
      || fixedName(section.subarray(16, 32)) !== MACHO_SEGMENT_NAME
    ) continue;
    if ((section.readUInt32LE(64) & 0xff) !== 0) throw invalid("Mach-O SEA section is not regular data");
    const address = safeNumber(section.readBigUInt64LE(32), "Mach-O SEA section address");
    const size = safeNumber(section.readBigUInt64LE(40), "Mach-O SEA section size");
    if (address < vmAddress || address - vmAddress > fileSize || size > fileSize - (address - vmAddress)) {
      throw invalid("Mach-O SEA section is not fully file-backed by its segment");
    }
    const offset = fileOffset + (address - vmAddress);
    if (offset !== section.readUInt32LE(48)) throw invalid("Mach-O SEA section offset disagrees with its VM mapping");
    assertRange(offset, size, file.size, "Mach-O SEA section");
    matches.push({ offset, size });
  }
  return matches;
}

async function elfProgramHeaders(file, header) {
  const tableOffset = safeNumber(header.readBigUInt64LE(32), "ELF program header offset");
  const entrySize = header.readUInt16LE(54);
  const entryCount = header.readUInt16LE(56);
  if (
    entrySize !== 56
    || entryCount === 0
    || entryCount === 0xffff
    || entryCount > MAX_HEADER_RECORDS
  ) {
    throw invalid("ELF program header table is unsupported");
  }
  assertRange(tableOffset, entrySize * entryCount, file.size, "ELF program header table");
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    const bytes = await readAt(file, tableOffset + index * entrySize, entrySize, "ELF program header");
    entries.push({
      type: bytes.readUInt32LE(0),
      offset: safeNumber(bytes.readBigUInt64LE(8), "ELF segment offset"),
      address: safeNumber(bytes.readBigUInt64LE(16), "ELF segment address"),
      fileSize: safeNumber(bytes.readBigUInt64LE(32), "ELF segment file size"),
      memorySize: safeNumber(bytes.readBigUInt64LE(40), "ELF segment memory size"),
    });
  }
  return entries;
}

function elfNoteFileRange(note, loads, fileSize) {
  if (note.fileSize !== note.memorySize || note.memorySize <= 0) {
    throw invalid("ELF PT_NOTE is not one fully file-backed range");
  }
  const mappings = loads.filter((load) => (
    note.address >= load.address
    && note.address - load.address <= load.fileSize
    && note.memorySize <= load.fileSize - (note.address - load.address)
  ));
  if (mappings.length !== 1) throw invalid("ELF PT_NOTE does not have one authoritative PT_LOAD mapping");
  const offset = mappings[0].offset + (note.address - mappings[0].address);
  if (offset !== note.offset) throw invalid("ELF PT_NOTE offset disagrees with its VM mapping");
  assertRange(offset, note.memorySize, fileSize, "ELF PT_NOTE");
  return { offset, size: note.memorySize };
}

async function activeElfNote(file, range) {
  let cursor = range.offset;
  const end = range.offset + range.size;
  while (cursor < end) {
    if (end - cursor < 12) return null;
    const header = await readAt(file, cursor, 12, "ELF note header");
    const nameSize = header.readUInt32LE(0);
    const descriptionSize = header.readUInt32LE(4);
    const type = header.readUInt32LE(8);
    const paddedNameSize = align4(nameSize);
    const paddedDescriptionSize = align4(descriptionSize);
    const noteSize = 12 + paddedNameSize + paddedDescriptionSize;
    if (noteSize > end - cursor) throw invalid("ELF note exceeds its PT_NOTE range");
    if (nameSize > 0 && descriptionSize > 0) {
      const prefix = await readAt(file, cursor + 12, ELF_ACTIVE_NAME_PREFIX.length, "ELF note name");
      if (prefix.equals(ELF_ACTIVE_NAME_PREFIX)) {
        if (nameSize !== ELF_CANONICAL_NAME.length || type !== 0) {
          throw invalid("ELF runtime selects a non-canonical NODE_SEA-prefixed note");
        }
        const name = await readAt(file, cursor + 12, ELF_CANONICAL_NAME.length, "ELF active note name");
        if (!name.equals(ELF_CANONICAL_NAME)) {
          throw invalid("ELF runtime selects a non-canonical NODE_SEA-prefixed note");
        }
        return { offset: cursor + 12 + paddedNameSize, size: descriptionSize };
      }
    }
    cursor += noteSize;
  }
  return null;
}

async function locateElfResource(file) {
  const header = await readAt(file, 0, 64, "ELF header");
  if (
    !header.subarray(0, 4).equals(ELF_MAGIC)
    || header[4] !== 2
    || header[5] !== 1
    || header.readUInt16LE(18) !== ELF_MACHINE_X64
    || header.readUInt16LE(52) !== 64
  ) throw invalid("ELF is not the supported little-endian x86-64 format");
  const entries = await elfProgramHeaders(file, header);
  const loads = entries.filter(({ type }) => type === ELF_PT_LOAD);
  for (const note of entries.filter(({ type }) => type === ELF_PT_NOTE)) {
    const active = await activeElfNote(file, elfNoteFileRange(note, loads, file.size));
    if (active) return { format: "elf", ranges: [active] };
  }
  throw invalid("ELF has no active SEA note");
}

async function peSections(file, offset, count) {
  if (count === 0 || count > MAX_HEADER_RECORDS || count > Math.floor((file.size - offset) / 40)) {
    throw invalid("PE section count is invalid");
  }
  const sections = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = await readAt(file, offset + index * 40, 40, "PE section header");
    sections.push({
      virtualSize: bytes.readUInt32LE(8),
      address: bytes.readUInt32LE(12),
      rawSize: bytes.readUInt32LE(16),
      rawOffset: bytes.readUInt32LE(20),
    });
  }
  return sections;
}

function peRvaOffset(rva, size, sections, fileSize, label) {
  const matches = sections.filter((section) => (
    rva >= section.address
    && rva - section.address <= section.rawSize
    && size <= section.rawSize - (rva - section.address)
    && size <= Math.max(section.virtualSize, section.rawSize) - (rva - section.address)
  ));
  if (matches.length !== 1) throw invalid(`${label} does not map through one file-backed PE section`);
  const offset = matches[0].rawOffset + (rva - matches[0].address);
  assertRange(offset, size, fileSize, label);
  return offset;
}

async function peDirectoryEntries(file, resource, relative, label) {
  if (relative > resource.size || 16 > resource.size - relative) throw invalid(`${label} is outside PE resources`);
  const header = await readAt(file, resource.offset + relative, 16, label);
  const count = header.readUInt16LE(12) + header.readUInt16LE(14);
  if (
    count === 0
    || count > MAX_HEADER_RECORDS
    || count > Math.floor((resource.size - relative - 16) / 8)
  ) {
    throw invalid(`${label} entry count is invalid`);
  }
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = await readAt(file, resource.offset + relative + 16 + index * 8, 8, `${label} entry`);
    entries.push({ name: bytes.readUInt32LE(0), child: bytes.readUInt32LE(4) });
  }
  return entries;
}

function oneEntry(entries, predicate, label) {
  const matches = entries.filter(predicate);
  if (matches.length !== 1) throw invalid(`PE resources must contain exactly one ${label}`);
  return matches[0];
}

async function peResourceName(file, resource, encoded) {
  const relative = encoded & 0x7fffffff;
  if (relative > resource.size || 2 > resource.size - relative) throw invalid("PE resource name is outside resources");
  const lengthBytes = await readAt(file, resource.offset + relative, 2, "PE resource name length");
  const length = lengthBytes.readUInt16LE(0);
  if (length !== SEA_RESOURCE_NAME.length || 2 + length * 2 > resource.size - relative) return null;
  const bytes = await readAt(file, resource.offset + relative + 2, length * 2, "PE resource name");
  return bytes.toString("utf16le");
}

async function locatePeResource(file) {
  const dos = await readAt(file, 0, 64, "PE DOS header");
  if (dos.readUInt16LE(0) !== 0x5a4d) throw invalid("executable format is not supported");
  const peOffset = dos.readUInt32LE(0x3c);
  const coff = await readAt(file, peOffset, 24, "PE signature and COFF header");
  if (!coff.subarray(0, 4).equals(Buffer.from("PE\0\0", "binary")) || coff.readUInt16LE(4) !== PE_MACHINE_X64) {
    throw invalid("PE is not the supported x86-64 executable format");
  }
  const sectionCount = coff.readUInt16LE(6);
  const optionalSize = coff.readUInt16LE(20);
  const optionalOffset = peOffset + 24;
  if (optionalSize < 136) throw invalid("PE optional header is too small for resources");
  const optional = await readAt(file, optionalOffset, optionalSize, "PE optional header");
  if (optional.readUInt16LE(0) !== PE_OPTIONAL_MAGIC_64 || optional.readUInt32LE(108) < 3) {
    throw invalid("PE optional header is not PE32+ with resources");
  }
  const resourceRva = optional.readUInt32LE(128);
  const resourceSize = optional.readUInt32LE(132);
  if (resourceRva === 0 || resourceSize === 0) throw invalid("PE has no resource directory");
  const sections = await peSections(file, optionalOffset + optionalSize, sectionCount);
  const resource = {
    offset: peRvaOffset(resourceRva, resourceSize, sections, file.size, "PE resource directory"),
    size: resourceSize,
  };

  const root = await peDirectoryEntries(file, resource, 0, "PE resource root");
  const type = oneEntry(root, (entry) => (
    (entry.name & 0x80000000) === 0
    && entry.name === PE_RESOURCE_TYPE_RCDATA
  ), "RT_RCDATA directory");
  if ((type.child & 0x80000000) === 0) throw invalid("PE RT_RCDATA entry is not a directory");
  const names = await peDirectoryEntries(file, resource, type.child & 0x7fffffff, "PE RT_RCDATA directory");
  const named = [];
  for (const entry of names) {
    if ((entry.name & 0x80000000) !== 0 && await peResourceName(file, resource, entry.name) === SEA_RESOURCE_NAME) {
      named.push(entry);
    }
  }
  const resourceName = oneEntry(named, () => true, "NODE_SEA_BLOB entry");
  if ((resourceName.child & 0x80000000) === 0) throw invalid("PE NODE_SEA_BLOB entry is not a directory");
  const languages = await peDirectoryEntries(file, resource, resourceName.child & 0x7fffffff, "PE SEA language directory");
  if (languages.length !== 1 || languages[0].name !== 0 || (languages[0].child & 0x80000000) !== 0) {
    throw invalid("PE SEA resource must have one neutral language data entry");
  }
  const dataRelative = languages[0].child;
  if (dataRelative > resource.size || 16 > resource.size - dataRelative) {
    throw invalid("PE SEA data entry is outside resources");
  }
  const data = await readAt(file, resource.offset + dataRelative, 16, "PE SEA data entry");
  const size = data.readUInt32LE(4);
  if (size === 0) throw invalid("PE SEA resource is empty");
  const offset = peRvaOffset(data.readUInt32LE(0), size, sections, file.size, "PE SEA resource");
  return { format: "pe", ranges: [{ offset, size }] };
}

async function locateActiveSeaResource(file) {
  const magic = await readAt(file, 0, 4, "executable magic");
  const fatMagic = magic.readUInt32BE(0);
  if (MACHO_FAT_MAGICS.has(fatMagic)) {
    throw invalid("universal Mach-O is unsupported by the pinned postject injector");
  }
  if (magic.readUInt32LE(0) === MACHO_MAGIC_64) return locateMachOResource(file);
  if (magic.equals(ELF_MAGIC)) return locateElfResource(file);
  if (magic.readUInt16LE(0) === 0x5a4d) return locatePeResource(file);
  throw invalid("executable format is not Mach-O, ELF, or PE");
}

async function compareResource(file, range, expected) {
  if (range.size !== expected.size) throw invalid("active SEA resource size differs from the retained blob");
  const left = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  const right = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  let compared = 0;
  while (compared < range.size) {
    const length = Math.min(STREAM_CHUNK_BYTES, range.size - compared);
    const [leftRead, rightRead] = await Promise.all([
      readExact(file.handle, left.subarray(0, length), range.offset + compared),
      readExact(expected.handle, right.subarray(0, length), compared),
    ]);
    if (
      leftRead !== length
      || rightRead !== length
      || !left.subarray(0, length).equals(right.subarray(0, length))
    ) throw invalid("active SEA resource bytes differ from the retained blob");
    compared += length;
  }
}

/**
 * Verifies the loader-selected SEA resource equals the retained blob byte-for-byte.
 *
 * Opens and identity-binds both files, parses only bounded executable headers,
 * and streams the declared resource extent so large packaged runtimes are never
 * loaded into memory. Supports the release matrix: thin arm64 Mach-O, x86-64
 * little-endian ELF, and x86-64 PE32+; every other format fails closed.
 */
export async function verifyActiveSeaResource(executable, expectedBlob) {
  const file = await openBoundFile(executable, "SEA executable");
  let expected;
  try {
    expected = await openBoundFile(expectedBlob, "retained SEA blob");
  } catch (error) {
    await file.handle.close();
    throw error;
  }
  try {
    const located = await locateActiveSeaResource(file);
    for (const range of located.ranges) await compareResource(file, range, expected);
    await Promise.all([
      assertBoundFileUnchanged(file, "SEA executable"),
      assertBoundFileUnchanged(expected, "retained SEA blob"),
    ]);
    return located;
  } finally {
    await Promise.allSettled([file.handle.close(), expected.handle.close()]);
  }
}
