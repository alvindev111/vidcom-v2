import type { z } from "zod";

import {
  CancelJobInputSchema,
  CancelJobOutputSchema,
  DEFAULT_TTS_COMPUTE_DEVICE,
  ErrorCode,
  GetJobStatusInputSchema,
  GetJobStatusOutputSchema,
  GetRenderOutputInputSchema,
  GetRenderOutputOutputSchema,
  ListTtsVoicesInputSchema,
  ListTtsVoicesOutputSchema,
  StartTtsInputSchema,
  StartTtsOutputSchema,
  TERMINAL_JOB_STATUSES,
  type ContentHash,
  type ProjectId,
} from "@vidcom/contracts";
import {
  canonicalizeJobInput,
  err,
  listTtsVoices,
  ok,
  planNarrationSynthesis,
  readRenderOutput,
  type IdPort,
  type JobId,
  type JobStorePort,
  type ProjectReadDependencies,
  type TtsPort,
} from "@vidcom/core";

import { annotationsForLevel, ToolRegistry } from "./registry";
import type { ToolDefinition } from "./types";

export interface JobToolDependencies {
  reads: ProjectReadDependencies;
  jobs: JobStorePort;
  tts: TtsPort;
  ids: IdPort;
  hashContent(content: string | Uint8Array): ContentHash;
  mimeFromPath(path: string): string | null;
}

/**
 * Lists the speech engines and voices installed on this machine.
 *
 * A separate tool rather than a field on `get_project_context`: the catalog is
 * machine state, not project state, and an agent needs it before it can name a
 * voice in `start_tts`.
 */
