const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIMESTAMP = 2 ** 48 - 1;

export interface UlidSource {
  now(): number;
  randomBytes(length: number): Uint8Array;
}

const browserSource: UlidSource = {
  now: Date.now,
  randomBytes(length) {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  },
};

function encodeTimestamp(value: number): string {
  let output = "";
  for (let index = 0; index < 10; index += 1) {
    output = CROCKFORD[value % 32]! + output;
    value = Math.floor(value / 32);
  }
  return output;
}

function encodeRandom(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = buffer * 256 + byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      const divisor = 2 ** bits;
      output += CROCKFORD[Math.floor(buffer / divisor)]!;
      buffer %= divisor;
    }
  }
  return output;
}

/** Generates a canonical 48-bit timestamp + 80-bit randomness ULID. */
export function createUlid(source: UlidSource = browserSource): string {
  const timestamp = source.now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_TIMESTAMP) {
    throw new RangeError("ULID timestamp is outside the 48-bit range");
  }
  const random = source.randomBytes(10);
  if (random.byteLength !== 10) throw new RangeError("ULID randomness must be exactly 80 bits");
  return encodeTimestamp(timestamp) + encodeRandom(random);
}
