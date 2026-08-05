import {
  ErrorCode,
  WarningCode,
  type Actor,
  type ContentHash,
  type DomainError,
  type JobWarningDto,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import {
  canonicalizeJobInput,
  err,
  finalizeGuardedArtifact,
  getPreviewSettings,
  jobExecutionOutcome,
  JobCancelledError,
  JobFailureError,
  ok,
  type BinaryProbePort,
  type ClockPort,
  type CompositeMutationJournalPort,
  type CompositionPort,
  type DerivedMutationPath,
  type IdPort,
  type Job,
  type JobExecutionContext,
  type JobId,
  type JobStorePort,
  type JobTypeDefinition,
  type MutationJournalPort,
  type PreviewSettings,
  type ProcessSupervisorPort,
  type ProjectRef,
  type RenderProjectPort,
  type RenderRootPort,
  type Result,
  type RuntimeAssetGuardPort,
  type WorkspacePort,
  type WriteAuthority,
} from "@vidcom/core";

import { preflightRenderDocument } from "./render-job";

export interface SnapshotJobInput {
  projectId: ProjectId;
  idempotencyKey?: string;
}

export interface SnapshotJobResult {
  outcome: "succeeded" | "partial";
  complete: boolean;
  sceneCount: number;
  sceneIds: string[];
  missingSceneIds: string[];
  snapshotPaths: Record<string, RelPath>;
  contactSheet: RelPath | null;
  computedAtSourceRevision: number | null;
  partialAtSourceRevision: number | null;
}

interface PreparedSnapshot {
  ref: ProjectRef;
  sourceRevision: number;
  previewSettings: PreviewSettings;
  rootDuration: number;
  scenes: Array<{ id: string; start: number; duration: number; index: number }>;
}

export interface SnapshotJobDependencies {
  process: ProcessSupervisorPort;
  roots: RenderRootPort;
  renderProjects: RenderProjectPort;
  authority: WriteAuthority;
  composition: CompositionPort;
  workspace: WorkspacePort;
  journal: MutationJournalPort & Pick<CompositeMutationJournalPort, "readProjectRecoveryStatus">;
  jobs: JobStorePort;
  guard: RuntimeAssetGuardPort;
  binaries: BinaryProbePort;
  runtimeSource(): string;
  injectGuard(document: string, guard: { csp: string; bootstrapScript: string }): string;
  clock: ClockPort;
  actor: Actor;
}

export interface SnapshotEnqueueDependencies {
  jobs: JobStorePort;
  ids: IdPort;
  hashContent(content: string | Uint8Array): ContentHash;
  binaries: BinaryProbePort;
}

function parseInput(raw: unknown): SnapshotJobInput {
  if (!raw || typeof raw !== "object" || typeof (raw as { projectId?: unknown }).projectId !== "string"
    || ((raw as { idempotencyKey?: unknown }).idempotencyKey !== undefined
      && (typeof (raw as { idempotencyKey?: unknown }).idempotencyKey !== "string"
        || (raw as { idempotencyKey: string }).idempotencyKey.length === 0))) {
    throw new TypeError("snapshot job input does not match its schema");
  }
  const input = raw as { projectId: string; idempotencyKey?: string };
  return {
    projectId: input.projectId as ProjectId,
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  };
}

export async function prepareSnapshot(
  dependencies: Pick<SnapshotJobDependencies, "workspace" | "composition" | "journal">,
  projectId: ProjectId,
): Promise<Result<PreparedSnapshot, DomainError>> {
  const ref = await dependencies.workspace.readProjectRef(projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  const entry = await dependencies.workspace.resolve(ref, ref.entry, "read-source");
  if (!entry.ok) return err({ code: ErrorCode.ProjectInvalid, message: "project entry path is invalid" });
  const source = await dependencies.workspace.readFile(entry.value);
  if (!source) return err({ code: ErrorCode.NoComposition, message: "project has no composition" });
  if (dependencies.composition.validateSource) {
    const valid = await dependencies.composition.validateSource(ref.entry, source.content);
    if (!valid.ok) return err({
      code: ErrorCode.ProjectInvalid,
      message: "project composition is invalid",
      details: { reason: ErrorCode.CompositionParseError },
    });
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
    rootDuration: model.project.duration,
    scenes: model.scenes.map((scene, index) => ({
      id: scene.id,
      start: scene.start,
      duration: scene.duration,
      index,
    })),
  });
}

export async function enqueueSnapshotJob(
  dependencies: Pick<SnapshotJobDependencies, "workspace" | "composition" | "journal"> & SnapshotEnqueueDependencies,
  rawInput: SnapshotJobInput,
): Promise<Result<Job, DomainError>> {
  let input: SnapshotJobInput;
  try { input = parseInput(rawInput); }
  catch { return err({ code: ErrorCode.SchemaInvalid, message: "snapshot job input does not match its schema" }); }
  const prepared = await prepareSnapshot(dependencies, input.projectId);
  if (!prepared.ok) return prepared;
  const preflight = await preflightRenderDocument(dependencies, prepared.value);
  if (!preflight.ok) return preflight;
  const canonicalInput = canonicalizeJobInput(input);
  const enqueued = await dependencies.jobs.enqueue({
    id: dependencies.ids.newId("job") as JobId,
    projectId: input.projectId,
    type: "snapshot",
    input,
    inputHash: dependencies.hashContent(canonicalInput),
    idempotencyKey: input.idempotencyKey ?? null,
  });
  return "conflict" in enqueued
    ? err({ code: ErrorCode.IdempotencyKeyReused, message: "snapshot idempotency key was reused with different input" })
    : ok(enqueued.job);
}

const normalizedTimestamp = (value: number): string => Number(value.toFixed(6)).toString();

export function snapshotTimestampFromFilename(filename: string): number | null {
  const match = /-at-(-?\d+(?:\.\d+)?)s\.png$/iu.exec(filename);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function mapSnapshotArtifacts(
  scenes: readonly { id: string; midpoint: number }[],
  artifacts: readonly { name: string; content: Uint8Array }[],
): { images: Map<string, Uint8Array>; missingSceneIds: string[] } {
  const byTimestamp = new Map<string, Uint8Array>();
  for (const artifact of artifacts) {
    const timestamp = snapshotTimestampFromFilename(artifact.name);
    if (timestamp === null) continue;
    const key = normalizedTimestamp(timestamp);
    if (!byTimestamp.has(key)) byTimestamp.set(key, artifact.content);
  }
  const images = new Map<string, Uint8Array>();
  const missingSceneIds: string[] = [];
  for (const scene of scenes) {
    const image = byTimestamp.get(normalizedTimestamp(scene.midpoint));
    if (image) images.set(scene.id, image);
    else missingSceneIds.push(scene.id);
  }
  return { images, missingSceneIds };
}

function priorResult(job: Job | null): SnapshotJobResult | null {
  const value = job?.result;
  if (!value || typeof value !== "object") return null;
  const result = value as Partial<SnapshotJobResult>;
  return typeof result.complete === "boolean"
    && Array.isArray(result.sceneIds)
    && Array.isArray(result.missingSceneIds)
    && result.snapshotPaths !== null
    && typeof result.snapshotPaths === "object"
    ? result as SnapshotJobResult
    : null;
}

function warning(code: WarningCode, message: string): JobWarningDto {
  return { code, message };
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
    message: error instanceof Error ? error.message : "snapshot job failed",
  }, { cause: error, warnings, cleanupPending });
}

