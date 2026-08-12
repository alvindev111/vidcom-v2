import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = [
  "packages/adapter/src",
  "packages/cli/bin",
  "packages/cli/src",
  "packages/core/src",
  "packages/mcp/src",
  "packages/server/src",
  "packages/worker/src",
] as const;

interface ImportRecord {
  file: string;
  module: string;
  names: string[];
  dynamic: boolean;
}

const EXPECTED_HYPERFRAMES_IMPORTS: ImportRecord[] = [
  record("packages/adapter/src/hyperframes/compiler-probe-child.ts", "@hyperframes/core/compiler", ["dynamic"], true),
  record("packages/adapter/src/hyperframes/document.ts", "@hyperframes/studio-server", ["buildSubCompositionHtml"]),
  record("packages/adapter/src/hyperframes/dom.ts", "@hyperframes/core", ["readClipTiming"]),
  record("packages/adapter/src/hyperframes/elements.ts", "@hyperframes/core", ["readClipTiming"]),
  record("packages/adapter/src/hyperframes/elements.ts", "@hyperframes/parsers/gsap-parser", ["parseGsapScript"]),
  record("packages/adapter/src/hyperframes/font-compatibility.ts", "@hyperframes/core", ["resolveWithinProject"]),
  record("packages/adapter/src/hyperframes/legacy-projects.ts", "@hyperframes/core", [
    "getHyperframeRuntimeScript", "parseNumeric", "readClipTiming", "resolveWithinProject",
  ]),
  record("packages/adapter/src/hyperframes/legacy-projects.ts", "@hyperframes/studio-server", ["getMimeType"]),
  record("packages/adapter/src/hyperframes/legacy-sdk.ts", "@hyperframes/core", ["resolveWithinProject"]),
  record("packages/adapter/src/hyperframes/legacy-sdk.ts", "@hyperframes/sdk", [
    "openComposition", "type:Composition", "type:HyperFramesElement",
  ]),
  record("packages/adapter/src/hyperframes/parse.ts", "@hyperframes/core", [
    "parseNumeric", "readClipTiming", "resolveWithinProject",
  ]),
  record("packages/adapter/src/hyperframes/parse.ts", "@hyperframes/core/registry", ["resolveBlockCategory"]),
  record("packages/adapter/src/hyperframes/parse.ts", "@hyperframes/sdk", [
    "openComposition", "type:Composition", "type:HyperFramesElement",
  ]),
  record("packages/adapter/src/hyperframes/runtime.ts", "@hyperframes/core", ["getHyperframeRuntimeScript"]),
  record("packages/adapter/src/hyperframes/sdk-ops.ts", "@hyperframes/core", ["resolveWithinProject"]),
  record("packages/adapter/src/hyperframes/sdk-ops.ts", "@hyperframes/sdk", [
    "openComposition", "type:Composition", "type:EditOp", "type:HyperFramesElement",
  ]),
].sort(compareRecords);

const COMPILER_BOUNDARY = "packages/adapter/src/hyperframes/compiler-probe-child.ts";
const COMPILER_CALLS = new Set(["buildHyperframesRuntimeScript", "buildSync", "bundleToSingleHtml", "transformSync"]);

function record(file: string, moduleName: string, names: string[], dynamic = false): ImportRecord {
  return { file, module: moduleName, names: [...names].sort(), dynamic };
}

function compareRecords(left: ImportRecord, right: ImportRecord): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right), "en");
}

function relevantModule(moduleName: string): boolean {
  return moduleName === "esbuild" || moduleName === "hyperframes" || moduleName.startsWith("@hyperframes/");
}

async function sourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (/\.(?:[cm]?js|jsx|tsx?)$/u.test(entry.name)) found.push(target);
    }
  };
  await visit(path.resolve(root));
  return found;
}

function importedNames(node: ts.ImportDeclaration): string[] {
  const names: string[] = [];
  const clause = node.importClause;
  if (!clause) return names;
  if (clause.name) names.push(`default:${clause.name.text}`);
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    names.push(`namespace:${clause.namedBindings.name.text}`);
  } else if (clause.namedBindings) {
    for (const element of clause.namedBindings.elements) {
      names.push(`${element.isTypeOnly ? "type:" : ""}${element.propertyName?.text ?? element.name.text}`);
    }
  }
  return names.sort();
}

function exportedNames(node: ts.ExportDeclaration): string[] {
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return ["*"];
  return node.exportClause.elements.map((element) =>
    `${element.isTypeOnly ? "type:" : ""}${element.propertyName?.text ?? element.name.text}`).sort();
}

interface CommonJsLoaders {
  createRequire: Set<string>;
  moduleNamespaces: Set<string>;
  require: Set<string>;
}

