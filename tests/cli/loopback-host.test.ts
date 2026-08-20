import { createRequestRouter, type FetchTarget } from "@vidcom/cli";
import { describe, expect, it } from "vitest";

function responder(body: string): FetchTarget {
  return () => new Response(body, { status: 200 });
}

function get(pathname: string): Request {
  return new Request(`http://127.0.0.1${pathname}`);
}

function previewGet(pathname: string): Request {
  return new Request(`http://preview.localhost${pathname}`, {
    headers: { Host: "preview.localhost:43123" },
  });
}

async function body(router: ReturnType<typeof createRequestRouter>, pathname: string): Promise<string> {
  return (await router.handle(get(pathname))).text();
}

describe("loopback request router", () => {
  it("sends /api/** to the API target and everything else to the static host", async () => {
    const router = createRequestRouter({ api: responder("api"), static: responder("static") });

    expect(await body(router, "/api/bridge/v1/tools/list")).toBe("api");
    expect(await body(router, "/api/health")).toBe("api");
    expect(await body(router, "/projects/demo")).toBe("static");
    expect(await body(router, "/")).toBe("static");
  });

  it("does not treat a path that merely starts with the letters api as an API route", async () => {
    const router = createRequestRouter({ api: responder("api"), static: responder("static") });
    // `/apixyz` is not under `/api/`, and routing it to the API would expose
    // authenticated surface at an unintended path.
    expect(await body(router, "/apixyz")).toBe("static");
    expect(await body(router, "/api")).toBe("static");
  });

  it("serves the new target on the very next request after a swap", async () => {
    const router = createRequestRouter({ api: responder("first"), static: responder("static") });
    expect(await body(router, "/api/health")).toBe("first");

    router.swapApi(responder("second"));

    // Read at call time, not captured at construction: this is what lets a
    // workspace switch keep the port and the session.
    expect(await body(router, "/api/health")).toBe("second");
  });

  it("keeps the static host untouched when only the API target swaps", async () => {
    const router = createRequestRouter({ api: responder("api"), static: responder("static") });
    router.swapApi(responder("api2"));

    expect(await body(router, "/projects/demo")).toBe("static");
    expect(await body(router, "/api/health")).toBe("api2");
  });

  it("cannot leave a request straddling a swap", async () => {
    // A request already in flight finishes against the target it started on;
    // the assignment runs to completion between turns, so no request can ever
    // observe half of a swap.
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slow: FetchTarget = async () => {
      await held;
      return new Response("slow", { status: 200 });
    };

    const router = createRequestRouter({ api: slow, static: responder("static") });
    const inFlight = router.handle(get("/api/health"));
    router.swapApi(responder("fast"));

    // The swap is already visible to new requests while the old one is still open.
    expect(await body(router, "/api/health")).toBe("fast");
    release();
    expect(await (await inFlight).text()).toBe("slow");
  });

  it("swaps the static host independently, as a rebuilt asset host requires", async () => {
    const router = createRequestRouter({ api: responder("api"), static: responder("old") });
    router.swapStatic(responder("new"));

    expect(await body(router, "/projects/demo")).toBe("new");
    expect(await body(router, "/api/health")).toBe("api");
  });

  it("serves only the isolated preview shell on the preview hostname", async () => {
    const router = createRequestRouter({ api: responder("api"), static: responder("static") });

    const host = await router.handle(previewGet("/preview-host.html"));
    expect(await host.text()).toBe("static");
    expect(host.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(await (await router.handle(previewGet("/preview-host.js"))).text()).toBe("static");
    expect((await router.handle(previewGet("/"))).status).toBe(403);
    expect((await router.handle(previewGet("/projects/demo"))).status).toBe(403);
    expect(await (await router.handle(previewGet("/api/preview/v1/c/token/projects/p/runtime"))).text()).toBe("api");
  });
});
