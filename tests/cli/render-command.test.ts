import { DaemonClientError, type DaemonClient, type DaemonJob, type EnqueueRenderInput } from "@vidcom/adapter";
import { ErrorCode } from "@vidcom/contracts";
import {
  CliInputError,
  RENDER_EXIT,
  RENDER_WORKSPACE_HELP,
  assertRenderableWorkspace,
  exitCodeForJob,
  isProjectId,
  parseRenderCommandArgs,
  renderIdempotencyKey,
  runRender,
  runRenderCommand,
} from "@vidcom/cli";
import { describe, expect, it } from "vitest";

function capture(): { io: { stdout: Sink; stderr: Sink }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: { write: (chunk: string) => { out.push(chunk); return true; } },
      stderr: { write: (chunk: string) => { err.push(chunk); return true; } },
    },
  };
}

interface Sink { write(chunk: string): boolean }

function daemon(options: {
  statuses?: string[];
  onCancel?: () => void;
  onEnqueue?: (projectId: string, input: EnqueueRenderInput) => void;
}): DaemonClient {
  const statuses = [...(options.statuses ?? ["succeeded"])];
  return {
    handshake: () => Promise.reject(new Error("unused")),
    attach: () => Promise.reject(new Error("unused")),
    renew: () => Promise.reject(new Error("unused")),
    detach: () => Promise.reject(new Error("unused")),
    invokeTool: () => Promise.reject(new Error("unused")),
    enqueueRender: (projectId, input) => {
      options.onEnqueue?.(projectId, input);
      return Promise.resolve({ jobId: "job_1" });
    },
    getJob: () => Promise.resolve({
      id: "job_1",
      status: statuses.length > 1 ? statuses.shift()! : statuses[0]!,
    } as DaemonJob),
    cancelJob: () => {
      options.onCancel?.();
      return Promise.resolve();
    },
  };
}

async function* once(): AsyncGenerator<void> {
  yield undefined;
}

async function* twice(): AsyncGenerator<void> {
  yield undefined;
  yield undefined;
}

describe("render arguments", () => {
  it("takes one project and its flags", () => {
    expect(parseRenderCommandArgs(["swiss-grid", "--workspace", "/w", "--detach"]))
      .toEqual({ target: "swiss-grid", workspace: "/w", detach: true });
  });

  it("refuses two projects, a repeat and an unknown flag", () => {
    expect(() => parseRenderCommandArgs(["a", "b"])).toThrow(CliInputError);
    expect(() => parseRenderCommandArgs([])).toThrow(CliInputError);
    expect(() => parseRenderCommandArgs(["a", "--workspace"])).toThrow(CliInputError);
    expect(() => parseRenderCommandArgs(["a", "--wait"])).toThrow(CliInputError);
  });

  it("says that --workspace does not move the app's workspace", () => {
    // The opposite used to be true: resolving a workspace wrote it back as the
    // active one, so one render silently changed what the UI opened next.
    expect(RENDER_WORKSPACE_HELP).toContain("Does not change the workspace the app opens");
  });
});

describe("render target", () => {
  it("decides id or slug once, by shape", () => {
    // Never "try the id, then fall back to the slug": a slug shaped like an id
    // would be looked up twice with the second answer winning, and a typo in an
    // id would quietly render a different project.
    expect(isProjectId("project_0127e186-5e32-45ac-b66f-1c099ff8a292")).toBe(true);
    expect(isProjectId("swiss-grid")).toBe(false);
    expect(isProjectId("project_short")).toBe(false);
  });
});

describe("render workspace", () => {
  it("refuses the working directory when nothing marks it as a workspace", () => {
    // For the UI that is a reasonable place to start looking. For a render it
    // would write output into whatever directory the user was standing in.
    let thrown: unknown;
    try {
      assertRenderableWorkspace("cwd");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliInputError);
    expect((thrown as CliInputError).exitCode).toBe(RENDER_EXIT.input);
  });

  it.each(["explicit", "cwd-project", "cwd-solo", "active"])("accepts %s", (source) => {
    expect(() => assertRenderableWorkspace(source)).not.toThrow();
  });
});