function isCreateRequireExpression(expression: ts.Expression, loaders: CommonJsLoaders): boolean {
  if (ts.isIdentifier(expression)) return loaders.createRequire.has(expression.text);
  if (
    ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && loaders.moduleNamespaces.has(expression.expression.text)
  ) return expression.name.text === "createRequire";
  return ts.isElementAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && loaders.moduleNamespaces.has(expression.expression.text)
    && ts.isStringLiteral(expression.argumentExpression)
    && expression.argumentExpression.text === "createRequire";
}

function commonJsLoaderNames(syntax: ts.SourceFile): CommonJsLoaders {
  const createRequire = new Set(["createRequire"]);
  const moduleNamespaces = new Set<string>();
  const require = new Set(["require"]);
  const collectImports = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && (node.moduleSpecifier.text === "node:module" || node.moduleSpecifier.text === "module")
      && node.importClause
    ) {
      if (node.importClause.name) moduleNamespaces.add(node.importClause.name.text);
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        moduleNamespaces.add(bindings.name.text);
      } else if (bindings) {
        for (const element of bindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) === "createRequire") {
            createRequire.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, collectImports);
  };
  collectImports(syntax);

  const loaders: CommonJsLoaders = { createRequire, moduleNamespaces, require };
  let changed = true;
  while (changed) {
    changed = false;
    const add = (target: Set<string>, name: string): void => {
      const before = target.size;
      target.add(name);
      if (target.size !== before) changed = true;
    };
    const collectAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const initializer = node.initializer;
        if (ts.isIdentifier(initializer) && moduleNamespaces.has(initializer.text)) {
          add(moduleNamespaces, node.name.text);
        } else if (isCreateRequireExpression(initializer, loaders)) {
          add(createRequire, node.name.text);
        } else if (
          ts.isCallExpression(initializer)
          && isCreateRequireExpression(initializer.expression, loaders)
        ) {
          add(require, node.name.text);
        } else if (ts.isIdentifier(initializer) && require.has(initializer.text)) {
          add(require, node.name.text);
        }
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(syntax);
  }
  return loaders;
}

function commonJsModule(node: ts.CallExpression, loaders: ReturnType<typeof commonJsLoaderNames>): string | null {
  if (node.arguments.length < 1 || !ts.isStringLiteral(node.arguments[0])) return null;
  if (ts.isIdentifier(node.expression) && loaders.require.has(node.expression.text)) return node.arguments[0].text;
  if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "require") {
    return node.arguments[0].text;
  }
  if (
    ts.isCallExpression(node.expression)
    && isCreateRequireExpression(node.expression.expression, loaders)
  ) return node.arguments[0].text;
  return null;
}

