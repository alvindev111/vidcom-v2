export type AssetKind = "image" | "video" | "audio" | "font";

export const ASSET_POLICIES = Object.freeze({
  image: { maxBytes: 25 * 1024 * 1024, extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg"] },
  video: { maxBytes: 500 * 1024 * 1024, extensions: ["mp4", "webm", "mov"] },
  audio: { maxBytes: 100 * 1024 * 1024, extensions: ["mp3", "wav", "m4a", "ogg"] },
  font: { maxBytes: 5 * 1024 * 1024, extensions: ["woff2", "woff", "ttf", "otf"] },
}) satisfies Readonly<Record<AssetKind, { maxBytes: number; extensions: readonly string[] }>>;

function has(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function looksLikeSvg(head: Uint8Array): boolean {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(head);
    if (source.startsWith("\uFEFF")) source = source.slice(1);
    source = source.trimStart();
  } catch {
    return false;
  }
  if (source.startsWith("<?xml")) {
    const end = source.indexOf("?>");
    if (end < 0) return false;
    source = source.slice(end + 2).trimStart();
  }
  while (source.startsWith("<!--")) {
    const end = source.indexOf("-->", 4);
    if (end < 0) return false;
    source = source.slice(end + 3).trimStart();
  }
  return source.startsWith("<svg") && [">", "/", " ", "\t", "\r", "\n"].includes(source[4] ?? "");
}

/** Detects an upload class from a bounded head buffer, never from client MIME. */
export function detectAssetKind(head: Uint8Array): AssetKind | null {
  if (has(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    || has(head, 0, [0xff, 0xd8, 0xff])
    || ascii(head, 0, 6) === "GIF87a"
    || ascii(head, 0, 6) === "GIF89a"
    || (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP")
    || looksLikeSvg(head)) return "image";

  if (has(head, 0, [0x1a, 0x45, 0xdf, 0xa3])) return "video";
  if (ascii(head, 4, 4) === "ftyp") {
    const brand = ascii(head, 8, 4).toUpperCase();
    return brand.startsWith("M4A") || brand.startsWith("M4B") ? "audio" : "video";
  }

  if (ascii(head, 0, 3) === "ID3"
    || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)
    || (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WAVE")
    || ascii(head, 0, 4) === "OggS") return "audio";

  if (ascii(head, 0, 4) === "wOFF"
    || ascii(head, 0, 4) === "wOF2"
    || ascii(head, 0, 4) === "OTTO"
    || ascii(head, 0, 4) === "true"
    || has(head, 0, [0x00, 0x01, 0x00, 0x00])) return "font";
  return null;
}

export function matchesDeclaredKind(head: Uint8Array, kind: AssetKind): boolean {
  return detectAssetKind(head) === kind;
}