const snapshotPath = (index: number): DerivedMutationPath =>
  `snapshots/scene-${String(index + 1).padStart(4, "0")}.png` as DerivedMutationPath;

async function readPriorImages(
  dependencies: SnapshotJobDependencies,
  prepared: PreparedSnapshot,
  previous: SnapshotJobResult,
): Promise<Map<string, Uint8Array>> {
  const images = new Map<string, Uint8Array>();
  for (const scene of prepared.scenes) {
    const relative = previous.snapshotPaths[scene.id];
    if (!relative) continue;
    const resolved = await dependencies.workspace.resolve(prepared.ref, relative, "read-asset");
    if (!resolved.ok) continue;
    const content = await dependencies.workspace.readBytes(resolved.value);
    if (content) images.set(scene.id, content.bytes);
  }
  return images;
}

async function snapshotArtifactsExist(
  dependencies: SnapshotJobDependencies,
  prepared: PreparedSnapshot,
  previous: SnapshotJobResult,
): Promise<boolean> {
  const paths = [
    ...prepared.scenes.map((scene) => previous.snapshotPaths[scene.id]),
    previous.contactSheet,
  ];
  if (paths.some((relative) => !relative)) return false;
  for (const relative of paths) {
    const resolved = await dependencies.workspace.resolve(prepared.ref, relative!, "read-asset");
    if (!resolved.ok || !(await dependencies.workspace.exists(resolved.value))) return false;
  }
  return true;
}

