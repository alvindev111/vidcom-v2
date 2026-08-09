import type { JobExecutionContext, JobTypeDefinition } from "@vidcom/core";

export interface ProjectImportJobInput {
  source: string;
  workspaceRoot: string;
  targetName?: string;
}

export interface ProjectImportJobOutput {
  slug: string;
  target: string;
  files: number;
}

/**
 * What the job needs from the outside, so it can be driven without a filesystem.
 *
 * The staging copier and the plan both live elsewhere and are already covered
 * by their own suites; this type exists to sequence them and to make the
 * sequence itself testable.
 */
export interface ProjectImportJobDependencies {
  plan(input: { source: string; workspaceRoot: string; targetName?: string }): Promise<{
    slug: string;
    target: string;
    staging: string;
  }>;
  copy(source: string, staging: string): Promise<{ files: number }>;
  commit(staging: string, target: string): Promise<void>;
  discard(staging: string): Promise<void>;
  /** Registers the copied directory as a project, the same way a fresh one is. */
  backfill(target: string): Promise<void>;
}

/**
 * Copies a directory into the workspace and registers it as a project.
 *
 * Staged first and renamed last, always. A copy written straight into the
 * workspace is visible to the watcher while it is still half a project, and a
 * failure halfway leaves a directory the user has to identify and delete
 * themselves. Staging turns both into one rename that either happened or did
 * not.
 *
 * The source is never modified. Import means copy — a user who imports the
 * wrong folder has lost nothing.
 */
export function createProjectImportJobType(
  dependencies: ProjectImportJobDependencies,
  options: { concurrency?: number } = {},
): JobTypeDefinition {
  return {
    type: "project-import",
    // One at a time. Two imports racing can choose the same free slug, and the
    // loser would rename onto a directory the winner just created.
    concurrency: options.concurrency ?? 1,
    idempotent: false,
    async run(rawInput: unknown, context: JobExecutionContext): Promise<ProjectImportJobOutput> {
      const input = rawInput as ProjectImportJobInput;
      if (typeof input?.source !== "string" || typeof input?.workspaceRoot !== "string") {
        throw new TypeError("project-import needs a source and a workspace root");
      }

      const planned = await dependencies.plan({
        source: input.source,
        workspaceRoot: input.workspaceRoot,
        ...(input.targetName === undefined ? {} : { targetName: input.targetName }),
      });
      await context.updateProgress(0.1, `importing as ${planned.slug}`);

      let copied: { files: number };
      try {
        await context.throwIfCancelled();
        copied = await dependencies.copy(input.source, planned.staging);
        await context.updateProgress(0.8, `copied ${String(copied.files)} files`);
        await context.throwIfCancelled();
        await dependencies.commit(planned.staging, planned.target);
      } catch (error) {
        // The staging directory is this job's own mess, so it cleans it up. What
        // it must not touch is the source or anything already in the workspace.
        await dependencies.discard(planned.staging).catch(() => undefined);
        throw error;
      }

      // After the rename: backfill reads the directory where it now lives, and
      // a project registered before the rename would point at a path that is
      // about to stop existing.
      await dependencies.backfill(planned.target);
      await context.updateProgress(1, `imported ${planned.slug}`);
      return { slug: planned.slug, target: planned.target, files: copied.files };
    },
  };
}
