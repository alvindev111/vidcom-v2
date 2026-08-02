import { randomUUID } from "node:crypto";

import {
  AppDataBackupStore,
  initializeDatabase,
  migrateDatabase,
  MutationJournal,
  WorkspaceFs,
} from "@vidcom/adapter";
import type { ProjectId } from "@vidcom/contracts";
import { restoreBackup, type AbsolutePath, type BackupManifest } from "@vidcom/core";

import { CliInputError } from "../cli-error";
import { createApplication, createInfrastructure } from "../composition-root";
import { defaultAppDataRoot } from "../next-host";
import { writeJson, type CliOutput } from "../output";

export interface BackupCommandDependencies {
  appDataRoot(): string;
  stdout: CliOutput;
  now(): Date;
  newId(): string;
}

const defaultDependencies: BackupCommandDependencies = {
  appDataRoot: defaultAppDataRoot,
  stdout: process.stdout,
  now: () => new Date(),
  newId: () => `backup_admin_${randomUUID()}`,
};

type BackupOperation =
  | { kind: "list"; projectId?: ProjectId }
  | { kind: "verify"; id: string }
  | { kind: "restore"; id: string };

function parseBackupOperation(argv: readonly string[]): BackupOperation {
  const [action, ...args] = argv;
  if (action === "list" && args.length <= 1 && !args[0]?.startsWith("--")) {
    return args[0]
      ? { kind: "list", projectId: args[0] as ProjectId }
      : { kind: "list" };
  }
  if ((action === "verify" || action === "restore")
    && args.length === 1 && args[0] && !args[0].startsWith("--")) {
    return { kind: action, id: args[0] };
  }
  throw new CliInputError("usage: vidcom backup list [projectId]|verify <id>|restore <id>");
}

async function runReadOperation(
  operation: Extract<BackupOperation, { kind: "list" | "verify" }>,
  dependencies: BackupCommandDependencies,
): Promise<void> {
  const appDataRoot = dependencies.appDataRoot();
  const database = await initializeDatabase(appDataRoot);
  try {
    const backups = new AppDataBackupStore(
      appDataRoot,
      database,
      { now: dependencies.now },
      { newId: () => dependencies.newId() },
    );
    if (operation.kind === "list") {
      const manifests = operation.projectId
        ? await backups.list(operation.projectId)
        : await backups.listAll();
      writeJson(dependencies.stdout, { backups: manifests });
      return;
    }
    const manifest = await backups.read(operation.id);
    if (!manifest) throw new CliInputError("backup_not_found");
    writeJson(dependencies.stdout, {
      backupId: operation.id,
      valid: await backups.verify(operation.id),
    });
  } finally {
    await database.destroy();
  }
}

async function validateRestoreTarget(
  id: string,
  dependencies: BackupCommandDependencies,
): Promise<{ manifest: BackupManifest; workspaceRoot: AbsolutePath }> {
  const appDataRoot = dependencies.appDataRoot();
  const database = await initializeDatabase(appDataRoot);
  try {
    const backups = new AppDataBackupStore(
      appDataRoot,
      database,
      { now: dependencies.now },
      { newId: () => dependencies.newId() },
    );
    const manifest = await backups.read(id);
    if (!manifest) throw new CliInputError("backup_not_found");
    if (manifest.payloadPrunedAt !== null) throw new CliInputError("backup_expired");
    if (manifest.revisionId === null || !(await backups.verify(id))) {
      throw new CliInputError("backup_failed");
    }
    const journal = new MutationJournal(database, { now: dependencies.now });
    const registration = await journal.findProjectRegistration(manifest.projectId);
    if (!registration) throw new CliInputError("project_not_found");
    const workspaceRoot = registration.workspaceRoot as AbsolutePath;
    if (!(await new WorkspaceFs(workspaceRoot).readProjectRef(manifest.projectId))) {
      throw new CliInputError("project_not_found");
    }
    return { manifest, workspaceRoot };
  } finally {
    await database.destroy();
  }
}

async function startBackupRestoreRuntime(
  workspaceRoot: AbsolutePath,
  dependencies: BackupCommandDependencies,
) {
  const appDataRoot = dependencies.appDataRoot();
  const infrastructure = createInfrastructure({
    appDataRoot,
    workspaceRoot,
    clock: { now: dependencies.now },
    ids: { newId: () => dependencies.newId() },
  });
  let leaseId: string | null = null;
  try {
    await migrateDatabase(infrastructure.database);
    const acquired = await infrastructure.lease.acquire(
      workspaceRoot,
      `backup:${process.pid}:${randomUUID()}`,
    );
    if (!acquired.ok) throw new CliInputError("workspace_lease_denied");
    leaseId = acquired.leaseId;
    return {
      infrastructure,
      application: createApplication(infrastructure, leaseId),
      async stop() {
        const errors: unknown[] = [];
        try { await infrastructure.lease.release(leaseId!); }
        catch (error) { errors.push(error); }
        try { await infrastructure.database.destroy(); }
        catch (error) { errors.push(error); }
        if (errors.length > 0) throw new AggregateError(errors, "Backup restore shutdown failed");
      },
    };
  } catch (error) {
    if (leaseId) await infrastructure.lease.release(leaseId).catch(() => undefined);
    await infrastructure.database.destroy();
    throw error;
  }
}

/** Executes trusted backup inspection and delegates every restore write to the Core use case. */
export async function runBackupCommand(
  argv: readonly string[],
  dependencies: BackupCommandDependencies = defaultDependencies,
): Promise<void> {
  const operation = parseBackupOperation(argv);
  if (operation.kind !== "restore") {
    await runReadOperation(operation, dependencies);
    return;
  }

  const target = await validateRestoreTarget(operation.id, dependencies);
  const runtime = await startBackupRestoreRuntime(target.workspaceRoot, dependencies);
  try {
    const result = await restoreBackup({
      backups: runtime.infrastructure.backups,
      journal: runtime.infrastructure.journal,
      workspace: runtime.infrastructure.workspace,
      writes: runtime.application.authority,
    }, {
      projectId: target.manifest.projectId,
      backupId: operation.id,
    }, "cli-external");
    if (!result.ok) throw new CliInputError(result.error.code);
    writeJson(dependencies.stdout, { backupId: operation.id, envelope: result.value });
  } finally {
    await runtime.stop();
  }
}
