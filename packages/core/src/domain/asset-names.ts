const WINDOWS_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);
const INVALID = new Set(['<', '>', ':', '"', '/', "\\", "|", "?", "*"]);

/** Produces one portable basename; client-supplied directory components never survive. */
export function sanitizeFilename(raw: string): string {
  const normalized = raw.normalize("NFC");
  const separator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  let name = "";
  for (const character of normalized.slice(separator + 1).trim()) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) continue;
    name += INVALID.has(character) ? "_" : character;
  }
  while (name.endsWith(".") || name.endsWith(" ")) name = name.slice(0, -1);
  if (!name || name === "." || name === "..") return "asset";
  const stem = name.slice(0, name.indexOf(".") < 0 ? name.length : name.indexOf(".")).toUpperCase();
  return WINDOWS_RESERVED.has(stem) ? `_${name}` : name;
}

/** Returns the first visible `name (n).ext` candidate under portable case-folding. */
export function resolveCollision(name: string, taken: ReadonlySet<string>): string {
  const folded = new Set([...taken].map((entry) => entry.normalize("NFC").toLocaleLowerCase("en-US")));
  if (!folded.has(name.toLocaleLowerCase("en-US"))) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem} (${suffix})${extension}`;
    if (!folded.has(candidate.toLocaleLowerCase("en-US"))) return candidate;
  }
}
