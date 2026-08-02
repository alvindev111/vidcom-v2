import { randomUUID } from "node:crypto";

import { AppDataBackupStore, initializeDatabase, nodeSchedulerTimers } from "@vidcom/adapter";
import type { ProjectId } from "@vidcom/contracts";
import { JobScheduler, restoreBackup, type AbsolutePath } from "@vidcom/core";
import { createNoopProbeJobType } from "@vidcom/worker";

import { CliInputError } from "../cli-error";
import { defaultAppDataRoot } from "../next-host";
import { writeJson, type CliOutput } from "../output";
import { startVidcomFoundation } from "../startup";
import { selectWorkspace } from "../workspace-selection";

export interface BackupCommandDependencies {
  appDataRoot(): string;
  stdout: CliOutput;
  now(): Date;
  newId(): string;
  selectWorkspace: typeof selectWorkspace;
}

const defaultDependencies: BackupCommandDependencies = {
  appDataRoot: defaultAppDataRoot,
  stdout: process.stdout,
  now: () => new Date(),
  newId: () => `backup_admin_${randomUUID()}`,
  selectWorkspace,
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

  const appDataRoot = dependencies.appDataRoot();
  const workspaceRoot = await dependencies.selectWorkspace({
    explicit: process.env.VIDCOM_WORKSPACE,
    appDataRoot,
  });
  let scheduler: JobScheduler | null = null;
  const runtime = await startVidcomFoundation({
    appDataRoot,
    workspaceRoot: workspaceRoot as AbsolutePath,
    holderId: `backup:${process.pid}:${randomUUID()}`,
    clock: { now: dependencies.now },
    ids: { newId: () => dependencies.newId() },
  }, {
    async recoverJobs({ infrastructure }) {
      scheduler = new JobScheduler(
        infrastructure.jobs,
        infrastructure.clock,
        infrastructure.ids,
        [createNoopProbeJobType()],
        infrastructure.events,
        nodeSchedulerTimers,
      );
      await scheduler.recoverStale();
    },
    async startScheduler() {
      scheduler?.start();
      return scheduler ? { stop: () => scheduler!.stop() } : undefined;
    },
    async startWatcher({ infrastructure }) {
      await infrastructure.watcher.start();
      return infrastructure.watcher;
    },
    async openListener() { return null; },
  });
  try {
    const manifest = await runtime.infrastructure.backups.read(operation.id);
    if (!manifest) throw new CliInputError("backup_not_found");
    const result = await restoreBackup({
      backups: runtime.infrastructure.backups,
      journal: runtime.infrastructure.journal,
      workspace: runtime.infrastructure.workspace,
      writes: runtime.application.authority,
    }, {
      projectId: manifest.projectId,
      backupId: operation.id,
    }, "cli-external");
    if (!result.ok) throw new CliInputError(result.error.code);
    writeJson(dependencies.stdout, { backupId: operation.id, envelope: result.value });
  } finally {
    await runtime.stop();
  }
}