function resultFor(
  prepared: PreparedSnapshot,
  images: ReadonlyMap<string, Uint8Array>,
  missingSceneIds: string[],
  contactSheet: RelPath | null,
): SnapshotJobResult {
  const complete = missingSceneIds.length === 0;
  const snapshotPaths = Object.fromEntries(prepared.scenes
    .filter((scene) => images.has(scene.id))
    .map((scene) => [scene.id, snapshotPath(scene.index)])) as Record<string, RelPath>;
  return {
    outcome: complete ? "succeeded" : "partial",
    complete,
    sceneCount: prepared.scenes.length,
    sceneIds: prepared.scenes.map((scene) => scene.id),
    missingSceneIds,
    snapshotPaths,
    contactSheet,
    computedAtSourceRevision: complete ? prepared.sourceRevision : null,
    partialAtSourceRevision: complete ? null : prepared.sourceRevision,
  };
}

export function createSnapshotJobHandler(dependencies: SnapshotJobDependencies): JobTypeDefinition {
  return {
    type: "snapshot",
    concurrency: 2,
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 30 * 60 * 1_000,
    cleanupPendingOnStale: true,
    async run(rawInput: unknown, context: JobExecutionContext) {
      const input = parseInput(rawInput);
      const warnings: JobWarningDto[] = [];
      let cleanupPending = false;
      let acquired = false;
      let guardSession: { token: string } | null = null;
      let pendingError: unknown = null;
      let result: SnapshotJobResult | null = null;
      try {
        const preparedResult = await prepareSnapshot(dependencies, input.projectId);
        if (!preparedResult.ok) throw new JobFailureError(preparedResult.error);
        const prepared = preparedResult.value;
        const previous = priorResult(await dependencies.jobs.latestTerminal(input.projectId, "snapshot"));
        if (prepared.scenes.length === 0) {
          result = resultFor(prepared, new Map(), [], null);
        } else if (previous?.complete
          && previous.computedAtSourceRevision === prepared.sourceRevision
          && previous.sceneIds.join("\0") === prepared.scenes.map((scene) => scene.id).join("\0")
          && await snapshotArtifactsExist(dependencies, prepared, previous)) {
          result = previous;
        } else {
          const preflight = await preflightRenderDocument(dependencies, prepared);
          if (!preflight.ok) throw new JobFailureError(preflight.error);
          warnings.push(...preflight.value.binaries.warnings);
          const samePartialGeneration = previous?.complete === false
            && previous.partialAtSourceRevision === prepared.sourceRevision;
          const images = samePartialGeneration
            ? await readPriorImages(dependencies, prepared, previous)
            : new Map<string, Uint8Array>();
          const targetScenes = prepared.scenes.filter((scene) => !images.has(scene.id));
          const midpointGroups = new Map<string, { midpoint: number; scenes: typeof targetScenes }>();
          for (const scene of targetScenes) {
            const midpoint = scene.start + scene.duration / 2;
            if (!Number.isFinite(midpoint) || midpoint < 0 || midpoint > prepared.rootDuration) {
              throw new JobFailureError({
                code: ErrorCode.TimingInvalid,
                message: "snapshot midpoint is outside the root timeline",
                details: { sceneId: scene.id, midpoint, rootDuration: prepared.rootDuration },
              });
            }
            const key = normalizedTimestamp(midpoint);
            const group = midpointGroups.get(key) ?? { midpoint: Number(key), scenes: [] };
            group.scenes.push(scene);
            midpointGroups.set(key, group);
          }

          const root = await dependencies.roots.acquire(context.job.id as JobId);
          acquired = true;
          const opened = await dependencies.guard.open(context.job.id as JobId);
          guardSession = opened;
          const externalDependencies = preflight.value.externalDependencies;
          const staged = await dependencies.renderProjects.stage(
            prepared.ref,
            root.root,
            dependencies.injectGuard(preflight.value.document, opened),
            dependencies.runtimeSource(),
          );
          if (midpointGroups.size > 0) {
            await context.throwIfCancelled();
            await context.updateProgress(0.1, "capturing scene snapshots");
            const captured = await dependencies.process.run({
              command: [
                ...preflight.value.binaries.hyperframesCommand,
                "snapshot",
                staged.projectRoot,
                "--at",
                [...midpointGroups.values()].map(({ midpoint }) => normalizedTimestamp(midpoint)).join(","),
                "--no-end",
                "--describe", "false",
                "--output", staged.snapshotOutputRoot,
              ],
              cwd: staged.projectRoot,
              environment: {
                ...root.environment,
                HYPERFRAMES_BROWSER_PATH: preflight.value.binaries.browserPath,
                HYPERFRAMES_FFMPEG_PATH: preflight.value.binaries.ffmpegPath,
                HYPERFRAMES_FFPROBE_PATH: preflight.value.binaries.ffprobePath,
              },
              signal: context.signal,
            });
            if (captured.status === "terminated") {
              warnings.push(...captured.warnings.map(() => warning(
                WarningCode.TerminationProofNotExhaustive,
                "process termination proof was not exhaustive",
              )));
              if (await context.isCancellationRequested()) {
                throw new JobCancelledError(warnings, !captured.proof.exhaustive, captured.proof);
              }
              throw new JobFailureError(
                { code: ErrorCode.Internal, message: "snapshot process timed out" },
                { terminationProof: captured.proof },
              );
            }
            if (captured.output.exitCode !== 0) {
              throw new JobFailureError({ code: ErrorCode.Internal, message: "HyperFrames snapshot failed" });
            }
            const mapped = mapSnapshotArtifacts(
              [...midpointGroups.values()].map(({ midpoint, scenes }) =>
                scenes.map((scene) => ({ id: scene.id, midpoint }))).flat(),
              await dependencies.renderProjects.readSnapshotArtifacts(staged.snapshotOutputRoot),
            );
            for (const [sceneId, content] of mapped.images) images.set(sceneId, content);
          }

          const missingSceneIds = prepared.scenes.filter((scene) => !images.has(scene.id)).map((scene) => scene.id);
          const orderedImages = prepared.scenes.flatMap((scene) => {
            const image = images.get(scene.id);
            return image ? [image] : [];
          });
          const contactSheet = missingSceneIds.length === 0
            ? "snapshots/contact-sheet.png" as DerivedMutationPath
            : null;
          result = resultFor(prepared, images, missingSceneIds, contactSheet);
          await context.throwIfCancelled();
          const writes = prepared.scenes.flatMap((scene) => {
            const image = images.get(scene.id);
            return image ? [{ path: snapshotPath(scene.index), content: image }] : [];
          });
          if (contactSheet) writes.push({
            path: contactSheet,
            content: await dependencies.renderProjects.composeContactSheet(orderedImages),
          });
          let guarded;
          try {
            guarded = await finalizeGuardedArtifact(
              dependencies.guard,
              context.job.id as JobId,
              opened.token,
              {
                async publish(guardResult) {
                  if ([...externalDependencies, ...guardResult.externalDependencies].length > 0) warnings.push(warning(
                    WarningCode.ExternalDependencyUnpinned,
                    "snapshot used an external script, stylesheet, or font",
                  ));
                  await context.beginPublication();
                  const published = await dependencies.authority.mutateDerived({
                    ref: prepared.ref,
                    writes,
                    producedByJobId: context.job.id as JobId,
                    computedAtSourceRevision: prepared.sourceRevision,
                  }, dependencies.actor);
                  if (!published.ok) throw new JobFailureError(published.error);
                },
                async discard() {},
              },
            );
          } finally {
            guardSession = null;
          }
          if (!guarded.ok) throw new JobFailureError(guarded.error);
          await context.updateProgress(1, null);
        }
      } catch (error) {
        pendingError = error;
      } finally {
        if (guardSession) await dependencies.guard.close(context.job.id as JobId, guardSession.token).catch(() => {});
        if (acquired) cleanupPending = !(await dependencies.roots.release(context.job.id as JobId)).ok;
      }
      if (pendingError) throw withCleanup(pendingError, warnings, cleanupPending);
      if (!result) throw new JobFailureError({ code: ErrorCode.Internal, message: "snapshot result was not produced" });
      return jobExecutionOutcome(result.complete
        ? { status: "succeeded", result, warnings, cleanupPending }
        : { status: "partial", result, warnings, cleanupPending });
    },
  };
}
