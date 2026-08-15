import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { resolveWithinProject } from "@hyperframes/core";
import * as fontkit from "fontkit";
import { parseHTML } from "linkedom";

import type { RelPath } from "@vidcom/contracts";
import type {
  CompositionSource,
  FontCompatibilityIssue,
  FontCompatibilityPort,
  ProjectRef,
} from "@vidcom/core";

import { authoredCompositionRoot } from "./dom";
import {
  collectTextRuns,
  cssResourcePath,
  fontFamilies,
  parseFontFaces,
  relevantCodePoints,
  type CssChunk,
  type FontFace,
  type TextRun,
} from "./font-css";

const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif",
  "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong",
]);

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function containedFile(ref: ProjectRef, relativePath: RelPath): Promise<string | null> {
  const candidate = resolveWithinProject(ref.root, relativePath);
  if (!candidate) return null;
  try {
    const [root, target] = await Promise.all([realpath(ref.root), realpath(candidate)]);
    const relative = path.relative(root, target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    return (await stat(target)).isFile() ? target : null;
  } catch {
    return null;
  }
}

async function readProjectBytes(ref: ProjectRef, relativePath: RelPath): Promise<Uint8Array | null> {
  const filename = await containedFile(ref, relativePath);
  return filename ? new Uint8Array(await readFile(filename)) : null;
}

async function stylesheetChunks(
  ref: ProjectRef,
  document: Document,
  sourcePath: RelPath,
  issues: FontCompatibilityIssue[],
): Promise<CssChunk[]> {
  const chunks: CssChunk[] = [...document.querySelectorAll("style")]
    .map((element) => ({ path: sourcePath, css: element.textContent ?? "" }));
  const queue = [...document.querySelectorAll("link[rel~='stylesheet']")]
    .flatMap((element) => {
      const href = element.getAttribute("href");
      const resolved = href ? cssResourcePath(sourcePath, href) : null;
      return resolved ? [resolved] : [];
    });
  const seen = new Set<RelPath>();
  while (queue.length > 0) {
    const cssPath = queue.shift()!;
    if (seen.has(cssPath)) continue;
    seen.add(cssPath);
    const bytes = await readProjectBytes(ref, cssPath);
    if (!bytes) continue;
    const css = decodeUtf8(bytes);
    if (css === null) {
      issues.push({ kind: "invalid-utf8", sourceFile: cssPath });
      continue;
    }
    chunks.push({ path: cssPath, css });
    for (const imported of css.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/giu)) {
      const resolved = cssResourcePath(cssPath, imported[1]!);
      if (resolved) queue.push(resolved);
    }
  }
  return chunks;
}

function fontsFromResource(resource: fontkit.Font | fontkit.FontCollection): fontkit.Font[] {
  return "fonts" in resource ? resource.fonts : [resource];
}

function sample(text: string): string {
  return [...text].slice(0, 80).join("");
}

/** Reads UTF-8 composition text and proves project-local font glyph coverage with fontkit. */
export class FontkitCompatibilityInspector implements FontCompatibilityPort {
  async inspect(ref: ProjectRef, sources: readonly CompositionSource[]): Promise<FontCompatibilityIssue[]> {
    const issues: FontCompatibilityIssue[] = [];
    const coverage = new Map<RelPath, Set<number> | null>();
    for (const source of sources) {
      if (!source.path.toLowerCase().endsWith(".html")) continue;
      const bytes = await readProjectBytes(ref, source.path);
      if (!bytes) continue;
      const html = decodeUtf8(bytes);
      if (html === null) {
        issues.push({ kind: "invalid-utf8", sourceFile: source.path });
        continue;
      }
      const { document } = parseHTML(html);
      const chunks = await stylesheetChunks(ref, document, source.path, issues);
      const faces = parseFontFaces(chunks);
      const runs = collectTextRuns(authoredCompositionRoot(document), chunks);
      for (const run of runs) {
        await this.inspectRun(ref, source.path, run, faces, coverage, issues);
      }
    }
    const unique = new Map<string, FontCompatibilityIssue>();
    for (const issue of issues) unique.set(JSON.stringify(issue), issue);
    return [...unique.values()];
  }

  private async inspectRun(
    ref: ProjectRef,
    sourceFile: RelPath,
    run: TextRun,
    faces: ReadonlyMap<string, FontFace>,
    coverage: Map<RelPath, Set<number> | null>,
    issues: FontCompatibilityIssue[],
  ): Promise<void> {
    const families = run.family ? fontFamilies(run.family) : [];
    if (families.length === 0) {
      issues.push({
        kind: "font-coverage-unverified",
        sourceFile,
        sample: sample(run.text),
      });
      return;
    }
    const required = new Set(relevantCodePoints(run.text));
    const supported = new Set<number>();
    const inspectedFaces: FontFace[] = [];
    let uninspectableBeforeProof: string | null = null;
    for (const family of families) {
      if (required.size === 0) break;
      const face = faces.get(family.toLocaleLowerCase("en-US"));
      if (GENERIC_FAMILIES.has(family.toLocaleLowerCase("en-US")) || !face) {
        uninspectableBeforeProof ??= family;
        continue;
      }
      inspectedFaces.push(face);
      if (face.hasUninspectableSource || face.paths.length === 0) uninspectableBeforeProof ??= face.family;
      for (const fontPath of face.paths) {
        let codePoints = coverage.get(fontPath);
        if (codePoints === undefined) {
          codePoints = await this.readCoverage(ref, fontPath);
          coverage.set(fontPath, codePoints);
        }
        if (codePoints === null) {
          issues.push({ kind: "font-file-invalid", sourceFile, fontFamily: face.family, fontFile: fontPath });
        } else {
          for (const codePoint of codePoints) {
            supported.add(codePoint);
            required.delete(codePoint);
          }
        }
      }
    }
    if (required.size === 0) {
      if (uninspectableBeforeProof) issues.push({
        kind: "font-coverage-unverified",
        sourceFile,
        fontFamily: uninspectableBeforeProof,
        sample: sample(run.text),
      });
      return;
    }
    if (inspectedFaces.length === 0 || supported.size === 0 && uninspectableBeforeProof) {
      issues.push({
        kind: "font-coverage-unverified",
        sourceFile,
        fontFamily: uninspectableBeforeProof ?? families[0],
        missingCodePoints: [...required],
        sample: sample(run.text),
      });
      return;
    }
    issues.push({
      kind: "font-glyph-missing",
      sourceFile,
      fontFamily: inspectedFaces.map(({ family }) => family).join(", "),
      fontFile: inspectedFaces.flatMap(({ paths }) => paths).at(0),
      missingCodePoints: [...required],
      sample: sample(run.text),
    });
  }

  private async readCoverage(ref: ProjectRef, fontPath: RelPath): Promise<Set<number> | null> {
    const bytes = await readProjectBytes(ref, fontPath);
    if (!bytes) return null;
    try {
      const resource = fontkit.create(Buffer.from(bytes));
      return new Set(fontsFromResource(resource).flatMap((font) => font.characterSet));
    } catch {
      return null;
    }
  }
}