export function listTtsVoicesTool(
  dependencies: JobToolDependencies,
): ToolDefinition<z.infer<typeof ListTtsVoicesInputSchema>, z.infer<typeof ListTtsVoicesOutputSchema>> {
  return {
    name: "list_tts_voices",
    title: "List narration voices",
    level: "read",
    description: [
      "Use when you need to discover which speech engines are installed on this machine and which voices each offers, before calling start_tts.",
      "Do not use to read a scene's existing narration text; use get_project_context.",
      "Preconditions: projectId comes from list_projects.",
      "Side effects: read-only; no project files, revisions or jobs are created.",
      "Errors/recovery: a provider with available=false reports why in unavailableReason — add an API key, install the sidecar, or install FFmpeg — and cannot be passed to start_tts until fixed. A voice offering only cpu in computeDevices means this machine has no usable GPU.",
    ].join(" "),
    input: ListTtsVoicesInputSchema,
    output: ListTtsVoicesOutputSchema,
    annotations: annotationsForLevel("read"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (_context, input) => {
      const ref = await dependencies.reads.workspace.readProjectRef(input.projectId as ProjectId);
      if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
      return ok(await listTtsVoices(dependencies));
    },
  };
}

/**
 * Queues narration synthesis for one or more scenes and returns a job to poll.
 *
 * Every reason the request could not succeed is checked before the job exists,
 * so a rejection names the field to fix instead of arriving minutes later as a
 * failed job.
 */
export function startTtsTool(
  dependencies: JobToolDependencies,
): ToolDefinition<z.infer<typeof StartTtsInputSchema>, z.infer<typeof StartTtsOutputSchema>> {
  return {
    name: "start_tts",
    title: "Generate scene narration audio",
    level: "job",
    description: [
      "Use when you need to turn the narration text already written on one or more scenes into audio files in the project.",
      "Do not use to write or change narration text, and do not use to render video.",
      "Preconditions: every scene must already have narration text; providerId and voiceId come from list_tts_voices; leave computeDevice unset for CPU and only pass gpu when the voice lists it.",
      "Side effects: enqueues one job, then writes narration/<sceneId>.wav plus its JSON sidecar and commits one project revision when the job succeeds. Cloud engines bill the account.",
      "Errors/recovery: this job is never retried automatically because synthesis costs money and its output is not reproducible — read the failed job's error code and resubmit deliberately. Poll with get_job_status; cancel through the job API stops the engine before anything is written.",
    ].join(" "),
    input: StartTtsInputSchema,
    output: StartTtsOutputSchema,
    annotations: annotationsForLevel("job"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (_context, raw) => {
      const projectId = raw.projectId as ProjectId;
      const input = {
        projectId,
        sceneIds: raw.sceneIds,
        providerId: raw.providerId,
        voiceId: raw.voiceId,
        modelId: raw.modelId ?? null,
        ratePercent: raw.ratePercent ?? 0,
        computeDevice: raw.computeDevice ?? DEFAULT_TTS_COMPUTE_DEVICE,
      };
      const planned = await planNarrationSynthesis(dependencies, input);
      if (!planned.ok) return planned;

      const enqueued = await dependencies.jobs.enqueue({
        id: dependencies.ids.newId("job") as JobId,
        projectId,
        type: "tts",
        input,
        inputHash: dependencies.hashContent(canonicalizeJobInput(input)),
        // An agent retrying a tool call must not silently pay twice; the input
        // hash makes an identical resubmission reuse the existing job.
        idempotencyKey: `tts:${dependencies.hashContent(canonicalizeJobInput(input))}`,
      });
      if ("conflict" in enqueued) {
        return err({
          code: ErrorCode.IdempotencyKeyReused,
          message: "an identical narration job already exists; poll it with get_job_status",
        });
      }
      return ok({ jobId: enqueued.job.id, status: "queued" as const, pollWith: "get_job_status" as const });
    },
  };
}

/** Reads one job's progress or terminal outcome, including the error code that failed it. */
export function getJobStatusTool(
  dependencies: JobToolDependencies,
): ToolDefinition<z.infer<typeof GetJobStatusInputSchema>, z.infer<typeof GetJobStatusOutputSchema>> {
  return {
    name: "get_job_status",
    title: "Get background job status",
    level: "read",
    description: [
      "Use when you need to poll a jobId returned by start_tts, start_snapshot, or start_render until it reaches a terminal outcome.",
      "Do not use to list jobs or to cancel one.",
      "Preconditions: jobId comes from the tool that queued the work.",
      "Side effects: read-only.",
      "Errors/recovery: wait pollAfterMs before the next poll; terminal outcome is explicit, including partial. On failed, fix error.code before a deliberate resubmission.",
    ].join(" "),
    input: GetJobStatusInputSchema,
    output: GetJobStatusOutputSchema,
    annotations: annotationsForLevel("read"),
    availableInLegacy: true,
    projectIdOf: () => null,
    handler: async (_context, input) => {
      const job = await dependencies.jobs.get(input.jobId as JobId);
      if (!job) return err({ code: ErrorCode.NotFound, message: "job was not found" });
      return ok(GetJobStatusOutputSchema.parse({
        id: job.id,
        type: job.type,
        status: job.status,
        progress: job.progress,
        stage: job.stage,
        result: job.result,
        error: job.error,
        warnings: job.warnings,
        cleanupPending: job.cleanupPending,
        attempt: job.attempt,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        outcome: job.status === "succeeded" || job.status === "partial"
          || job.status === "failed" || job.status === "cancelled"
          ? job.status
          : null,
        pollAfterMs: job.status === "queued" ? 250 : job.status === "running" ? 1000 : null,
      }));
    },
  };
}

/**
 * Asks a running job to stop cooperatively.
 *
 * The job decides when it is safe to stop, so this returns what was requested
 * rather than claiming the process is already gone; `get_job_status` reports the
 * terminal outcome.
 */
export function cancelJobTool(
  dependencies: JobToolDependencies,
): ToolDefinition<z.infer<typeof CancelJobInputSchema>, z.infer<typeof CancelJobOutputSchema>> {
  return {
    name: "cancel_job",
    title: "Cancel a background job",
    level: "job",
    description: [
      "Use when a render, snapshot or narration job you queued is no longer wanted and should stop before it finishes.",
      "Do not use to delete a finished artifact, and do not treat it as proof the work stopped.",
      "Preconditions: jobId comes from the tool that queued the work.",
      "Side effects: records a cooperative cancellation request; a job already succeeded, partial, failed or cancelled is left untouched and returns requested=false.",
      "Errors/recovery: not_found means the jobId is unknown; after requested=true keep polling get_job_status until it reports the cancelled outcome, because cancellation is not instant.",
    ].join(" "),
    input: CancelJobInputSchema,
    output: CancelJobOutputSchema,
    annotations: annotationsForLevel("job"),
    availableInLegacy: true,
    projectIdOf: () => null,
    handler: async (_context, input) => {
      const job = await dependencies.jobs.get(input.jobId as JobId);
      if (!job) return err({ code: ErrorCode.NotFound, message: "job was not found" });
      const terminal = (TERMINAL_JOB_STATUSES as readonly string[]).includes(job.status);
      if (!terminal) await dependencies.jobs.requestCancel(job.id as JobId);
      return ok({ jobId: job.id, status: job.status, requested: !terminal });
    },
  };
}

/** Names the finished MP4 on disk so a local agent host can open it without streaming bytes. */
export function getRenderOutputTool(
  dependencies: JobToolDependencies,
): ToolDefinition<z.infer<typeof GetRenderOutputInputSchema>, z.infer<typeof GetRenderOutputOutputSchema>> {
  return {
    name: "get_render_output",
    title: "Locate a finished render",
    level: "read",
    description: [
      "Use when a render job has succeeded and you need the produced file's path, size, hash and media type to report or open it.",
      "Do not use to poll progress, to fetch the video bytes through this tool, or for snapshot jobs.",
      "Preconditions: jobId comes from start_render and get_job_status must already report succeeded or partial.",
      "Side effects: read-only; the artifact stays where the render wrote it.",
      "Errors/recovery: precondition_required means the job has not finished, so keep polling get_job_status; not_found means the job is not a render or its artifact is gone, so render again; a partial outcome means the file exists but the render reported warnings worth repeating.",
    ].join(" "),
    input: GetRenderOutputInputSchema,
    output: GetRenderOutputOutputSchema,
    annotations: annotationsForLevel("read"),
    availableInLegacy: true,
    projectIdOf: () => null,
    handler: async (_context, input) => readRenderOutput({
      ...dependencies.reads,
      jobs: dependencies.jobs,
      mimeFromPath: dependencies.mimeFromPath,
    }, input.jobId),
  };
}

export function registerJobTools(registry: ToolRegistry, dependencies: JobToolDependencies): void {
  registry.register(listTtsVoicesTool(dependencies));
  registry.register(startTtsTool(dependencies));
  registry.register(getJobStatusTool(dependencies));
  registry.register(cancelJobTool(dependencies));
  registry.register(getRenderOutputTool(dependencies));
}
