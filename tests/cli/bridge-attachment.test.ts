import {
  DAEMON_RECORD_SCHEMA_VERSION,
  DaemonClientError,
  workspaceHash,
  type DaemonClient,
  type DaemonRecord,
} from "@vidcom/adapter";
import {
  ensureDaemon,
  ensureDaemonArgs,
  spawnEnsuredDaemon,
  waitForDaemonRecord,
  type EnsureDaemonDependencies,
} from "@vidcom/cli";
import { ErrorCode } from "@vidcom/contracts";
import { describe, expect, it } from "vitest";

const WORKSPACE = "/canonical/workspace";

function record(instanceId: string, port = 43_127): DaemonRecord {
  return {
    schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
    workspaceRoot: WORKSPACE,
    workspaceHash: workspaceHash(WORKSPACE),
    instanceId,
    pid: 4321,
    host: "127.0.0.1",
    port,
    startedAt: "2026-08-09T00:00:00.000Z",
  };
}

function client(options: { handshakeFails?: boolean } = {}): DaemonClient {
  return {
    handshake: () => options.handshakeFails
      ? Promise.reject(new DaemonClientError(ErrorCode.DaemonIdentityMismatch, "gone"))
      : Promise.resolve({
        workspaceRoot: WORKSPACE,
        instanceId: "unused",
        protocolVersions: ["2026-07-28"],
        daemonVersion: "1.0.0",
      }),
    attach: () => Promise.resolve({
      attachmentId: "attachment-1",
      heartbeatEveryMs: 5_000,
      expiresAt: "2026-08-09T00:00:20.000Z",
    }),
    renew: () => Promise.reject(new Error("unused")),
    detach: () => Promise.resolve(),
    enqueueRender: () => Promise.reject(new Error("unused")),
    getJob: () => Promise.reject(new Error("unused")),
    cancelJob: () => Promise.reject(new Error("unused")),
    invokeTool: () => Promise.reject(new Error("unused")),
  };
}

function dependencies(overrides: Partial<EnsureDaemonDependencies> = {}): EnsureDaemonDependencies {
  return {
    workspaceRoot: WORKSPACE,
    kind: "bridge",
    clientVersion: "1.0.0",
    readRecord: () => Promise.resolve(null),
    connect: () => client(),
    spawnDaemon: () => Promise.resolve(),
    waitForRecord: () => Promise.resolve(record("daemon_started")),
    ...overrides,
  };
}

describe("bridge stdout", () => {
  it("has nothing in the bridge path that can write to stdout", async () => {
    // stdout is the JSON-RPC channel. One stray line and the agent host stops
    // being able to parse the stream at all — not a degraded session, a dead
    // one. The end-to-end stdio host proves the runtime stays clean; this
    // catches the line before it is ever written, which is where it is cheap.
    const { readdir, readFile } = await import("node:fs/promises");
    const directory = "packages/cli/src/bridge";
    for (const entry of await readdir(directory)) {
      const source = await readFile(`${directory}/${entry}`, "utf8");
      expect(source, entry).not.toMatch(/console\.(?:log|info|debug)\b/u);
      expect(source, entry).not.toMatch(/process\.stdout\b/u);
    }
  });
});

describe("starting a daemon on demand", () => {
  it("marks it as started on demand and opens no window", () => {
    // `--ensure` is the only thing that ever lets a daemon retire itself. And
    // note what is missing: a daemon started because an agent needed one must
    // not open a browser on somebody's screen.
    expect(ensureDaemonArgs("/w")).toEqual(["serve", "--ensure", "--workspace", "/w"]);
  });

  it("detaches the child and gives it no stdio", () => {
    // The client exits long before the daemon does. A child sharing this
    // process's stdio would write into a pipe nobody reads — and when the
    // caller is the bridge, that pipe is the JSON-RPC stream.
    let seen: { options?: { detached?: boolean; stdio?: unknown } } = {};
    spawnEnsuredDaemon({
      workspaceRoot: "/w",
      spawnProcess: ((_command: string, _args: string[], options: Record<string, unknown>) => {
        seen = { options };
        return { unref: () => undefined };
      }) as never,
    });
    expect(seen.options).toMatchObject({ detached: true, stdio: "ignore" });
  });

  it("waits for whichever daemon publishes, not for its own child", async () => {
    // Losing the lease race means somebody else's daemon publishes the record.
    // Watching our own child would never see that.
    let reads = 0;
    const record = await waitForDaemonRecord(
      () => Promise.resolve(reads++ < 2 ? null : record0),
      { pollMs: 0, sleep: () => Promise.resolve() },
    );
    expect(record?.instanceId).toBe("daemon_winner");
    expect(reads).toBe(3);
  });

  it("gives up rather than waiting for a daemon that never arrives", async () => {
    expect(await waitForDaemonRecord(() => Promise.resolve(null), {
      timeoutMs: 0,
      pollMs: 0,
      sleep: () => Promise.resolve(),
    })).toBeNull();
  });
});

