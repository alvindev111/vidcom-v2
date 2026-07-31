export type TokenKind =
  | "plain"
  | "comment"
  | "doctype"
  | "tag"
  | "string"
  | "color"
  | "attr"
  | "selector"
  | "property"
  | "number"
  | "punctuation";

export interface Token {
  kind: TokenKind;
  value: string;
}

/**
 * Stop-gap highlighter for the read-only code view. It covers the HTML + CSS
 * subset a HyperFrames composition is written in; swap the whole thing out once
 * the panel is backed by a real editor (CodeMirror ships with the studio deps).
 */
const TOKEN_PATTERN = new RegExp(
  [
    "(?<comment>\\/\\*.*?\\*\\/|\\/\\/[^\\n]*|<!--.*?-->)",
    "(?<doctype><![a-z]+[^>]*>)",
    "(?<tag><\\/?[a-z][\\w-]*)",
    "(?<string>\"[^\"]*\"|'[^']*')",
    "(?<color>#[0-9a-f]{3,8}\\b)",
    "(?<attr>[a-z-]+(?=\\s*=))",
    "(?<selector>[.#][a-z][\\w-]*|:[a-z-]+(?=\\s*[{,])|\\*(?=\\s*\\{))",
    "(?<property>--[a-z][\\w-]*|[a-z-]+(?=\\s*:))",
    "(?<number>\\b\\d+(?:\\.\\d+)?(?:px|%|s|ms|rem|em|vh|vw|deg|fr)?\\b)",
    "(?<punctuation>[{}()\\[\\];:,=>/])",
  ].join("|"),
  "gis",
);

const KIND_ORDER: TokenKind[] = [
  "comment",
  "doctype",
  "tag",
  "string",
  "color",
  "attr",
  "selector",
  "property",
  "number",
  "punctuation",
];

export function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  for (const match of line.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ kind: "plain", value: line.slice(cursor, index) });
    }

    const kind =
      KIND_ORDER.find((candidate) => match.groups?.[candidate] != null) ??
      "plain";
    tokens.push({ kind, value: match[0] });
    cursor = index + match[0].length;
  }

  if (cursor < line.length) {
    tokens.push({ kind: "plain", value: line.slice(cursor) });
  }

  return tokens;
}

export const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: "text-foreground/85",
  comment: "text-muted-foreground italic",
  doctype: "text-muted-foreground",
  tag: "text-sky-600 dark:text-sky-400",
  string: "text-amber-700 dark:text-amber-300",
  color: "text-emerald-600 dark:text-emerald-300",
  attr: "text-violet-600 dark:text-violet-300",
  selector: "text-rose-600 dark:text-rose-300",
  property: "text-teal-700 dark:text-teal-300",
  number: "text-orange-600 dark:text-orange-300",
  punctuation: "text-muted-foreground",
};
