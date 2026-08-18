import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { applyFontStyle } from "@vidcom/adapter";
import type { RelPath } from "@vidcom/contracts";

const postcss = createRequire(new URL("../../packages/adapter/package.json", import.meta.url))("postcss") as {
  parse(source: string): {
    nodes: Array<{ type: string; selector?: string }>;
    toString(): string;
    walkAtRules(name: string, visit: (rule: { toString(): string }) => void): void;
    walkDecls(visit: (declaration: { prop: string; value: string }) => void): void;
  };
};

describe("font style serialization", () => {
  it("emits one local font-face and cannot escape CSS strings or create a second URL", async () => {
    const family = 'Family"} body { background: url(https://evil.test/x) } \\ tail';
    const result = await applyFontStyle("<html><head></head><body><main>Hi</main></body></html>", {
      family,
      style: "Bold Italic } url(evil)",
      fontPath: "assets/fonts/My Font (Final).woff2" as RelPath,
      target: { kind: "document" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const match = result.value.match(/<style[^>]*data-vidcom-font-target="document"[^>]*>([\s\S]*?)<\/style>/u);
    expect(match?.[1]).toBeTruthy();
    const root = postcss.parse(match![1]!);
    const faces: string[] = [];
    const sources: string[] = [];
    const properties: string[] = [];
    root.walkAtRules("font-face", (rule) => faces.push(rule.toString()));
    root.walkDecls((declaration) => {
      properties.push(declaration.prop);
      if (declaration.prop === "src") sources.push(declaration.value);
    });
    expect(faces).toHaveLength(1);
    expect(sources).toEqual(['url("assets/fonts/My%20Font%20(Final).woff2")']);
    expect(root.nodes.filter((node) => node.type === "rule")).toHaveLength(1);
    expect(properties).not.toContain("background");
  });

  it("replaces only the owned scope block and safely selects one inline composition", async () => {
    const source = '<html><head><style>.keep{color:red}</style></head><body></body></html>';
    const first = await applyFontStyle(source, {
      family: "Family", style: "Regular", fontPath: "assets/fonts/font.woff2" as RelPath,
      target: { kind: "composition", id: 'alpha"]{} body {' },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await applyFontStyle(first.value, {
      family: "Family", style: "Regular", fontPath: "assets/fonts/font.woff2" as RelPath,
      target: { kind: "composition", id: 'alpha"]{} body {' },
    });
    expect(second).toEqual(first);
    expect(first.value.match(/data-vidcom-font-target=/gu)).toHaveLength(1);
    expect(first.value).toContain(".keep{color:red}");
    const match = first.value.match(/<style[^>]*data-vidcom-font-target[^>]*>([\s\S]*?)<\/style>/u);
    const parsed = postcss.parse(match![1]!);
    const rules = parsed.nodes.filter((node) => node.type === "rule");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.selector).toMatch(/^\[data-composition-id="alpha\\22 /u);
  });
});
