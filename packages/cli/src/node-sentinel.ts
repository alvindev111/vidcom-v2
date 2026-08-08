import path from "node:path";
import { pathToFileURL } from "node:url";

import { ErrorCode } from "@vidcom/contracts";

export const NODE_SENTINEL = "--vidcom-node";

export class NodeSentinelError extends Error {
  readonly name = "NodeSentinelError";
  constructor(readonly code: ErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

/**
 * Runs a runtime script as if this executable were `node`.
 *
 * The artifact ships one binary, so anything that used to call `node script.js`
 * has to call the artifact instead. Without a sentinel the artifact re-enters
 * its own command parser and silently starts the app: `parseVidcomCommand`
 * treats every argv beginning with `--` as `vidcom app`, so the wrong behaviour
 * produces no error at all.
 *
 * The sentinel is internal. It is dispatched before the public parser and MUST
 * NOT appear in help or in the published mode list.
 */
export function isNodeSentinel(argv: readonly string[]): boolean {
  return argv[0] === NODE_SENTINEL;
}

/**
 * Imports the named script with `process.argv` rewritten to look like Node's.
 *
 * Only a script inside the verified runtime root may be imported: this entry
 * point turns an argument into executed code, so an unconstrained path here
 * would run anything the caller names.
 */
export async function runNodeSentinel(
  argv: readonly string[],
  runtimeRoot: string,
  importModule: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<void> {
  const [, script, ...rest] = argv;
  if (!script) {
    throw new NodeSentinelError(
      ErrorCode.RuntimeManifestInvalid,
      `${NODE_SENTINEL} requires a script path`,
    );
  }
  const resolved = path.resolve(script);
  const root = path.resolve(runtimeRoot);
  const contained = resolved === root
    || resolved.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
  if (!contained) {
    throw new NodeSentinelError(
      ErrorCode.RuntimeManifestInvalid,
      "the node sentinel may only run a script inside the verified runtime root",
      { script: resolved, runtimeRoot: root },
    );
  }

  // The script reads process.argv expecting Node's shape: execPath, script,
  // then its own arguments. Leaving the sentinel in place would make every
  // downstream argument index off by one.
  const original = process.argv;
  process.argv = [process.argv[0] ?? process.execPath, resolved, ...rest];
  try {
    await importModule(pathToFileURL(resolved).href);
  } finally {
    process.argv = original;
  }
}
