import { isIP } from "node:net";

/**
 * Public-network address policy shared by every outbound adapter.
 *
 * Extracted from the BGM provider so the catalog registry client applies the
 * identical rule instead of a second, subtly different one. Pure functions with
 * no error vocabulary of their own, so each caller keeps its own diagnostics.
 */

/** Whether an address is ordinary public unicast and safe to connect to. */
export function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized)?.[1];
  if (mapped) return isPublicAddress(mapped);
  if (normalized.includes(".")) {
    const parts = normalized.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b] = parts as [number, number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168 || (b === 88 && parts[2] === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100)))
      || (a === 203 && b === 0 && parts[2] === 113));
  }
  if (isIP(normalized) !== 6) return false;
  const expanded = expandIpv6(normalized);
  if (!expanded) return false;
  const [a, b, c, d, e, f, g, h] = expanded;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return isPublicAddress(`${g! >> 8}.${g! & 0xff}.${h! >> 8}.${h! & 0xff}`);
  }
  // Only ordinary global-unicast IPv6 is eligible. Translation/transition,
  // documentation and benchmarking prefixes can embed a private IPv4 target
  // or have no public route, so an adapter must not connect through them.
  if (a! < 0x2000 || a! > 0x3fff) return false;
  if (a === 0x2002) return false; // 6to4
  if (a === 0x2001 && (
    b === 0x0000 // Teredo and special-purpose 2001::/32
    || (b === 0x0002 && c === 0x0000) // benchmarking
    || (b! >= 0x0010 && b! <= 0x002f) // ORCHID/ORCHIDv2
    || b === 0x0db8 // documentation
  )) return false;
  if (a === 0x3fff && b! <= 0x0fff) return false; // documentation
  return true;
}

/** Expands an IPv6 literal into eight 16-bit groups, or null when malformed. */
export function expandIpv6(address: string): number[] | null {
  const pieces = address.split("::");
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((pieces.length === 1 && missing !== 0) || missing < 0) return null;
  const values = [...left, ...Array.from({ length: missing }, () => "0"), ...right]
    .map((piece) => Number.parseInt(piece || "0", 16));
  return values.length === 8 && values.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffff)
    ? values
    : null;
}
