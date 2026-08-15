import path from "node:path";

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
  storyMotionDiagnostics,
  type BinaryProbePort,
  type ClockPort,
  type CompositeMutationJournalPort,
  type CompositionPort,
  type DerivedMutationPath,
  type DiagnosticsReport,
  type FontCompatibilityService,
  type JobExecutionContext,
  type Job,
  type JobId,
  type JobStorePort,
  type JobTypeDefinition,
  type IdPort,
  type MutationJournalPort,
  type ProcessSupervisorPort,
  type PreviewSettings,
  type RenderBinaryProbeResult,
  type ProjectRef,
  type RenderProjectPort,
  type RenderRootPort,
  type Result,
  type RuntimeAssetGuardPort,
  type WorkspacePort,
  type WriteAuthority,
} from "@vidcom/core";

import { checkFontCompatibility } from "./font-compatibility-gate";

export interface RenderJobInput {
  projectId: ProjectId;
  expectedSourceRevision?: number;
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
  renderTiming: RenderTiming;
}

export interface RenderTiming {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
}

const HD_PIXELS = 1_920 * 1_080;
const RENDER_TIMEOUT_HEADROOM_SECONDS = 120;
const RENDER_TIMEOUT_MULTIPLIER = 3;
export const MIN_RENDER_PROCESS_TIMEOUT_MS = 10 * 60 * 1_000;
export const MAX_RENDER_PROCESS_TIMEOUT_MS = 90 * 60 * 1_000;
export const RENDER_JOB_TIMEOUT_MS = 95 * 60 * 1_000;

/** A bounded render allowance scaled by authored duration, resolution and frame rate. */
export function renderProcessTimeoutMs(timing: RenderTiming): number {
  const values = [timing.durationSeconds, timing.width, timing.height, timing.fps];
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError("render timing values must be positive finite numbers");
  }
  const workSeconds = timing.durationSeconds
    * Math.max(1, (timing.width * timing.height) / HD_PIXELS)
    * Math.max(1, timing.fps / 30);
  const scaledMs = Math.ceil(
    (RENDER_TIMEOUT_HEADROOM_SECONDS + RENDER_TIMEOUT_MULTIPLIER * workSeconds) * 1_000,
  );
  return Math.min(MAX_RENDER_PROCESS_TIMEOUT_MS, Math.max(MIN_RENDER_PROCESS_TIMEOUT_MS, scaledMs));
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
  fonts: FontCompatibilityService;
  diagnostics: {
    forProject(projectId: ProjectId): Promise<Result<DiagnosticsReport, DomainError>>;
  };
  runtimeSource(): string;
  injectGuard(document: string, guard: { csp: string; bootstrapScript: string }): string;
  clock: ClockPort;
  actor: Actor;
}

export interface RenderJobEnqueueDependencies {
  jobs: JobStorePort;
  ids: IdPort;
  hashContent(content: string | Uint8Array): import("@vidcom/contracts").ContentHash;
  binaries: BinaryProbePort;
  diagnostics: RenderJobDependencies["diagnostics"];
}

