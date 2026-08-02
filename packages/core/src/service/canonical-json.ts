function normalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("job input numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, seen));
  if (typeof value !== "object") throw new TypeError("job input must be JSON-compatible");
  if (seen.has(value)) throw new TypeError("job input must not be circular");

  seen.add(value);
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) result[key] = normalize(source[key], seen);
  }
  seen.delete(value);
  return result;
}

/** Produces stable JSON for any JSON-compatible value regardless of object key order. */
export function canonicalizeJson(input: unknown): string {
  return JSON.stringify(normalize(input, new Set()));
}

/** Produces stable JSON for hashing job input regardless of object key order. */
export function canonicalizeJobInput(input: unknown): string {
  return canonicalizeJson(input);
}
