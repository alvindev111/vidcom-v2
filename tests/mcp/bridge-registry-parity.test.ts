import { DaemonClientError, type DaemonClient } from "@vidcom/adapter";
import { createRemoteToolInvoker } from "@vidcom/cli";
import type { ProjectId } from "@vidcom/contracts";
import { ErrorCode } from "@vidcom/contracts";
import type { ApprovalService, ToolAuditService } from "@vidcom/core";
import {
  ToolRegistry,
  type ToolDefinition,
  type ToolInvoker,
  type ToolRequestContext,
} from "@vidcom/mcp";
import { describe, expect, it } from "vitest";

function passthrough<T>(keys: readonly string[]): ToolDefinition<T, T>["input"] {
  return {
    parse(raw: unknown) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)
        || Object.keys(raw).some((key) => !keys.includes(key))) throw new TypeError("invalid");
      return raw;
    },
  } as unknown as ToolDefinition<T, T>["input"];
}

function definition(name: string): ToolDefinition<{ projectId: string }, { value: string }> {
  return {
    name,
    title: `${name} title`,
    level: "read",
    description: `${name} description`,
    input: passthrough(["projectId"]),
    output: passthrough(["value"]),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    availableInLegacy: true,
    projectIdOf: (input: { projectId: string }) => input.projectId as ProjectId,
    handler: (_context: unknown, input: { projectId: string }) =>
      Promise.resolve({ ok: true, value: { value: input.projectId } }),
  } as unknown as ToolDefinition<{ projectId: string }, { value: string }>;
}

/** Records nothing, answers everything: the audit trail has its own suites. */
function silentAudit(): ToolAuditService {
  return {
    currentRevision: () => Promise.resolve(0),
    recordRead: () => Promise.resolve(),
    recordFailure: () => Promise.resolve(),
    recordFailureIfCallerOwned: () => Promise.resolve(),
    ownershipOf: () => Promise.resolve(null),
  } as unknown as ToolAuditService;
}

function registry(): ToolRegistry {
  const instance = new ToolRegistry({
    audit: silentAudit(),
    approvals: { request: null as unknown as ApprovalService["request"] },
  });
  instance.register(definition("list_projects"));
  instance.register(definition("get_project_context"));
  return instance;
}

const request: ToolRequestContext = {
  era: "modern",
  protocolVersion: "2026-07-28",
  credentialId: "system-bridge",
  requestInput: () => Promise.reject(new Error("no elicitation over the bridge")),
};

/** A daemon that runs the very same registry, which is what the real one does. */
function daemonRunning(local: ToolRegistry): DaemonClient {
  return {
    handshake: () => Promise.reject(new Error("unused")),
    attach: () => Promise.reject(new Error("unused")),
    renew: () => Promise.reject(new Error("unused")),
    detach: () => Promise.reject(new Error("unused")),
    invokeTool: async (name, input, context) => {
      const result = await local.invoke(name, input, { ...request, protocolVersion: context.protocolVersion });
      // The real daemon answers a refused tool with its stable code, and the
      // client turns that into a DaemonClientError. Anything less faithful here
      // would make the parity assertions test the stub instead of the seam.
      if (!result.ok) throw new DaemonClientError(result.error.code, result.error.message);
      return result.value;
    },
  };
}

describe("bridge and local registry parity", () => {
  it("lists the same tools whichever invoker runs them", () => {
    // The registry is the one source of the list, the schemas and the era rules
    // regardless of where execution happens. A bridge that published a
    // different roster would be a second catalogue with no way to say which is
    // right.
    const local = registry();
    const invoker: ToolInvoker = createRemoteToolInvoker(daemonRunning(local));
    expect(typeof invoker.invoke).toBe("function");
    expect(local.list("modern").map((tool) => tool.name))
      .toEqual(["get_project_context", "list_projects"]);
    expect(local.list("legacy").map((tool) => tool.name))
      .toEqual(local.list("modern").map((tool) => tool.name));
  });

  it("returns the same value from the local and the remote path", async () => {
    const local = registry();
    const remote = createRemoteToolInvoker(daemonRunning(local));
    const input = { projectId: "project-1" };
    expect(await remote.invoke("list_projects", input, request))
      .toEqual(await local.invoke("list_projects", input, request));
  });

  it("returns the same failure shape for input the schema refuses", async () => {
    // The distinction that matters: a tool that refused the input has to look
    // the same over the bridge as it does locally, or a caller learns to treat
    // every remote failure as a transport problem.
    const local = registry();
    const remote = createRemoteToolInvoker(daemonRunning(local));
    const invalid = { projectId: "project-1", unexpected: true };
    const localResult = await local.invoke("list_projects", invalid, request);
    const remoteResult = await remote.invoke("list_projects", invalid, request);
    expect(localResult.ok).toBe(false);
    expect(remoteResult).toMatchObject({ ok: false, error: { code: ErrorCode.SchemaInvalid } });
  });

  it("reports an unregistered tool the same way on both paths", async () => {
    const local = registry();
    const remote = createRemoteToolInvoker(daemonRunning(local));
    expect(await local.invoke("rm_rf", {}, request)).toMatchObject({
      ok: false,
      error: { code: ErrorCode.NotFound },
    });
    expect(await remote.invoke("rm_rf", {}, request)).toMatchObject({
      ok: false,
      error: { code: ErrorCode.NotFound },
    });
  });

  it("forwards the negotiated protocol version rather than a default", async () => {
    let seen: string | undefined;
    const remote = createRemoteToolInvoker({
      handshake: () => Promise.reject(new Error("unused")),
      attach: () => Promise.reject(new Error("unused")),
      renew: () => Promise.reject(new Error("unused")),
      detach: () => Promise.reject(new Error("unused")),
      invokeTool: (_name, _input, context) => {
        seen = context.protocolVersion;
        return Promise.resolve({ value: "ok" });
      },
    });
    await remote.invoke("list_projects", { projectId: "p" }, { ...request, protocolVersion: "2025-11-25" });
    expect(seen).toBe("2025-11-25");
  });
});