function inspectSource(file: string, source: string): { imports: ImportRecord[]; compilerCalls: string[] } {
  const relative = path.relative(process.cwd(), file).split(path.sep).join("/");
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const commonJsLoaders = commonJsLoaderNames(syntax);
  const imports: ImportRecord[] = [];
  const compilerCalls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      if (relevantModule(moduleName)) imports.push(record(relative, moduleName, importedNames(node)));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      if (relevantModule(moduleName)) imports.push(record(relative, moduleName, exportedNames(node)));
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) {
      const moduleName = node.arguments[0].text;
      if (relevantModule(moduleName)) imports.push(record(relative, moduleName, ["dynamic"], true));
    } else if (ts.isCallExpression(node)) {
      const requiredModule = commonJsModule(node, commonJsLoaders);
      if (requiredModule && relevantModule(requiredModule)) {
        imports.push(record(relative, requiredModule, ["require"], true));
      }
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
      if (name && COMPILER_CALLS.has(name)) compilerCalls.push(`${relative}:${name}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return { imports, compilerCalls };
}

async function inventory(): Promise<{ imports: ImportRecord[]; compilerCalls: string[] }> {
  const imports: ImportRecord[] = [];
  const compilerCalls: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of await sourceFiles(root)) {
      const inspected = inspectSource(file, await readFile(file, "utf8"));
      imports.push(...inspected.imports);
      compilerCalls.push(...inspected.compilerCalls);
    }
  }
  return { imports: imports.sort(compareRecords), compilerCalls: compilerCalls.sort() };
}

describe("compiler boundary audit", () => {
  it("recognizes direct require and createRequire aliases as inventory entries", () => {
    const inspected = inspectSource(path.resolve("synthetic-commonjs.ts"), `
      import { createRequire as makeRequire } from "node:module";
      const loadModule = makeRequire(import.meta.url);
      const first = require("esbuild");
      const second = loadModule("@hyperframes/core");
      const third = makeRequire(import.meta.url)("@hyperframes/sdk");
    `);
    expect(inspected.imports).toEqual([
      record("synthetic-commonjs.ts", "esbuild", ["require"], true),
      record("synthetic-commonjs.ts", "@hyperframes/core", ["require"], true),
      record("synthetic-commonjs.ts", "@hyperframes/sdk", ["require"], true),
    ]);
  });

  it("follows createRequire through a node:module namespace import", () => {
    const inspected = inspectSource(path.resolve("synthetic-namespace-commonjs.ts"), `
      import * as moduleApi from "node:module";
      const loadModule = moduleApi.createRequire(import.meta.url);
      const compiler = loadModule("@hyperframes/core/compiler");
    `);
    expect(inspected.imports).toEqual([
      record("synthetic-namespace-commonjs.ts", "@hyperframes/core/compiler", ["require"], true),
    ]);
  });

  it("follows an indirect createRequire function alias", () => {
    const inspected = inspectSource(path.resolve("synthetic-indirect-commonjs.ts"), `
      import { createRequire } from "node:module";
      const make = createRequire;
      const loadModule = make(import.meta.url);
      const compiler = loadModule("esbuild");
    `);
    expect(inspected.imports).toEqual([
      record("synthetic-indirect-commonjs.ts", "esbuild", ["require"], true),
    ]);
  });

  it("requires review for every production HyperFrames or esbuild import", async () => {
    expect((await inventory()).imports).toEqual(EXPECTED_HYPERFRAMES_IMPORTS);
  });

  it("keeps the single compiler-capable call inside the child boundary", async () => {
    expect((await inventory()).compilerCalls).toEqual([`${COMPILER_BOUNDARY}:bundleToSingleHtml`]);
  });

  it("keeps the nine reviewed static adapter import sites unchanged", async () => {
    const staticFiles = new Set((await inventory()).imports
      .filter((entry) => !entry.dynamic)
      .map((entry) => entry.file));
    expect([...staticFiles].sort()).toEqual([
      "packages/adapter/src/hyperframes/document.ts",
      "packages/adapter/src/hyperframes/dom.ts",
      "packages/adapter/src/hyperframes/elements.ts",
      "packages/adapter/src/hyperframes/font-compatibility.ts",
      "packages/adapter/src/hyperframes/legacy-projects.ts",
      "packages/adapter/src/hyperframes/legacy-sdk.ts",
      "packages/adapter/src/hyperframes/parse.ts",
      "packages/adapter/src/hyperframes/runtime.ts",
      "packages/adapter/src/hyperframes/sdk-ops.ts",
    ]);
  });

  it("pins the reviewed HyperFrames dependency graph to 0.7.86", async () => {
    const requireFromTest = createRequire(import.meta.url);
    const packagePath = requireFromTest.resolve("@hyperframes/core/package.json");
    const packageValue: unknown = JSON.parse(await readFile(packagePath, "utf8"));
    expect(packageValue).toMatchObject({ name: "@hyperframes/core", version: "0.7.86" });

    const adapterPackage: unknown = JSON.parse(await readFile("packages/adapter/package.json", "utf8"));
    expect(adapterPackage).toMatchObject({
      dependencies: {
        "@hyperframes/core": "0.7.86",
        "@hyperframes/parsers": "0.7.86",
        "@hyperframes/sdk": "0.7.86",
        "@hyperframes/studio-server": "0.7.86",
      },
    });
    const rootPackage: unknown = JSON.parse(await readFile("package.json", "utf8"));
    expect(rootPackage).toMatchObject({ dependencies: { hyperframes: "0.7.86" } });
  });

  it("keeps the SEA entry compiler-free until boot performs the preload", async () => {
    const entry = await readFile("packages/cli/src/sea-entry.ts", "utf8");
    const boot = await readFile("packages/cli/src/boot.ts", "utf8");
    expect(entry).not.toMatch(/@vidcom\/adapter|@hyperframes|\besbuild\b/u);
    expect(boot).not.toMatch(/from\s+["'](?:@vidcom\/adapter(?!\/compiler-guard)|@hyperframes|esbuild)/u);
    expect(boot.indexOf("await configureCompilerBeforeRuntime")).toBeLessThan(boot.indexOf('import("./main")'));
  });

  it("configures the source loader before tsx can evaluate its own esbuild", async () => {
    const launcher = await readFile("packages/cli/bin/vidcom.mjs", "utf8");
    expect(launcher).not.toMatch(/from\s+["']tsx(?:\/|["'])/u);
    expect(launcher.indexOf("process.env.ESBUILD_BINARY_PATH =")).toBeGreaterThan(-1);
    expect(launcher.indexOf("process.env.ESBUILD_BINARY_PATH =")).toBeLessThan(
      launcher.indexOf('await import("tsx/esm/api")'),
    );
  });
});
