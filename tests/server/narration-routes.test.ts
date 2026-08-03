import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ContentHash, ProjectId, TtsProviderDto } from "@vidcom/contracts";
import type {
  Job,
  JobStorePort,
  NewJob,
  ProjectReadDependencies,
  ProjectRef,
  TtsPort,
} from "@vidcom/core";
import { createNarrationRoutes, mapHttpError } from "@vidcom/server";
import { Hono } from "hono";

import { createSequentialIdPort } from "../support/deterministic";

const PROJECT_ID = "demo" as ProjectId;

const CATALOG: TtsProviderDto[] = [{
  id: "vieneu",
  label: "VieNeu-TTS v3 Turbo",
  available: true,
  unavailableReason: null,
  voices: [{
    id: "vieneu-v3-doan-trang",
    providerId: "vieneu",
    label: "Đoan Trang",
    language: "vi",
    modelId: "vieneu-v3-turbo",
    supportsEmotionCues: true,
    computeDevices: ["cpu"],
    recommended: true,
  }],
  allowsCustomVoiceId: false,
  customVoiceDefaults: null,
}];

function narratedScene(id: string, text: string | null) {
  return {
    id,
    src: null,
    start: 0,
    duration: 5,
    trackIndex: 0,
    block: null,
    isTransition: false,
    media: [],
    script: [],
    narration: text === null ? null : {
      sceneId: id,
      text,
      voice: "af_heart",
      status: "mock" as const,
      audioPath: `narration/${id}.wav`,
      command: "",
      revision: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
      staleSince: null,
    },
    elements: [],
    unresolvedEffects: 0,
  };
}

