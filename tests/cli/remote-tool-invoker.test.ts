import { readFile } from "node:fs/promises";

import { DaemonClientError, type DaemonClient } from "@vidcom/adapter";
import { createRemoteToolInvoker } from "@vidcom/cli";
import { ErrorCode } from "@vidcom/contracts";
import type { ToolRequestContext } from "@vidcom/mcp";
import { describe, expect, it } from "vitest";

const request: ToolRequestContext = {
  era: "modern",
  protocolVersion: "2026-07-28",
  credentialId: "credential-1",
  requestInput: () => Promise.reject(new Error("no elicitation over the bridge")),
};

function client(invokeTool: DaemonClient["invokeTool"]): DaemonClient {
  return {
    handshake: () => Promise.reject(new Error("unused")),
    attach: () => Promise.reject(new Error("unused")),
    renew: () => Promise.reject(new Error("unused")),
    detach: () => Promise.reject(new Error("unused")),
    invokeTool,
  };
}

describe("remote tool invoker", () => {
  it("answers the same shape the registry does", async () => {
    // The registry's own invoke returns a Result, and the bridge has to be
    // substitutable for it — that substitutability is the entire seam.
    const invoker = createRemoteToolInvoker(client(() => Promise.resolve({ projects: [] })));
    expect(await invoker.invoke("list_projects", {}, request))
      .toEqual({ ok: true, value: { projects: [] } });
  });

  it("forwards the negotiated protocol version", async () => {
    let seen: string | undefined;
    const invoker = createRemoteToolInvoker(client((_name, _input, context) => {
      seen = context.protocolVersion;
      return Promise.resolve(null);
    }));
    await invoker.invoke("list_projects", {}, request);
    expect(seen).toBe("2026-07-28");
  });

  it("keeps the daemon's code rather than collapsing everything to one error", async () => {
    // Collapsing hides the difference between a tool that refused the input and
    // a daemon that never answered, which is the distinction a caller needs
    // most.
    const invoker = createRemoteToolInvoker(client(() => Promise.reject(
      new DaemonClientError(ErrorCode.SchemaInvalid, "tool input does not match its strict schema"),
    )));
    expect(await invoker.invoke("save_file", {}, request)).toMatchObject({
      ok: false,
      error: { code: ErrorCode.SchemaInvalid },
    });
  });

  it("reports an unexpected failure as the daemon being unavailable", async () => {
    const invoker = createRemoteToolInvoker(client(() => Promise.reject(new TypeError("boom"))));
    expect(await invoker.invoke("list_projects", {}, request)).toMatchObject({
      ok: false,
      error: { code: ErrorCode.DaemonUnavailable },
    });
  });

  it("lives in cli, because mcp may not import adapter", async () => {
    // Two independent gates enforce that, and the boundary script resolves the
    // package by path prefix — so `adapter/daemon` is still `adapter` and there
    // is no spelling of the import that escapes it. Stated here so a future
    // move to `mcp` fails as a test rather than as a red pipeline.
    const source = await readFile("packages/mcp/src/registry/types.ts", "utf8");
    expect(source).toContain("interface ToolInvoker");
    expect(source).not.toContain("@vidcom/adapter");

    const manifest = JSON.parse(await readFile("packages/mcp/package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies)).not.toContain("@vidcom/adapter");
  });
});
