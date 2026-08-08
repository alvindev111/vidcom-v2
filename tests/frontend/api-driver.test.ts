import { resolveApiBaseUrl } from "../../src/lib/api/base-url";
import {
  SERVICE_CATALOG,
  serviceRequest,
  serviceUrl,
  type ServiceId,
} from "../../src/lib/api/services";
import { describe, expect, it } from "vitest";

describe("api base url", () => {
  it("prefers the injected global over the page origin", () => {
    // The daemon picks a free loopback port at runtime, so the origin cannot be
    // known when the bundle is built.
    expect(resolveApiBaseUrl({
      __VIDCOM_API_BASE_URL__: "http://127.0.0.1:7788",
      location: { origin: "http://127.0.0.1:3000" },
    })).toBe("http://127.0.0.1:7788");
  });

  it("falls back to the page origin", () => {
    expect(resolveApiBaseUrl({ location: { origin: "http://127.0.0.1:3000" } }))
      .toBe("http://127.0.0.1:3000");
  });

  it("returns an empty base when neither is available", () => {
    // Same-origin relative requests: right in a browser, honest anywhere else.
    expect(resolveApiBaseUrl({})).toBe("");
  });

  it("ignores a blank injected value rather than producing a broken base", () => {
    expect(resolveApiBaseUrl({
      __VIDCOM_API_BASE_URL__: "   ",
      location: { origin: "http://127.0.0.1:3000" },
    })).toBe("http://127.0.0.1:3000");
  });

  it("strips trailing slashes so joins cannot double them", () => {
    expect(resolveApiBaseUrl({ __VIDCOM_API_BASE_URL__: "http://127.0.0.1:7788//" }))
      .toBe("http://127.0.0.1:7788");
  });

  it("is callable without any browser globals at all", () => {
    // The signature exists so this test can be written under environment:
    // "node"; a function reading `window` in its body could not be.
    expect(() => resolveApiBaseUrl()).not.toThrow();
  });
});

describe("service catalog", () => {
  it("never doubles the version prefix", () => {
    for (const id of Object.keys(SERVICE_CATALOG) as ServiceId[]) {
      const url = serviceUrl(id, { __VIDCOM_API_BASE_URL__: "http://127.0.0.1:7788" });
      // Automatic version injection on top of these yields /api/v1/v1/..., a
      // 404 that reads like a missing route rather than a doubled prefix.
      expect(url, id).not.toContain("/v1/v1/");
      expect(url, id).toContain("/api/v1/");
    }
  });

  it("names every entry v1.<domain>.<action>", () => {
    for (const id of Object.keys(SERVICE_CATALOG)) {
      expect(id, id).toMatch(/^v1(\.[a-zA-Z]+){1,2}$/u);
    }
  });

  it("sends the session cookie on every request", () => {
    for (const id of Object.keys(SERVICE_CATALOG) as ServiceId[]) {
      // The session is a cookie; omitting it is answered as anonymous, which
      // reads as a permissions bug rather than a missing header.
      expect(serviceRequest(id).init.credentials, id).toBe("include");
    }
  });

  it("uses the method the catalog declares", () => {
    expect(serviceRequest("v1.system.entries").init.method).toBe("POST");
    expect(serviceRequest("v1.workspace.activate").init.method).toBe("PUT");
    expect(serviceRequest("v1.system.roots").init.method).toBe("GET");
  });

  it("serialises a body only when one is given", () => {
    const withBody = serviceRequest("v1.system.entries", { body: { token: "browse_1" } });
    expect((withBody.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(withBody.init.body).toBe(JSON.stringify({ token: "browse_1" }));

    expect(serviceRequest("v1.system.roots").init.headers).toBeUndefined();
    expect(serviceRequest("v1.system.roots").init.body).toBeUndefined();
  });

  it("keeps browsing on POST so directory names stay out of the request line", () => {
    expect(SERVICE_CATALOG["v1.system.entries"].method).toBe("POST");
    expect(SERVICE_CATALOG["v1.system.createDirectory"].method).toBe("POST");
  });
});