describe("render command", () => {
  function connectable(client: DaemonClient, detached: string[]) {
    return {
      connect: () => Promise.resolve({
        client: { ...client, detach: (id: string) => { detached.push(id); return Promise.resolve(); } },
        attachmentId: "attachment-1",
      }),
      workspaceSource: () => Promise.resolve("explicit"),
    };
  }

  it("refuses before touching the daemon when the workspace is a guess", async () => {
    let connected = false;
    await expect(runRenderCommand(["swiss-grid"], {
      connect: () => { connected = true; return Promise.reject(new Error("unused")); },
      workspaceSource: () => Promise.resolve("cwd"),
    })).rejects.toBeInstanceOf(CliInputError);
    expect(connected).toBe(false);
  });

  it("resolves a slug through the tool surface, not a new endpoint", async () => {
    const detached: string[] = [];
    const client = {
      ...daemon({}),
      invokeTool: () => Promise.resolve({
        projects: [{ id: "project_0127e186-5e32-45ac-b66f-1c099ff8a292", slug: "swiss-grid" }],
      }),
    } as DaemonClient;
    const output = capture();
    const code = await runRenderCommand(["swiss-grid", "--detach"], {
      ...connectable(client, detached),
      io: output.io,
    });
    expect(code).toBe(RENDER_EXIT.succeeded);
    expect(output.out.join("")).toBe("job_1\n");
  });

  it("says so when no project in the workspace has that name", async () => {
    const client = { ...daemon({}), invokeTool: () => Promise.resolve({ projects: [] }) } as DaemonClient;
    await expect(runRenderCommand(["missing", "--detach"], connectable(client, [])))
      .rejects.toBeInstanceOf(CliInputError);
  });

  it("detaches even when the render fails", async () => {
    // An attachment left behind keeps an auto-started daemon alive for its full
    // TTL after the client that needed it has gone.
    const detached: string[] = [];
    const client = { ...daemon({}), invokeTool: () => Promise.reject(new Error("boom")) } as DaemonClient;
    await expect(runRenderCommand(["swiss-grid"], connectable(client, detached))).rejects.toThrow();
    expect(detached).toEqual(["attachment-1"]);
  });

  it("prints only a stable code when daemon polling fails", async () => {
    const output = capture();
    const detached: string[] = [];
    const client = {
      ...daemon({}),
      getJob: () => Promise.reject(new DaemonClientError(
        ErrorCode.DaemonUnavailable,
        "private path C:\\Users\\runner\\workspace timed out",
        { cause: "ECONNRESET at C:\\private" },
      )),
    } as DaemonClient;

    const code = await runRenderCommand([
      "project_0127e186-5e32-45ac-b66f-1c099ff8a292",
    ], { ...connectable(client, detached), io: output.io });
    expect(code).toBe(RENDER_EXIT.failed);
    expect(output.out).toEqual([]);
    expect(output.err.join("")).toBe("render_error daemon_unavailable\n");
    expect(output.err.join("")).not.toContain("Users");
    expect(detached).toEqual(["attachment-1"]);
  });
});

