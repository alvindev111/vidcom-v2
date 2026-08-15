import { randomUUID } from "node:crypto";

import {
  AppDataBackupStore,
  initializeDatabase,
  MutationJournal,
  WorkspaceFs,
  type RuntimePaths,
  type VidcomDatabase,
} from "@vidcom/adapter";
import type { ProjectId } from "@vidcom/contracts";
import { restoreBackup, type AbsolutePath, type BackupManifest } from "@vidcom/core";

import { CliInputError } from "../cli-error";
import { createApplication, createInfrastructure } from "../composition-root";
import { earlyAppDataRoot } from "../app-data-root";
import { writeJson, type CliOutput } from "../output";
import { prepareRuntimeForCli, runtimePathsFor } from "../runtime-paths-source";

export interface BackupCommandDependencies {
  appDataRoot(): string | Promise<string>;
  stdout: CliOutput;
  now(): Date;
  newId(): string;
  /** Runs extraction, migration and credential reconciliation before a restore can write. */
  prepareRuntime: typeof prepareRuntimeForCli;
  /** Resolves the complete artifact or development runtime path set from the prepared runtime. */
  runtimePathsFor: typeof runtimePathsFor;
  /** Builds the restore composition root only after bootstrap has supplied complete runtime paths. */
  createInfrastructure: typeof createInfrastructure;
}

const defaultDependencies: BackupCommandDependencies = {
  appDataRoot: earlyAppDataRoot,
  stdout: process.stdout,
  now: () => new Date(),
  newId: () => `backup_admin_${randomUUID()}`,
  prepareRuntime: prepareRuntimeForCli,
  runtimePathsFor,
  createInfrastructure,
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
  appDataRoot: string,
  dependencies: BackupCommandDependencies,
): Promise<void> {
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
  appDataRoot: string,
  dependencies: BackupCommandDependencies,
  database: VidcomDatabase,
): Promise<{ manifest: BackupManifest & { projectId: ProjectId }; workspaceRoot: AbsolutePath }> {
  const backups = new AppDataBackupStore(
    appDataRoot,
    database,
    { now: dependencies.now },
    { newId: () => dependencies.newId() },
  );
  const manifest = await backups.read(id);
  if (!manifest) throw new CliInputError("backup_not_found");
  if (manifest.projectId === null) throw new CliInputError("project_not_found");
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
  return { manifest: { ...manifest, projectId: manifest.projectId }, workspaceRoot };
}

async function startBackupRestoreRuntime(
  input: { appDataRoot: string; workspaceRoot: AbsolutePath; runtimePaths: RuntimePaths },
  dependencies: BackupCommandDependencies,
) {
  const infrastructure = dependencies.createInfrastructure({
    appDataRoot: input.appDataRoot,
    workspaceRoot: input.workspaceRoot,
    clock: { now: dependencies.now },
    ids: { newId: () => dependencies.newId() },
    runtimePaths: input.runtimePaths,
  });
  let leaseId: string | null = null;
  try {
    const acquired = await infrastructure.lease.acquire(
      input.workspaceRoot,
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

/** Prepares and releases bootstrap ownership before any restore composition root or lease exists. */
async function prepareBackupRestore(
  id: string,
  appDataRoot: string,
  dependencies: BackupCommandDependencies,
) {
  const prepared = await dependencies.prepareRuntime(appDataRoot);
  try {
    return {
      appDataRoot,
      target: await validateRestoreTarget(id, appDataRoot, dependencies, prepared.database),
      runtimePaths: dependencies.runtimePathsFor(appDataRoot, prepared),
    };
  } finally {
    await prepared.release();
  }
}

/** Executes trusted backup inspection and delegates every restore write to the Core use case. */
export async function runBackupCommand(
  argv: readonly string[],
  dependencies: BackupCommandDependencies = defaultDependencies,
): Promise<void> {
  const operation = parseBackupOperation(argv);
  const appDataRoot = await dependencies.appDataRoot();
  if (operation.kind !== "restore") {
    await runReadOperation(operation, appDataRoot, dependencies);
    return;
  }

  const prepared = await prepareBackupRestore(operation.id, appDataRoot, dependencies);
  const runtime = await startBackupRestoreRuntime({
    appDataRoot: prepared.appDataRoot,
    workspaceRoot: prepared.target.workspaceRoot,
    runtimePaths: prepared.runtimePaths,
  }, dependencies);
  try {
    const result = await restoreBackup({
      backups: runtime.infrastructure.backups,
      journal: runtime.infrastructure.journal,
      workspace: runtime.infrastructure.workspace,
      writes: runtime.application.authority,
    }, {
      projectId: prepared.target.manifest.projectId,
      backupId: operation.id,
    }, "cli-external");
    if (!result.ok) throw new CliInputError(result.error.code);
    writeJson(dependencies.stdout, { backupId: operation.id, envelope: result.value });
  } finally {
    await runtime.stop();
  }
}
