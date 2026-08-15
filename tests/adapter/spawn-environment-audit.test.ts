import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = ["packages/adapter/src", "packages/cli/src", "packages/server/src", "packages/worker/src"];
const CHILD_PROCESS_CALLS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);

interface ChildProcessCall { name: string; target: string; allowlisted: boolean }

/** Finds child-process calls by binding, including renamed imports and local wrappers. */
function childProcessCalls(source: string): ChildProcessCall[] {
  const file = ts.createSourceFile("spawn-audit.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const callableNames = new Set<string>();
  const namespaceNames = new Set<string>();
  const declarations: ts.VariableDeclaration[] = [];

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !["node:child_process", "child_process"].includes(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaceNames.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (CHILD_PROCESS_CALLS.has(importedName)) callableNames.add(element.name.text);
      }
    }
  }

  const collectDeclarations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(file);

  const referencesChildProcess = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node) && callableNames.has(node.text)) return true;
    if (ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && namespaceNames.has(node.expression.text)
      && CHILD_PROCESS_CALLS.has(node.name.text)) return true;
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && referencesChildProcess(child)) found = true;
    });
    return found;
  };

  // Resolve `promisify(execFile)`, `const run = execFile`, and the injected
  // `options.spawnProcess ?? spawn` shape. Iterate because aliases may chain.
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer
        || callableNames.has(declaration.name.text)
        || !referencesChildProcess(declaration.initializer)) continue;
      callableNames.add(declaration.name.text);
      changed = true;
    }
  }

  const trustedEnvironmentHelpers = new Set([
    "allowlistedEnvironment",
    "posixProbeEnvironment",
    "windowsProbeEnvironment",
  ]);
  const containsAllowlist = (node: ts.Node): boolean => {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && trustedEnvironmentHelpers.has(node.expression.text)) return true;
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && containsAllowlist(child)) found = true;
    });
    return found;
  };
  const calls: ChildProcessCall[] = [];
  const visitCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && callableNames.has(node.expression.text)) {
        calls.push({
          name: node.expression.text,
          target: node.arguments[0]?.getText(file) ?? "<missing>",
          allowlisted: containsAllowlist(node),
        });
      } else if (ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && namespaceNames.has(node.expression.expression.text)
        && CHILD_PROCESS_CALLS.has(node.expression.name.text)) {
        calls.push({
          name: `${node.expression.expression.text}.${node.expression.name.text}`,
          target: node.arguments[0]?.getText(file) ?? "<missing>",
          allowlisted: containsAllowlist(node),
        });
      }
    }
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(file);
  return calls;
}

function childProcessCallNames(source: string): string[] {
  return [...new Set(childProcessCalls(source).map((call) => call.name))].sort();
}

/**
 * Exact calls allowed to spawn without `allowlistedEnvironment`, each for a reason.
 *
 * Every other spawn must go through the helper: it is the single place that
 * forces UTF-8 and carries the certificate bundle, so a spawn that builds its
 * own environment loses both protections at once and nothing reports it.
 */
const EXEMPT = new Map<string, string>([
  [
    "packages/adapter/src/fs/credential-store.ts#execFileSync(executable)",
    "runs the fixed credential ACL inspection command with no user-controlled executable",
  ],
  [
    "packages/adapter/src/fs/credential-store.ts#execFileAsync(executable)",
    "runs the fixed credential ACL update command with no user-controlled executable",
  ],
  [
    "packages/cli/src/main.ts#spawn(command)",
    "launches the OS browser opener, which is not a supervised toolchain child",
  ],
]);

function exemptionKey(relative: string, call: ChildProcessCall): string {
  return `${relative}#${call.name}(${call.target})`;
}

async function sourceFiles(root: string): Promise<string[]> {
  const absolute = path.resolve(root);
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name.endsWith(".ts")) found.push(target);
    }
  };
  await visit(absolute);
  return found;
}

describe("spawn environment audit", () => {
  it("recognizes aliases without mistaking method calls for processes", () => {
    expect(childProcessCallNames(`
      import { execFile as executeFile } from "node:child_process";
      executeFile("tool", []);
    `)).toEqual(["executeFile"]);
    expect(childProcessCallNames(`
      import { spawn } from "node:child_process";
      const spawnProcess = options.spawnProcess ?? spawn;
      spawnProcess("tool", []);
    `)).toEqual(["spawnProcess"]);
    expect(childProcessCallNames(`
      import { execFile } from "node:child_process";
      const executeFile = promisify(execFile);
      executeFile("tool", []);
    `)).toEqual(["executeFile"]);
    expect(childProcessCallNames("pattern.exec(value); client.exec(query);")).toEqual([]);
    expect(childProcessCalls(`
      import { spawn } from "node:child_process";
      spawn("tool", [], { env: allowlistedEnvironment(process.env) });
      spawn("other", []);
    `)).toEqual([
      { name: "spawn", target: '"tool"', allowlisted: true },
      { name: "spawn", target: '"other"', allowlisted: false },
    ]);
  });

  it("routes every toolchain spawn through allowlistedEnvironment", async () => {
    const offenders: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of await sourceFiles(root)) {
        const relative = path.relative(process.cwd(), file).split(path.sep).join("/");
        const source = await readFile(file, "utf8");
        const calls = childProcessCalls(source);
        if (calls.length === 0) continue;
        const unguarded = calls
          .filter((call) => !call.allowlisted && !EXEMPT.has(exemptionKey(relative, call)))
          .map((call) => `${call.name}(${call.target})`);
        if (unguarded.length > 0) offenders.push(`${relative}: ${unguarded.join(", ")}`);
      }
    }
    // A new spawn point is expected to fail this until it either uses the
    // helper or is listed above with its reason.
    expect(offenders).toEqual([]);
  });

  it("keeps every exemption pointing at exactly one unguarded call", async () => {
    // An exemption outliving its exact call is a hole left open for the next one.
    for (const [key] of EXEMPT) {
      const relative = key.slice(0, key.indexOf("#"));
      const source = await readFile(path.resolve(relative), "utf8");
      const matching = childProcessCalls(source)
        .filter((call) => !call.allowlisted && exemptionKey(relative, call) === key);
      expect(matching, `${key} no longer names one unguarded call`).toHaveLength(1);
    }
  });

  it("documents a reason for every exemption", () => {
    for (const [relative, reason] of EXEMPT) {
      expect(reason.length, `${relative} has no reason`).toBeGreaterThan(20);
    }
  });
});
