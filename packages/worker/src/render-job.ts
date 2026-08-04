import {
  ErrorCode,
  WarningCode,
  type Actor,
  type DomainError,
  type JobWarningDto,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import {
  canonicalizeJobInput,
  canonicalizeJson,
  err,
  evaluateRemoteAssetGuard,
  getPreviewSettings,
  jobExecutionOutcome,
  JobCancelledError,
  JobFailureError,
  ok,
  scanExternalDependencies,
  scanRemoteMedia,
  type BinaryProbePort,
  type ClockPort,
  type CompositeMutationJournalPort,
  type CompositionPort,
  type DerivedMutationPath,
  type JobExecutionContext,
  type Job,
  type JobId,
  type JobStorePort,
  type JobTypeDefinition,
  type IdPort,
  type MutationJournalPort,
  type ProcessSupervisorPort,
  type PreviewSettings,
  type ProjectRef,
  type RenderProjectPort,
  type RenderRootPort,
  type Result,
  type RuntimeAssetGuardPort,
  type WorkspacePort,
  type WriteAuthority,
} from "@vidcom/core";

export interface RenderJobInput {
  projectId: ProjectId;
  bestEffort?: boolean;
  renderPresetId?: string;
  idempotencyKey?: string;
}

export interface RenderJobResult {
  artifactPath: RelPath;
  computedAtSourceRevision: number;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  reproducible: boolean;
  externalDependencies: string[];
  warnings: JobWarningDto[];
  runtimeMs: number;
}

interface PreparedRender {
  ref: ProjectRef;
  sourceRevision: number;
  previewSettings: PreviewSettings;
}

export interface RenderJobDependencies {
  process: ProcessSupervisorPort;
  roots: RenderRootPort;
  renderProjects: RenderProjectPort;
  authority: WriteAuthority;
  composition: CompositionPort;
  workspace: WorkspacePort;
  journal: MutationJournalPort & Pick<CompositeMutationJournalPort, "readProjectRecoveryStatus">;
  guard: RuntimeAssetGuardPort;
  binaries: BinaryProbePort;
  runtimeSource(): string;
  injectGuard(document: string, guard: { csp: string; bootstrapScript: string }): string;
  clock: ClockPort;
  actor: Actor;
}

export interface RenderJobEnqueueDependencies {
  jobs: JobStorePort;
  ids: IdPort;
  hashContent(content: string | Uint8Array): import("@vidcom/contracts").ContentHash;
}

function parseInput(raw: unknown): RenderJobInput {
  if (!raw || typeof raw !== "object") throw new TypeError("render job input does not match its schema");
  const input = raw as Record<string, unknown>;
  if (typeof input.projectId !== "string" || input.projectId.length === 0
    || (input.bestEffort !== undefined && typeof input.bestEffort !== "boolean")
    || (input.renderPresetId !== undefined && typeof input.renderPresetId !== "string")
    || (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0))) {
    throw new TypeError("render job input does not match its schema");
  }
  return {
    projectId: input.projectId as ProjectId,
    bestEffort: input.bestEffort !== false,
    ...(input.renderPresetId === undefined ? {} : { renderPresetId: input.renderPresetId }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  };
}

/** Gate shared by enqueue adapters and the worker's defensive re-check. */
export async function prepareRender(
  dependencies: Pick<RenderJobDependencies, "workspace" | "composition" | "journal">,
  projectId: ProjectId,
): Promise<Result<PreparedRender, DomainError>> {
  const ref = await dependencies.workspace.readProjectRef(projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  const entry = await dependencies.workspace.resolve(ref, ref.entry, "read-source");
  if (!entry.ok) return err({ code: ErrorCode.ProjectInvalid, message: "project entry path is invalid" });
  let entryFile;
  try {
    entryFile = await dependencies.workspace.readFile(entry.value);
  } catch {
    return err({
      code: ErrorCode.ProjectInvalid,
      message: "project composition is invalid",
      details: { reason: ErrorCode.CompositionParseError },
    });
  }
  if (!entryFile) {
    return err({ code: ErrorCode.NoComposition, message: "project has no composition" });
  }
  if (dependencies.composition.validateSource) {
    const validation = await dependencies.composition.validateSource(ref.entry, entryFile.content);
    if (!validation.ok) {
      return err({
        code: ErrorCode.ProjectInvalid,
        message: "project composition is invalid",
        details: { reason: ErrorCode.CompositionParseError },
      });
    }
  }
  let model;
  try {
    model = await dependencies.composition.parseProject(ref);
  } catch {
    return err({
      code: ErrorCode.ProjectInvalid,
      message: "project composition is invalid",
      details: { reason: ErrorCode.CompositionParseError },
    });
  }
  if (model.scenes.length === 0) return err({ code: ErrorCode.NoScenes, message: "project has no scenes" });
  const settings = await getPreviewSettings({
    workspace: dependencies.workspace,
    composition: dependencies.composition,
    journal: dependencies.journal,
  }, projectId);
  if (!settings.ok) return settings;
  return ok({
    ref,
    sourceRevision: await dependencies.journal.latestSourceRevision(projectId) ?? 0,
    previewSettings: settings.value.previewSettings,
  });
}

/** Performs the state gate before any durable queue row becomes visible. */
export async function enqueueRenderJob(
  dependencies: Pick<RenderJobDependencies, "workspace" | "composition" | "journal"> & RenderJobEnqueueDependencies,
  rawInput: RenderJobInput,
): Promise<Result<Job, DomainError>> {
  let input: RenderJobInput;
  try {
    input = parseInput(rawInput);
  } catch {
    return err({ code: ErrorCode.SchemaInvalid, message: "render job input does not match its schema" });
  }
  const prepared = await prepareRender(dependencies, input.projectId);
  if (!prepared.ok) return prepared;
  const canonicalInput = canonicalizeJobInput(input);
  const enqueued = await dependencies.jobs.enqueue({
    id: dependencies.ids.newId("job") as JobId,
    projectId: input.projectId,
    type: "render",
    input,
    inputHash: dependencies.hashContent(canonicalInput),
    idempotencyKey: input.idempotencyKey ?? null,
  });
  if ("conflict" in enqueued) {
    return err({ code: ErrorCode.IdempotencyKeyReused, message: "render idempotency key was reused with different input" });
  }
  return ok(enqueued.job);
}

function warning(code: WarningCode, message: string): JobWarningDto {
  return { code, message };
}

function readinessWarnings(stderr: string): JobWarningDto[] {
  return stderr.includes(WarningCode.SubTimelineReadinessTimeout)
    ? [warning(WarningCode.SubTimelineReadinessTimeout, "a sub-composition timeline did not become ready")]
    : [];
}

function fps(value: string): number {
  const [numerator, denominator = "1"] = value.split("/");
  const result = Number(numerator) / Number(denominator);
  if (!Number.isFinite(result) || result <= 0) throw new Error("ffprobe returned an invalid frame rate");
  return result;
}

function metadata(stdout: string): { durationSeconds: number; width: number; height: number; fps: number } {
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string }>;
    format?: { duration?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const durationSeconds = Number(parsed.format?.duration);
  if (!video || !Number.isInteger(video.width) || !Number.isInteger(video.height)
    || !video.r_frame_rate || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("ffprobe did not return complete video metadata");
  }
  return { durationSeconds, width: video.width!, height: video.height!, fps: fps(video.r_frame_rate) };
}

function mergeDependencies(...groups: readonly string[][]): string[] {
  return [...new Set(groups.flat())].sort();
}

function withCleanup(error: unknown, warnings: readonly JobWarningDto[], cleanupPending: boolean): Error {
  if (error instanceof JobCancelledError) {
    return new JobCancelledError(
      [...warnings, ...error.warnings], cleanupPending || error.cleanupPending, error.terminationProof,
    );
  }
  if (error instanceof JobFailureError) {
    return new JobFailureError(error.error, {
      cause: error,
      warnings: [...warnings, ...error.warnings],
      cleanupPending: cleanupPending || error.cleanupPending,
      terminationProof: error.terminationProof,
    });
  }
  if (typeof error === "object" && error !== null
    && "code" in error && error.code === ErrorCode.ProcessTerminationUnverified) {
    return new JobFailureError({
      code: ErrorCode.ProcessTerminationUnverified,
      message: error instanceof Error ? error.message : "process termination could not be verified",
    }, {
      cause: error,
      warnings,
      cleanupPending,
      terminationProof: "proof" in error ? error.proof as import("@vidcom/core").ProcessTerminationProof : undefined,
    });
  }
  return new JobFailureError({
    code: ErrorCode.Internal,
    message: error instanceof Error ? error.message : "render job failed",
  }, { cause: error, warnings, cleanupPending });
}

export function createRenderJobHandler(dependencies: RenderJobDependencies): JobTypeDefinition {
  return {
    type: "render",
    concurrency: 2,
    idempotent: false,
    maxAttempts: 1,
    cleanupPendingOnStale: true,
    timeoutMs: 30 * 60 * 1_000,
    async run(rawInput: unknown, context: JobExecutionContext) {
      const input = parseInput(rawInput);
      const startedAt = dependencies.clock.now().getTime();
      const warnings: JobWarningDto[] = [];
      let cleanupPending = false;
      let guardSession: { token: string } | null = null;
      let pendingError: unknown = null;
      let result: RenderJobResult | null = null;
      const acquired = await dependencies.roots.acquire(context.job.id as JobId);
      try {
        const prepared = await prepareRender(dependencies, input.projectId);
        if (!prepared.ok) throw new JobFailureError(prepared.error);
        const binaries = await dependencies.binaries.probe();
        if (!binaries.ok) throw new JobFailureError(binaries.error);
        warnings.push(...binaries.value.warnings);

        await context.updateProgress(0.05, "building render document");
        const opened = await dependencies.guard.open(context.job.id as JobId);
        guardSession = opened;
        const baseDocument = await dependencies.composition.buildDocument(
          prepared.value.ref,
          prepared.value.previewSettings,
          { root: true, runtimeUrl: "./.vidcom-runtime.js", fileBaseUrl: "./" },
        );
        const staticViolations = scanRemoteMedia([{ path: prepared.value.ref.entry, html: baseDocument }], []);
        if (staticViolations.length > 0) {
          throw new JobFailureError({
            code: ErrorCode.RemoteAssetNotLocal,
            message: "rendered document declares remote media",
            details: { violations: staticViolations },
          });
        }
        const staticDependencies = scanExternalDependencies([{ path: prepared.value.ref.entry, html: baseDocument }]);
        const document = dependencies.injectGuard(baseDocument, opened);
        const staged = await dependencies.renderProjects.stage(
          prepared.value.ref,
          acquired.root,
          document,
          dependencies.runtimeSource(),
        );

        await context.throwIfCancelled();
        await context.updateProgress(0.1, "rendering video");
        const rendered = await dependencies.process.run({
          command: [
            ...binaries.value.hyperframesCommand,
            "render",
            staged.projectRoot,
            "-o",
            staged.outputPath,
            "--workers",
            "1",
            "--quiet",
            input.bestEffort ? "--best-effort" : "--no-best-effort",
          ],
          cwd: staged.projectRoot,
          environment: {
            ...acquired.environment,
            HYPERFRAMES_BROWSER_PATH: binaries.value.browserPath,
            HYPERFRAMES_FFMPEG_PATH: binaries.value.ffmpegPath,
            HYPERFRAMES_FFPROBE_PATH: binaries.value.ffprobePath,
          },
          signal: context.signal,
        });
        if (rendered.status === "terminated") {
          warnings.push(...rendered.warnings.map(() => warning(
            WarningCode.TerminationProofNotExhaustive,
            "process termination proof was not exhaustive",
          )));
          if (await context.isCancellationRequested()) throw new JobCancelledError([], false, rendered.proof);
          throw new JobFailureError(
            { code: ErrorCode.Internal, message: "render process timed out" },
            { terminationProof: rendered.proof },
          );
        }
        const captureWarnings = readinessWarnings(rendered.output.stderr);
        warnings.push(...captureWarnings);
        if (rendered.output.exitCode !== 0) {
          const readiness = captureWarnings.length > 0;
          throw new JobFailureError({
            code: readiness ? ErrorCode.SubTimelineReadinessTimeout : ErrorCode.Internal,
            message: readiness ? "a sub-composition timeline did not become ready" : "HyperFrames render failed",
          });
        }

        await context.updateProgress(0.92, "validating video");
        const probed = await dependencies.process.run({
          command: [
            binaries.value.ffprobePath,
            "-v", "error",
            "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate",
            "-of", "json",
            staged.outputPath,
          ],
          cwd: staged.projectRoot,
          environment: acquired.environment,
          signal: context.signal,
        });
        if (probed.status !== "exited" || probed.output.exitCode !== 0) {
          throw new JobFailureError({ code: ErrorCode.Internal, message: "render artifact validation failed" });
        }
        const artifactMetadata = metadata(probed.output.stdout);
        let guardSnapshot;
        try {
          guardSnapshot = await dependencies.guard.close(context.job.id as JobId, opened.token);
        } catch (cause) {
          throw new JobFailureError({
            code: ErrorCode.StorageUnavailable,
            message: "runtime asset guard could not be closed",
          }, { cause });
        } finally {
          guardSession = null;
        }
        const guarded = evaluateRemoteAssetGuard(guardSnapshot);
        if (!guarded.ok) throw new JobFailureError(guarded.error);
        const externalDependencies = mergeDependencies(
          staticDependencies,
          guarded.value.externalDependencies,
        );
        if (externalDependencies.length > 0) warnings.push(warning(
          WarningCode.ExternalDependencyUnpinned,
          "render used an external script, stylesheet, or font",
        ));
        const artifactPath = `renders/${context.job.id}.mp4` as DerivedMutationPath;
        const sidecarPath = `renders/${context.job.id}.json` as DerivedMutationPath;
        result = {
          artifactPath,
          computedAtSourceRevision: prepared.value.sourceRevision,
          ...artifactMetadata,
          reproducible: externalDependencies.length === 0,
          externalDependencies,
          warnings: [...warnings],
          runtimeMs: Math.max(0, dependencies.clock.now().getTime() - startedAt),
        };
        await context.throwIfCancelled();
        const published = await dependencies.authority.mutateDerived({
          ref: prepared.value.ref,
          writes: [
            { path: artifactPath, content: await dependencies.renderProjects.readArtifact(staged.outputPath) },
            {
              path: sidecarPath,
              content: `${canonicalizeJson({ ...result, renderPresetId: input.renderPresetId ?? null })}\n`,
            },
          ],
          producedByJobId: context.job.id as JobId,
          computedAtSourceRevision: prepared.value.sourceRevision,
        }, dependencies.actor);
        if (!published.ok) throw new JobFailureError(published.error);
        await context.updateProgress(1, null);
      } catch (error) {
        pendingError = error;
      } finally {
        if (guardSession) {
          await dependencies.guard.close(context.job.id as JobId, guardSession.token).catch(() => {});
        }
        const released = await dependencies.roots.release(context.job.id as JobId);
        cleanupPending = !released.ok;
      }

      if (pendingError) throw withCleanup(pendingError, warnings, cleanupPending);
      if (!result) throw new JobFailureError({ code: ErrorCode.Internal, message: "render result was not produced" });
      return jobExecutionOutcome({
        status: "succeeded",
        result,
        warnings,
        cleanupPending,
      });
    },
  };
}

/** Existing composition-root name retained while Phase O adopts the public handler name. */
export const createRenderJobType = createRenderJobHandler;
