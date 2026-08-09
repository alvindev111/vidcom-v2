import { randomUUID } from "node:crypto";

import {
  initializeDatabase,
  NodeMcpCredentialCrypto,
  SqliteMcpCredentialStore,
  type VidcomDatabase,
} from "@vidcom/adapter";
import { MAX_CREDENTIAL_ROTATION_OVERLAP_MS, McpCredentialService } from "@vidcom/core";

import { CliInputError } from "../cli-error";
import { DEFAULT_MCP_RUNTIME_CONFIG } from "../composition-root";
import { defaultAppDataRoot } from "../next-host";
import { writeJson, type CliOutput } from "../output";

export interface CredentialCommandDependencies {
  appDataRoot(): string;
  /**
   * An already-migrated database, when the caller has one.
   *
   * A packaged build must supply it. Opening the database here runs the
   * migration with the source-relative history folder, and L.1 rewrites
   * `import.meta.url` to the `/vidcom` marker so the build machine's paths
   * never ship — which leaves that folder pointing at nothing inside an
   * artifact. The bootstrap coordinator already migrates against the copy in
   * the extracted runtime, so the fix is to use its database rather than to
   * open a second one.
   */
  database?(): Promise<{ database: VidcomDatabase; release(): Promise<void> }>;
  stdout: CliOutput;
  now(): Date;
  newId(): string;
}

const defaultDependencies: CredentialCommandDependencies = {
  appDataRoot: defaultAppDataRoot,
  stdout: process.stdout,
  now: () => new Date(),
  newId: () => `credential_${randomUUID()}`,
};

type CredentialOperation =
  | { kind: "issue"; label: string }
  | { kind: "list" }
  | { kind: "rotate"; id: string; overlapMs?: number }
  | { kind: "revoke"; id: string };

function parseCredentialOperation(argv: readonly string[]): CredentialOperation {
  const [action, ...args] = argv;
  if (action === "issue" && args.length === 1 && args[0] && !args[0].startsWith("--")) {
    return { kind: "issue", label: args[0] };
  }
  if (action === "list" && args.length === 0) return { kind: "list" };
  if (action === "revoke" && args.length === 1 && args[0] && !args[0].startsWith("--")) {
    return { kind: "revoke", id: args[0] };
  }
  if (action === "rotate" && args[0] && !args[0].startsWith("--")) {
    if (args.length === 1) return { kind: "rotate", id: args[0] };
    if (args.length === 3 && args[1] === "--overlap-ms") {
      const overlapMs = Number(args[2]);
      if (!Number.isSafeInteger(overlapMs) || overlapMs <= 0
        || overlapMs > MAX_CREDENTIAL_ROTATION_OVERLAP_MS) {
        throw new CliInputError(
          `--overlap-ms must be a positive integer no greater than ${MAX_CREDENTIAL_ROTATION_OVERLAP_MS}`,
        );
      }
      return { kind: "rotate", id: args[0], overlapMs };
    }
  }
  throw new CliInputError(
    "usage: vidcom credential issue <label>|list|rotate <id> [--overlap-ms <positive-int>]|revoke <id>",
  );
}

/** Executes MCP credential administration while disclosing new secrets only in issue/rotate output. */
export async function runCredentialCommand(
  argv: readonly string[],
  dependencies: CredentialCommandDependencies = defaultDependencies,
): Promise<void> {
  const operation = parseCredentialOperation(argv);
  const prepared = dependencies.database ? await dependencies.database() : null;
  const database = prepared?.database ?? await initializeDatabase(dependencies.appDataRoot());
  try {
    const service = new McpCredentialService({
      credentials: new SqliteMcpCredentialStore(database),
      crypto: new NodeMcpCredentialCrypto(),
      clock: { now: dependencies.now },
      ids: { newId: () => dependencies.newId() },
      config: { rotationOverlapMs: DEFAULT_MCP_RUNTIME_CONFIG.credentialRotationOverlapMs },
    });
    if (operation.kind === "issue") {
      writeJson(dependencies.stdout, await service.issue(operation.label));
      return;
    }
    if (operation.kind === "list") {
      writeJson(dependencies.stdout, { credentials: await service.list() });
      return;
    }
    if (operation.kind === "rotate") {
      writeJson(dependencies.stdout, await service.rotate(operation.id, operation.overlapMs));
      return;
    }
    await service.revoke(operation.id);
    writeJson(dependencies.stdout, { id: operation.id, status: "revoked" });
  } catch (error) {
    if (error instanceof Error && error.message === "credential_invalid") {
      throw new CliInputError("credential_invalid");
    }
    throw error;
  } finally {
    // Whoever opened it closes it. Destroying a database the coordinator owns
    // would pull it out from under the lock that is still holding it.
    if (prepared) await prepared.release();
    else await database.destroy();
  }
}