const record0 = record("daemon_winner");

describe("ensure daemon", () => {
  it("uses the daemon that is already serving the workspace", async () => {
    let spawned = 0;
    const ensured = await ensureDaemon(dependencies({
      readRecord: () => Promise.resolve(record("daemon_first")),
      spawnDaemon: () => { spawned += 1; return Promise.resolve(); },
    }));
    expect(ensured.started).toBe(false);
    expect(ensured.record.instanceId).toBe("daemon_first");
    expect(spawned).toBe(0);
  });

  it("starts one when nothing is serving the workspace", async () => {
    const ensured = await ensureDaemon(dependencies());
    expect(ensured.started).toBe(true);
    expect(ensured.attachmentId).toBe("attachment-1");
  });

  it("starts one when the record outlived the process it described", async () => {
    // A daemon that was killed leaves its record behind, and the record looks
    // perfectly valid. Only the handshake finds out.
    let spawned = 0;
    const ensured = await ensureDaemon(dependencies({
      readRecord: () => Promise.resolve(record("daemon_dead")),
      connect: (target) => client({ handshakeFails: target.instanceId === "daemon_dead" }),
      spawnDaemon: () => { spawned += 1; return Promise.resolve(); },
    }));
    expect(spawned).toBe(1);
    expect(ensured.record.instanceId).toBe("daemon_started");
  });

  it("turns the loser of the start race into a client", async () => {
    // Two clients can find no record at the same moment and both start a
    // daemon. Exactly one wins the workspace lease and the other exits — and
    // the client that started the loser still wanted a daemon, and there is
    // one, so it must not fail.
    const ensured = await ensureDaemon(dependencies({
      spawnDaemon: () => Promise.reject(new Error("workspace lease is held elsewhere")),
      waitForRecord: () => Promise.resolve(record("daemon_winner")),
    }));
    expect(ensured.record.instanceId).toBe("daemon_winner");
    expect(ensured.started).toBe(false);
    expect(ensured.attachmentId).toBe("attachment-1");
  });

  it("names the real failure when nothing came up at all", async () => {
    // Reporting "no daemon appeared" would hide the reason the start failed,
    // which is the only thing worth telling the user here.
    await expect(ensureDaemon(dependencies({
      spawnDaemon: () => Promise.reject(new Error("the runtime is not extracted")),
      waitForRecord: () => Promise.resolve(null),
    }))).rejects.toMatchObject({
      code: ErrorCode.DaemonUnavailable,
      details: { cause: "the runtime is not extracted" },
    });
  });

  it("reports a daemon that came up and then refused the handshake", async () => {
    await expect(ensureDaemon(dependencies({
      connect: () => client({ handshakeFails: true }),
    }))).rejects.toMatchObject({ code: ErrorCode.DaemonUnavailable });
  });

  it("attaches as the kind the caller asked for", async () => {
    // The kind decides whether the daemon may ever shut itself down, so it is
    // not a label: a UI attachment takes that right away permanently.
    let attachedAs: string | undefined;
    await ensureDaemon(dependencies({
      kind: "ui",
      readRecord: () => Promise.resolve(record("daemon_first")),
      connect: () => ({
        ...client(),
        attach: (kind) => {
          attachedAs = kind;
          return Promise.resolve({
            attachmentId: "attachment-1",
            heartbeatEveryMs: 5_000,
            expiresAt: "2026-08-09T00:00:20.000Z",
          });
        },
      }),
    }));
    expect(attachedAs).toBe("ui");
  });
});
