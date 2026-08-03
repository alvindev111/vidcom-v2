import {
  DEFAULT_TTS_COMPUTE_DEVICE,
  ErrorCode,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  ProjectParamsSchema,
  SynthesizeNarrationRequestSchema,
  type ContentHash,
  type ProjectId,
} from "@vidcom/contracts";
import {
  canonicalizeJobInput,
  listTtsVoices,
  planNarrationSynthesis,
  type IdPort,
  type JobId,
  type JobStorePort,
  type ProjectReadDependencies,
  type TtsPort,
  type WorkspacePort,
} from "@vidcom/core";
import { Hono, type Context } from "hono";

import { HttpBoundaryError } from "../middleware/error-mapper";

export interface NarrationRouteDependencies {
  workspace: Pick<WorkspacePort, "readProjectRef">;
  reads: ProjectReadDependencies;
  jobs: JobStorePort;
  tts: TtsPort;
  ids: IdPort;
  hashContent(content: string | Uint8Array): ContentHash;
}

function fail(error: { code: ErrorCode; message: string; field?: string }): never {
  throw new HttpBoundaryError(error);
}

function projectId(c: Context): ProjectId {
  const parsed = ProjectParamsSchema.safeParse({ id: c.req.param("id") });
  return parsed.success
    ? parsed.data.id as ProjectId
    : fail({ code: ErrorCode.SchemaInvalid, message: "project id is invalid", field: "id" });
}

/**
 * The `Idempotency-Key` header, normalized, or `null` when absent.
 *
 * An empty or whitespace-only header is treated as absent rather than stored:
 * kept verbatim it becomes a real key that every other keyless client collides
 * with, producing conflicts nobody can explain. Length is bounded because the
 * value is written straight into SQLite.
 */
function idempotencyKey(c: Context): string | null {
  const raw = c.req.header("Idempotency-Key")?.trim();
  if (!raw) return null;
  if (raw.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    fail({
      code: ErrorCode.SchemaInvalid,
      message: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      field: "Idempotency-Key",
    });
  }
  return raw;
}

/**
 * Narration synthesis and the TTS catalog.
 *
 * Synthesis is enqueued rather than awaited: a batch runs for tens of seconds on
 * a cloud engine and minutes on a local one, well past what a request should
 * hold open. Everything that decides whether the job *can* succeed — provider,
 * voice, device, scene, narration text — is checked here first, because a job
 * that cannot succeed is landfill in the queue and the caller learns about it
 * minutes later with no field to point at.
 */
export function createNarrationRoutes(dependencies: NarrationRouteDependencies): Hono {
  const routes = new Hono();

  routes.get("/v1/projects/:id/tts/voices", async (c) => {
    await requireProject(dependencies, projectId(c));
    return c.json(await listTtsVoices(dependencies));
  });

  routes.post("/v1/projects/:id/narration/synthesize", async (c) => {
    const id = projectId(c);
    const key = idempotencyKey(c);
    const body = await c.req.json().catch(() => fail({
      code: ErrorCode.SchemaInvalid, message: "request body is not valid JSON",
    }));
    const parsed = SynthesizeNarrationRequestSchema.safeParse(body);
    if (!parsed.success) {
      fail({
        code: ErrorCode.SchemaInvalid,
        message: "narration synthesis payload is invalid",
        field: String(parsed.error.issues[0]?.path[0] ?? "sceneIds"),
      });
    }
    await requireProject(dependencies, id);

    const input = {
      ...parsed.data,
      projectId: id,
      // Defaulted here rather than in the job so the persisted input records the
      // device that was actually chosen, not "whatever the worker decided later".
      computeDevice: parsed.data.computeDevice ?? DEFAULT_TTS_COMPUTE_DEVICE,
      ratePercent: parsed.data.ratePercent ?? 0,
      modelId: parsed.data.modelId ?? null,
    };
    const planned = await planNarrationSynthesis({
      tts: dependencies.tts,
      reads: dependencies.reads,
    }, input);
    if (!planned.ok) fail(planned.error);

    const enqueued = await dependencies.jobs.enqueue({
      id: dependencies.ids.newId("job") as JobId,
      projectId: id,
      type: "tts",
      input,
      inputHash: dependencies.hashContent(canonicalizeJobInput(input)),
      idempotencyKey: key,
    });
    if ("conflict" in enqueued) {
      fail({
        code: ErrorCode.IdempotencyKeyReused,
        message: "this Idempotency-Key was already used for a different narration request",
      });
    }
    return c.json({ jobId: enqueued.job.id, status: "queued" as const }, 202);
  });

  return routes;
}

/** Rejects an unknown project so a project-scoped route never answers 200 for one that is absent. */
async function requireProject(dependencies: NarrationRouteDependencies, id: ProjectId): Promise<void> {
  if (!(await dependencies.workspace.readProjectRef(id))) {
    fail({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  }
}