describe("render run", () => {
  it("gives every invocation its own idempotency key", () => {
    // Two identical renders are two renders. A stable key would make the second
    // one return the first one's job and look like it worked.
    expect(renderIdempotencyKey()).not.toBe(renderIdempotencyKey());
  });

  it("prints only the job id when detached", async () => {
    const output = capture();
    const code = await runRender({
      client: daemon({}),
      projectId: "project_1",
      options: { target: "project_1", detach: true },
      io: output.io,
    });
    expect(code).toBe(RENDER_EXIT.succeeded);
    expect(output.out.join("")).toBe("job_1\n");
  });

  it("waits for the job by default", async () => {
    const output = capture();
    const code = await runRender({
      client: daemon({ statuses: ["queued", "running", "succeeded"] }),
      projectId: "project_1",
      options: { target: "project_1" },
      io: output.io,
      sleep: () => Promise.resolve(),
    });
    expect(code).toBe(RENDER_EXIT.succeeded);
  });

  it("prints the terminal failure code without its message", async () => {
    const output = capture();
    const client = {
      ...daemon({}),
      getJob: () => Promise.resolve({
        id: "job_1",
        status: "failed",
        error: { code: "render_binary_missing", message: "C:\\private\\ffmpeg.exe missing" },
      } as DaemonJob),
    } as DaemonClient;
    const code = await runRender({
      client,
      projectId: "project_1",
      options: { target: "project_1" },
      io: output.io,
    });
    expect(code).toBe(RENDER_EXIT.failed);
    expect(output.out).toEqual([]);
    expect(output.err.join("")).toBe("render_failed render_binary_missing\n");
    expect(output.err.join("")).not.toContain("private");
  });

  it.each([
    ["failed", RENDER_EXIT.failed],
    ["cancelled", RENDER_EXIT.interrupted],
    ["succeeded", RENDER_EXIT.succeeded],
  ])("exits %s as %i", (status, expected) => {
    expect(exitCodeForJob({ id: "job_1", status } as DaemonJob)).toBe(expected);
  });

  it("asks the daemon to cancel on the first interrupt and keeps waiting", async () => {
    // A cancelling render still has files to clean up and a job row to finish,
    // and the exit code has to come from what the daemon actually recorded.
    let cancelled = 0;
    const output = capture();
    const code = await runRender({
      client: daemon({ statuses: ["running", "running", "cancelled"], onCancel: () => { cancelled += 1; } }),
      projectId: "project_1",
      options: { target: "project_1" },
      io: output.io,
      interrupts: once(),
      sleep: () => Promise.resolve(),
    });
    expect(cancelled).toBe(1);
    expect(code).toBe(RENDER_EXIT.interrupted);
    expect(output.err.join("")).toContain("press Ctrl+C again");
  });

  it("stops waiting on the second interrupt", async () => {
    // Pressing it twice tells this process to go away, not the daemon. The
    // render keeps going; only the waiting stops.
    const output = capture();
    const code = await runRender({
      client: daemon({ statuses: ["running"] }),
      projectId: "project_1",
      options: { target: "project_1" },
      io: output.io,
      interrupts: twice(),
      sleep: () => Promise.resolve(),
    });
    expect(code).toBe(RENDER_EXIT.interrupted);
  });

  it("returns even when the interrupt stream can never be closed", async () => {
    // Found by reviewing the diff. Waiting for the next Ctrl+C parks an async
    // generator on a promise nothing settles, so `return()` cannot resume it to
    // run cleanup — awaiting that would hang the very exit it is cleaning up
    // for. The render says it is done listening and moves on; the handler's
    // owner removes it.
    async function* endless(): AsyncGenerator<void> {
      for (;;) await new Promise<void>(() => undefined);
    }
    const code = await runRender({
      client: daemon({}),
      projectId: "project_1",
      options: { target: "project_1" },
      io: capture().io,
      interrupts: endless(),
      sleep: () => Promise.resolve(),
    });
    expect(code).toBe(RENDER_EXIT.succeeded);
  });

  it("goes through the daemon client rather than a second HTTP client", async () => {
    let seen: EnqueueRenderInput | undefined;
    await runRender({
      client: daemon({ onEnqueue: (_projectId, input) => { seen = input; } }),
      projectId: "project_1",
      options: { target: "project_1", detach: true, preset: "vertical-shorts" },
      io: capture().io,
    });
    expect(seen).toMatchObject({ renderPresetId: "vertical-shorts" });
    expect(seen).not.toHaveProperty("projectId");
    expect(String(seen?.["idempotencyKey"])).toMatch(/^render_/u);
  });
});