async function localStylesheets(
  dependencies: Pick<RenderJobDependencies, "workspace">,
  ref: ProjectRef,
  document: string,
): Promise<Array<{ path: RelPath; css: string }>> {
  const queue = [...document.matchAll(/<link\b[^>]*\brel\s*=\s*["'][^"']*stylesheet[^"']*["'][^>]*>/giu)]
    .flatMap((tag) => [...tag[0].matchAll(/\bhref\s*=\s*["']([^"']+)["']/giu)]
      .map((match) => ({ href: match[1]!, base: path.posix.dirname(ref.entry) })));
  const loaded: Array<{ path: RelPath; css: string }> = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (/^(?:[a-z]+:|\/\/|#)/iu.test(next.href)) continue;
    const clean = next.href.split(/[?#]/u, 1)[0]!;
    const relative = path.posix.normalize(path.posix.join(next.base, clean));
    if (relative.startsWith("../") || path.posix.isAbsolute(relative) || seen.has(relative)) continue;
    seen.add(relative);
    const resolved = await dependencies.workspace.resolve(ref, relative, "read-source");
    if (!resolved.ok) throw new TypeError("local stylesheet path is invalid");
    const file = await dependencies.workspace.readFile(resolved.value);
    if (!file) throw new TypeError("local stylesheet is missing");
    loaded.push({ path: relative as RelPath, css: file.content });
    for (const imported of file.content.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/giu)) {
      queue.push({ href: imported[1]!, base: path.posix.dirname(relative) });
    }
  }
  return loaded;
}

/** Runs binary, generated-document and authored-stylesheet gates before queueing and again in the worker. */
export async function preflightRenderDocument(
  dependencies: Pick<RenderJobDependencies, "workspace" | "composition" | "binaries">,
  prepared: Pick<PreparedRender, "ref" | "previewSettings">,
): Promise<Result<{
  document: string;
  binaries: RenderBinaryProbeResult;
  externalDependencies: string[];
}, DomainError>> {
  const binaries = await dependencies.binaries.probe(prepared.ref.root);
  if (!binaries.ok) return binaries;
  try {
    const document = await dependencies.composition.buildDocument(
      prepared.ref,
      prepared.previewSettings,
      { root: true, runtimeUrl: "./.vidcom-runtime.js", fileBaseUrl: "./" },
    );
    const stylesheets = await localStylesheets(dependencies, prepared.ref, document);
    const violations = scanRemoteMedia([{ path: prepared.ref.entry, html: document }], stylesheets);
    if (violations.length > 0) return err({
      code: ErrorCode.RemoteAssetNotLocal,
      message: "rendered document declares remote media",
      details: { violations },
    });
    return ok({
      document,
      binaries: binaries.value,
      externalDependencies: scanExternalDependencies([{ path: prepared.ref.entry, html: document }], stylesheets),
    });
  } catch {
    return err({ code: ErrorCode.ProjectInvalid, message: "render document or local stylesheet is invalid" });
  }
}

function parseInput(raw: unknown): RenderJobInput {
  if (!raw || typeof raw !== "object") throw new TypeError("render job input does not match its schema");
  const input = raw as Record<string, unknown>;
  if (typeof input.projectId !== "string" || input.projectId.length === 0
    || (input.expectedSourceRevision !== undefined
      && (typeof input.expectedSourceRevision !== "number"
        || !Number.isInteger(input.expectedSourceRevision) || input.expectedSourceRevision < 0))
    || (input.bestEffort !== undefined && typeof input.bestEffort !== "boolean")
    || (input.renderPresetId !== undefined && typeof input.renderPresetId !== "string")
    || (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0))) {
    throw new TypeError("render job input does not match its schema");
  }
  return {
    projectId: input.projectId as ProjectId,
    ...(input.expectedSourceRevision === undefined
      ? {}
      : { expectedSourceRevision: input.expectedSourceRevision as number }),
    bestEffort: input.bestEffort !== false,
    ...(input.renderPresetId === undefined ? {} : { renderPresetId: input.renderPresetId }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  };
}

function staleRevision(expectedSourceRevision: number, actualSourceRevision: number): Result<never, DomainError> {
  return err({
    code: ErrorCode.WriteConflict,
    message: "project source revision changed after validation or review",
    field: "expectedSourceRevision",
    details: { expectedSourceRevision, actualSourceRevision },
  });
}

async function enforceDiagnosticsGate(
  dependencies: Pick<RenderJobDependencies, "diagnostics" | "journal">,
  input: RenderJobInput & { expectedSourceRevision: number },
): Promise<Result<undefined, DomainError>> {
  const report = await dependencies.diagnostics.forProject(input.projectId);
  if (!report.ok) return report;
  if (report.value.computedAtSourceRevision !== input.expectedSourceRevision) {
    return staleRevision(input.expectedSourceRevision, report.value.computedAtSourceRevision ?? 0);
  }
  const errors = report.value.diagnostics.filter(({ severity }) => severity === "error");
  if (errors.length > 0) return err({
    code: ErrorCode.ProjectInvalid,
    message: "project diagnostics contain render-blocking errors",
    details: {
      reason: errors[0]?.code ?? "diagnostics-error",
      diagnosticCodes: [...new Set(errors.map(({ code }) => code))],
    },
  });
  if (input.bestEffort === false && !report.value.lintSourceAvailable) return err({
    code: ErrorCode.ProjectInvalid,
    message: "strict render requires the HyperFrames diagnostics source",
    details: { reason: "lint-source-unavailable" },
  });
  const latest = await dependencies.journal.latestSourceRevision(input.projectId) ?? 0;
  return latest === input.expectedSourceRevision
    ? ok(undefined)
    : staleRevision(input.expectedSourceRevision, latest);
}

/** Gate shared by enqueue adapters and the worker's defensive re-check. */
export async function prepareRender(
  dependencies: Pick<RenderJobDependencies, "workspace" | "composition" | "journal" | "fonts">,
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
  const shallowMotion = storyMotionDiagnostics(model.scenes.filter((scene) => scene.src !== null));
  if (shallowMotion.length > 0) return err({
    code: ErrorCode.ProjectInvalid,
    message: "story scenes require meaningful multi-phase motion before render",
    details: {
      reason: shallowMotion[0]?.code ?? "story-motion-shallow",
      sceneIds: shallowMotion.flatMap(({ sceneId }) => sceneId ? [sceneId] : []),
    },
  });
  const fontCompatibility = await checkFontCompatibility(dependencies.fonts, ref, model.sources);
  if (!fontCompatibility.ok) return fontCompatibility;
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
    renderTiming: {
      durationSeconds: model.project.duration,
      width: model.project.width,
      height: model.project.height,
      fps: model.frameRate ?? 30,
    },
  });
}

/** Performs the state gate before any durable queue row becomes visible. */
export async function enqueueRenderJob(
  dependencies: Pick<RenderJobDependencies, "workspace" | "composition" | "journal" | "fonts" | "diagnostics">
    & RenderJobEnqueueDependencies,
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
  const expectedSourceRevision = input.expectedSourceRevision ?? prepared.value.sourceRevision;
  if (prepared.value.sourceRevision !== expectedSourceRevision) {
    return staleRevision(expectedSourceRevision, prepared.value.sourceRevision);
  }
  const pinnedInput = { ...input, expectedSourceRevision };
  const diagnostics = await enforceDiagnosticsGate(dependencies, pinnedInput);
  if (!diagnostics.ok) return diagnostics;
  const preflight = await preflightRenderDocument(dependencies, prepared.value);
  if (!preflight.ok) return preflight;
  const latest = await dependencies.journal.latestSourceRevision(input.projectId) ?? 0;
  if (latest !== expectedSourceRevision) return staleRevision(expectedSourceRevision, latest);
  const canonicalInput = canonicalizeJobInput(pinnedInput);
  const enqueued = await dependencies.jobs.enqueue({
    id: dependencies.ids.newId("job") as JobId,
    projectId: input.projectId,
    type: "render",
    input: pinnedInput,
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
    timeoutMs: RENDER_JOB_TIMEOUT_MS,
    async run(rawInput: unknown, context: JobExecutionContext) {
      const input = parseInput(rawInput);
      if (input.expectedSourceRevision === undefined) {
        throw new JobFailureError({
          code: ErrorCode.SchemaInvalid,
          message: "render job is missing its expected source revision",
          field: "expectedSourceRevision",
        });
      }
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
        if (prepared.value.sourceRevision !== input.expectedSourceRevision) {
          const stale = staleRevision(input.expectedSourceRevision, prepared.value.sourceRevision);
          if (!stale.ok) throw new JobFailureError(stale.error);
        }
        const diagnostics = await enforceDiagnosticsGate(dependencies, {
          ...input,
          expectedSourceRevision: input.expectedSourceRevision,
        });
        if (!diagnostics.ok) throw new JobFailureError(diagnostics.error);
        const preflight = await preflightRenderDocument(dependencies, prepared.value);
        if (!preflight.ok) throw new JobFailureError(preflight.error);
        const latest = await dependencies.journal.latestSourceRevision(input.projectId) ?? 0;
        if (latest !== input.expectedSourceRevision) {
          const stale = staleRevision(input.expectedSourceRevision, latest);
          if (!stale.ok) throw new JobFailureError(stale.error);
        }
        warnings.push(...preflight.value.binaries.warnings);

        await context.updateProgress(0.05, "building render document");
        const opened = await dependencies.guard.open(context.job.id as JobId);
        guardSession = opened;
        const staticDependencies = preflight.value.externalDependencies;
        const document = dependencies.injectGuard(preflight.value.document, opened);
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
            ...preflight.value.binaries.hyperframesCommand,
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
            // The exact HyperFrames pin defaults experimental fast capture on
            // for macOS with a hardware-GPU browser. Packaged rendering uses
            // the stable screenshot path on every machine instead of allowing
            // host GPU state to select a different capture implementation.
            PRODUCER_EXPERIMENTAL_FAST_CAPTURE: "false",
            HF_DE_PARALLEL_ROUTER: "false",
            HYPERFRAMES_BROWSER_PATH: preflight.value.binaries.browserPath,
            HYPERFRAMES_FFMPEG_PATH: preflight.value.binaries.ffmpegPath,
            HYPERFRAMES_FFPROBE_PATH: preflight.value.binaries.ffprobePath,
          },
          timeoutMs: renderProcessTimeoutMs(prepared.value.renderTiming),
          signal: context.signal,
        });
        if (rendered.status === "terminated") {
          warnings.push(...rendered.warnings.map(() => warning(
            WarningCode.TerminationProofNotExhaustive,
            "process termination proof was not exhaustive",
          )));
          if (await context.isCancellationRequested()) {
            throw new JobCancelledError(warnings, !rendered.proof.exhaustive, rendered.proof);
          }
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
        const stagedArtifact = await dependencies.renderProjects.artifactSource(staged.outputPath)
          .catch((cause: unknown) => {
            const output = [rendered.output.stdout, rendered.output.stderr]
              .map((value) => value.trim())
              .filter(Boolean)
              .join(" | ")
              .slice(-2_048);
            throw new JobFailureError({
              code: ErrorCode.Internal,
              message: `HyperFrames exited 0 without producing the render artifact${output ? ` (${output})` : ""}`,
            }, { cause });
          });

        await context.updateProgress(0.92, "validating video");
        const probed = await dependencies.process.run({
          command: [
            preflight.value.binaries.ffprobePath,
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
          const diagnostic = probed.status === "exited"
            ? `ffprobe exited ${String(probed.output.exitCode)}: ${probed.output.stderr.trim().slice(0, 240)}`
            : `ffprobe was ${probed.status}`;
          throw new JobFailureError({
            code: ErrorCode.Internal,
            message: `render artifact validation failed (${diagnostic})`,
          });
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
        await context.beginPublication();
        const published = await dependencies.authority.mutateDerived({
          ref: prepared.value.ref,
          writes: [
            { path: artifactPath, content: stagedArtifact },
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
