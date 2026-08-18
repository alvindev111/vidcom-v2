import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function sourceCandidate(specifier) {
  if (!specifier.startsWith("@vidcom/")) return null;
  const [packageName, ...subpath] = specifier.slice("@vidcom/".length).split("/");
  const target = subpath.length === 0
    ? path.join(workspaceRoot, "packages", packageName, "src", "index.ts")
    : path.join(workspaceRoot, "packages", packageName, "src", `${subpath.join("/")}.ts`);
  return existsSync(target) ? pathToFileURL(target).href : null;
}

export async function resolve(specifier, context, nextResolve) {
  const workspaceSource = sourceCandidate(specifier);
  if (workspaceSource) return { url: workspaceSource, shortCircuit: true };
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
      for (const suffix of [".ts", "/index.ts"]) {
        const candidate = new URL(`${specifier}${suffix}`, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
      }
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(pathToFileURL(workspaceRoot).href) && url.endsWith("/package.json")) {
    const value = JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
    return { format: "module", source: `export default ${JSON.stringify(value)};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
