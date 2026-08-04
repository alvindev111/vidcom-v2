import { access, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LoopbackRuntimeAssetGuard } from "@vidcom/adapter";
import {
  evaluateRemoteAssetGuard,
  finalizeGuardedArtifact,
  type JobId,
} from "@vidcom/core";

function callbackUrl(bootstrap: string): string {
  const match = bootstrap.match(/const callbackUrl = ("[^"]+");/u);
  if (!match) throw new Error("bootstrap did not expose its generated callback constant");
  return JSON.parse(match[1]!) as string;
}

describe("LoopbackRuntimeAssetGuard", () => {
  it("authenticates a multi-report job session, dedupes media, and caps external entries", async () => {
    const guard = new LoopbackRuntimeAssetGuard();
    const jobId = "job_runtime_guard" as JobId;
    const opened = await guard.open(jobId);
    const url = callbackUrl(opened.bootstrapScript);
    const report = (body: Record<string, unknown>) => fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId, token: opened.token, ...body }),
    });

    expect((await report({ kind: "media", blockedUri: "https://assets.test/image.png", directive: "img-src" })).status)
      .toBe(204);
    expect((await report({ kind: "media", blockedUri: "https://assets.test/image.png", directive: "img-src" })).status)
      .toBe(204);
    for (let index = 0; index < 105; index += 1) {
      expect((await report({
        kind: "external",
        url: `https://scripts.test/${index}.js`,
        initiatorType: "script",
      })).status).toBe(204);
    }
    expect((await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId,
        token: `${opened.token}x`,
        kind: "media",
        blockedUri: "https://assets.test/forged.png",
        directive: "img-src",
      }),
    })).status).toBe(403);

    const snapshot = await guard.close(jobId, opened.token);
    expect(snapshot.mediaViolations).toEqual([{
      url: "https://assets.test/image.png",
      source: "observed-request",
      reference: "img-src",
    }]);
    expect(snapshot.externalDependencies).toHaveLength(100);
    expect(evaluateRemoteAssetGuard(snapshot)).toMatchObject({
      ok: false,
      error: { code: "remote_asset_not_local" },
    });
  });

  it("binds loopback and emits the observer safety contract without logging its token", async () => {
    const guard = new LoopbackRuntimeAssetGuard();
    const jobId = "job_runtime_contract" as JobId;
    const opened = await guard.open(jobId);
    try {
      expect(callbackUrl(opened.bootstrapScript)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/report$/u);
      expect(opened.bootstrapScript).toContain('entry.name === callbackUrl');
      expect(opened.bootstrapScript).toContain('observed.size >= 100');
      expect(opened.bootstrapScript).toContain('observe({ type: "resource", buffered: true })');
      expect(opened.csp).toContain("img-src 'self' data: blob:");
      expect(opened.csp).toContain("media-src 'self' data: blob:");
    } finally {
      await guard.close(jobId, opened.token);
    }
  });

  it("discards a real staged artifact after close when a runtime media violation exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-guarded-artifact-"));
    const staged = path.join(root, "staged.mp4");
    const published = path.join(root, "published.mp4");
    const guard = new LoopbackRuntimeAssetGuard();
    const jobId = "job_guarded_artifact" as JobId;
    const opened = await guard.open(jobId);
    const order: string[] = [];
    try {
      await writeFile(staged, "artifact");
      const response = await fetch(callbackUrl(opened.bootstrapScript), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobId,
          token: opened.token,
          kind: "media",
          blockedUri: "https://assets.test/runtime.png",
          directive: "img-src",
        }),
      });
      expect(response.status).toBe(204);
      const result = await finalizeGuardedArtifact({
        open: guard.open.bind(guard),
        async close(id, token) {
          order.push("close");
          return guard.close(id, token);
        },
      }, jobId, opened.token, {
        async publish() { order.push("publish"); await rename(staged, published); },
        async discard() { order.push("discard"); await rm(staged, { force: true }); },
      });
      expect(result).toMatchObject({ ok: false, error: { code: "remote_asset_not_local" } });
      expect(order).toEqual(["close", "discard"]);
      await expect(access(staged)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(published)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await guard.close(jobId, opened.token).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
});
