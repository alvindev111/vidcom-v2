import {
  InMemoryNonceStore,
  InMemoryPreviewCapabilityStore,
  InMemorySessionStore,
  createServerApp,
  previewCapabilityPolicy,
} from "@vidcom/server";
import type { ProjectId } from "@vidcom/contracts";
import { describe, expect, it } from "vitest";

function mutableClock(initial = Date.parse("2026-08-20T12:40:00.000Z")) {
  let now = initial;
  return {
    now: () => new Date(now),
    advance(milliseconds: number) { now += milliseconds; },
  };
}

function deterministicRandom(fill: number) {
  return (size: number) => Buffer.alloc(size, fill);
}

describe("preview read capabilities", () => {
  it("stores only a token hash and binds verification to one project", () => {
    const clock = mutableClock();
    const capabilities = new InMemoryPreviewCapabilityStore(clock, deterministicRandom(0x41));
    const issued = capabilities.mint({
      projectId: "project-a" as ProjectId,
      browserSessionId: "browser:a",
      studioSessionId: "01K34H7G9F0M7JQF1D91V8KY0A",
    });

    expect(Buffer.from(issued.token, "base64url")).toHaveLength(previewCapabilityPolicy.bytes);
    expect(capabilities.storedHashes()).toHaveLength(1);
    expect(capabilities.storedHashes()).not.toContain(issued.token);
    expect(capabilities.verify(issued.token, "project-a" as ProjectId)).toBe(true);
    expect(capabilities.verify(issued.token, "project-b" as ProjectId)).toBe(false);
  });

  it("expires exactly and revokes every token owned by a detached studio session", () => {
    const clock = mutableClock();
    let seed = 0;
    const capabilities = new InMemoryPreviewCapabilityStore(
      clock,
      (size) => Buffer.alloc(size, ++seed),
    );
    const owner = {
      projectId: "project-a" as ProjectId,
      browserSessionId: "browser:a",
      studioSessionId: "01K34H7G9F0M7JQF1D91V8KY0A",
    };
    const first = capabilities.mint(owner);
    const second = capabilities.mint(owner);
    capabilities.mint({ ...owner, studioSessionId: "01K34H7G9F0M7JQF1D91V8KY0B" });

    capabilities.revoke(owner);
    expect(capabilities.verify(first.token, owner.projectId)).toBe(false);
    expect(capabilities.verify(second.token, owner.projectId)).toBe(false);
    expect(capabilities.storedHashes()).toHaveLength(1);

    const expiring = capabilities.mint(owner);
    clock.advance(previewCapabilityPolicy.ttlMs);
    expect(capabilities.verify(expiring.token, owner.projectId)).toBe(false);
  });

  it("admits only capability-scoped read routes on preview.localhost", async () => {
    const port = 43123;
    const clock = mutableClock();
    const capabilities = new InMemoryPreviewCapabilityStore(clock, deterministicRandom(0x42));
    const app = createServerApp({
      port,
      uiOrigins: [`http://127.0.0.1:${port}`],
      nonces: new InMemoryNonceStore(clock, deterministicRandom(0x11)),
      sessions: new InMemorySessionStore(clock, deterministicRandom(0x22)),
      previewCapabilities: capabilities,
    });
    const issued = capabilities.mint({
      projectId: "project-a" as ProjectId,
      browserSessionId: "browser:a",
      studioSessionId: "01K34H7G9F0M7JQF1D91V8KY0A",
    });
    const request = (pathname: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Host", `preview.localhost:${port}`);
      return app.request(`http://preview.localhost:${port}${pathname}`, { ...init, headers });
    };

    const privileged = await request("/api/v1/health", { headers: { Cookie: "vidcom_session=fake" } });
    expect(privileged.status).toBe(403);
    expect(await privileged.json()).toMatchObject({ error: { code: "host_not_allowed" } });

    const missing = await request("/api/preview/v1/c/missing/projects/project-a/runtime");
    expect(missing.status).toBe(401);

    const wrongProject = await request(
      `/api/preview/v1/c/${encodeURIComponent(issued.token)}/projects/project-b/runtime`,
    );
    expect(wrongProject.status).toBe(401);

    const allowed = await request(
      `/api/preview/v1/c/${encodeURIComponent(issued.token)}/projects/project-a/runtime`,
    );
    expect(allowed.status).toBe(404);
  });
});
