import { randomUUID } from "node:crypto";

import {
  LargePreviousContentStore,
  MutationJournal,
  type RuntimePaths,
  type VidcomDatabase,
} from "@vidcom/adapter";
import {
  reconcileCompositeMutation,
  resolveOrphanedMutation,
  type AbsolutePath,
  type JournalId,
  type OrphanResolution,
} from "@vidcom/core";

import { CliInputError } from "../cli-error";
import { createApplication, createInfrastructure } from "../composition-root";
import { prepareRuntimeForCli, runtimePathsFor } from "../runtime-paths-source";
import { defaultAppDataRoot } from "../next-host";
import { writeJson, type CliOutput } from "../output";
import { selectWorkspace } from "../workspace-selection";

export interface RecoveryCommandDependencies {
  appDataRoot(): string;
  stdout: CliOutput;
  now(): Date;
  newId(prefix: string): string;
  selectWorkspace: typeof selectWorkspace;
}

const defaultDependencies: RecoveryCommandDependencies = {
  appDataRoot: defaultAppDataRoot,
  stdout: process.stdout,
  now: () => new Date(),
  newId: (prefix) => `${prefix}_${randomUUID()}`,
  selectWorkspace,
};

type RecoveryOperation =
  | { kind: "inspect"; id: JournalId }
  | { kind: "reconcile"; id: JournalId }
  | { kind: "resolve"; id: JournalId; resolution: OrphanResolution };

function parseJournalId(value: string | undefined): JournalId | null {
  if (!value || value.startsWith("--")) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id as JournalId : null;
}

function parseRecoveryOperation(argv: readonly string[]): RecoveryOperation {
  const [action, id, choice, ...rest] = argv;
  const journalId = parseJournalId(id);
  if ((action === "inspect" || action === "reconcile")
    && journalId !== null && choice === undefined) {
    return { kind: action, id: journalId };
  }
  if (action === "resolve" && journalId !== null && rest.length === 0) {
    if (choice === "--restore-previous") {
      return { kind: "resolve", id: journalId, resolution: "restore-previous" };
    }
    if (choice === "--accept-current") {
      return { kind: "resolve", id: journalId, resolution: "accept-current" };
    }
  }
  throw new CliInputError(
    "usage: vidcom recovery inspect <journalId>|reconcile <journalId>|resolve <journalId> --restore-previous|--accept-current",
  );
}

async function inspectRecovery(
  id: JournalId,
  dependencies: RecoveryCommandDependencies,
  database: VidcomDatabase,
): Promise<void> {
  const largeContent = new LargePreviousContentStore(dependencies.appDataRoot());
  const mutation = await new MutationJournal(
    database,
    { now: dependencies.now },
    largeContent,
  ).readPendingComposite(id);
  if (!mutation) throw new CliInputError("recovery_required");
  writeJson(dependencies.stdout, {
    journal: {
      id: mutation.id,
      status: mutation.status,
      projectId: mutation.projectId,
      actor: mutation.actor,
      grantId: mutation.grantId,
      backupId: mutation.backupId,
      toolAudit: mutation.context.toolAudit,
      commandAudit: mutation.context.commandAudit,
      steps: mutation.steps.map((step) => ({
        ordinal: step.ordinal,
        kind: step.kind,
        path: step.path,
        entity: step.entity,
        fromHash: step.fromHash,
        toHash: step.toHash,
      })),
    },
  });
}

async function recoveryWorkspaceRoot(
  dependencies: RecoveryCommandDependencies,
  journalId: JournalId,
  database: VidcomDatabase,
): Promise<AbsolutePath> {
  const journal = new MutationJournal(
    database,
    { now: dependencies.now },
    new LargePreviousContentStore(dependencies.appDataRoot()),
  );
  const mutation = await journal.readPendingComposite(journalId);
  if (!mutation) throw new CliInputError("recovery_required");
  const registration = await journal.findProjectRegistration(mutation.projectId);
  if (!registration) throw new CliInputError("project_not_found");
  return registration.workspaceRoot as AbsolutePath;
}

async function startRecoveryRuntime(
  dependencies: RecoveryCommandDependencies,
  input: { appDataRoot: string; workspaceRoot: AbsolutePath; runtimePaths: RuntimePaths },
) {
  const { appDataRoot, workspaceRoot, runtimePaths } = input;
  const infrastructure = createInfrastructure({
    appDataRoot,
    workspaceRoot: workspaceRoot as AbsolutePath,
    clock: { now: dependencies.now },
    ids: { newId: dependencies.newId },
    runtimePaths,
  });
  let leaseId: string | null = null;
  try {
    const acquired = await infrastructure.lease.acquire(
      workspaceRoot as AbsolutePath,
      `recovery:${process.pid}:${randomUUID()}`,
    );
    if (!acquired.ok) throw new CliInputError("workspace_lease_denied");
    leaseId = acquired.leaseId;
    return {
      infrastructure,
      application: createApplication(infrastructure, leaseId),
      leaseId,
      async stop() {
        await infrastructure.lease.release(leaseId!);
        await infrastructure.database.destroy();
      },
    };
  } catch (error) {
    if (leaseId) await infrastructure.lease.release(leaseId).catch(() => {});
    await infrastructure.database.destroy();
    throw error;
  }
}

/** Runs targeted recovery administration without startup's automatic all-journal reconciliation. */
export async function runRecoveryCommand(
  argv: readonly string[],
  dependencies: RecoveryCommandDependencies = defaultDependencies,
): Promise<void> {
  const operation = parseRecoveryOperation(argv);
  const appDataRoot = dependencies.appDataRoot();
  const prepared = await prepareRuntimeForCli(appDataRoot);
  if (operation.kind === "inspect") {
    try {
      await inspectRecovery(operation.id, dependencies, prepared.database);
    } finally {
      await prepared.release();
    }
    return;
  }

  let workspaceRoot: AbsolutePath;
  let runtimePaths: RuntimePaths;
  try {
    workspaceRoot = await recoveryWorkspaceRoot(dependencies, operation.id, prepared.database);
    runtimePaths = runtimePathsFor(appDataRoot, prepared);
  } finally {
    await prepared.release();
  }
  const runtime = await startRecoveryRuntime(dependencies, {
    appDataRoot,
    workspaceRoot,
    runtimePaths,
  });
  try {
    const result = operation.kind === "reconcile"
      ? await reconcileCompositeMutation({
          workspace: runtime.infrastructure.workspace,
          journal: runtime.infrastructure.journal,
          resolveProjectRef: runtime.infrastructure.resolveProjectRef,
        }, operation.id)
      : await resolveOrphanedMutation({
          workspace: runtime.infrastructure.workspace,
          journal: runtime.infrastructure.journal,
          composition: runtime.infrastructure.composition,
          lease: runtime.infrastructure.lease,
          leaseId: runtime.leaseId,
          resolveProjectRef: runtime.infrastructure.resolveProjectRef,
        }, operation.id, operation.resolution, "cli-external");
    if (!result.ok) throw new CliInputError(result.error.code);
    writeJson(dependencies.stdout, operation.kind === "reconcile"
      ? { journalId: operation.id, outcome: result.value }
      : { journalId: operation.id, resolution: operation.resolution, envelope: result.value });
  } finally {
    await runtime.stop();
  }
}
