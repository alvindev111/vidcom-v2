import { initializeDatabase, SqliteApprovalGrantStore } from "@vidcom/adapter";
import { ApprovalService } from "@vidcom/core";

import { CliInputError } from "../cli-error";
import { defaultAppDataRoot } from "../next-host";
import { writeJson, type CliOutput } from "../output";

export interface ApproveCommandDependencies {
  appDataRoot(): string;
  stdout: CliOutput;
  now(): Date;
}

const defaultDependencies: ApproveCommandDependencies = {
  appDataRoot: defaultAppDataRoot,
  stdout: process.stdout,
  now: () => new Date(),
};

/** Issues one existing approval request through the trusted local-admin channel. */
export async function runApproveCommand(
  argv: readonly string[],
  dependencies: ApproveCommandDependencies = defaultDependencies,
): Promise<void> {
  if (argv.length !== 1 || !argv[0] || argv[0].startsWith("--")) {
    throw new CliInputError("usage: vidcom approve <requestId>");
  }
  const database = await initializeDatabase(dependencies.appDataRoot());
  try {
    const approvals = new ApprovalService({
      grants: new SqliteApprovalGrantStore(database),
      clock: { now: dependencies.now },
      ids: { newId: () => { throw new Error("approve does not create IDs"); } },
    });
    const result = await approvals.issue(argv[0], "cli");
    if (!result.ok) throw new CliInputError(result.error.code);
    writeJson(dependencies.stdout, { grantId: result.value });
  } finally {
    await database.destroy();
  }
}