function harness(options: {
  projectExists?: boolean;
  enqueueConflict?: boolean;
  scenes?: ReturnType<typeof narratedScene>[];
  providers?: TtsProviderDto[];
} = {}) {
  const enqueued: NewJob[] = [];
  const jobs = {
    async enqueue(job: NewJob) {
      enqueued.push(job);
      return options.enqueueConflict
        ? { conflict: "idempotency_key_reused" as const }
        : { job: { ...job, status: "queued" } as unknown as Job, reused: false };
    },
  } as unknown as JobStorePort;
  const tts = { async listProviders() { return options.providers ?? CATALOG; } } as unknown as TtsPort;
  const readProjectRef = async (): Promise<ProjectRef | null> => (
    options.projectExists === false ? null : { id: PROJECT_ID, slug: "demo", root: "/w/demo" } as ProjectRef
  );
  const reads = {
    workspace: { readProjectRef },
    composition: {
      async parseProject() {
        return { scenes: options.scenes ?? [narratedScene("intro", "Xin chào")] };
      },
    },
  } as unknown as ProjectReadDependencies;
  // The real app installs this in `createServerApp`; without it every boundary
  // error arrives as a bare 500 and the status assertions test nothing.
  const app = new Hono().onError(mapHttpError).route("/", createNarrationRoutes({
    workspace: { readProjectRef },
    reads,
    jobs,
    tts,
    ids: createSequentialIdPort(),
    hashContent: (content) => `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash,
  }));
  return { app, enqueued };
}

const BODY = { sceneIds: ["intro"], providerId: "vieneu", voiceId: "vieneu-v3-doan-trang" };

function post(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  return app.request(`http://local/v1/projects/${PROJECT_ID}/narration/synthesize`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("narration routes", () => {
  it("returns the catalog including engines that cannot run here", async () => {
    const { app } = harness();

    const response = await app.request(`http://local/v1/projects/${PROJECT_ID}/tts/voices`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ providers: CATALOG });
  });

  it("enqueues rather than synthesizing inside the request", async () => {
    const { app, enqueued } = harness();

    const response = await post(app, BODY);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ jobId: "job_0001", status: "queued" });
    expect(enqueued[0]).toMatchObject({ type: "tts", projectId: PROJECT_ID });
  });

  it("records the device that was chosen instead of leaving it to the worker", async () => {
    const { app, enqueued } = harness();

    await post(app, BODY);

    expect(enqueued[0]?.input).toMatchObject({ computeDevice: "cpu", ratePercent: 0, modelId: null });
  });

  it("keeps an explicit GPU request in the persisted input when the machine has one", async () => {
    const { app, enqueued } = harness({
      providers: [{
        ...CATALOG[0]!,
        voices: [{ ...CATALOG[0]!.voices[0]!, computeDevices: ["cpu", "gpu"] }],
      }],
    });

    await post(app, { ...BODY, computeDevice: "gpu" });

    expect(enqueued[0]?.input).toMatchObject({ computeDevice: "gpu" });
  });

  it("rejects a device the contract does not define", async () => {
    const { app, enqueued } = harness();

    const response = await post(app, { ...BODY, computeDevice: "auto" });

    // No `auto`: an engine left to choose picks CUDA whenever a driver exists.
    expect(response.status).toBe(400);
    expect(enqueued).toHaveLength(0);
  });

  it("rejects a rate outside the safe window before anything is queued", async () => {
    const { app, enqueued } = harness();

    const response = await post(app, { ...BODY, ratePercent: 50 });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "schema_invalid", field: "ratePercent" } });
    expect(enqueued).toHaveLength(0);
  });

  it("rejects an empty scene list", async () => {
    const { app, enqueued } = harness();

    expect((await post(app, { ...BODY, sceneIds: [] })).status).toBe(400);
    expect(enqueued).toHaveLength(0);
  });

  it("rejects a body that is not JSON", async () => {
    const { app } = harness();

    const response = await app.request(`http://local/v1/projects/${PROJECT_ID}/narration/synthesize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
  });

  it("reports a missing project before queueing work that cannot succeed", async () => {
    const { app, enqueued } = harness({ projectExists: false });

    const response = await post(app, BODY);

    expect(response.status).toBe(404);
    expect(enqueued).toHaveLength(0);
  });

  it("reports a missing project on the catalog too, not 200", async () => {
    const { app } = harness({ projectExists: false });

    const response = await app.request(`http://local/v1/projects/${PROJECT_ID}/tts/voices`);

    expect(response.status).toBe(404);
  });

  it("rejects an unknown provider before enqueue", async () => {
    const { app, enqueued } = harness();

    const response = await post(app, { ...BODY, providerId: "typo" });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "tts_provider_unavailable", field: "providerId" },
    });
    expect(enqueued).toHaveLength(0);
  });

  it("rejects a voice that does not belong to the provider before enqueue", async () => {
    const { app, enqueued } = harness();

    const response = await post(app, { ...BODY, voiceId: "someone-else" });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "tts_voice_not_supported", field: "voiceId" },
    });
    expect(enqueued).toHaveLength(0);
  });

  it("names a missing credential rather than queueing a job that cannot pay", async () => {
    const { app, enqueued } = harness({
      providers: [{ ...CATALOG[0]!, available: false, unavailableReason: "credential_missing" }],
    });

    const response = await post(app, BODY);

    expect(await response.json()).toMatchObject({ error: { code: "tts_credential_missing" } });
    expect(enqueued).toHaveLength(0);
  });

  it("rejects a GPU request the provider has not advertised before enqueue", async () => {
    const { app, enqueued } = harness();

    const response = await post(app, { ...BODY, computeDevice: "gpu" });

    expect(await response.json()).toMatchObject({
      error: { code: "tts_provider_unavailable", field: "computeDevice" },
    });
    expect(enqueued).toHaveLength(0);
  });

  it("rejects a scene that is not in the project before enqueue", async () => {
    const { app, enqueued } = harness();

    const response = await post(app, { ...BODY, sceneIds: ["ghost"] });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "scene_not_found", field: "sceneIds" },
    });
    expect(enqueued).toHaveLength(0);
  });

  it("rejects a scene with no narration text before enqueue", async () => {
    const { app, enqueued } = harness({ scenes: [narratedScene("intro", null)] });

    const response = await post(app, BODY);

    expect(response.status).toBe(404);
    expect(enqueued).toHaveLength(0);
  });

  it("rejects the same scene named twice before enqueue", async () => {
    const { app, enqueued } = harness();

    const response = await post(app, { ...BODY, sceneIds: ["intro", "intro"] });

    expect(await response.json()).toMatchObject({ error: { code: "duplicate_mutation_target" } });
    expect(enqueued).toHaveLength(0);
  });

  it("treats a whitespace-only Idempotency-Key as absent", async () => {
    const { app, enqueued } = harness();

    // Stored verbatim it becomes a real key that every keyless client collides
    // with, producing conflicts nobody can explain.
    await post(app, BODY, { "Idempotency-Key": "   " });

    expect(enqueued[0]?.idempotencyKey).toBe(null);
  });

  it("rejects an oversized Idempotency-Key rather than writing it to SQLite", async () => {
    const { app, enqueued } = harness();

    const response = await post(app, BODY, { "Idempotency-Key": "k".repeat(256) });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { field: "Idempotency-Key" } });
    expect(enqueued).toHaveLength(0);
  });

  it("passes the Idempotency-Key through and reports a reused one as a conflict", async () => {
    const { app, enqueued } = harness({ enqueueConflict: true });

    const response = await post(app, BODY, { "Idempotency-Key": "batch-1" });

    expect(enqueued[0]?.idempotencyKey).toBe("batch-1");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "idempotency_key_reused" } });
  });

  it("hashes the input so the same request twice is recognisable as the same job", async () => {
    const { app, enqueued } = harness();

    await post(app, BODY);
    await post(app, { voiceId: BODY.voiceId, providerId: BODY.providerId, sceneIds: BODY.sceneIds });

    expect(enqueued[0]?.inputHash).toBe(enqueued[1]?.inputHash);
  });
});
